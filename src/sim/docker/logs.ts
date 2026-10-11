// Container logs live in files on the server and grow forever unless the logging
// options cap them. When they fill the disk, Postgres is the first to fall over.
import { registerReconciler } from "../tick";
import type { Container, Host, World } from "../types";
import { log } from "./behaviour";
import { fullId } from "./format";

/** Bytes per second each kind writes to its log while running. */
const RATE: Record<string, number> = { nextjs: 450, caddy: 160, postgres: 25 };

function parseSize(v: string | undefined): number | undefined {
  const m = /^(\d+(?:\.\d+)?)([kmg]?)b?$/i.exec(v ?? "");
  if (!m) return undefined;
  const mult = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase() as "" | "k" | "m" | "g"];
  return Number(m[1]) * mult;
}

/** The most this container's log can take up, given its logging options (Infinity if unlimited). */
export function logCap(c: Container): number {
  const opts = c.logging?.options ?? {};
  if (c.logging?.driver === "none") return 0;
  const size = parseSize(opts["max-size"]);
  if (size === undefined) return c.logging?.driver === "local" ? 100 * 1024 ** 2 : Infinity;
  const files = Math.max(1, Number(opts["max-file"] ?? (c.logging?.driver === "local" ? 5 : 1)));
  return size * files;
}

export function logBytes(c: Container): number {
  return Math.min(c.logBytes ?? c.logs.join("\n").length, logCap(c));
}

/** Where Docker keeps a container's log on the server. */
export function logPath(c: Container): string {
  const id = fullId(c.id);
  return `/var/lib/docker/containers/${id}/${id}-json.log`;
}

/** Disk the server can use, and how much is taken, in MB (shared with df). */
export function diskSizeMb(host: Host): number {
  return host.diskGb * 1024 - 1600;
}

export function containerLogsMb(host: Host): number {
  return Object.values(host.docker.containers).reduce((s, c) => s + logBytes(c) / 1024 ** 2, 0);
}

let usedFn: ((h: Host) => number) | null = null;
/** system.ts registers its disk-usage function here, to avoid an import cycle. */
export function setDiskUsage(fn: (h: Host) => number): void {
  usedFn = fn;
}

export function diskFull(host: Host): boolean {
  return !!usedFn && usedFn(host) >= diskSizeMb(host);
}

export function reconcileLogs(w: World, from: number, to: number): void {
  const host = w.hosts.vps;
  if (!w.provider.rented) return;
  const dt = to - from;
  for (const c of Object.values(host.docker.containers)) {
    if (c.status !== "running") continue;
    const rate = RATE[c.kind] ?? 10;
    const next = (c.logBytes ?? 0) + rate * dt;
    c.logBytes = Math.min(next, logCap(c));
  }
  if (!diskFull(host)) return;
  for (const c of Object.values(host.docker.containers)) {
    if (c.kind !== "postgres" || c.status !== "running") continue;
    log(
      c,
      `${new Date(Date.UTC(2026, 9, 11, 9) + to * 1000).toISOString().replace("T", " ").slice(0, 23)} UTC [1] PANIC:  could not write to file "pg_wal/xlogtemp.32": No space left on device`,
      `${new Date(Date.UTC(2026, 9, 11, 9) + to * 1000).toISOString().replace("T", " ").slice(0, 23)} UTC [1] LOG:  database system is shut down`,
    );
    c.status = c.restart === "no" ? "exited" : "restarting";
    c.exitCode = 1;
    c.health = c.healthcheck ? "unhealthy" : c.health;
    c.nextRestartAt = to + 30;
  }
}

registerReconciler("docker-logs", reconcileLogs);
