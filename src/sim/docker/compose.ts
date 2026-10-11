// Reading compose.yaml the way Docker Compose 2.29 does: find the file, interpolate ${VARS}
// from .env and the shell, validate, and turn it into a plain model.
import { parseDocument } from "yaml";
import { basename, can, dirname, getFile, resolvePath } from "../fs";
import type { Container, HealthCheck, Host, PortMap } from "../types";
import { hashHex } from "../util";

export const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"];

export type DependCondition = "service_started" | "service_healthy" | "service_completed_successfully";

export interface ComposeService {
  name: string;
  image?: string;
  build?: { context: string; dockerfile: string; args: Record<string, string>; target?: string };
  containerName?: string;
  ports: PortMap[];
  expose: number[];
  mounts: Container["mounts"];
  /** environment after env_file and environment are merged. */
  env: Record<string, string>;
  envFiles: string[];
  restart: Container["restart"];
  /** "disabled" turns off a healthcheck the image has. */
  healthcheck?: HealthCheck | "disabled";
  dependsOn: Record<string, DependCondition>;
  /** Full network names (crumb_default). */
  networks: string[];
  logging?: { driver: string; options: Record<string, string> };
  command?: string[];
}

export interface ComposeModel {
  project: string;
  dir: string;
  file: string;
  services: Record<string, ComposeService>;
  /** Declaration order. */
  order: string[];
  /** Short name to full name (pgdata -> crumb_pgdata). External ones keep their name. */
  volumes: Record<string, { name: string; external: boolean }>;
  networks: Record<string, { name: string; external: boolean }>;
  /** The interpolated file, for compose config. */
  raw: Record<string, unknown>;
}

export interface LoadResult {
  model?: ComposeModel;
  error?: string;
  /** WARN[0000] lines, printed before anything else. */
  warnings: string[];
}

/** Compose looks in the current folder, then each parent. */
export function findComposeFile(host: Host, cwd: string): string | undefined {
  let d = cwd;
  for (;;) {
    for (const f of COMPOSE_FILES) {
      const p = (d === "/" ? "" : d) + "/" + f;
      if (getFile(host, p)) return p;
    }
    if (d === "/") return undefined;
    d = dirname(d);
  }
}

/** KEY=value lines, the way Compose reads .env and env_file. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (/^'.*'$/.test(v)) v = v.slice(1, -1);
    else if (/^".*"$/.test(v)) v = v.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
    else v = v.replace(/\s+#.*$/, "").trim();
    out[m[1]] = v;
  }
  return out;
}

class ComposeError extends Error {}

/** ${VAR}, ${VAR:-default}, ${VAR-default}, ${VAR:?msg}, ${VAR:+alt}, $VAR and $$. */
export function interpolate(s: string, vars: Record<string, string>, missing: string[], where: string): string {
  return s.replace(/\$\$|\$\{([^}]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (all, braced: string | undefined, bare: string | undefined) => {
    if (all === "$$") return "$";
    const expr = braced ?? bare ?? "";
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])(.*))?$/.exec(expr);
    if (!m) throw new ComposeError(`invalid interpolation format for ${where}: "${all}"; you may need to escape any $ with another $`);
    const [, name, op, arg = ""] = m;
    const has = name in vars;
    const val = vars[name];
    const empty = !has || (op?.startsWith(":") && val === "");
    switch (op) {
      case ":-":
      case "-":
        return empty ? interpolate(arg, vars, missing, where) : val;
      case ":?":
      case "?":
        if (empty) throw new ComposeError(`error while interpolating ${where}: required variable ${name} is missing a value${arg ? ": " + arg : ""}`);
        return val;
      case ":+":
      case "+":
        return empty ? "" : interpolate(arg, vars, missing, where);
      default:
        if (!has) {
          if (!missing.includes(name)) missing.push(name);
          return "";
        }
        return val;
    }
  });
}

function interpolateTree(node: unknown, vars: Record<string, string>, missing: string[], path: string): unknown {
  if (typeof node === "string") return interpolate(node, vars, missing, path);
  if (Array.isArray(node)) return node.map((n) => interpolateTree(n, vars, missing, `${path}.[]`));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = interpolateTree(v, vars, missing, path ? `${path}.${k}` : k);
    return out;
  }
  return node;
}

const TOP_KEYS = ["version", "name", "services", "volumes", "networks", "secrets", "configs", "include"];
const SERVICE_KEYS = [
  "image", "build", "container_name", "hostname", "ports", "expose", "volumes", "environment", "env_file", "restart",
  "healthcheck", "depends_on", "networks", "logging", "command", "entrypoint", "labels", "user", "working_dir",
  "profiles", "deploy", "secrets", "configs", "extra_hosts", "cap_add", "cap_drop", "init", "tty", "stdin_open",
  "stop_grace_period", "stop_signal", "ulimits", "pull_policy", "platform", "read_only", "tmpfs", "mem_limit",
  "cpus", "dns", "extends", "develop", "devices", "privileged", "security_opt", "shm_size", "sysctls",
  "network_mode", "pid", "ipc", "domainname", "mac_address", "runtime", "scale", "attach", "annotations",
];
const RESTARTS = ["no", "always", "unless-stopped", "on-failure"];

/** "1m30s" -> 90. Plain numbers are seconds in the sim (real Compose wants a unit). */
export function parseDuration(v: unknown, fallback: number): number {
  if (typeof v === "number") return v;
  if (typeof v !== "string" || !v.trim()) return fallback;
  let total = 0;
  let matched = false;
  for (const m of v.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === "h" ? n * 3600 : m[2] === "m" ? n * 60 : m[2] === "ms" ? n / 1000 : n;
  }
  return matched ? total : Number(v) || fallback;
}

function asMap(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

/** Split a command string the way a shell would (quotes kept together). */
export function splitWords(s: string): string[] {
  return (s.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((w) => w.replace(/"([^"]*)"|'([^']*)'/g, "$1$2"));
}

function yamlError(e: { code: string; linePos?: { line: number }[]; message: string }): string {
  const line = e.linePos?.[0]?.line ?? 1;
  const msg =
    e.code === "BLOCK_AS_IMPLICIT_KEY" || e.code === "MULTILINE_IMPLICIT_KEY"
      ? "mapping values are not allowed in this context"
      : e.code === "TAB_AS_INDENT"
        ? "found character that cannot start any token"
        : e.code === "DUPLICATE_KEY"
          ? `mapping key already defined`
          : "did not find expected key";
  return `yaml: line ${line}: ${msg}`;
}

export interface LoadOpts {
  /** -f */
  file?: string;
  /** -p */
  projectName?: string;
}

/**
 * Load the compose project in `cwd` as `user` (the files are read with your permissions,
 * even when the daemon runs as root). `shellEnv` is your shell's environment.
 */
export function loadCompose(host: Host, user: string, cwd: string, shellEnv: Record<string, string>, opts: LoadOpts = {}): LoadResult {
  const warnings: string[] = [];
  const fail = (error: string): LoadResult => ({ error, warnings });
  const file = opts.file ? resolvePath(cwd, opts.file, "/") : findComposeFile(host, cwd);
  if (!file) return fail("no configuration file provided: not found");
  const node = getFile(host, file);
  if (!node) return fail(`open ${file}: no such file or directory`);
  if (!can(host, user, node, "r")) return fail(`open ${file}: permission denied`);
  const dir = dirname(file);
  const read = (p: string): string | { error: string } => {
    const f = getFile(host, p);
    if (!f) return { error: `stat ${p}: no such file or directory` };
    if (!can(host, user, f, "r")) return { error: `open ${p}: permission denied` };
    return f.content;
  };

  // The project .env is only for ${VAR} in this file. It does NOT reach containers by itself.
  let projectEnv: Record<string, string> = {};
  const envPath = `${dir === "/" ? "" : dir}/.env`;
  if (getFile(host, envPath)) {
    const t = read(envPath);
    if (typeof t !== "string") return fail(t.error.replace(/^stat/, "open"));
    projectEnv = parseDotenv(t);
  }
  const vars = { ...projectEnv, ...shellEnv };

  const doc = parseDocument(node.content, { prettyErrors: false });
  if (doc.errors.length) return fail(yamlError(doc.errors[0] as never));
  const parsed = doc.toJS() as unknown;
  const top = asMap(parsed);
  if (!top) return fail(`validating ${file}: (root) must be a mapping`);

  if ("version" in top) {
    warnings.push(`WARN[0000] ${file}: the attribute \`version\` is obsolete, it will be ignored, please remove it to avoid potential confusion`);
  }
  for (const k of Object.keys(top)) {
    if (!TOP_KEYS.includes(k) && !k.startsWith("x-")) return fail(`validating ${file}: (root) Additional property ${k} is not allowed`);
  }

  const missing: string[] = [];
  let raw: Record<string, unknown>;
  try {
    raw = interpolateTree(top, vars, missing, "") as Record<string, unknown>;
  } catch (e) {
    return fail((e as Error).message);
  }
  for (const m of missing) warnings.push(`WARN[0000] The "${m}" variable is not set. Defaulting to a blank string.`);

  const servicesRaw = asMap(raw.services);
  if (!servicesRaw) return fail(raw.services === undefined ? "no service selected" : `validating ${file}: services must be a mapping`);

  const projectRaw = opts.projectName ?? (raw.name ? str(raw.name) : undefined) ?? vars.COMPOSE_PROJECT_NAME ?? basename(dir);
  const project = projectRaw.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!project) return fail(`project name must not be empty`);

  const volumes: ComposeModel["volumes"] = {};
  for (const [k, v] of Object.entries(asMap(raw.volumes) ?? {})) {
    const m = asMap(v) ?? {};
    const external = m.external === true;
    volumes[k] = { name: m.name ? str(m.name) : external ? k : `${project}_${k}`, external };
  }
  const networks: ComposeModel["networks"] = { default: { name: `${project}_default`, external: false } };
  for (const [k, v] of Object.entries(asMap(raw.networks) ?? {})) {
    const m = asMap(v) ?? {};
    const external = m.external === true;
    networks[k] = { name: m.name ? str(m.name) : external ? k : `${project}_${k}`, external };
  }

  const services: Record<string, ComposeService> = {};
  const order = Object.keys(servicesRaw);
  try {
    for (const name of order) {
      const s = asMap(servicesRaw[name]) ?? {};
      for (const k of Object.keys(s)) {
        if (!SERVICE_KEYS.includes(k) && !k.startsWith("x-")) throw new ComposeError(`validating ${file}: services.${name} Additional property ${k} is not allowed`);
      }
      services[name] = parseService(name, s, { file, dir, project, volumes, networks, vars, read });
    }
  } catch (e) {
    if (e instanceof ComposeError) return fail(e.message);
    throw e;
  }
  for (const name of order) {
    for (const dep of Object.keys(services[name].dependsOn)) {
      if (!services[dep]) return fail(`service "${name}" depends on undefined service "${dep}": invalid compose project`);
    }
  }
  const model: ComposeModel = { project, dir, file, services, order, volumes, networks, raw };
  const cycle = findCycle(model);
  if (cycle) return fail(`dependency cycle detected: ${cycle.join(" -> ")}`);
  return { model, warnings };
}

interface ParseEnv {
  file: string;
  dir: string;
  project: string;
  volumes: ComposeModel["volumes"];
  networks: ComposeModel["networks"];
  vars: Record<string, string>;
  read: (p: string) => string | { error: string };
}

function parsePorts(name: string, list: unknown, file: string): PortMap[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new ComposeError(`validating ${file}: services.${name}.ports must be a list`);
  const out: PortMap[] = [];
  list.forEach((p, i) => {
    const m = asMap(p);
    if (m) {
      out.push({ hostIp: str(m.host_ip) || "0.0.0.0", hostPort: Number(m.published ?? 0) || 32768 + i, containerPort: Number(m.target) });
      return;
    }
    const parts = str(p).replace(/\/(tcp|udp)$/, "").split(":");
    const nums = (x: string) => Number(x.split("-")[0]);
    const bad = (x: string) => !/^\d+(-\d+)?$/.test(x);
    let hostIp = "0.0.0.0";
    let host: string | undefined;
    let cont: string;
    if (parts.length === 1) cont = parts[0];
    else if (parts.length === 2) [host, cont] = parts;
    else [hostIp, host, cont] = [parts.slice(0, -2).join(":"), parts[parts.length - 2], parts[parts.length - 1]];
    if (bad(cont) || (host !== undefined && host !== "" && bad(host))) throw new ComposeError(`invalid port: "${str(p)}"`);
    out.push({ hostIp: hostIp.replace(/^\[|\]$/g, ""), hostPort: host ? nums(host) : 32768 + i, containerPort: nums(cont) });
  });
  return out;
}

function parseService(name: string, s: Record<string, unknown>, e: ParseEnv): ComposeService {
  const { file, dir, project } = e;
  const abs = (p: string) => resolvePath(dir, p, "/root");

  let build: ComposeService["build"];
  if (s.build !== undefined) {
    const b = asMap(s.build);
    const context = abs(b ? str(b.context || ".") : str(s.build));
    const args: Record<string, string> = {};
    const a = b?.args;
    if (Array.isArray(a)) {
      for (const x of a) {
        const [k, ...v] = str(x).split("=");
        args[k] = v.length ? v.join("=") : (e.vars[k] ?? "");
      }
    } else for (const [k, v] of Object.entries(asMap(a) ?? {})) args[k] = str(v);
    build = { context, dockerfile: b?.dockerfile ? str(b.dockerfile) : "Dockerfile", args, ...(b?.target ? { target: str(b.target) } : {}) };
  }
  const image = s.image !== undefined ? str(s.image) : undefined;
  if (!image && !build) throw new ComposeError(`service "${name}" has neither an image nor a build context specified: invalid compose project`);

  // environment: env_file first, then environment wins.
  const env: Record<string, string> = {};
  const envFiles: string[] = [];
  const ef = s.env_file;
  const efList = ef === undefined ? [] : Array.isArray(ef) ? ef : [ef];
  for (const item of efList) {
    const m = asMap(item);
    const p = abs(m ? str(m.path) : str(item));
    const required = m ? m.required !== false : true;
    const t = e.read(p);
    if (typeof t !== "string") {
      if (!required && t.error.startsWith("stat")) continue;
      throw new ComposeError(t.error.startsWith("stat") ? `env file ${p} not found: ${t.error}` : t.error);
    }
    envFiles.push(p);
    Object.assign(env, parseDotenv(t));
  }
  const envRaw = s.environment;
  if (Array.isArray(envRaw)) {
    for (const x of envRaw) {
      const t = str(x);
      const i = t.indexOf("=");
      if (i < 0) {
        if (t in e.vars) env[t] = e.vars[t];
      } else env[t.slice(0, i)] = t.slice(i + 1);
    }
  } else if (envRaw !== undefined) {
    const m = asMap(envRaw);
    if (!m) throw new ComposeError(`validating ${file}: services.${name}.environment must be a mapping`);
    for (const [k, v] of Object.entries(m)) {
      if (v === null) {
        if (k in e.vars) env[k] = e.vars[k];
      } else env[k] = str(v);
    }
  }

  const mounts: Container["mounts"] = [];
  const vlist = s.volumes === undefined ? [] : s.volumes;
  if (!Array.isArray(vlist)) throw new ComposeError(`validating ${file}: services.${name}.volumes must be a list`);
  for (const v of vlist) {
    const m = asMap(v);
    let source: string;
    let target: string;
    if (m) {
      source = str(m.source);
      target = str(m.target);
      if (m.type === "bind") {
        mounts.push({ source: abs(source), target, type: "bind" });
        continue;
      }
    } else {
      const parts = str(v).split(":");
      if (parts.length === 1) {
        // Just a path: an anonymous volume. The daemon names it.
        mounts.push({ source: hashHex(`anon|${project}|${name}|${parts[0]}`, 64), target: parts[0], type: "volume" });
        continue;
      }
      [source, target] = parts;
    }
    if (/^[./~]/.test(source)) {
      mounts.push({ source: abs(source), target, type: "bind" });
      continue;
    }
    const decl = e.volumes[source];
    if (!decl) throw new ComposeError(`service "${name}" refers to undefined volume ${source}: invalid compose project`);
    mounts.push({ source: decl.name, target, type: "volume" });
  }

  let restart: Container["restart"] = "no";
  if (s.restart !== undefined && s.restart !== false) {
    const r = str(s.restart).replace(/:\d+$/, "");
    if (!RESTARTS.includes(r)) throw new ComposeError(`invalid restart policy: unknown policy '${str(s.restart)}'`);
    restart = r as Container["restart"];
  }

  let healthcheck: ComposeService["healthcheck"];
  const h = asMap(s.healthcheck);
  if (h) {
    if (h.disable === true) healthcheck = "disabled";
    else {
      const t = h.test;
      const test = Array.isArray(t) ? t.map(str) : t === undefined ? [] : ["CMD-SHELL", str(t)];
      if (test[0] === "NONE") healthcheck = "disabled";
      else
        healthcheck = {
          test,
          interval: parseDuration(h.interval, 30),
          timeout: parseDuration(h.timeout, 30),
          retries: h.retries === undefined ? 3 : Number(h.retries),
          startPeriod: parseDuration(h.start_period, 0),
        };
    }
  }

  const dependsOn: Record<string, DependCondition> = {};
  const d = s.depends_on;
  if (Array.isArray(d)) for (const x of d) dependsOn[str(x)] = "service_started";
  else
    for (const [k, v] of Object.entries(asMap(d) ?? {})) {
      const cond = str(asMap(v)?.condition || "service_started") as DependCondition;
      if (!["service_started", "service_healthy", "service_completed_successfully"].includes(cond)) {
        throw new ComposeError(`validating ${file}: services.${name}.depends_on.${k}.condition must be one of the following: "service_started", "service_healthy", "service_completed_successfully"`);
      }
      dependsOn[k] = cond;
    }

  const netNames = Array.isArray(s.networks) ? s.networks.map(str) : Object.keys(asMap(s.networks) ?? {});
  const nets = (netNames.length ? netNames : ["default"]).map((n) => {
    const decl = e.networks[n];
    if (!decl) throw new ComposeError(`service "${name}" refers to undefined network ${n}: invalid compose project`);
    return decl.name;
  });

  let logging: ComposeService["logging"];
  const lg = asMap(s.logging);
  if (lg) {
    const options: Record<string, string> = {};
    for (const [k, v] of Object.entries(asMap(lg.options) ?? {})) options[k] = str(v);
    logging = { driver: lg.driver ? str(lg.driver) : "json-file", options };
  }

  let command: string[] | undefined;
  if (Array.isArray(s.command)) command = s.command.map(str);
  else if (s.command !== undefined && s.command !== null) command = splitWords(str(s.command));

  const expose = (Array.isArray(s.expose) ? s.expose : []).map((x) => Number(str(x).split("/")[0]));
  return {
    name,
    image,
    build,
    containerName: s.container_name ? str(s.container_name) : undefined,
    ports: parsePorts(name, s.ports, file),
    expose,
    mounts,
    env,
    envFiles,
    restart,
    healthcheck,
    dependsOn,
    networks: nets,
    logging,
    command,
  };
}

function findCycle(m: ComposeModel): string[] | undefined {
  const state: Record<string, 1 | 2> = {};
  const stack: string[] = [];
  const visit = (n: string): string[] | undefined => {
    if (state[n] === 2) return undefined;
    if (state[n] === 1) return [...stack.slice(stack.indexOf(n)), n];
    state[n] = 1;
    stack.push(n);
    for (const d of Object.keys(m.services[n].dependsOn)) {
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state[n] = 2;
    return undefined;
  };
  for (const n of m.order) {
    const c = visit(n);
    if (c) return c;
  }
  return undefined;
}

/** Dependencies first, then declaration order. With `only`, just those services and what they need. */
export function topoOrder(m: ComposeModel, only?: string[]): string[] {
  const out: string[] = [];
  const add = (n: string) => {
    if (out.includes(n)) return;
    for (const d of Object.keys(m.services[n].dependsOn)) add(d);
    out.push(n);
  };
  for (const n of only?.length ? only : m.order) if (m.services[n]) add(n);
  return out;
}

export function containerName(m: ComposeModel, svc: ComposeService): string {
  return svc.containerName ?? `${m.project}-${svc.name}-1`;
}

/** The image a service runs: its image:, or the one Compose builds (project-service). */
export function serviceImage(m: ComposeModel, svc: ComposeService): string {
  return svc.image ?? `${m.project}-${svc.name}`;
}

/** Changes to anything here mean up -d recreates the container. */
export function serviceHash(svc: ComposeService, imageId: string | undefined): string {
  const { name, build, envFiles, dependsOn, ...rest } = svc;
  void name;
  void build;
  void envFiles;
  void dependsOn;
  return hashHex(JSON.stringify({ ...rest, imageId: imageId ?? "" }), 16);
}
