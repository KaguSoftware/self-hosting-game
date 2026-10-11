// The Docker daemon: create, start, stop and remove containers, volumes, crash loops
// and healthchecks. Pure state changes on an immer draft; the CLI does the printing.
import { registerReconciler } from "../tick";
import { pgTime } from "../time";
import type { Container, HealthCheck, Host, PortMap, World } from "../types";
import { hashHex } from "../util";
import { boot, log, pgDataPath, pgMajor, probe } from "./behaviour";
import { fullId, startedAt } from "./format";
import { localImage, normalizeRef } from "./images";
import { allocIps, ensureNetwork, ipOf } from "./network";

export const DOCKER_VERSION = "27.3.1";
export const COMPOSE_VERSION = "2.29.7";
export const API_VERSION = "1.47";

export function dockerInstalled(host: Host): boolean {
  return !!(host.packages["docker-ce"] || host.packages["docker.io"]);
}

export function dockerActive(host: Host): boolean {
  return host.services.docker?.state === "active";
}

export type Mount = Container["mounts"][number];

export interface RunSpec {
  name?: string;
  image: string;
  ports?: PortMap[];
  env?: Record<string, string>;
  mounts?: Mount[];
  restart?: Container["restart"];
  networks?: string[];
  command?: string[];
  project?: string;
  service?: string;
  /** null turns off a healthcheck the image has. */
  healthcheck?: HealthCheck | null;
  logging?: Container["logging"];
  autoRemove?: boolean;
  configHash?: string;
  dependsOn?: string[];
}

const ADJECTIVES = ["admiring", "bold", "brave", "eager", "festive", "gifted", "happy", "jolly", "keen", "loving", "nifty", "quirky", "sharp", "vibrant", "zealous", "hopeful"];
const NAMES = ["turing", "hopper", "lovelace", "curie", "darwin", "feynman", "goldberg", "hamilton", "kalam", "knuth", "noether", "ritchie", "torvalds", "wozniak", "shannon", "babbage"];

function randomName(host: Host, seed: string): string {
  const h = parseInt(hashHex(seed, 8), 16);
  const base = `${ADJECTIVES[h % ADJECTIVES.length]}_${NAMES[(h >>> 8) % NAMES.length]}`;
  let name = base;
  for (let i = 2; host.docker.containers[name]; i++) name = `${base}${i}`;
  return name;
}

export function findContainer(host: Host, ref: string): Container | undefined {
  const cs = host.docker.containers;
  if (cs[ref]) return cs[ref];
  const byName = Object.values(cs).find((c) => c.name === ref.replace(/^\//, ""));
  if (byName) return byName;
  if (/^[0-9a-f]{2,64}$/.test(ref)) {
    const hits = Object.values(cs).filter((c) => fullId(c.id).startsWith(ref));
    if (hits.length === 1) return hits[0];
  }
  return undefined;
}

export function ensureVolume(w: World, host: Host, name: string, project?: string): boolean {
  if (host.docker.volumes[name]) return false;
  host.docker.volumes[name] = { name, sizeMb: 0, createdAt: w.clock, ...(project ? { project } : {}) };
  return true;
}

export function volumeUsers(host: Host, name: string): Container[] {
  return Object.values(host.docker.containers).filter((c) => c.mounts.some((m) => m.type === "volume" && m.source === name));
}

/** A 64 hex name: what Docker calls a volume nobody named. */
export function isAnonymous(name: string): boolean {
  return /^[0-9a-f]{64}$/.test(name);
}

/** Create (not start) a container. The image must be local already. */
export function createContainer(w: World, host: Host, spec: RunSpec): Container {
  const img = localImage(host, spec.image);
  const meta = img?.meta ?? {};
  const count = Object.keys(host.docker.containers).length;
  const id = hashHex(`${spec.name ?? spec.image}|${w.clock}|${w.seed}|${count}|${Object.keys(host.docker.volumes).length}`, 64);
  const name = spec.name ?? randomName(host, id);
  const mounts = [...(spec.mounts ?? [])];
  const kind = img?.kind ?? "generic";
  if (kind === "postgres") {
    // The postgres image declares a VOLUME. Without your own mount, Docker makes a nameless one.
    const target = pgDataPath(meta.version?.split(".")[0] ?? /:(\d+)/.exec(spec.image)?.[1] ?? "17");
    if (!mounts.some((m) => m.target === target || m.target === "/var/lib/postgresql/data")) {
      const anon = hashHex(`anon|${id}`, 64);
      mounts.push({ source: anon, target, type: "volume" });
    }
  }
  for (const m of mounts) if (m.type === "volume") ensureVolume(w, host, m.source, spec.project);
  const networks = spec.networks?.length ? spec.networks : ["bridge"];
  for (const n of networks) ensureNetwork(host, n, spec.project);
  const c: Container = {
    id,
    name,
    image: spec.image,
    kind,
    status: "created",
    ports: spec.ports ?? [],
    networks,
    env: { ...(meta.env ?? {}), ...(spec.env ?? {}) },
    mounts,
    restart: spec.restart ?? "no",
    listenAddr: "0.0.0.0",
    listenPort: meta.exposed?.[0] ?? 0,
    logs: [],
    createdAt: w.clock,
    restartCount: 0,
    logging: spec.logging ?? { driver: "json-file", options: {} },
    imageId: img?.id,
  };
  if (spec.project) c.project = spec.project;
  if (spec.service) c.service = spec.service;
  if (spec.command?.length) c.command = spec.command;
  const hc = spec.healthcheck === null ? undefined : (spec.healthcheck ?? meta.healthcheck);
  if (hc) c.healthcheck = hc;
  if (spec.autoRemove) c.autoRemove = true;
  if (spec.configHash) c.configHash = spec.configHash;
  if (spec.dependsOn?.length) c.dependsOn = spec.dependsOn;
  host.docker.containers[name] = c;
  allocIps(host, c);
  return c;
}

function overlaps(a: string, b: string): boolean {
  return a === b || a === "0.0.0.0" || b === "0.0.0.0" || a === "::" || b === "::";
}

/** The daemon's error when a published port is taken, or undefined. */
export function portConflict(host: Host, c: Container): string | undefined {
  for (const p of c.ports) {
    for (const o of Object.values(host.docker.containers)) {
      if (o === c || (o.status !== "running" && o.status !== "restarting")) continue;
      if (o.ports.some((q) => q.hostPort === p.hostPort && overlaps(q.hostIp, p.hostIp))) {
        return `driver failed programming external connectivity on endpoint ${c.name} (${fullId(c.id)}): Bind for ${p.hostIp}:${p.hostPort} failed: port is already allocated`;
      }
    }
    for (const s of Object.values(host.services)) {
      if (s.state !== "active") continue;
      if ((s.listens ?? []).some((l) => l.port === p.hostPort && overlaps(l.addr, p.hostIp))) {
        return `driver failed programming external connectivity on endpoint ${c.name} (${fullId(c.id)}): failed to bind host port for ${p.hostIp}:${p.hostPort}:${ipOf(host, c)}:${p.containerPort}/tcp: address already in use`;
      }
    }
  }
  return undefined;
}

export interface StartResult {
  ok: boolean;
  error?: string;
}

/** Start a created, exited or restarting container. It may crash right away; that still counts as started. */
export function startContainer(w: World, host: Host, c: Container, now = w.clock): StartResult {
  if (c.status === "running") return { ok: true };
  const conflict = portConflict(host, c);
  if (conflict) return { ok: false, error: conflict };
  allocIps(host, c);
  const before = c.status;
  c.status = "running";
  c.startedAt = now;
  c.manuallyStopped = false;
  c.nextRestartAt = undefined;
  c.exitCode = undefined;
  c.healthFails = 0;
  c.lastProbe = now;
  c.health = c.healthcheck ? "starting" : undefined;
  const r = boot(w, host, c, now);
  if (r.startError) {
    c.status = before === "restarting" ? "exited" : "created";
    c.exitCode = 127;
    c.health = undefined;
    c.finishedAt = now;
    if (c.autoRemove) removeContainer(host, c, { volumes: true });
    return { ok: false, error: r.startError };
  }
  if (r.exit !== undefined) exited(w, host, c, r.exit, now);
  return { ok: true };
}

function backoff(n: number): number {
  return Math.min(60, 2 ** Math.max(0, n - 1));
}

/** The main process ended. Restart policies decide what happens next. */
export function exited(w: World, host: Host, c: Container, code: number, now = w.clock): void {
  c.status = "exited";
  c.exitCode = code;
  c.finishedAt = now;
  c.health = undefined;
  const again =
    !c.manuallyStopped && (c.restart === "always" || c.restart === "unless-stopped" || (c.restart === "on-failure" && code !== 0));
  if (again) {
    c.status = "restarting";
    c.restartCount = (c.restartCount ?? 0) + 1;
    c.nextRestartAt = now + backoff(c.restartCount);
  } else if (c.autoRemove) {
    removeContainer(host, c, { volumes: true });
  }
}

/** docker stop: SIGTERM, the process exits cleanly. */
export function stopContainer(w: World, host: Host, c: Container, manual = true): void {
  if (c.status !== "running" && c.status !== "restarting") return;
  const wasRunning = c.status === "running";
  if (wasRunning && c.kind === "postgres") {
    const t = pgTime(w.clock);
    log(c, `${t} [1] LOG:  received fast shutdown request`, `${t} [1] LOG:  aborting any active transactions`, `${t} [1] LOG:  database system is shut down`);
  }
  c.status = "exited";
  c.exitCode = wasRunning ? (c.kind === "generic" && !c.listenPort ? 137 : 0) : (c.exitCode ?? 1);
  c.finishedAt = w.clock;
  c.health = undefined;
  c.nextRestartAt = undefined;
  if (manual) c.manuallyStopped = true;
  if (c.autoRemove) removeContainer(host, c, { volumes: true });
}

/** docker rm. With volumes, nameless volumes go too (docker rm -v, --rm, compose down). */
export function removeContainer(host: Host, c: Container, opts: { volumes?: boolean } = {}): void {
  delete host.docker.containers[c.name];
  if (!opts.volumes) return;
  for (const m of c.mounts) {
    if (m.type === "volume" && isAnonymous(m.source) && !volumeUsers(host, m.source).length) delete host.docker.volumes[m.source];
  }
}

export function imageInUse(host: Host, ref: string): Container | undefined {
  const n = normalizeRef(ref);
  return Object.values(host.docker.containers).find((c) => normalizeRef(c.image) === n);
}

// ---------- time passing: crash loops and healthchecks ----------

function runProbes(host: Host, c: Container, to: number): void {
  const hc = c.healthcheck;
  if (!hc || hc.interval <= 0) return;
  const last = c.lastProbe ?? startedAt(c);
  const due = Math.floor((to - last) / hc.interval);
  if (due <= 0) return;
  // Every probe in this window gives the same answer (nothing else changes meanwhile).
  if (probe(host, c)) {
    c.health = "healthy";
    c.healthFails = 0;
  } else {
    // Failures during the start period do not count.
    const first = Math.max(1, Math.floor((startedAt(c) + hc.startPeriod - last) / hc.interval) + 1);
    c.healthFails = (c.healthFails ?? 0) + Math.max(0, due - first + 1);
    if (c.healthFails >= hc.retries) c.health = "unhealthy";
  }
  c.lastProbe = last + due * hc.interval;
}

export function reconcileDocker(w: World, _from: number, to: number): void {
  for (const host of Object.values(w.hosts)) {
    if (!dockerActive(host)) continue;
    for (const c of Object.values(host.docker.containers)) {
      let guard = 0;
      while (c.status === "restarting" && (c.nextRestartAt ?? Infinity) <= to && guard++ < 40) {
        const t = c.nextRestartAt!;
        startContainer(w, host, c, t);
      }
      if (c.status === "restarting" && guard >= 40) c.nextRestartAt = to + 60;
      if (c.status === "running" && c.healthcheck) runProbes(host, c, to);
    }
  }
}

registerReconciler("docker", reconcileDocker);

/** The mount holding a postgres container's data, if any. */
export function pgDataMount(host: Host, c: Container): Mount | undefined {
  const target = pgDataPath(pgMajor(host, c));
  return c.mounts.find((m) => m.target === target);
}
