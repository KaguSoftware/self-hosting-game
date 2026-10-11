// What docker compose up, down, restart and friends do to the daemon, with Compose 2.29 output.
import { stringify } from "yaml";
import { advance } from "../tick";
import type { Container, Host, World } from "../types";
import { containerName, serviceHash, serviceImage, topoOrder, type ComposeModel, type ComposeService } from "./compose";
import { buildImage } from "./dockerfile";
import { commandText, humanDuration, portsText, statusText } from "./format";
import { localImage, pullImage } from "./images";
import { ensureNetwork, networkInUse } from "./network";
import { createContainer, ensureVolume, isAnonymous, removeContainer, startContainer, stopContainer, volumeUsers, type Mount } from "./runtime";

export interface IO {
  out(s: string): void;
  err(s: string): void;
  info(s: string): void;
}

interface Event {
  kind: "Network" | "Volume" | "Container" | "Service";
  name: string;
  status: string;
  ok: boolean;
  secs: number;
}

function ev(kind: Event["kind"], name: string, status: string, ok = true, secs = 0.1): Event {
  return { kind, name, status, ok, secs };
}

/** "[+] Running 3/3" and one line per thing, the way Compose leaves the screen. */
export function block(title: string, events: Event[]): string {
  if (!events.length) return "";
  const labels = events.map((e) => `${e.kind === "Service" ? "Service" : e.kind} ${e.kind === "Volume" && e.status === "Created" ? `"${e.name}"` : e.name}`);
  const width = Math.max(...labels.map((l) => l.length));
  const ok = events.filter((e) => e.ok).length;
  return [
    `[+] ${title} ${ok}/${events.length}`,
    ...events.map((e, i) => `${` ${e.ok ? "✔" : "✘"} ${labels[i].padEnd(width)}  ${e.status}`.padEnd(74)} ${e.secs.toFixed(1)}s `.trimEnd()),
  ].join("\n");
}

export function projectContainers(host: Host, m: ComposeModel): Container[] {
  return Object.values(host.docker.containers).filter((c) => c.project === m.project);
}

function containerOf(host: Host, m: ComposeModel, svc: string): Container | undefined {
  const s = m.services[svc];
  return s ? host.docker.containers[containerName(m, s)] : undefined;
}

function createFor(w: World, host: Host, m: ComposeModel, svc: ComposeService, hash: string, carry: Mount[] = []): Container {
  const mounts = [...svc.mounts];
  // Compose keeps a container's nameless volumes when it recreates it.
  for (const a of carry) if (!mounts.some((x) => x.target === a.target)) mounts.push(a);
  return createContainer(w, host, {
    name: containerName(m, svc),
    image: serviceImage(m, svc),
    ports: svc.ports,
    env: svc.env,
    mounts,
    restart: svc.restart,
    networks: svc.networks,
    command: svc.command,
    project: m.project,
    service: svc.name,
    healthcheck: svc.healthcheck === "disabled" ? null : svc.healthcheck,
    logging: svc.logging,
    configHash: hash,
    dependsOn: Object.keys(svc.dependsOn),
  });
}

type Wait = "healthy" | "unhealthy" | "exited" | "nocheck";

/** Let time pass until the container's healthcheck decides (Compose blocks here too). */
export function waitHealthy(w: World, c: Container): Wait {
  const hc = c.healthcheck;
  if (!hc) return "nocheck";
  const limit = w.clock + hc.startPeriod + hc.interval * (hc.retries + 1) + 2;
  let guard = 0;
  while (c.status === "running" && c.health === "starting" && w.clock < limit && guard++ < 2000) advance(w, w.clock + 1);
  if (c.status !== "running") return "exited";
  return c.health === "healthy" ? "healthy" : "unhealthy";
}

export interface UpOpts {
  detach?: boolean;
  build?: boolean;
  forceRecreate?: boolean;
  removeOrphans?: boolean;
  wait?: boolean;
  services?: string[];
}

export function composeUp(w: World, host: Host, m: ComposeModel, io: IO, o: UpOpts = {}): number {
  for (const s of o.services ?? []) {
    if (!m.services[s]) {
      io.err(`no such service: ${s}`);
      return 1;
    }
  }
  const order = topoOrder(m, o.services);

  // 1. Pull images nobody has yet.
  const toPull = order.filter((n) => !m.services[n].build && !localImage(host, m.services[n].image!));
  if (toPull.length) {
    const lines: string[] = [];
    let failed: string | undefined;
    for (const n of toPull) {
      const r = pullImage(w, host, m.services[n].image!);
      if (!r.ok) {
        lines.push(`${` ✘ ${n} Error ${r.error?.split(":")[0] ?? ""}`.padEnd(74)} 1.2s`);
        failed ??= r.error;
        continue;
      }
      lines.push(`${` ✔ ${n} Pulled`.padEnd(74)} ${(2 + r.layers.length * 0.4).toFixed(1)}s `.trimEnd());
      for (const l of r.layers) lines.push(`${`   ✔ ${l} Pull complete`.padEnd(74)} 0.9s `.trimEnd());
    }
    io.out([`[+] Running ${lines.filter((l) => !l.includes("✘")).length}/${lines.length}`, ...lines].join("\n"));
    if (failed) {
      io.err(`Error response from daemon: ${failed}`);
      return 1;
    }
  }

  // 2. Build images that have a build: section.
  const built: Event[] = [];
  for (const n of order) {
    const s = m.services[n];
    if (!s.build) continue;
    const tag = serviceImage(m, s);
    if (!o.build && localImage(host, tag)) continue;
    const r = buildImage(w, host, { contextDir: s.build.context, dockerfile: s.build.dockerfile, tag, buildArgs: s.build.args, target: s.build.target, service: n });
    io.out(r.lines.join("\n"));
    if (!r.ok) {
      io.err(r.error ?? "failed to solve");
      return 1;
    }
    built.push(ev("Service", n, "Built", true, r.seconds));
  }

  const events: Event[] = [...built];
  const fail = (msg: string): number => {
    io.out(block("Running", events));
    io.err(msg);
    return 1;
  };
  // Compose shows one line per container: its latest state replaces the earlier one.
  const mark = (name: string, status: string, ok: boolean, secs: number) => {
    const e = events.find((x) => x.kind === "Container" && x.name === name);
    if (e) Object.assign(e, { status, ok, secs: e.secs + secs });
    else events.push(ev("Container", name, status, ok, secs));
  };

  // 3. Networks and volumes.
  const nets = new Set(order.flatMap((n) => m.services[n].networks));
  for (const [, net] of Object.entries(m.networks)) {
    if (!nets.has(net.name)) continue;
    if (net.external) {
      if (!host.docker.networks[net.name]) return fail(`network ${net.name} declared as external, but could not be found`);
      continue;
    }
    if (ensureNetwork(host, net.name, m.project)) events.push(ev("Network", net.name, "Created"));
  }
  const vols = new Set(order.flatMap((n) => m.services[n].mounts.filter((x) => x.type === "volume").map((x) => x.source)));
  for (const [, v] of Object.entries(m.volumes)) {
    if (!vols.has(v.name)) continue;
    if (v.external) {
      if (!host.docker.volumes[v.name]) return fail(`external volume "${v.name}" not found`);
      continue;
    }
    if (ensureVolume(w, host, v.name, m.project)) events.push(ev("Volume", v.name, "Created", true, 0));
  }

  // 4. Containers, dependencies first.
  const waited = new Set<string>();
  for (const n of order) {
    const svc = m.services[n];
    for (const [dep, cond] of Object.entries(svc.dependsOn)) {
      const dc = containerOf(host, m, dep);
      if (!dc) continue;
      const dn = dc.name;
      if (cond === "service_healthy" && !waited.has(dep)) {
        waited.add(dep);
        const r = waitHealthy(w, dc);
        if (r === "nocheck") return fail(`dependency failed to start: container ${dn} has no healthcheck configured`);
        if (r === "exited") {
          mark(dn, "Error", false, 2.1);
          return fail(`dependency failed to start: container ${dn} exited (${dc.exitCode ?? 1})`);
        }
        if (r === "unhealthy") {
          mark(dn, "Error", false, 30.4);
          return fail(`dependency failed to start: container ${dn} is unhealthy`);
        }
        mark(dn, "Healthy", true, 5.2);
      }
      if (cond === "service_completed_successfully" && !waited.has(dep)) {
        waited.add(dep);
        if (dc.status !== "exited" || dc.exitCode !== 0) {
          return fail(`service "${dep}" didn't complete successfully: exit ${dc.exitCode ?? 1}`);
        }
      }
    }
    const img = localImage(host, serviceImage(m, svc));
    const hash = serviceHash(svc, img?.id);
    const name = containerName(m, svc);
    let c = host.docker.containers[name];
    let status: string;
    if (c && c.project !== m.project) {
      return fail(`Error response from daemon: Conflict. The container name "/${name}" is already in use by container "${c.id}". You have to remove (or rename) that container to be able to reuse that name.`);
    }
    if (c && (c.configHash !== hash || o.forceRecreate)) {
      const carry = c.mounts.filter((x) => x.type === "volume" && isAnonymous(x.source));
      stopContainer(w, host, c, false);
      removeContainer(host, c);
      c = createFor(w, host, m, svc, hash, carry);
      status = "Recreated";
    } else if (c && (c.status === "running" || c.status === "restarting")) {
      events.push(ev("Container", name, "Running", true, 0));
      continue;
    } else if (c) {
      status = "Started";
    } else {
      c = createFor(w, host, m, svc, hash);
      status = "Started";
    }
    const r = startContainer(w, host, c);
    if (!r.ok) {
      events.push(ev("Container", name, "Starting", false, 0.4));
      return fail(`Error response from daemon: ${r.error}`);
    }
    events.push(ev("Container", name, status, true, 0.4));
  }

  // 5. Leftovers from services that were removed from the file.
  const orphans = projectContainers(host, m).filter((c) => !c.service || !m.services[c.service]);
  if (orphans.length) {
    if (o.removeOrphans) {
      for (const c of orphans) {
        stopContainer(w, host, c, false);
        removeContainer(host, c);
        events.unshift(ev("Container", c.name, "Removed"));
      }
    } else {
      io.err(
        `WARN[0000] Found orphan containers ([${orphans.map((c) => c.name).join(" ")}]) for this project. If you removed or renamed this service in your compose file, you can run this command with the --remove-orphans flag to clean it up.`,
      );
    }
  }

  // 6. --wait: block until everything with a healthcheck is healthy.
  if (o.wait) {
    for (const n of order) {
      const c = containerOf(host, m, n);
      if (!c?.healthcheck || waited.has(n)) continue;
      const r = waitHealthy(w, c);
      if (r !== "healthy") {
        mark(c.name, "Error", false, 30.1);
        return fail(`container ${c.name} is ${r === "exited" ? "exited" : "unhealthy"}`);
      }
      mark(c.name, "Healthy", true, 5.2);
    }
  }

  host.docker.projects ??= {};
  host.docker.projects[m.project] = { name: m.project, dir: m.dir, file: m.file, services: [...m.order] };
  io.out(block("Running", events));

  if (!o.detach) {
    // Attached: logs stream until Ctrl+C, which stops everything.
    const cs = order.map((n) => containerOf(host, m, n)).filter((c): c is Container => !!c);
    io.out(`Attaching to ${cs.map((c) => shortName(c)).join(", ")}`);
    const logs = composeLogs(host, m, order);
    if (logs) io.out(logs);
    io.out("Gracefully stopping... (press Ctrl+C again to force)");
    const stopped: Event[] = [];
    for (const c of [...cs].reverse()) {
      if (c.status !== "running" && c.status !== "restarting") continue;
      stopContainer(w, host, c);
      stopped.push(ev("Container", c.name, "Stopped", true, 0.3));
    }
    io.out(block("Stopping", stopped));
    io.info("Without -d, Compose holds your terminal and Ctrl+C stops everything. Add -d to keep it running in the background.");
  }
  return 0;
}

export function shortName(c: Container): string {
  return c.service ? `${c.service}-${c.name.split("-").pop()}` : c.name;
}

export function composeDown(w: World, host: Host, m: ComposeModel, io: IO, o: { volumes?: boolean; removeOrphans?: boolean } = {}): number {
  const rank = topoOrder(m);
  const cs = projectContainers(host, m)
    .filter((c) => o.removeOrphans || (c.service && m.services[c.service]))
    .sort((a, b) => rank.indexOf(b.service ?? "") - rank.indexOf(a.service ?? ""));
  const events: Event[] = [];
  for (const c of cs) {
    stopContainer(w, host, c, false);
    removeContainer(host, c, { volumes: o.volumes });
    events.push(ev("Container", c.name, "Removed", true, 0.3));
  }
  if (o.volumes) {
    for (const v of Object.values(m.volumes)) {
      if (v.external || !host.docker.volumes[v.name] || volumeUsers(host, v.name).length) continue;
      delete host.docker.volumes[v.name];
      events.push(ev("Volume", v.name, "Removed", true, 0));
    }
  }
  for (const net of Object.values(m.networks)) {
    if (net.external || !host.docker.networks[net.name] || networkInUse(host, net.name)) continue;
    delete host.docker.networks[net.name];
    events.push(ev("Network", net.name, "Removed", true, 0.2));
  }
  if (host.docker.projects) delete host.docker.projects[m.project];
  if (events.length) io.out(block("Running", events));
  return 0;
}

function pick(host: Host, m: ComposeModel, services: string[] | undefined): Container[] {
  for (const s of services ?? []) if (!m.services[s]) return [];
  const names = services?.length ? services : topoOrder(m);
  return names.map((n) => containerOf(host, m, n)).filter((c): c is Container => !!c);
}

/** restart: stop and start the SAME containers. It does not read .env or compose.yaml again. */
export function composeRestart(w: World, host: Host, m: ComposeModel, io: IO, services?: string[]): number {
  const events: Event[] = [];
  for (const c of pick(host, m, services)) {
    stopContainer(w, host, c, false);
    const r = startContainer(w, host, c);
    if (!r.ok) {
      events.push(ev("Container", c.name, "Error", false));
      io.out(block("Restarting", events));
      io.err(`Error response from daemon: ${r.error}`);
      return 1;
    }
    events.push(ev("Container", c.name, "Started", true, 0.5));
  }
  io.out(block("Restarting", events));
  return 0;
}

export function composeStop(w: World, host: Host, m: ComposeModel, io: IO, services?: string[]): number {
  const events: Event[] = [];
  for (const c of pick(host, m, services).reverse()) {
    stopContainer(w, host, c);
    events.push(ev("Container", c.name, "Stopped", true, 0.3));
  }
  io.out(block("Stopping", events));
  return 0;
}

export function composeStart(w: World, host: Host, m: ComposeModel, io: IO, services?: string[]): number {
  const events: Event[] = [];
  for (const c of pick(host, m, services)) {
    if (c.status === "running") {
      events.push(ev("Container", c.name, "Running", true, 0));
      continue;
    }
    const r = startContainer(w, host, c);
    if (!r.ok) {
      events.push(ev("Container", c.name, "Error", false));
      io.out(block("Running", events));
      io.err(`Error response from daemon: ${r.error}`);
      return 1;
    }
    events.push(ev("Container", c.name, "Started", true, 0.4));
  }
  io.out(block("Running", events));
  return 0;
}

export function composePs(w: World, host: Host, m: ComposeModel, all: boolean): string[][] {
  const cs = projectContainers(host, m)
    .filter((c) => all || c.status === "running" || c.status === "restarting")
    .sort((a, b) => a.name.localeCompare(b.name));
  const rows = [["NAME", "IMAGE", "COMMAND", "SERVICE", "CREATED", "STATUS", "PORTS"]];
  for (const c of cs) {
    rows.push([c.name, c.image, commandText(host, c), c.service ?? "", `${humanDuration(w.clock - c.createdAt)} ago`, statusText(w, c), portsText(host, c)]);
  }
  return rows;
}

/** Logs of the project's containers, each line prefixed "db-1  | ". */
export function composeLogs(host: Host, m: ComposeModel, services?: string[], tail?: number): string {
  const cs = pick(host, m, services?.length ? services : undefined);
  const width = Math.max(0, ...cs.map((c) => shortName(c).length));
  const out: string[] = [];
  for (const c of cs) {
    const lines = tail !== undefined ? (tail === 0 ? [] : c.logs.slice(-tail)) : c.logs;
    for (const l of lines) out.push(`${shortName(c).padEnd(width)}  | ${l}`);
  }
  return out.join("\n");
}

export function composePull(w: World, host: Host, m: ComposeModel, io: IO, services?: string[]): number {
  const names = (services?.length ? services : m.order).filter((n) => m.services[n]?.image);
  const lines: string[] = [];
  let failed: string | undefined;
  let ok = 0;
  for (const n of names) {
    const r = pullImage(w, host, m.services[n].image!);
    if (!r.ok) {
      if (m.services[n].build) continue;
      lines.push(`${` ✘ ${n} Error`.padEnd(74)} 1.1s`);
      failed ??= r.error;
      continue;
    }
    ok++;
    lines.push(`${` ✔ ${n} Pulled`.padEnd(74)} ${(1 + r.layers.length * 0.4).toFixed(1)}s`);
    for (const l of r.layers) lines.push(`${`   ✔ ${l} Pull complete`.padEnd(74)} 0.9s`);
  }
  if (lines.length) io.out([`[+] Pulling ${ok}/${lines.filter((l) => !l.startsWith("   ")).length}`, ...lines].join("\n"));
  if (failed) {
    io.err(`Error response from daemon: ${failed}`);
    return 1;
  }
  return 0;
}

export function composeBuild(w: World, host: Host, m: ComposeModel, io: IO, opts: { services?: string[]; noCache?: boolean } = {}): number {
  const names = (opts.services?.length ? opts.services : m.order).filter((n) => m.services[n]?.build);
  for (const n of names) {
    const s = m.services[n];
    const r = buildImage(w, host, {
      contextDir: s.build!.context,
      dockerfile: s.build!.dockerfile,
      tag: serviceImage(m, s),
      buildArgs: s.build!.args,
      target: s.build!.target,
      service: n,
      noCache: opts.noCache,
    });
    io.out(r.lines.join("\n"));
    if (!r.ok) {
      io.err(r.error ?? "failed to solve");
      return 1;
    }
  }
  return 0;
}

/** docker compose config: the file after interpolation, env_file merged in, long syntax. */
export function composeConfig(m: ComposeModel): string {
  const shortVol = (full: string) => Object.entries(m.volumes).find(([, v]) => v.name === full)?.[0] ?? full;
  const shortNet = (full: string) => Object.entries(m.networks).find(([, v]) => v.name === full)?.[0] ?? full;
  const services: Record<string, unknown> = {};
  for (const n of [...m.order].sort()) {
    const s = m.services[n];
    const out: Record<string, unknown> = {};
    if (s.build) out.build = { context: s.build.context, dockerfile: s.build.dockerfile, ...(Object.keys(s.build.args).length ? { args: s.build.args } : {}) };
    if (s.command) out.command = s.command;
    if (s.containerName) out.container_name = s.containerName;
    const deps = Object.entries(s.dependsOn);
    if (deps.length) out.depends_on = Object.fromEntries(deps.map(([d, c]) => [d, { condition: c, required: true }]));
    if (Object.keys(s.env).length) out.environment = Object.fromEntries(Object.entries(s.env).sort(([a], [b]) => a.localeCompare(b)));
    if (s.healthcheck && s.healthcheck !== "disabled") {
      out.healthcheck = { test: s.healthcheck.test, timeout: `${s.healthcheck.timeout}s`, interval: `${s.healthcheck.interval}s`, retries: s.healthcheck.retries };
    }
    if (s.image) out.image = s.image;
    if (s.logging) out.logging = s.logging;
    out.networks = Object.fromEntries(s.networks.map((x) => [shortNet(x), null]));
    if (s.ports.length) {
      out.ports = s.ports.map((p) => ({
        mode: "ingress",
        ...(p.hostIp !== "0.0.0.0" ? { host_ip: p.hostIp } : {}),
        target: p.containerPort,
        published: String(p.hostPort),
        protocol: "tcp",
      }));
    }
    if (s.restart !== "no") out.restart = s.restart;
    if (s.mounts.length) {
      out.volumes = s.mounts.map((v) =>
        v.type === "bind"
          ? { type: "bind", source: v.source, target: v.target, bind: { create_host_path: true } }
          : { type: "volume", source: isAnonymous(v.source) ? undefined : shortVol(v.source), target: v.target, volume: {} },
      );
    }
    services[n] = out;
  }
  const doc: Record<string, unknown> = { name: m.project, services };
  const usedNets = new Set(Object.values(m.services).flatMap((s) => s.networks));
  doc.networks = Object.fromEntries(Object.entries(m.networks).filter(([, v]) => usedNets.has(v.name)).map(([k, v]) => [k, { name: v.name, ...(v.external ? { external: true } : {}) }]));
  if (Object.keys(m.volumes).length) doc.volumes = Object.fromEntries(Object.entries(m.volumes).map(([k, v]) => [k, { name: v.name, ...(v.external ? { external: true } : {}) }]));
  return stringify(doc, { lineWidth: 0 }).trimEnd();
}
