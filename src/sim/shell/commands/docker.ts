import { buildImage } from "../../docker/dockerfile";
import { loadCompose, containerName } from "../../docker/compose";
import { execIn, metaOf } from "../../docker/behaviour";
import { commandOf, commandText, fullId, humanDuration, portsText, shortId, statusText, table } from "../../docker/format";
import { digestOf, fullRef, localImage, normalizeRef, pullImage, repoOf, sizeText, tagOf } from "../../docker/images";
import { INSTALL_SCRIPT_COMMIT, INSTALL_SCRIPT_FOOTER, scriptInstall } from "../../docker/install";
import { DEFAULT_NETWORKS, ensureDefaultNetworks, ensureNetwork, gatewayOf, ipOf, networkInUse, subnetPrefix } from "../../docker/network";
import {
  composeBuild,
  composeConfig,
  composeDown,
  composeLogs,
  composePs,
  composePull,
  composeRestart,
  composeStart,
  composeStop,
  composeUp,
  projectContainers,
  type IO,
} from "../../docker/reconcile";
import {
  API_VERSION,
  COMPOSE_VERSION,
  DOCKER_VERSION,
  createContainer,
  dockerActive,
  dockerInstalled,
  findContainer,
  imageInUse,
  isAnonymous,
  removeContainer,
  startContainer,
  stopContainer,
  volumeUsers,
  type Mount,
} from "../../docker/runtime";
import { can, getDir, getFile, isSudoer, put, dir as mkDir, userGroups } from "../../fs";
import { isoTime } from "../../time";
import type { Container, HealthCheck, PortMap } from "../../types";
import { hashHex } from "../../util";
import { parseDuration, parseDotenv } from "../../docker/compose";
import type { Command, Ctx } from "../ctx";

// ---------- talking to the daemon ----------

const SOCK = "unix:///var/run/docker.sock";
const SOCK_URL = "http://%2Fvar%2Frun%2Fdocker.sock";

function isCe(ctx: Ctx): boolean {
  return !!ctx.host.packages["docker-ce"] || (!ctx.host.packages["docker.io"] && !!ctx.host.packages["docker-ce-cli"]);
}

function clientVersion(ctx: Ctx): string {
  return isCe(ctx) ? DOCKER_VERSION : "24.0.7";
}

function hasCompose(ctx: Ctx): boolean {
  return !!(ctx.host.packages["docker-compose-plugin"] || ctx.host.packages["docker-compose-v2"]);
}

function composeVersion(ctx: Ctx): string {
  return ctx.host.packages["docker-compose-plugin"] ? `v${COMPOSE_VERSION}` : "2.24.6+ds1-0ubuntu2~24.04.1";
}

function hasBuildx(ctx: Ctx): boolean {
  return !!(ctx.host.packages["docker-buildx-plugin"] || ctx.host.packages["docker-buildx"]);
}

/** Can this user open /var/run/docker.sock? Group changes only count from the next login. */
export function canUseDaemon(ctx: Ctx): boolean {
  if (ctx.user === "root") return true;
  const groups = ctx.user === ctx.realUser && ctx.frame.loginGroups ? ctx.frame.loginGroups : userGroups(ctx.host, ctx.user);
  return groups.includes("docker");
}

/**
 * Check the daemon is up and reachable. Prints the real error and returns false if not.
 * `prefix` is "docker: " for docker run, whose errors look different.
 */
function daemon(ctx: Ctx, method: string, path: string, opts: { prefix?: string; see?: string } = {}): boolean {
  const p = opts.prefix ?? "";
  const see = opts.see ? `\nSee 'docker ${opts.see} --help'.` : "";
  if (!dockerInstalled(ctx.host) || !dockerActive(ctx.host)) {
    ctx.err(`${p}Cannot connect to the Docker daemon at ${SOCK}. Is the docker daemon running?${opts.prefix ? "." : ""}${see}`);
    return false;
  }
  if (!canUseDaemon(ctx)) {
    ctx.err(
      `${p}permission denied while trying to connect to the Docker daemon socket at ${SOCK}: ${method} "${SOCK_URL}${path}": dial unix /var/run/docker.sock: connect: permission denied${opts.prefix ? "." : ""}${see}`,
    );
    return false;
  }
  return true;
}

function io(ctx: Ctx): IO {
  return { out: (s) => s && ctx.out(s), err: (s) => s && ctx.err(s), info: (s) => ctx.info(s) };
}

// ---------- option parsing ----------

interface Parsed {
  vals: Record<string, string[]>;
  bools: Set<string>;
  rest: string[];
  error?: string;
}

/**
 * Parse docker-style flags. `valued` flags take a value (-p 80:80, --name=web).
 * With stopAtPositional, everything after the first plain word is left alone (docker run IMAGE CMD...).
 */
function parseFlags(args: string[], valued: string[], bools: string[], stopAtPositional = false): Parsed {
  const out: Parsed = { vals: {}, bools: new Set(), rest: [] };
  const add = (k: string, v: string) => (out.vals[k] ??= []).push(v);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      out.rest.push(...args.slice(i + 1));
      break;
    }
    if (!a.startsWith("-") || a === "-") {
      if (stopAtPositional) {
        out.rest.push(...args.slice(i));
        break;
      }
      out.rest.push(a);
      continue;
    }
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (valued.includes(k)) {
        const val = v ?? args[++i];
        if (val === undefined) return { ...out, error: `flag needs an argument: --${k}` };
        add(k, val);
      } else if (bools.includes(k)) out.bools.add(k);
      else return { ...out, error: `unknown flag: --${k}` };
      continue;
    }
    // Short flags, maybe bundled (-it, -dp 80:80, -p80:80).
    const chars = a.slice(1);
    for (let j = 0; j < chars.length; j++) {
      const ch = chars[j];
      if (valued.includes(ch)) {
        const rest = chars.slice(j + 1).replace(/^=/, "");
        const val = rest || args[++i];
        if (val === undefined) return { ...out, error: `flag needs an argument: '${ch}' in -${ch}` };
        add(ch, val);
        break;
      }
      if (bools.includes(ch)) out.bools.add(ch);
      else return { ...out, error: `unknown shorthand flag: '${ch}' in -${chars}` };
    }
  }
  return out;
}

function last(p: Parsed, ...keys: string[]): string | undefined {
  for (const k of keys) if (p.vals[k]?.length) return p.vals[k][p.vals[k].length - 1];
  return undefined;
}

function all(p: Parsed, ...keys: string[]): string[] {
  return keys.flatMap((k) => p.vals[k] ?? []);
}

function has(p: Parsed, ...keys: string[]): boolean {
  return keys.some((k) => p.bools.has(k));
}

function usageError(ctx: Ctx, sub: string, error: string): number {
  ctx.err(`${error}\nSee 'docker ${sub} --help'.`);
  return 125;
}

function noSuch(ctx: Ctx, ref: string): void {
  ctx.err(`Error response from daemon: No such container: ${ref}`);
}

// ---------- shared pieces ----------

function parsePort(spec: string, i: number): PortMap | undefined {
  const parts = spec.replace(/\/(tcp|udp)$/, "").split(":");
  if (parts.some((x, k) => (k === parts.length - 1 || k === parts.length - 2) && x !== "" && !/^\d+$/.test(x))) return undefined;
  if (parts.length === 1) return { hostIp: "0.0.0.0", hostPort: 32768 + i, containerPort: Number(parts[0]) };
  if (parts.length === 2) return { hostIp: "0.0.0.0", hostPort: Number(parts[0]) || 32768 + i, containerPort: Number(parts[1]) };
  return { hostIp: parts[0] || "0.0.0.0", hostPort: Number(parts[1]) || 32768 + i, containerPort: Number(parts[2]) };
}

const VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;

function parseVolume(ctx: Ctx, spec: string): Mount | string {
  const parts = spec.split(":");
  if (parts.length === 1) return { source: hashHex(`anon|${spec}|${ctx.w.clock}`, 64), target: spec, type: "volume" };
  const [src, target] = parts;
  if (/^[./~]/.test(src)) {
    const abs = ctx.path(src);
    // Docker creates a missing bind source as an empty folder owned by root.
    if (!getDir(ctx.host, abs) && !getFile(ctx.host, abs)) put(ctx.host, abs, mkDir());
    return { source: abs, target, type: "bind" };
  }
  if (!VOLUME_NAME.test(src)) {
    return `create ${src}: "${src}" includes invalid characters for a local volume name, only "[a-zA-Z0-9][a-zA-Z0-9_.-]" are allowed. If you intended to pass a host directory, use absolute path`;
  }
  return { source: src, target, type: "volume" };
}

const RESTARTS = ["no", "always", "unless-stopped", "on-failure"];

/** Pull for docker run / create. Prints like Docker 27. Returns false on failure. */
function ensureImage(ctx: Ctx, ref: string, prefix: string, see: string): boolean {
  if (localImage(ctx.host, ref)) return true;
  ctx.out(`Unable to find image '${normalizeRef(ref)}' locally`);
  const r = pullImage(ctx.w, ctx.host, ref);
  if (!r.ok) {
    ctx.err(`${prefix}Error response from daemon: ${r.error}.\nSee 'docker ${see} --help'.`);
    return false;
  }
  ctx.out(r.lines.join("\n"));
  return true;
}

// ---------- docker run ----------

const RUN_VALUED = ["p", "publish", "name", "e", "env", "env-file", "v", "volume", "restart", "network", "net", "w", "workdir", "u", "user", "health-cmd", "health-interval", "health-retries", "health-timeout", "health-start-period", "hostname", "h", "entrypoint", "label", "l", "log-driver", "log-opt", "memory", "m", "cpus", "platform", "pull", "mount"];
const RUN_BOOLS = ["d", "detach", "i", "interactive", "t", "tty", "rm", "no-healthcheck", "privileged", "init", "P", "publish-all", "q", "quiet", "read-only"];

function cmdRun(ctx: Ctx, args: string[]): number {
  if (!daemon(ctx, "Head", "/_ping", { prefix: "docker: ", see: "run" })) return 125;
  const p = parseFlags(args, RUN_VALUED, RUN_BOOLS, true);
  if (p.error) return usageError(ctx, "run", `docker: ${p.error}`);
  const image = p.rest[0];
  if (!image) {
    ctx.err(`docker: 'docker run' requires at least 1 argument\n\nUsage:  docker run [OPTIONS] IMAGE [COMMAND] [ARG...]\n\nSee 'docker run --help' for more information`);
    return 1;
  }
  const command = p.rest.slice(1);
  const name = last(p, "name");
  if (name && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(name)) {
    ctx.err(`docker: Error response from daemon: Invalid container name (${name}), only [a-zA-Z0-9][a-zA-Z0-9_.-] are allowed.\nSee 'docker run --help'.`);
    return 125;
  }
  const ports: PortMap[] = [];
  for (const [i, s] of all(p, "p", "publish").entries()) {
    const pm = parsePort(s, i);
    if (!pm) {
      ctx.err(`docker: invalid containerPort: ${s.split(":").pop()}.\nSee 'docker run --help'.`);
      return 125;
    }
    ports.push(pm);
  }
  const env: Record<string, string> = {};
  for (const f of all(p, "env-file")) {
    const node = getFile(ctx.host, ctx.path(f));
    if (!node || !can(ctx.host, ctx.user, node, "r")) {
      ctx.err(`docker: open ${f}: ${node ? "permission denied" : "no such file or directory"}.\nSee 'docker run --help'.`);
      return 125;
    }
    Object.assign(env, parseDotenv(node.content));
  }
  for (const e of all(p, "e", "env")) {
    const i = e.indexOf("=");
    if (i < 0) {
      if (e in ctx.env) env[e] = ctx.env[e];
    } else env[e.slice(0, i)] = e.slice(i + 1);
  }
  const mounts: Mount[] = [];
  for (const v of all(p, "v", "volume")) {
    const m = parseVolume(ctx, v);
    if (typeof m === "string") {
      ctx.err(`docker: Error response from daemon: ${m}.\nSee 'docker run --help'.`);
      return 125;
    }
    mounts.push(m);
  }
  const restartRaw = last(p, "restart") ?? "no";
  const restart = restartRaw.replace(/:\d+$/, "");
  if (!RESTARTS.includes(restart)) {
    ctx.err(`docker: Error response from daemon: invalid restart policy: unknown policy '${restartRaw}'; use one of 'no', 'always', 'on-failure', or 'unless-stopped'.\nSee 'docker run --help'.`);
    return 125;
  }
  const autoRemove = has(p, "rm");
  if (autoRemove && restart !== "no") {
    ctx.err(`docker: Conflicting options: --restart and --rm.\nSee 'docker run --help'.`);
    return 125;
  }
  ensureDefaultNetworks(ctx.host);
  const network = last(p, "network", "net") ?? "bridge";
  if (!ctx.host.docker.networks[network]) {
    ctx.err(`docker: Error response from daemon: network ${network} not found.\nSee 'docker run --help'.`);
    return 125;
  }
  let healthcheck: HealthCheck | null | undefined;
  if (has(p, "no-healthcheck")) healthcheck = null;
  const hcmd = last(p, "health-cmd");
  if (hcmd) {
    healthcheck = {
      test: ["CMD-SHELL", hcmd],
      interval: parseDuration(last(p, "health-interval"), 30),
      timeout: parseDuration(last(p, "health-timeout"), 30),
      retries: Number(last(p, "health-retries") ?? 3),
      startPeriod: parseDuration(last(p, "health-start-period"), 0),
    };
  }
  if (name) {
    const clash = findContainer(ctx.host, name);
    if (clash && clash.name === name) {
      ctx.err(
        `docker: Error response from daemon: Conflict. The container name "/${name}" is already in use by container "${fullId(clash.id)}". You have to remove (or rename) that container to be able to reuse that name.\nSee 'docker run --help'.`,
      );
      return 125;
    }
  }
  if (!ensureImage(ctx, image, "docker: ", "run")) return 125;
  const logOpts: Record<string, string> = {};
  for (const o of all(p, "log-opt")) {
    const [k, v] = o.split("=");
    logOpts[k] = v ?? "";
  }
  const c = createContainer(ctx.w, ctx.host, {
    name,
    image,
    ports,
    env,
    mounts,
    restart: restart as Container["restart"],
    networks: [network],
    command: command.length ? command : undefined,
    healthcheck,
    autoRemove,
    logging: { driver: last(p, "log-driver") ?? "json-file", options: logOpts },
  });
  const interactive = has(p, "i", "interactive") && has(p, "t", "tty");
  const before = c.logs.length;
  const r = startContainer(ctx.w, ctx.host, c);
  if (!r.ok) {
    ctx.err(`docker: Error response from daemon: ${r.error}.`);
    if (r.error?.includes("executable file not found")) return 127;
    return 125;
  }
  const detach = has(p, "d", "detach");
  if (detach) {
    ctx.out(fullId(c.id));
    return 0;
  }
  const printed = c.logs.slice(before);
  if (printed.length) ctx.out(printed.join("\n"));
  const live = ctx.host.docker.containers[c.name];
  if (live && live.status === "running") {
    if (interactive && live.listenPort === 0) {
      ctx.info("An interactive shell inside a container is not in this game. Run one command at a time, like: docker run --rm alpine:3.20 echo hi");
    } else {
      ctx.info("Without -d this keeps running and holds your terminal. Here it stopped when you pressed Ctrl+C. Add -d to run it in the background.");
    }
    stopContainer(ctx.w, ctx.host, live);
    return interactive ? 0 : 130;
  }
  return live?.exitCode ?? (c.exitCode ?? 0);
}

// ---------- ps, logs, start, stop, rm ----------

function psRows(ctx: Ctx, cs: Container[]): string[][] {
  const rows = [["CONTAINER ID", "IMAGE", "COMMAND", "CREATED", "STATUS", "PORTS", "NAMES"]];
  for (const c of cs) {
    rows.push([shortId(c), c.image, commandText(ctx.host, c), `${humanDuration(ctx.w.clock - c.createdAt)} ago`, statusText(ctx.w, c), portsText(ctx.host, c), c.name]);
  }
  return rows;
}

function formatTemplate(tpl: string, fields: Record<string, string>): string {
  return tpl.replace(/\\t/g, "\t").replace(/\{\{\s*\.(\w+)\s*\}\}/g, (_, k) => fields[k] ?? "");
}

function cmdPs(ctx: Ctx, args: string[]): number {
  if (!daemon(ctx, "Get", `/v${API_VERSION}/containers/json`)) return 1;
  const p = parseFlags(args, ["filter", "f", "format", "n", "last"], ["a", "all", "q", "quiet", "s", "size", "no-trunc", "l", "latest"]);
  if (p.error) return usageError(ctx, "ps", p.error);
  let cs = Object.values(ctx.host.docker.containers).sort((a, b) => b.createdAt - a.createdAt || b.name.localeCompare(a.name));
  if (!has(p, "a", "all")) cs = cs.filter((c) => c.status === "running" || c.status === "restarting");
  for (const f of all(p, "filter", "f")) {
    const [k, v] = f.split("=");
    if (k === "name") cs = cs.filter((c) => c.name.includes(v));
    else if (k === "status") cs = cs.filter((c) => c.status === v);
    else if (k === "label" && v?.startsWith("com.docker.compose.project=")) cs = cs.filter((c) => c.project === v.split("=")[1]);
  }
  if (has(p, "l", "latest")) cs = cs.slice(0, 1);
  if (has(p, "q", "quiet")) {
    if (cs.length) ctx.out(cs.map((c) => shortId(c)).join("\n"));
    return 0;
  }
  const fmt = last(p, "format");
  if (fmt) {
    const tableMode = fmt.startsWith("table");
    const tpl = fmt.replace(/^table\s*/, "");
    const lines = cs.map((c) =>
      formatTemplate(tpl, {
        ID: shortId(c),
        Names: c.name,
        Image: c.image,
        Status: statusText(ctx.w, c),
        State: c.status,
        Ports: portsText(ctx.host, c),
        Command: commandText(ctx.host, c),
        CreatedAt: isoTime(c.createdAt),
        RunningFor: `${humanDuration(ctx.w.clock - c.createdAt)} ago`,
      }),
    );
    if (tableMode) {
      const head = formatTemplate(tpl, { ID: "CONTAINER ID", Names: "NAMES", Image: "IMAGE", Status: "STATUS", State: "STATE", Ports: "PORTS", Command: "COMMAND", CreatedAt: "CREATED AT", RunningFor: "CREATED" });
      ctx.out(table([head, ...lines].map((l) => l.split("\t"))));
    } else if (lines.length) ctx.out(lines.join("\n"));
    return 0;
  }
  ctx.out(table(psRows(ctx, cs)));
  return 0;
}

function cmdLogs(ctx: Ctx, args: string[]): number {
  const p = parseFlags(args, ["tail", "n", "since", "until"], ["f", "follow", "t", "timestamps", "details"]);
  if (p.error) return usageError(ctx, "logs", p.error);
  const ref = p.rest[0];
  if (!ref) {
    ctx.err(`"docker logs" requires exactly 1 argument.\nSee 'docker logs --help'.\n\nUsage:  docker logs [OPTIONS] CONTAINER\n\nFetch the logs of a container`);
    return 1;
  }
  if (!daemon(ctx, "Get", `/v${API_VERSION}/containers/${ref}/json`)) return 1;
  const c = findContainer(ctx.host, ref);
  if (!c) {
    noSuch(ctx, ref);
    return 1;
  }
  const tailRaw = last(p, "tail", "n");
  const tail = tailRaw === undefined || tailRaw === "all" ? undefined : Number(tailRaw);
  const lines = tail === undefined ? c.logs : tail === 0 ? [] : c.logs.slice(-tail);
  if (lines.length) ctx.out(lines.join("\n"));
  return 0;
}

function eachContainer(ctx: Ctx, refs: string[], fn: (c: Container, ref: string) => boolean): number {
  let code = 0;
  for (const ref of refs) {
    const c = findContainer(ctx.host, ref);
    if (!c) {
      noSuch(ctx, ref);
      code = 1;
      continue;
    }
    if (fn(c, ref)) ctx.out(ref);
    else code = 1;
  }
  return code;
}

function needOne(ctx: Ctx, sub: string, refs: string[], usage: string): boolean {
  if (refs.length) return true;
  ctx.err(`"docker ${sub}" requires at least 1 argument.\nSee 'docker ${sub} --help'.\n\nUsage:  docker ${sub} ${usage}`);
  return false;
}

function cmdStop(ctx: Ctx, args: string[], kill = false): number {
  const sub = kill ? "kill" : "stop";
  const p = parseFlags(args, ["t", "time", "timeout", "s", "signal"], []);
  if (p.error) return usageError(ctx, sub, p.error);
  if (!needOne(ctx, sub, p.rest, "[OPTIONS] CONTAINER [CONTAINER...]")) return 1;
  if (!daemon(ctx, "Post", `/v${API_VERSION}/containers/${p.rest[0]}/${sub}`)) return 1;
  return eachContainer(ctx, p.rest, (c, ref) => {
    if (kill && c.status !== "running" && c.status !== "restarting") {
      ctx.err(`Error response from daemon: cannot kill container: ${ref}: container ${fullId(c.id)} is not running`);
      return false;
    }
    stopContainer(ctx.w, ctx.host, c);
    if (kill && ctx.host.docker.containers[c.name]) c.exitCode = 137;
    return true;
  });
}

function cmdStart(ctx: Ctx, args: string[]): number {
  const p = parseFlags(args, [], ["a", "attach", "i", "interactive"]);
  if (p.error) return usageError(ctx, "start", p.error);
  if (!needOne(ctx, "start", p.rest, "[OPTIONS] CONTAINER [CONTAINER...]")) return 1;
  if (!daemon(ctx, "Post", `/v${API_VERSION}/containers/${p.rest[0]}/start`)) return 1;
  const failed: string[] = [];
  const code = eachContainer(ctx, p.rest, (c, ref) => {
    if (c.status === "restarting") c.status = "exited";
    const r = startContainer(ctx.w, ctx.host, c);
    if (!r.ok) {
      ctx.err(`Error response from daemon: ${r.error}`);
      failed.push(ref);
      return false;
    }
    return true;
  });
  if (failed.length) ctx.err(`Error: failed to start containers: ${failed.join(", ")}`);
  return code;
}

function cmdRestart(ctx: Ctx, args: string[]): number {
  const p = parseFlags(args, ["t", "time", "timeout", "s", "signal"], []);
  if (p.error) return usageError(ctx, "restart", p.error);
  if (!needOne(ctx, "restart", p.rest, "[OPTIONS] CONTAINER [CONTAINER...]")) return 1;
  if (!daemon(ctx, "Post", `/v${API_VERSION}/containers/${p.rest[0]}/restart`)) return 1;
  return eachContainer(ctx, p.rest, (c) => {
    stopContainer(ctx.w, ctx.host, c, false);
    const r = startContainer(ctx.w, ctx.host, c);
    if (!r.ok) ctx.err(`Error response from daemon: ${r.error}`);
    return r.ok;
  });
}

function cmdRm(ctx: Ctx, args: string[]): number {
  const p = parseFlags(args, [], ["f", "force", "v", "volumes", "l", "link"]);
  if (p.error) return usageError(ctx, "rm", p.error);
  if (!needOne(ctx, "rm", p.rest, "[OPTIONS] CONTAINER [CONTAINER...]")) return 1;
  if (!daemon(ctx, "Delete", `/v${API_VERSION}/containers/${p.rest[0]}`)) return 1;
  const force = has(p, "f", "force");
  return eachContainer(ctx, p.rest, (c, ref) => {
    if ((c.status === "running" || c.status === "restarting") && !force) {
      ctx.err(`Error response from daemon: cannot remove container "/${c.name}": container is ${c.status}: stop the container before removing or force remove`);
      void ref;
      return false;
    }
    if (c.status === "running" || c.status === "restarting") {
      c.status = "exited";
      c.exitCode = 137;
    }
    removeContainer(ctx.host, c, { volumes: has(p, "v", "volumes") });
    return true;
  });
}

// ---------- images ----------

function cmdImages(ctx: Ctx, args: string[]): number {
  if (!daemon(ctx, "Get", `/v${API_VERSION}/images/json`)) return 1;
  const p = parseFlags(args, ["filter", "f", "format"], ["a", "all", "q", "quiet", "digests", "no-trunc"]);
  if (p.error) return usageError(ctx, "images", p.error);
  let imgs = Object.values(ctx.host.docker.images).sort((a, b) => b.createdAt - a.createdAt || a.ref.localeCompare(b.ref));
  const want = p.rest[0];
  if (want) imgs = imgs.filter((i) => repoOf(i.ref) === repoOf(want) && (!want.includes(":") || tagOf(i.ref) === tagOf(want)));
  if (has(p, "q", "quiet")) {
    if (imgs.length) ctx.out([...new Set(imgs.map((i) => i.id))].join("\n"));
    return 0;
  }
  const rows = [["REPOSITORY", "TAG", "IMAGE ID", "CREATED", "SIZE"]];
  for (const i of imgs) {
    const none = i.ref.startsWith("<none>");
    rows.push([none ? "<none>" : repoOf(i.ref), none ? "<none>" : tagOf(i.ref), i.id, `${humanDuration(ctx.w.clock - i.createdAt)} ago`, sizeText(i.sizeMb)]);
  }
  ctx.out(table(rows));
  return 0;
}

function cmdPull(ctx: Ctx, args: string[]): number {
  const p = parseFlags(args, ["platform"], ["q", "quiet", "a", "all-tags"]);
  if (p.error) return usageError(ctx, "pull", p.error);
  const ref = p.rest[0];
  if (!ref) {
    ctx.err(`"docker pull" requires exactly 1 argument.\nSee 'docker pull --help'.\n\nUsage:  docker pull [OPTIONS] NAME[:TAG|@DIGEST]\n\nDownload an image from a registry`);
    return 1;
  }
  const n = normalizeRef(ref);
  if (!daemon(ctx, "Post", `/v${API_VERSION}/images/create?fromImage=${encodeURIComponent(repoOf(n))}&tag=${tagOf(n)}`)) return 1;
  const lastPart = ref.slice(ref.lastIndexOf("/") + 1);
  if (!lastPart.includes(":")) ctx.out("Using default tag: latest");
  const r = pullImage(ctx.w, ctx.host, ref);
  if (!r.ok) {
    ctx.err(`Error response from daemon: ${r.error}`);
    return 1;
  }
  ctx.out([...(has(p, "q", "quiet") ? [] : r.lines), fullRef(n)].join("\n"));
  return 0;
}

function cmdRmi(ctx: Ctx, args: string[]): number {
  const p = parseFlags(args, [], ["f", "force", "no-prune"]);
  if (p.error) return usageError(ctx, "rmi", p.error);
  if (!needOne(ctx, "rmi", p.rest, "[OPTIONS] IMAGE [IMAGE...]")) return 1;
  if (!daemon(ctx, "Delete", `/v${API_VERSION}/images/${p.rest[0]}`)) return 1;
  let code = 0;
  for (const ref of p.rest) {
    const img = localImage(ctx.host, ref);
    if (!img) {
      ctx.err(`Error response from daemon: No such image: ${normalizeRef(ref)}`);
      code = 1;
      continue;
    }
    const user = imageInUse(ctx.host, img.ref);
    if (user && !has(p, "f", "force")) {
      ctx.err(`Error response from daemon: conflict: unable to remove repository reference "${ref}" (must force) - container ${shortId(user)} is using its referenced image ${img.id}`);
      code = 1;
      continue;
    }
    delete ctx.host.docker.images[img.ref];
    ctx.out(`Untagged: ${img.ref}\nUntagged: ${repoOf(img.ref)}@${digestOf(img.ref)}\nDeleted: sha256:${img.id}${hashHex("img" + img.id, 52)}`);
  }
  return code;
}

function cmdBuild(ctx: Ctx, args: string[]): number {
  const p = parseFlags(args, ["t", "tag", "f", "file", "build-arg", "target", "platform", "progress"], ["no-cache", "q", "quiet", "pull", "load", "push"]);
  if (p.error) return usageError(ctx, "buildx build", `ERROR: ${p.error}`);
  const path = p.rest[0];
  if (!path) {
    ctx.err(`ERROR: "docker buildx build" requires exactly 1 argument.\nSee 'docker buildx build --help'.\n\nUsage:  docker buildx build [OPTIONS] PATH | URL | -\n\nStart a build`);
    return 1;
  }
  if (!daemon(ctx, "Get", `/v${API_VERSION}/info`, { prefix: "ERROR: " })) return 1;
  const buildArgs: Record<string, string> = {};
  for (const a of all(p, "build-arg")) {
    const i = a.indexOf("=");
    if (i < 0) {
      if (a in ctx.env) buildArgs[a] = ctx.env[a];
    } else buildArgs[a.slice(0, i)] = a.slice(i + 1);
  }
  const contextDir = ctx.path(path);
  const file = last(p, "f", "file");
  const r = buildImage(ctx.w, ctx.host, {
    contextDir,
    dockerfile: file ? ctx.path(file) : undefined,
    tag: last(p, "t", "tag") ?? "<none>:<none>",
    buildArgs,
    target: last(p, "target"),
    noCache: has(p, "no-cache"),
    legacy: !hasBuildx(ctx),
  });
  if (r.lines.length) ctx.out(r.lines.join("\n"));
  if (!r.ok) {
    ctx.err(hasBuildx(ctx) ? `ERROR: ${r.error}` : (r.error ?? ""));
    return 1;
  }
  return 0;
}

// ---------- exec ----------

function execInto(ctx: Ctx, c: Container, cmd: string[], workdir?: string): number {
  if (c.status === "restarting") {
    ctx.err(`Error response from daemon: Container ${fullId(c.id)} is restarting, wait until the container is running`);
    return 1;
  }
  if (c.status !== "running") {
    ctx.err(`Error response from daemon: container ${fullId(c.id)} is not running`);
    return 1;
  }
  return execIn({ w: ctx.w, host: ctx.host, c, argv: cmd, workdir, out: (s) => ctx.out(s), err: (s) => ctx.err(s), info: (s) => ctx.info(s) });
}

function cmdExec(ctx: Ctx, args: string[]): number {
  const p = parseFlags(args, ["w", "workdir", "e", "env", "u", "user", "env-file"], ["i", "interactive", "t", "tty", "d", "detach", "privileged"], true);
  if (p.error) return usageError(ctx, "exec", p.error);
  if (p.rest.length < 2) {
    ctx.err(`docker: 'docker exec' requires at least 2 arguments\n\nUsage:  docker exec [OPTIONS] CONTAINER COMMAND [ARG...]\n\nSee 'docker exec --help' for more information`);
    return 1;
  }
  if (!daemon(ctx, "Get", `/v${API_VERSION}/containers/${p.rest[0]}/json`)) return 1;
  const c = findContainer(ctx.host, p.rest[0]);
  if (!c) {
    noSuch(ctx, p.rest[0]);
    return 1;
  }
  return execInto(ctx, c, p.rest.slice(1), last(p, "w", "workdir"));
}

// ---------- inspect ----------

function containerJson(ctx: Ctx, c: Container): Record<string, unknown> {
  const host = ctx.host;
  const cmd = commandOf(host, c);
  const img = localImage(host, c.image);
  const env = { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", ...c.env };
  const ports: Record<string, unknown> = {};
  for (const pm of c.ports) ports[`${pm.containerPort}/tcp`] = [{ HostIp: pm.hostIp, HostPort: String(pm.hostPort) }];
  const networks: Record<string, unknown> = {};
  for (const n of c.networks) {
    networks[n] = {
      Aliases: n === "bridge" ? null : [c.name, ...(c.service ? [c.service] : [])],
      Gateway: gatewayOf(host, n),
      IPAddress: c.status === "running" ? ipOf(host, c, n) : "",
      IPPrefixLen: 16,
      MacAddress: c.status === "running" ? `02:42:ac:${subnetPrefix(host, n).split(".")[1]}:00:0${ipOf(host, c, n).split(".")[3]}` : "",
    };
  }
  const health = c.healthcheck
    ? { Status: c.health ?? "starting", FailingStreak: c.healthFails ?? 0, Log: [] as unknown[] }
    : undefined;
  return {
    Id: fullId(c.id),
    Created: isoTime(c.createdAt),
    Path: cmd[0] ?? "",
    Args: cmd.slice(1),
    State: {
      Status: c.status,
      Running: c.status === "running",
      Paused: false,
      Restarting: c.status === "restarting",
      OOMKilled: false,
      Dead: false,
      Pid: c.status === "running" ? 3000 + c.name.length * 13 : 0,
      ExitCode: c.exitCode ?? 0,
      Error: "",
      StartedAt: c.startedAt !== undefined ? isoTime(c.startedAt) : "0001-01-01T00:00:00Z",
      FinishedAt: c.finishedAt !== undefined ? isoTime(c.finishedAt) : "0001-01-01T00:00:00Z",
      ...(health ? { Health: health } : {}),
    },
    Image: `sha256:${img?.id ?? c.imageId ?? ""}${hashHex("img" + (img?.id ?? c.imageId ?? ""), 52)}`,
    Name: `/${c.name}`,
    RestartCount: c.restartCount ?? 0,
    HostConfig: {
      Binds: c.mounts.filter((m) => m.type === "bind").map((m) => `${m.source}:${m.target}`),
      LogConfig: { Type: c.logging?.driver ?? "json-file", Config: c.logging?.options ?? {} },
      NetworkMode: c.networks[0] ?? "bridge",
      PortBindings: ports,
      RestartPolicy: { Name: c.restart, MaximumRetryCount: 0 },
      AutoRemove: !!c.autoRemove,
    },
    Mounts: c.mounts.map((m) =>
      m.type === "volume"
        ? { Type: "volume", Name: m.source, Source: `/var/lib/docker/volumes/${m.source}/_data`, Destination: m.target, Driver: "local", Mode: "z", RW: true, Propagation: "" }
        : { Type: "bind", Source: m.source, Destination: m.target, Mode: "", RW: true, Propagation: "rprivate" },
    ),
    Config: {
      Hostname: c.id.slice(0, 12),
      Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      Cmd: c.command ?? metaOf(host, c).cmd ?? null,
      Image: c.image,
      WorkingDir: metaOf(host, c).workdir ?? "",
      Entrypoint: metaOf(host, c).entrypoint ?? null,
      Labels: c.project
        ? { "com.docker.compose.project": c.project, "com.docker.compose.service": c.service ?? "", "com.docker.compose.config-hash": c.configHash ?? "", "com.docker.compose.version": COMPOSE_VERSION }
        : {},
      ...(c.healthcheck
        ? { Healthcheck: { Test: c.healthcheck.test, Interval: c.healthcheck.interval * 1e9, Timeout: c.healthcheck.timeout * 1e9, Retries: c.healthcheck.retries } }
        : {}),
    },
    NetworkSettings: {
      Ports: c.status === "running" ? ports : {},
      IPAddress: c.networks.includes("bridge") && c.status === "running" ? ipOf(host, c, "bridge") : "",
      Networks: networks,
    },
  };
}

function volumeJson(ctx: Ctx, name: string): Record<string, unknown> {
  const v = ctx.host.docker.volumes[name];
  return {
    CreatedAt: isoTime(v.createdAt ?? 0).replace(/\.\d+Z$/, "Z"),
    Driver: "local",
    Labels: v.project ? { "com.docker.compose.project": v.project, "com.docker.compose.version": COMPOSE_VERSION, "com.docker.compose.volume": name.replace(`${v.project}_`, "") } : null,
    Mountpoint: `/var/lib/docker/volumes/${name}/_data`,
    Name: name,
    Options: null,
    Scope: "local",
  };
}

function imageJson(ctx: Ctx, ref: string): Record<string, unknown> {
  const i = localImage(ctx.host, ref)!;
  return {
    Id: `sha256:${i.id}${hashHex("img" + i.id, 52)}`,
    RepoTags: [i.ref],
    RepoDigests: i.meta?.built ? [] : [`${repoOf(i.ref)}@${digestOf(i.ref)}`],
    Created: isoTime(i.createdAt),
    Config: {
      Env: Object.entries(i.meta?.env ?? {}).map(([k, v]) => `${k}=${v}`),
      Cmd: i.meta?.cmd ?? null,
      Entrypoint: i.meta?.entrypoint ?? null,
      WorkingDir: i.meta?.workdir ?? "",
      ExposedPorts: Object.fromEntries((i.meta?.exposed ?? []).map((p) => [`${p}/tcp`, {}])),
    },
    Architecture: "amd64",
    Os: "linux",
    Size: Math.round(i.sizeMb * 1e6),
  };
}

function networkJson(ctx: Ctx, name: string): Record<string, unknown> {
  const n = ctx.host.docker.networks[name] ?? { name, driver: name === "host" ? "host" : name === "none" ? "null" : "bridge" };
  const containers: Record<string, unknown> = {};
  for (const c of Object.values(ctx.host.docker.containers)) {
    if (!c.networks.includes(name) || c.status !== "running") continue;
    containers[fullId(c.id)] = { Name: c.name, IPv4Address: `${ipOf(ctx.host, c, name)}/16` };
  }
  return {
    Name: name,
    Id: hashHex("net" + name, 64),
    Scope: "local",
    Driver: n.driver,
    IPAM: n.driver === "bridge" ? { Driver: "default", Config: [{ Subnet: `${subnetPrefix(ctx.host, name)}.0.0/16`, Gateway: gatewayOf(ctx.host, name) }] } : { Driver: "default", Config: [] },
    Containers: containers,
    Labels: n.project ? { "com.docker.compose.network": name.replace(`${n.project}_`, ""), "com.docker.compose.project": n.project } : {},
  };
}

/** {{.State.Status}}, {{json .Config.Env}}, {{.NetworkSettings.Networks}} ... */
function goTemplate(tpl: string, obj: Record<string, unknown>): string {
  const goFmt = (v: unknown): string => {
    if (v === null || v === undefined) return "<no value>";
    if (Array.isArray(v)) return `[${v.map(goFmt).join(" ")}]`;
    if (typeof v === "object") return `map[${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}:${goFmt(x)}`).join(" ")}]`;
    return String(v);
  };
  const get = (path: string): unknown => {
    let cur: unknown = obj;
    for (const part of path.split(".").filter(Boolean)) cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[part] : undefined;
    return cur;
  };
  return tpl.replace(/\{\{\s*(json\s+)?\.([\w.]*)\s*\}\}/g, (_, json, path) => (json ? JSON.stringify(get(path) ?? null) : goFmt(get(path))));
}

function cmdInspect(ctx: Ctx, args: string[], only?: "container" | "image" | "volume" | "network"): number {
  const p = parseFlags(args, ["f", "format", "type"], ["s", "size"]);
  if (p.error) return usageError(ctx, "inspect", p.error);
  if (!p.rest.length) {
    ctx.err(`"docker inspect" requires at least 1 argument.\nSee 'docker inspect --help'.\n\nUsage:  docker inspect [OPTIONS] NAME|ID [NAME|ID...]\n\nReturn low-level information on Docker objects`);
    return 1;
  }
  if (!daemon(ctx, "Get", `/v${API_VERSION}/containers/${p.rest[0]}/json`)) return 1;
  const type = only ?? (last(p, "type") as typeof only);
  const objs: Record<string, unknown>[] = [];
  const missing: string[] = [];
  for (const ref of p.rest) {
    const c = (!type || type === "container") && findContainer(ctx.host, ref);
    if (c) objs.push(containerJson(ctx, c));
    else if ((!type || type === "image") && localImage(ctx.host, ref)) objs.push(imageJson(ctx, ref));
    else if ((!type || type === "volume") && ctx.host.docker.volumes[ref]) objs.push(volumeJson(ctx, ref));
    else if ((!type || type === "network") && (ctx.host.docker.networks[ref] || DEFAULT_NETWORKS.includes(ref))) objs.push(networkJson(ctx, ref));
    else missing.push(ref);
  }
  const fmt = last(p, "f", "format");
  if (fmt) {
    if (objs.length) ctx.out(objs.map((o) => goTemplate(fmt, o)).join("\n"));
  } else ctx.out(JSON.stringify(objs, null, 4));
  for (const m of missing) {
    if (type === "volume") ctx.err(`Error response from daemon: get ${m}: no such volume`);
    else if (type === "network") ctx.err(`Error response from daemon: network ${m} not found`);
    else ctx.err(`Error: No such object: ${m}`);
  }
  return missing.length ? 1 : 0;
}

// ---------- volume, network, system ----------

function cmdVolume(ctx: Ctx, args: string[]): number {
  const sub = args[0];
  const rest = args.slice(1);
  if (!sub || !["ls", "list", "create", "rm", "remove", "inspect", "prune"].includes(sub)) {
    ctx.err(`Usage:  docker volume COMMAND\n\nManage volumes\n\nCommands:\n  create      Create a volume\n  inspect     Display detailed information on one or more volumes\n  ls          List volumes\n  prune       Remove unused local volumes\n  rm          Remove one or more volumes`);
    return sub ? 1 : 0;
  }
  if (!daemon(ctx, "Get", `/v${API_VERSION}/volumes`)) return 1;
  const vols = ctx.host.docker.volumes;
  switch (sub) {
    case "ls":
    case "list": {
      const p = parseFlags(rest, ["filter", "f", "format"], ["q", "quiet"]);
      const names = Object.keys(vols).sort();
      if (has(p, "q", "quiet")) {
        if (names.length) ctx.out(names.join("\n"));
        return 0;
      }
      ctx.out(table([["DRIVER", "VOLUME NAME"], ...names.map((n) => ["local", n])]));
      return 0;
    }
    case "create": {
      const name = rest.find((a) => !a.startsWith("-")) ?? hashHex(`vol|${ctx.w.clock}`, 64);
      if (!vols[name]) vols[name] = { name, sizeMb: 0, createdAt: ctx.w.clock };
      ctx.out(name);
      return 0;
    }
    case "rm":
    case "remove": {
      const p = parseFlags(rest, [], ["f", "force"]);
      if (!needOne(ctx, "volume rm", p.rest, "[OPTIONS] VOLUME [VOLUME...]")) return 1;
      let code = 0;
      for (const n of p.rest) {
        if (!vols[n]) {
          if (!has(p, "f", "force")) {
            ctx.err(`Error response from daemon: get ${n}: no such volume`);
            code = 1;
          }
          continue;
        }
        const users = volumeUsers(ctx.host, n);
        if (users.length) {
          ctx.err(`Error response from daemon: remove ${n}: volume is in use - [${users.map((c) => fullId(c.id)).join(", ")}]`);
          code = 1;
          continue;
        }
        delete vols[n];
        ctx.out(n);
      }
      return code;
    }
    case "inspect":
      return cmdInspect(ctx, rest, "volume");
    case "prune": {
      const p = parseFlags(rest, ["filter"], ["f", "force", "a", "all"]);
      const gone = Object.keys(vols).filter((n) => !volumeUsers(ctx.host, n).length && (has(p, "a", "all") || isAnonymous(n)));
      let mb = 0;
      for (const n of gone) {
        mb += vols[n].sizeMb;
        delete vols[n];
      }
      ctx.out([...(gone.length ? ["Deleted Volumes:", ...gone, ""] : []), `Total reclaimed space: ${sizeText(mb)}`].join("\n"));
      return 0;
    }
  }
  return 0;
}

function cmdNetwork(ctx: Ctx, args: string[]): number {
  const sub = args[0];
  const rest = args.slice(1);
  if (!sub || !["ls", "list", "create", "rm", "remove", "inspect"].includes(sub)) {
    ctx.err(`Usage:  docker network COMMAND\n\nManage networks\n\nCommands:\n  create      Create a network\n  inspect     Display detailed information on one or more networks\n  ls          List networks\n  rm          Remove one or more networks`);
    return sub ? 1 : 0;
  }
  if (!daemon(ctx, "Get", `/v${API_VERSION}/networks`)) return 1;
  const nets = ctx.host.docker.networks;
  switch (sub) {
    case "ls":
    case "list": {
      const names = [...new Set([...DEFAULT_NETWORKS, ...Object.keys(nets)])].sort();
      const rows = [["NETWORK ID", "NAME", "DRIVER", "SCOPE"]];
      for (const n of names) rows.push([hashHex("net" + n, 12), n, nets[n]?.driver ?? (n === "host" ? "host" : n === "none" ? "null" : "bridge"), "local"]);
      ctx.out(table(rows));
      return 0;
    }
    case "create": {
      const name = rest.find((a) => !a.startsWith("-"));
      if (!name) return usageError(ctx, "network create", `"docker network create" requires exactly 1 argument.`);
      if (nets[name]) {
        ctx.err(`Error response from daemon: network with name ${name} already exists`);
        return 1;
      }
      ensureNetwork(ctx.host, name);
      ctx.out(hashHex("net" + name, 64));
      return 0;
    }
    case "rm":
    case "remove": {
      let code = 0;
      for (const n of rest) {
        if (DEFAULT_NETWORKS.includes(n)) {
          ctx.err(`Error response from daemon: ${n} is a pre-defined network and cannot be removed`);
          code = 1;
        } else if (!nets[n]) {
          ctx.err(`Error response from daemon: network ${n} not found`);
          code = 1;
        } else if (networkInUse(ctx.host, n)) {
          ctx.err(`Error response from daemon: error while removing network: network ${n} id ${hashHex("net" + n, 64)} has active endpoints`);
          code = 1;
        } else {
          delete nets[n];
          ctx.out(n);
        }
      }
      return code;
    }
    case "inspect":
      return cmdInspect(ctx, rest, "network");
  }
  return 0;
}

function cmdSystem(ctx: Ctx, args: string[]): number {
  const sub = args[0];
  if (sub === "info") return cmdInfo(ctx);
  if (sub !== "df" && sub !== "prune") {
    ctx.err(`Usage:  docker system COMMAND\n\nManage Docker\n\nCommands:\n  df          Show docker disk usage\n  info        Display system-wide information\n  prune       Remove unused data`);
    return sub ? 1 : 0;
  }
  if (!daemon(ctx, "Get", `/v${API_VERSION}/system/df`)) return 1;
  const d = ctx.host.docker;
  const imgs = Object.values(d.images);
  const cs = Object.values(d.containers);
  const usedImgs = imgs.filter((i) => cs.some((c) => normalizeRef(c.image) === i.ref));
  const vols = Object.values(d.volumes);
  const usedVols = vols.filter((v) => volumeUsers(ctx.host, v.name).length);
  const cache = Object.keys(d.buildCache ?? {}).length;
  if (sub === "df") {
    const sum = (xs: { sizeMb: number }[]) => xs.reduce((s, x) => s + x.sizeMb, 0);
    const pct = (part: number, whole: number) => (whole ? ` (${Math.round((part / whole) * 100)}%)` : "");
    const imgSize = sum(imgs);
    const reclaimImg = imgSize - sum(usedImgs);
    const logMb = cs.reduce((s, c) => s + c.logs.length * 0.0002, 0);
    const volSize = sum(vols);
    const reclaimVol = volSize - sum(usedVols);
    ctx.out(
      table([
        ["TYPE", "TOTAL", "ACTIVE", "SIZE", "RECLAIMABLE"],
        ["Images", String(imgs.length), String(usedImgs.length), sizeText(imgSize), `${sizeText(reclaimImg)}${pct(reclaimImg, imgSize)}`],
        ["Containers", String(cs.length), String(cs.filter((c) => c.status === "running").length), sizeText(logMb), `0B (0%)`],
        ["Local Volumes", String(vols.length), String(usedVols.length), sizeText(volSize), `${sizeText(reclaimVol)}${pct(reclaimVol, volSize)}`],
        ["Build Cache", String(cache), "0", sizeText(cache * 12), sizeText(cache * 12)],
      ]),
    );
    return 0;
  }
  const p = parseFlags(args.slice(1), ["filter"], ["a", "all", "f", "force", "volumes"]);
  if (!has(p, "f", "force")) {
    ctx.out(
      [
        "WARNING! This will remove:",
        "  - all stopped containers",
        "  - all networks not used by at least one container",
        has(p, "volumes") ? "  - all anonymous volumes not used by at least one container" : "",
        has(p, "a", "all") ? "  - all images without at least one container associated to them" : "  - all dangling images",
        "  - unused build cache",
        "",
      ]
        .filter((l, i) => l || i > 4)
        .join("\n"),
    );
    ctx.prompt({ prompt: "Are you sure you want to continue? [y/N] ", secret: false, data: { prune: true, all: has(p, "a", "all"), volumes: has(p, "volumes") } });
    return 0;
  }
  return prune(ctx, has(p, "a", "all"), has(p, "volumes"));
}

function prune(ctx: Ctx, allImages: boolean, volumes: boolean): number {
  const d = ctx.host.docker;
  const out: string[] = [];
  let mb = 0;
  const goneC = Object.values(d.containers).filter((c) => c.status === "exited" || c.status === "created");
  if (goneC.length) out.push("Deleted Containers:", ...goneC.map((c) => fullId(c.id)), "");
  for (const c of goneC) removeContainer(ctx.host, c);
  const goneN = Object.keys(d.networks).filter((n) => !DEFAULT_NETWORKS.includes(n) && !networkInUse(ctx.host, n));
  if (goneN.length) out.push("Deleted Networks:", ...goneN, "");
  for (const n of goneN) delete d.networks[n];
  if (volumes) {
    const goneV = Object.keys(d.volumes).filter((n) => isAnonymous(n) && !volumeUsers(ctx.host, n).length);
    if (goneV.length) out.push("Deleted Volumes:", ...goneV, "");
    for (const n of goneV) {
      mb += d.volumes[n].sizeMb;
      delete d.volumes[n];
    }
  }
  if (allImages) {
    const goneI = Object.values(d.images).filter((i) => !imageInUse(ctx.host, i.ref));
    if (goneI.length) out.push("Deleted Images:", ...goneI.flatMap((i) => [`untagged: ${i.ref}`, `deleted: sha256:${i.id}${hashHex("img" + i.id, 52)}`]), "");
    for (const i of goneI) {
      mb += i.sizeMb;
      delete d.images[i.ref];
    }
  }
  const cache = Object.keys(d.buildCache ?? {}).length;
  if (cache) {
    out.push("Deleted build cache objects:", ...Object.keys(d.buildCache!).slice(0, 5).map((k) => hashHex(k, 25)), "");
    mb += cache * 12;
    d.buildCache = {};
  }
  out.push(`Total reclaimed space: ${sizeText(mb)}`);
  ctx.out(out.join("\n"));
  return 0;
}

function versionClient(ctx: Ctx): string[] {
  const ce = isCe(ctx);
  return [
    ce ? "Client: Docker Engine - Community" : "Client:",
    ` Version:           ${clientVersion(ctx)}`,
    ` API version:       ${ce ? API_VERSION : "1.43"}`,
    ` Go version:        ${ce ? "go1.22.7" : "go1.22.2"}`,
    ` Git commit:        ${ce ? "ce12230" : "24.0.7-0ubuntu4.1"}`,
    ` Built:             ${ce ? "Fri Sep 20 11:41:00 2024" : "Fri Apr 19 08:22:24 2024"}`,
    " OS/Arch:           linux/amd64",
    " Context:           default",
  ];
}

function versionServer(ctx: Ctx): string[] {
  const ce = !!ctx.host.packages["docker-ce"];
  return [
    ce ? "Server: Docker Engine - Community" : "Server:",
    " Engine:",
    `  Version:          ${ce ? DOCKER_VERSION : "24.0.7"}`,
    `  API version:      ${ce ? API_VERSION : "1.43"} (minimum version 1.24)`,
    `  Go version:       ${ce ? "go1.22.7" : "go1.22.2"}`,
    `  Git commit:       ${ce ? "41ca978" : "24.0.7-0ubuntu4.1"}`,
    `  Built:            ${ce ? "Fri Sep 20 11:41:00 2024" : "Fri Apr 19 08:22:24 2024"}`,
    "  OS/Arch:          linux/amd64",
    "  Experimental:     false",
    " containerd:",
    `  Version:          ${ce ? "1.7.22" : "1.7.12"}`,
    `  GitCommit:        ${ce ? "7f7fdf5fed64eb6a7caf99b3e12efcf9d60e311c" : ""}`,
    " runc:",
    `  Version:          ${ce ? "1.1.14" : "1.1.12-0ubuntu3.1"}`,
    `  GitCommit:        ${ce ? "v1.1.14-0-g2c9f560" : ""}`,
    " docker-init:",
    "  Version:          0.19.0",
    "  GitCommit:        de40ad0",
  ];
}

function cmdVersion(ctx: Ctx): number {
  ctx.out(versionClient(ctx).join("\n") + "\n");
  if (!daemon(ctx, "Get", `/v${API_VERSION}/version`)) return 1;
  ctx.out(versionServer(ctx).join("\n"));
  return 0;
}

function cmdInfo(ctx: Ctx): number {
  const plugins: string[] = [];
  if (hasBuildx(ctx)) plugins.push("  buildx: Docker Buildx (Docker Inc.)", "    Version:  v0.17.1", "    Path:     /usr/libexec/docker/cli-plugins/docker-buildx");
  if (hasCompose(ctx)) plugins.push("  compose: Docker Compose (Docker Inc.)", `    Version:  ${composeVersion(ctx)}`, "    Path:     /usr/libexec/docker/cli-plugins/docker-compose");
  ctx.out([isCe(ctx) ? "Client: Docker Engine - Community" : "Client:", ` Version:    ${clientVersion(ctx)}`, " Context:    default", " Debug Mode: false", ...(plugins.length ? [" Plugins:", ...plugins] : []), ""].join("\n"));
  if (!daemon(ctx, "Get", `/v${API_VERSION}/info`)) return 1;
  const cs = Object.values(ctx.host.docker.containers);
  const running = cs.filter((c) => c.status === "running").length;
  ctx.out(
    [
      "Server:",
      ` Containers: ${cs.length}`,
      `  Running: ${running}`,
      "  Paused: 0",
      `  Stopped: ${cs.length - running}`,
      ` Images: ${Object.keys(ctx.host.docker.images).length}`,
      ` Server Version: ${ctx.host.packages["docker-ce"] ? DOCKER_VERSION : "24.0.7"}`,
      " Storage Driver: overlay2",
      " Logging Driver: json-file",
      " Cgroup Driver: systemd",
      " Cgroup Version: 2",
      " Kernel Version: 6.8.0-45-generic",
      ` Operating System: ${ctx.host.os}`,
      " OSType: linux",
      " Architecture: x86_64",
      ` CPUs: ${ctx.host.cpus}`,
      ` Total Memory: ${(ctx.host.memMb / 1024).toFixed(3)}GiB`,
      ` Name: ${ctx.host.hostname}`,
      " Docker Root Dir: /var/lib/docker",
      " Live Restore Enabled: false",
    ].join("\n"),
  );
  return 0;
}

// ---------- docker compose ----------

const COMPOSE_SUBS = ["up", "down", "ps", "logs", "restart", "stop", "start", "pull", "build", "exec", "config", "ls", "version"];

function composeHelp(): string {
  return [
    "Usage:  docker compose [OPTIONS] COMMAND",
    "",
    "Define and run multi-container applications with Docker",
    "",
    "Commands:",
    "  build       Build or rebuild services",
    "  config      Parse, resolve and render compose file in canonical format",
    "  down        Stop and remove containers, networks",
    "  exec        Execute a command in a running container",
    "  logs        View output from containers",
    "  ls          List running compose projects",
    "  ps          List containers",
    "  pull        Pull service images",
    "  restart     Restart service containers",
    "  start       Start services",
    "  stop        Stop services",
    "  up          Create and start containers",
    "  version     Show the Docker Compose version information",
  ].join("\n");
}

function compose(ctx: Ctx, args: string[]): number {
  if (!hasCompose(ctx)) {
    ctx.err("docker: 'compose' is not a docker command.\nSee 'docker --help'");
    return 1;
  }
  // Global flags come before the subcommand.
  let file: string | undefined;
  let projectName: string | undefined;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === "-f" || a === "--file") file = args[++i];
    else if (a.startsWith("--file=")) file = a.slice(7);
    else if (a === "-p" || a === "--project-name") projectName = args[++i];
    else if (a.startsWith("--project-name=")) projectName = a.slice(15);
    else if (a === "--env-file" || a === "--project-directory") i++;
    else if (a === "--version" || a === "-v") {
      ctx.out(`Docker Compose version ${composeVersion(ctx)}`);
      return 0;
    } else break;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (!sub || sub === "--help" || sub === "help") {
    ctx.out(composeHelp());
    return 0;
  }
  if (!COMPOSE_SUBS.includes(sub)) {
    ctx.err(`unknown docker command: "compose ${sub}"`);
    return 1;
  }
  if (sub === "version") {
    ctx.out(`Docker Compose version ${composeVersion(ctx)}`);
    return 0;
  }
  if (sub === "ls") {
    if (!daemon(ctx, "Get", `/v${API_VERSION}/containers/json?all=1`)) return 1;
    const rows = [["NAME", "STATUS", "CONFIG FILES"]];
    for (const pr of Object.values(ctx.host.docker.projects ?? {})) {
      const cs = Object.values(ctx.host.docker.containers).filter((c) => c.project === pr.name);
      const counts: Record<string, number> = {};
      for (const c of cs) counts[c.status] = (counts[c.status] ?? 0) + 1;
      rows.push([pr.name, Object.entries(counts).map(([s, n]) => `${s}(${n})`).join(", ") || "exited(0)", pr.file]);
    }
    ctx.out(table(rows));
    return 0;
  }

  const loaded = loadCompose(ctx.host, ctx.user, ctx.frame.cwd, ctx.env, { file, projectName });
  for (const wline of loaded.warnings) ctx.err(wline);
  if (!loaded.model) {
    ctx.err(loaded.error ?? "invalid compose project");
    return sub === "config" ? 15 : 1;
  }
  const m = loaded.model;
  if (sub === "config") {
    const p = parseFlags(rest, ["format", "o", "output"], ["q", "quiet", "services", "volumes", "images", "no-interpolate", "no-normalize", "resolve-image-digests"]);
    if (has(p, "q", "quiet")) return 0;
    if (has(p, "services")) ctx.out(m.order.join("\n"));
    else if (has(p, "volumes")) ctx.out(Object.keys(m.volumes).join("\n"));
    else ctx.out(composeConfig(m));
    return 0;
  }
  const filters = encodeURIComponent(`{"label":{"com.docker.compose.config-hash":true,"com.docker.compose.project=${m.project}":true}}`);
  if (!daemon(ctx, "Get", `/v${API_VERSION}/containers/json?all=1&filters=${filters}`)) return 1;
  const IO = io(ctx);
  switch (sub) {
    case "up": {
      const p = parseFlags(rest, ["timeout", "t", "wait-timeout", "pull"], ["d", "detach", "build", "force-recreate", "remove-orphans", "wait", "no-build", "no-deps", "quiet-pull", "no-recreate", "y", "yes"]);
      if (p.error) return composeUsage(ctx, sub, p.error);
      return composeUp(ctx.w, ctx.host, m, IO, {
        detach: has(p, "d", "detach") || has(p, "wait"),
        build: has(p, "build"),
        forceRecreate: has(p, "force-recreate"),
        removeOrphans: has(p, "remove-orphans"),
        wait: has(p, "wait"),
        services: p.rest,
      });
    }
    case "down": {
      const p = parseFlags(rest, ["rmi", "timeout", "t"], ["v", "volumes", "remove-orphans"]);
      if (p.error) return composeUsage(ctx, sub, p.error);
      return composeDown(ctx.w, ctx.host, m, IO, { volumes: has(p, "v", "volumes"), removeOrphans: has(p, "remove-orphans") });
    }
    case "ps": {
      const p = parseFlags(rest, ["format", "filter", "status"], ["a", "all", "q", "quiet", "services"]);
      if (p.error) return composeUsage(ctx, sub, p.error);
      const rows = composePs(ctx.w, ctx.host, m, has(p, "a", "all"));
      if (has(p, "q", "quiet")) {
        const ids = projectContainers(ctx.host, m)
          .filter((c) => has(p, "a", "all") || c.status === "running" || c.status === "restarting")
          .map((c) => fullId(c.id));
        if (ids.length) ctx.out(ids.join("\n"));
        return 0;
      }
      if (has(p, "services")) {
        ctx.out(rows.slice(1).map((r) => r[3]).join("\n"));
        return 0;
      }
      ctx.out(table(rows));
      return 0;
    }
    case "logs": {
      const p = parseFlags(rest, ["tail", "n", "since", "until"], ["f", "follow", "t", "timestamps", "no-color", "no-log-prefix"]);
      if (p.error) return composeUsage(ctx, sub, p.error);
      for (const s of p.rest) {
        if (!m.services[s]) {
          ctx.err(`no such service: ${s}`);
          return 1;
        }
      }
      const tailRaw = last(p, "tail", "n");
      const text = composeLogs(ctx.host, m, p.rest, tailRaw === undefined || tailRaw === "all" ? undefined : Number(tailRaw));
      if (text) ctx.out(has(p, "no-log-prefix") ? text.replace(/^\S+\s+\| /gm, "") : text);
      return 0;
    }
    case "restart":
    case "stop":
    case "start": {
      const p = parseFlags(rest, ["timeout", "t"], ["no-deps"]);
      if (p.error) return composeUsage(ctx, sub, p.error);
      for (const s of p.rest) {
        if (!m.services[s]) {
          ctx.err(`no such service: ${s}`);
          return 1;
        }
      }
      if (sub === "restart") return composeRestart(ctx.w, ctx.host, m, IO, p.rest);
      if (sub === "stop") return composeStop(ctx.w, ctx.host, m, IO, p.rest);
      return composeStart(ctx.w, ctx.host, m, IO, p.rest);
    }
    case "pull": {
      const p = parseFlags(rest, ["policy"], ["q", "quiet", "ignore-pull-failures", "include-deps"]);
      return composePull(ctx.w, ctx.host, m, IO, p.rest);
    }
    case "build": {
      const p = parseFlags(rest, ["build-arg", "progress"], ["no-cache", "pull", "q", "quiet"]);
      return composeBuild(ctx.w, ctx.host, m, IO, { services: p.rest, noCache: has(p, "no-cache") });
    }
    case "exec": {
      const p = parseFlags(rest, ["w", "workdir", "e", "env", "u", "user", "index"], ["T", "no-TTY", "d", "detach", "i", "interactive", "t", "tty", "privileged"], true);
      if (p.error) return composeUsage(ctx, sub, p.error);
      const [svc, ...cmd] = p.rest;
      if (!svc || !cmd.length) {
        ctx.err(`'docker compose exec' requires at least 2 arguments\n\nUsage:  docker compose exec [OPTIONS] SERVICE COMMAND [ARGS...]`);
        return 1;
      }
      if (!m.services[svc]) {
        ctx.err(`no such service: ${svc}`);
        return 1;
      }
      const c = ctx.host.docker.containers[containerName(m, m.services[svc])];
      if (!c || c.status !== "running") {
        ctx.err(`service "${svc}" is not running`);
        return 1;
      }
      return execInto(ctx, c, cmd, last(p, "w", "workdir"));
    }
  }
  return 0;
}

function composeUsage(ctx: Ctx, sub: string, error: string): number {
  ctx.err(`${error}`);
  void sub;
  return 1;
}

// ---------- the docker command ----------

const SUBS: Record<string, (ctx: Ctx, args: string[]) => number> = {
  run: cmdRun,
  ps: cmdPs,
  logs: cmdLogs,
  stop: (ctx, a) => cmdStop(ctx, a),
  kill: (ctx, a) => cmdStop(ctx, a, true),
  start: cmdStart,
  restart: cmdRestart,
  rm: cmdRm,
  images: cmdImages,
  pull: cmdPull,
  rmi: cmdRmi,
  build: cmdBuild,
  exec: cmdExec,
  inspect: (ctx, a) => cmdInspect(ctx, a),
  volume: cmdVolume,
  network: cmdNetwork,
  system: cmdSystem,
  info: (ctx) => cmdInfo(ctx),
  version: (ctx) => cmdVersion(ctx),
  container: (ctx, a) => {
    const map: Record<string, string> = { ls: "ps", list: "ps", ps: "ps", rm: "rm", remove: "rm", stop: "stop", start: "start", restart: "restart", inspect: "inspect", logs: "logs", run: "run", exec: "exec", kill: "kill" };
    if (a[0] === "prune") return prune(ctx, false, false);
    const to = map[a[0] ?? ""];
    if (!to) {
      ctx.err("Usage:  docker container COMMAND\n\nManage containers");
      return a[0] ? 1 : 0;
    }
    return SUBS[to](ctx, a[0] === "ls" || a[0] === "list" ? a.slice(1) : a.slice(1));
  },
  image: (ctx, a) => {
    const map: Record<string, string> = { ls: "images", list: "images", rm: "rmi", remove: "rmi", pull: "pull", build: "build", inspect: "inspect" };
    if (a[0] === "prune") return prune(ctx, a.includes("-a") || a.includes("--all"), false);
    const to = map[a[0] ?? ""];
    if (!to) {
      ctx.err("Usage:  docker image COMMAND\n\nManage images");
      return a[0] ? 1 : 0;
    }
    return SUBS[to](ctx, a.slice(1));
  },
  compose,
};

const HELP = `
Usage:  docker [OPTIONS] COMMAND

A self-sufficient runtime for containers

Common Commands:
  run         Create and run a new container from an image
  exec        Execute a command in a running container
  ps          List containers
  build       Build an image from a Dockerfile
  pull        Download an image from a registry
  images      List images
  version     Show the Docker version information
  info        Display system-wide information

Management Commands:
  compose*    Docker Compose
  container   Manage containers
  image       Manage images
  network     Manage networks
  system      Manage Docker
  volume      Manage volumes

Commands:
  inspect     Return low-level information on Docker objects
  kill        Kill one or more running containers
  logs        Fetch the logs of a container
  restart     Restart one or more containers
  rm          Remove one or more containers
  rmi         Remove one or more images
  start       Start one or more stopped containers
  stop        Stop one or more running containers

Run 'docker COMMAND --help' for more information on a command.`;

export const docker: Command = {
  name: "docker",
  summary: "run containers (docker ps, docker compose up -d)",
  run(ctx) {
    const args = ctx.argv.slice(1);
    const sub = args[0];
    if (!sub || sub === "--help" || sub === "help") {
      ctx.out(HELP.trimStart());
      return 0;
    }
    if (sub === "--version" || sub === "-v") {
      ctx.out(isCe(ctx) ? `Docker version ${DOCKER_VERSION}, build ce12230` : "Docker version 24.0.7, build 24.0.7-0ubuntu4.1");
      return 0;
    }
    const fn = SUBS[sub];
    if (!fn) {
      ctx.err(`docker: '${sub}' is not a docker command.\nSee 'docker --help'`);
      return 1;
    }
    if (sub !== "compose" && args[1] === "--help") {
      ctx.out(`Usage:  docker ${sub} [OPTIONS]\n\nRun 'docker --help' for the list of commands.`);
      return 0;
    }
    return fn(ctx, args.slice(1));
  },
  resume(ctx, p, input) {
    if (!p.data.prune) return 0;
    if (!/^y(es)?$/i.test(input.trim())) return 1;
    return prune(ctx, Boolean(p.data.all), Boolean(p.data.volumes));
  },
  complete: () => ["run", "ps", "logs", "stop", "start", "restart", "rm", "images", "pull", "exec", "inspect", "volume", "network", "build", "compose", "system", "version", "info"],
};

// ---------- the install script and newgrp ----------

function runInstall(ctx: Ctx, viaSudo: boolean): number {
  const host = ctx.host;
  const pre = viaSudo ? "+ sudo -E sh -c" : "+ sh -c";
  const lines = [`# Executing docker install script, commit: ${INSTALL_SCRIPT_COMMIT}`];
  if (host.packages["docker-ce"] || host.packages["docker.io"]) {
    ctx.out(
      [
        "Warning: the \"docker\" command appears to already exist on this system.",
        "",
        "If you already have Docker installed, this script can cause trouble, which is",
        "why we're displaying this warning and provide the opportunity to cancel the",
        "installation.",
        "",
        "If you installed the current Docker package using this script and are using it",
        "again to update Docker, you can ignore this message, but be aware that the",
        "script resets any custom changes in the deb and rpm repo configuration",
        "files to match the parameters passed to the script.",
        "",
        "You may press Ctrl+C now to abort this script.",
        "+ sleep 20",
      ].join("\n"),
    );
  }
  lines.push(
    `${pre} apt-get -qq update >/dev/null`,
    `${pre} DEBIAN_FRONTEND=noninteractive apt-get -y -qq install ca-certificates curl >/dev/null`,
    `${pre} install -m 0755 -d /etc/apt/keyrings`,
    `${pre} curl -fsSL "https://download.docker.com/linux/ubuntu/gpg" -o /etc/apt/keyrings/docker.asc`,
    `${pre} chmod a+r /etc/apt/keyrings/docker.asc`,
    `${pre} echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list`,
    `${pre} apt-get -qq update >/dev/null`,
    `${pre} DEBIAN_FRONTEND=noninteractive apt-get -y -qq install docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-ce-rootless-extras docker-buildx-plugin >/dev/null`,
  );
  scriptInstall(ctx.w, host);
  lines.push(`${pre} docker version`);
  const asRoot = { ...ctx, user: "root" } as Ctx;
  lines.push(...versionClient(asRoot), "", ...versionServer(asRoot), ...INSTALL_SCRIPT_FOOTER);
  ctx.out(lines.join("\n"));
  return 0;
}

/** Hidden: what get-docker.sh calls. */
export const dockerInstall: Command = {
  name: "__docker_install",
  summary: "the get.docker.com installer",
  hidden: true,
  run(ctx) {
    if (ctx.argv.includes("--dry-run")) {
      ctx.out(`# Executing docker install script, commit: ${INSTALL_SCRIPT_COMMIT}\napt-get -qq update >/dev/null\n...\napt-get -y -qq install docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-ce-rootless-extras docker-buildx-plugin >/dev/null`);
      return 0;
    }
    if (ctx.user === "root") return runInstall(ctx, false);
    if (!isSudoer(ctx.host, ctx.user)) {
      ctx.err(`# Executing docker install script, commit: ${INSTALL_SCRIPT_COMMIT}\nERROR: this installer needs the ability to run commands as root.\nWe are unable to find either "sudo" or "su" available to make this happen.`);
      return 1;
    }
    if (ctx.frame.sudoOk) return runInstall(ctx, true);
    ctx.prompt({ prompt: `[sudo] password for ${ctx.realUser}: `, secret: true, data: {} });
    return 0;
  },
  resume(ctx, _p, input) {
    const pw = ctx.host.users[ctx.realUser]?.password;
    if (pw === undefined || input !== pw) {
      ctx.err("sudo: 1 incorrect password attempt");
      return 1;
    }
    ctx.frame.sudoOk = true;
    return runInstall(ctx, true);
  },
};

/** newgrp docker: a new shell where your new group already counts. */
export const newgrp: Command = {
  name: "newgrp",
  summary: "start a shell with a new group active (newgrp docker)",
  hidden: true,
  run(ctx) {
    const g = ctx.argv[1];
    if (!g) {
      ctx.sh.frames.push({ ...ctx.frame, via: "su", loginGroups: userGroups(ctx.host, ctx.realUser) });
      return 0;
    }
    if (!ctx.host.groups[g]) {
      ctx.err(`newgrp: group '${g}' does not exist`);
      return 1;
    }
    if (ctx.realUser !== "root" && !userGroups(ctx.host, ctx.realUser).includes(g)) {
      ctx.prompt({ prompt: "Password: ", secret: true, data: { g } });
      return 0;
    }
    ctx.sh.frames.push({ host: ctx.frame.host, user: ctx.realUser, cwd: ctx.frame.cwd, via: "su", loginGroups: userGroups(ctx.host, ctx.realUser) });
    return 0;
  },
  resume(ctx) {
    ctx.err("Invalid password.");
    return 1;
  },
};

export const DOCKER_COMMANDS = [docker, dockerInstall, newgrp];

// Kept for later worlds that want the same parsing.
export { parseFlags };
