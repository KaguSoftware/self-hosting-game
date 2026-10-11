// docker build: parse a Dockerfile, walk its stages with a layer cache, print BuildKit lines.
// The cache key of each step is hash(previous key, instruction, and for COPY the files it copies),
// so a COPY . . above RUN npm ci makes npm ci run again after any code edit.
import { getDir, getFile, resolvePath } from "../fs";
import { advance } from "../tick";
import type { AppKind, HealthCheck, Host, ImageMeta, World } from "../types";
import { globMatch, hashHex } from "../util";
import { findRemote, fullRef, localImage, normalizeRef } from "./images";
import { parseDuration, splitWords } from "./compose";

export interface DfInstr {
  op: string;
  args: string;
  flags: Record<string, string>;
  line: number;
}

export interface DfStage {
  index: number;
  name?: string;
  from: string;
  fromLine: number;
  instrs: DfInstr[];
}

export interface ParsedDockerfile {
  stages: DfStage[];
  /** ARGs before the first FROM. */
  globalArgs: Record<string, string | undefined>;
  error?: string;
}

const OPS = ["FROM", "RUN", "CMD", "LABEL", "EXPOSE", "ENV", "ADD", "COPY", "ENTRYPOINT", "VOLUME", "USER", "WORKDIR", "ARG", "ONBUILD", "STOPSIGNAL", "HEALTHCHECK", "SHELL", "MAINTAINER"];

export function parseDockerfile(text: string): ParsedDockerfile {
  const stages: DfStage[] = [];
  const globalArgs: Record<string, string | undefined> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    let line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    while (line.endsWith("\\") && i + 1 < lines.length) {
      line = line.slice(0, -1).trimEnd() + " " + lines[++i].trim();
    }
    const m = /^(\S+)\s*(.*)$/.exec(line)!;
    const op = m[1].toUpperCase();
    let rest = m[2].trim();
    if (!OPS.includes(op)) return { stages, globalArgs, error: `dockerfile parse error on line ${lineNo}: unknown instruction: ${m[1]}` };
    const flags: Record<string, string> = {};
    while (/^--[\w-]+(=\S+)?\s/.test(rest + " ") && op !== "RUN") {
      const f = /^--([\w-]+)(?:=(\S+))?\s*/.exec(rest)!;
      flags[f[1]] = f[2] ?? "true";
      rest = rest.slice(f[0].length);
    }
    if (op === "FROM") {
      const fm = /^(\S+)(?:\s+as\s+(\S+))?$/i.exec(rest);
      if (!fm) return { stages, globalArgs, error: `dockerfile parse error on line ${lineNo}: FROM requires either one or three arguments` };
      stages.push({ index: stages.length, name: fm[2]?.toLowerCase(), from: fm[1], fromLine: lineNo, instrs: [] });
      continue;
    }
    if (!stages.length) {
      if (op === "ARG") {
        const [k, v] = rest.split("=");
        globalArgs[k] = v;
        continue;
      }
      return { stages, globalArgs, error: `dockerfile parse error on line ${lineNo}: no build stage in current context` };
    }
    stages[stages.length - 1].instrs.push({ op, args: rest, flags, line: lineNo });
  }
  if (!stages.length) return { stages, globalArgs, error: "dockerfile parse error on line 1: file with no instructions" };
  return { stages, globalArgs };
}

// ---------- the build context ----------

interface IgnoreRule {
  re: RegExp;
  negate: boolean;
}

function ignoreRules(text: string | undefined): IgnoreRule[] {
  if (!text) return [];
  const rules: IgnoreRule[] = [];
  for (const raw of text.split("\n")) {
    let p = raw.trim();
    if (!p || p.startsWith("#")) continue;
    const negate = p.startsWith("!");
    if (negate) p = p.slice(1);
    p = p.replace(/^\/+/, "").replace(/\/+$/, "");
    const src = p
      .split("/")
      .map((part) => (part === "**" ? "(?:.*)" : part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")))
      .join("/")
      .replace(/\(\?:\.\*\)\//g, "(?:.*/)?");
    // A pattern also covers everything inside a matching folder.
    rules.push({ re: new RegExp(`^${src}(?:/.*)?$`), negate });
  }
  return rules;
}

function ignored(rules: IgnoreRule[], rel: string): boolean {
  let out = false;
  for (const r of rules) if (r.re.test(rel)) out = !r.negate;
  return out;
}

/** Context files (relative path to content) after .dockerignore. */
export function contextFiles(host: Host, contextDir: string): Map<string, string> {
  const rules = ignoreRules(getFile(host, `${contextDir}/.dockerignore`)?.content);
  const out = new Map<string, string>();
  const walk = (abs: string, rel: string) => {
    const d = getDir(host, abs);
    if (!d) return;
    for (const [name, node] of Object.entries(d.children).sort(([a], [b]) => a.localeCompare(b))) {
      const r = rel ? `${rel}/${name}` : name;
      if (ignored(rules, r)) continue;
      if (node.type === "dir") {
        if (!Object.keys(node.children).length) continue;
        walk(`${abs}/${name}`, r);
      } else out.set(r, node.content);
    }
  };
  walk(contextDir, "");
  return out;
}

// ---------- running the stages ----------

interface StageState {
  name: string;
  workdir: string;
  env: Record<string, string>;
  args: Record<string, string | undefined>;
  /** Absolute path inside the image to content (markers for big folders). */
  files: Map<string, string>;
  key: string;
  baked: Record<string, string>;
  /** Ran next build. */
  nextBuilt: boolean;
  baseKind: AppKind;
  baseMeta: ImageMeta;
  baseSizeMb: number;
  cmd?: string[];
  entrypoint?: string[];
  exposed: number[];
  healthcheck?: HealthCheck;
  fromRef: string;
}

export interface BuildOpts {
  contextDir: string;
  /** Path to the Dockerfile, relative to the context unless absolute. */
  dockerfile?: string;
  tag: string;
  buildArgs?: Record<string, string>;
  target?: string;
  noCache?: boolean;
  /** Compose service name: prefixes step labels ("[app builder 3/6]"). */
  service?: string;
  /** No buildx plugin: the old builder's "Step 1/8" output. */
  legacy?: boolean;
  /** Do not move the sim clock (a CI job builds inside a reconciler and keeps its own time). */
  noClock?: boolean;
}

export interface BuildResult {
  ok: boolean;
  lines: string[];
  /** The error line ("failed to solve: ..."), without the "ERROR: " prefix. */
  error?: string;
  ref?: string;
  seconds: number;
}

interface StepRec {
  label: string;
  text: string;
  cached: boolean;
  secs: number;
  stage: number;
  failed?: string;
  /** Same vertex as an earlier line (a repeated FROM): not printed by BuildKit. */
  hidden?: boolean;
  /** For FROM lines: the base image id (the old builder prints it). */
  baseId?: string;
}

interface Sizes {
  ctx: number;
  df: number;
  ignore: number;
}

/** go-units HumanSize: "412B", "1.23kB", "45.6MB". */
function bytesText(n: number): string {
  if (n < 1000) return `${n}B`;
  const units = ["kB", "MB", "GB"];
  let v = n / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${Number(v.toPrecision(3))}${units[i]}`;
}

const BIG: Record<string, number> = { node_modules: 180, ".next": 30, standalone: 22 };

function sub(s: string, vars: Record<string, string | undefined>): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, a, def, b) => vars[a ?? b] ?? def ?? "");
}

function jsonOrShell(args: string): string[] {
  const t = args.trim();
  if (t.startsWith("[")) {
    try {
      const v = JSON.parse(t);
      if (Array.isArray(v)) return v.map(String);
    } catch {
      // fall through to shell form
    }
  }
  return ["/bin/sh", "-c", t];
}

function abs(workdir: string, p: string): string {
  return resolvePath(workdir, p, "/root");
}

/** Build an image from a context folder. Moves the clock by however long the build took. */
export function buildImage(w: World, host: Host, opts: BuildOpts): BuildResult {
  const lines: string[] = [];
  const prefix = opts.service ? `${opts.service} ` : "";
  const fail = (error: string, secs = 0.1): BuildResult => ({ ok: false, lines, error, seconds: secs });
  if (!getDir(host, opts.contextDir)) return fail(`unable to prepare context: path "${opts.contextDir}" not found`);
  const dfPath = opts.dockerfile?.startsWith("/") ? opts.dockerfile : `${opts.contextDir}/${opts.dockerfile ?? "Dockerfile"}`;
  const dfFile = getFile(host, dfPath);
  if (!dfFile) return fail(`failed to solve: failed to read dockerfile: open ${opts.dockerfile ?? "Dockerfile"}: no such file or directory`);
  const parsed = parseDockerfile(dfFile.content);
  if (parsed.error) return fail(`failed to solve: ${parsed.error}`);
  const ctx = contextFiles(host, opts.contextDir);
  const buildArgs = opts.buildArgs ?? {};
  const cache = (host.docker.buildCache ??= {});
  const globals: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(parsed.globalArgs)) globals[k] = buildArgs[k] ?? v;

  // Which stages the target needs (BuildKit skips the rest).
  const stages = parsed.stages;
  let targetIdx = stages.length - 1;
  const target = opts.target;
  if (target) {
    targetIdx = stages.findIndex((s) => s.name === target.toLowerCase());
    if (targetIdx < 0) return fail(`failed to solve: target stage "${opts.target}" could not be found`);
  }
  const stageIndex = (ref: string) => {
    const byName = stages.findIndex((s) => s.name === ref.toLowerCase());
    if (byName >= 0) return byName;
    return /^\d+$/.test(ref) ? Number(ref) : -1;
  };
  const needed = new Set<number>();
  const need = (i: number) => {
    if (needed.has(i)) return;
    needed.add(i);
    const st = stages[i];
    const fromStage = stageIndex(sub(st.from, globals));
    if (fromStage >= 0 && fromStage < i) need(fromStage);
    for (const ins of st.instrs) {
      if ((ins.op === "COPY" || ins.op === "ADD") && ins.flags.from) {
        const j = stageIndex(ins.flags.from);
        if (j >= 0 && j < i) need(j);
      }
    }
  };
  need(targetIdx);
  const run = opts.legacy ? stages.map((s) => s.index).filter((i) => i <= targetIdx) : [...needed].sort((a, b) => a - b);
  const multi = stages.length > 1;

  const states: StageState[] = [];
  const steps: StepRec[] = [];
  const baseRefs: string[] = [];
  let ctxBytes = 0;
  for (const v of ctx.values()) ctxBytes += v.length;
  const sizes: Sizes = { ctx: ctxBytes, df: dfFile.content.length, ignore: getFile(host, `${opts.contextDir}/.dockerignore`)?.content.length ?? 0 };

  for (const si of run) {
    const st = stages[si];
    const fromRef = sub(st.from, globals);
    const label = st.name ?? (multi ? `stage-${si}` : "");
    const counted = st.instrs.filter((x) => ["RUN", "COPY", "ADD", "WORKDIR"].includes(x.op) || opts.legacy).length + 1;
    let n = 1;
    const stepLabel = () => `[${prefix}${label ? label + " " : ""}${n}/${counted}]`;
    let s: StageState;
    const fromStage = stageIndex(fromRef);
    if (fromStage >= 0 && fromStage < si && states[fromStage]) {
      const p = states[fromStage];
      s = { ...p, name: label, files: new Map(p.files), env: { ...p.env }, args: {}, baked: { ...p.baked }, exposed: [...p.exposed] };
      steps.push({ label: stepLabel(), text: `FROM ${p.name}`, cached: true, secs: 0, stage: si, hidden: true });
    } else {
      const local = localImage(host, fromRef);
      const remote = findRemote(w, fromRef);
      const base = remote ?? (local ? { ...local, meta: local.meta ?? {} } : undefined);
      if (!base) {
        const full = fullRef(fromRef);
        steps.push({ label: stepLabel(), text: `FROM ${full}`, cached: false, secs: 0.6, stage: si, failed: "" });
        lines.push(...renderSteps(steps, opts, sizes, baseRefs, false));
        return fail(`failed to solve: ${fromRef}: failed to resolve source metadata for ${full}: ${full}: not found`, 0.6);
      }
      // BuildKit shows one FROM line per base image, however many stages use it.
      const seen = baseRefs.includes(fullRef(fromRef));
      if (!seen) baseRefs.push(fullRef(fromRef));
      s = {
        name: label,
        workdir: base.meta.workdir ?? "/",
        env: { ...(base.meta.env ?? {}) },
        args: {},
        files: new Map((base.meta.files ?? []).map((f) => [f, ""])),
        key: hashHex(`FROM|${normalizeRef(fromRef)}|${base.id}`, 16),
        baked: { ...(base.meta.baked ?? {}) },
        nextBuilt: false,
        baseKind: base.kind,
        baseMeta: base.meta,
        baseSizeMb: base.sizeMb,
        cmd: base.meta.cmd,
        entrypoint: base.meta.entrypoint,
        exposed: [...(base.meta.exposed ?? [])],
        healthcheck: base.meta.healthcheck,
        fromRef,
      };
      steps.push({ label: stepLabel(), text: `FROM ${fullRef(fromRef)}@sha256:${hashHex("digest:" + normalizeRef(fromRef), 64)}`, cached: false, secs: 0, stage: si, hidden: seen, baseId: base.id });
    }
    states[si] = s;

    for (const ins of st.instrs) {
      const vars = { ...s.args, ...s.env };
      const text = `${ins.op} ${ins.flags.from ? `--from=${ins.flags.from} ` : ""}${ins.args}`;
      const isStep = ["RUN", "COPY", "ADD", "WORKDIR"].includes(ins.op) || !!opts.legacy;
      let extra = "";
      let secs = 0;
      let failed: string | undefined;
      switch (ins.op) {
        case "WORKDIR":
          s.workdir = abs(s.workdir, sub(ins.args, vars));
          break;
        case "ENV": {
          const a = sub(ins.args, vars);
          const pairs = /^[A-Za-z_][A-Za-z0-9_]*=/.test(a) ? (a.match(/[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)/g) ?? []) : [a.replace(/\s+/, "=")];
          for (const p of pairs) {
            const i = p.indexOf("=");
            s.env[p.slice(0, i)] = p.slice(i + 1).replace(/^["']|["']$/g, "");
          }
          break;
        }
        case "ARG": {
          const [k, ...v] = ins.args.split("=");
          const val = buildArgs[k] ?? (v.length ? v.join("=").replace(/^["']|["']$/g, "") : globals[k]);
          s.args[k] = val;
          extra = `${k}=${val ?? ""}`;
          break;
        }
        case "EXPOSE":
          for (const p of sub(ins.args, vars).split(/\s+/)) if (p) s.exposed.push(Number(p.split("/")[0]));
          break;
        case "CMD":
          s.cmd = jsonOrShell(ins.args);
          break;
        case "ENTRYPOINT":
          s.entrypoint = jsonOrShell(ins.args);
          break;
        case "HEALTHCHECK": {
          const t = ins.args.trim();
          if (/^NONE$/i.test(t)) s.healthcheck = undefined;
          else {
            const cmd = t.replace(/^CMD\s+/i, "");
            const test = cmd.startsWith("[") ? ["CMD", ...jsonOrShell(cmd)] : ["CMD-SHELL", cmd];
            s.healthcheck = {
              test,
              interval: parseDuration(ins.flags.interval, 30),
              timeout: parseDuration(ins.flags.timeout, 30),
              retries: ins.flags.retries ? Number(ins.flags.retries) : 3,
              startPeriod: parseDuration(ins.flags["start-period"], 0),
            };
          }
          break;
        }
        case "COPY":
        case "ADD": {
          const json = jsonOrShell(ins.args);
          const parts = json[0] === "/bin/sh" && json[1] === "-c" ? splitWords(sub(ins.args, vars)) : json.map((x) => sub(x, vars));
          const dest = parts[parts.length - 1];
          const srcs = parts.slice(0, -1);
          const destAbs = abs(s.workdir, dest);
          const destIsDir = dest.endsWith("/") || dest === "." || srcs.length > 1;
          const added: [string, string][] = [];
          const from = ins.flags.from;
          if (from) {
            const j = stageIndex(from);
            const srcState = j >= 0 ? states[j] : undefined;
            if (!srcState) {
              extra = from;
              break;
            }
            for (const src of srcs) {
              const sp = abs("/", src).replace(/\/$/, "");
              let hit = false;
              for (const [p, c] of srcState.files) {
                if (p === sp) {
                  hit = true;
                  added.push([destIsDir ? `${destAbs}/${p.split("/").pop()}` : destAbs, c]);
                } else if (p.startsWith(sp + "/")) {
                  hit = true;
                  added.push([`${destAbs}${p.slice(sp.length)}`, c]);
                }
              }
              if (!hit) {
                failed = `failed to compute cache key: failed to calculate checksum of ref ${hashHex("ref" + sp, 8)}-${hashHex("ref2" + sp, 4)}::${hashHex(sp, 25)}: "${sp}": not found`;
                break;
              }
              if ([...added].some(([p]) => p.includes("/.next"))) Object.assign(s.baked, srcState.baked);
            }
            extra = srcState.key;
          } else {
            for (const src of srcs) {
              const sp = src.replace(/^\.\//, "").replace(/\/$/, "");
              let hit = false;
              for (const [rel, c] of ctx) {
                if (sp === "." || sp === "") {
                  hit = true;
                  added.push([`${destAbs}/${rel}`, c]);
                } else if (rel === sp || globMatch(sp, rel)) {
                  hit = true;
                  added.push([destIsDir ? `${destAbs}/${rel.split("/").pop()}` : destAbs, c]);
                } else if (rel.startsWith(sp + "/")) {
                  hit = true;
                  added.push([`${destAbs}/${rel.slice(sp.length + 1)}`, c]);
                }
              }
              if (!hit) {
                failed = `failed to compute cache key: failed to calculate checksum of ref ${hashHex("ref" + sp, 8)}-${hashHex("ref2" + sp, 4)}::${hashHex(sp, 25)}: "/${sp}": not found`;
                break;
              }
            }
            extra = hashHex(added.map(([p, c]) => `${p}\n${c}`).join("\n\0"), 16);
          }
          for (const [p, c] of added) s.files.set(p.replace(/\/+/g, "/"), c);
          secs = failed ? 0 : 0.1;
          break;
        }
        case "RUN": {
          const cmd = sub(ins.args, vars);
          const wd = s.workdir === "/" ? "" : s.workdir;
          extra = JSON.stringify(s.args);
          if (/\bnpm ci\b/.test(cmd)) {
            secs = 8.2;
            if (!s.files.has(`${wd}/package-lock.json`) && !s.files.has(`${wd}/npm-shrinkwrap.json`)) {
              failed = "npm error code EUSAGE\nnpm error\nnpm error The `npm ci` command can only install with an existing package-lock.json or\nnpm error npm-shrinkwrap.json with lockfileVersion >= 1. Run an install with npm@5 or\nnpm error later to generate a package-lock.json file, then try again.|1";
              secs = 1.4;
            } else s.files.set(`${wd}/node_modules`, "");
          } else if (/\b(npm (install|i)|yarn( install)?|pnpm (install|i))\s*($|&&|;|--)/.test(cmd + " ")) {
            secs = 9.4;
            s.files.set(`${wd}/node_modules`, "");
          }
          if (!failed && /\b(npm run build|next build|yarn build|pnpm( run)? build)\b/.test(cmd)) {
            secs += 24.6;
            if (!s.files.has(`${wd}/node_modules`)) {
              failed = "\n> build\n> next build\n\nsh: next: not found|127";
              secs = 0.4;
            } else {
              // next build reads .env files and NEXT_PUBLIC_ env, and freezes NEXT_PUBLIC_* into the bundle.
              const fromFiles: Record<string, string> = {};
              for (const f of [".env", ".env.production"]) {
                const t = s.files.get(`${wd}/${f}`);
                if (t) for (const [k, v] of Object.entries(dotenvLite(t))) fromFiles[k] = v;
              }
              const all = { ...fromFiles, ...Object.fromEntries(Object.entries({ ...s.args, ...s.env }).filter(([, v]) => v !== undefined)) } as Record<string, string>;
              for (const [k, v] of Object.entries(all)) if (k.startsWith("NEXT_PUBLIC_")) s.baked[k] = v;
              s.nextBuilt = true;
              s.files.set(`${wd}/.next/BUILD_ID`, hashHex(s.key, 21));
              s.files.set(`${wd}/.next/static/chunks`, "");
              const conf = [...s.files.entries()].find(([p]) => /\/next\.config\.(js|mjs|ts|cjs)$/.test(p) && p.startsWith(wd + "/"));
              if (conf && /standalone/.test(conf[1])) {
                s.files.set(`${wd}/.next/standalone/server.js`, "// next standalone server");
                s.files.set(`${wd}/.next/standalone/package.json`, "{}");
                s.files.set(`${wd}/.next/standalone/node_modules`, "");
              }
            }
          }
          if (!secs) secs = /apk add|apt-get|apt /.test(cmd) ? 3.1 : 0.6;
          break;
        }
        default:
          break;
      }
      s.key = hashHex(`${s.key}|${text}|${extra}`, 16);
      if (!isStep) continue;
      n++;
      const cached = !opts.noCache && !!cache[s.key] && !failed;
      steps.push({ label: stepLabel(), text, cached, secs: cached ? 0 : secs, stage: si, failed: failed !== undefined ? failed : undefined });
      if (failed !== undefined) {
        lines.push(...renderSteps(steps, opts, sizes, baseRefs, false));
        const [msg, code] = failed.split("|");
        if (ins.op === "RUN") {
          return fail(`failed to solve: process "/bin/sh -c ${ins.args}" did not complete successfully: exit code: ${code ?? 1}`, totalSecs(steps));
        }
        void msg;
        return fail(`failed to solve: ${msg}`, totalSecs(steps));
      }
      cache[s.key] = w.clock;
    }
  }

  const fin = states[targetIdx];
  const ref = normalizeRef(opts.tag);
  const id = hashHex(`image|${fin.key}`, 12);
  const kind: AppKind =
    run.some((i) => states[i]?.nextBuilt) || (fin.cmd ?? []).some((x) => /server\.js$/.test(x)) || (fin.cmd ?? []).join(" ").includes("next start")
      ? "nextjs"
      : fin.baseKind;
  const required = new Set<string>();
  for (const i of run) {
    for (const c of states[i]?.files.values() ?? []) {
      for (const m of c.matchAll(/if\s*\(\s*!\s*process\.env\.([A-Z][A-Z0-9_]*)\s*\)\s*\{?\s*throw/g)) required.add(m[1]);
      for (const m of c.matchAll(/requireEnv\(\s*["'`]([A-Z][A-Z0-9_]*)["'`]\s*\)/g)) required.add(m[1]);
    }
  }
  const files = collapse([...fin.files.keys()]);
  let size = fin.baseSizeMb;
  for (const f of files) {
    const last = f.split("/").pop() ?? "";
    size += BIG[last] ?? 0;
  }
  for (const [p, c] of fin.files) if (!(fin.baseMeta.files ?? []).includes(p)) size += c.length / 1e6;
  const meta: ImageMeta = {
    flavor: fin.baseMeta.flavor,
    version: fin.baseMeta.version,
    env: fin.env,
    ...(fin.entrypoint ? { entrypoint: fin.entrypoint } : {}),
    ...(fin.cmd ? { cmd: fin.cmd } : {}),
    exposed: [...new Set(fin.exposed)],
    ...(required.size ? { requiredEnv: [...required] } : {}),
    baked: fin.baked,
    files,
    workdir: fin.workdir,
    ...(fin.healthcheck ? { healthcheck: fin.healthcheck } : {}),
    built: true,
  };
  const prev = host.docker.images[ref];
  host.docker.images[ref] = { ref, id, sizeMb: Math.round(size * 10) / 10, kind, createdAt: prev?.id === id ? prev.createdAt : w.clock, meta };
  const secs = totalSecs(steps) + 1.6;
  lines.push(...renderSteps(steps, opts, sizes, baseRefs, true, ref, id));
  if (!opts.noClock) advance(w, w.clock + Math.ceil(secs));
  return { ok: true, lines, ref, seconds: secs };
}

function totalSecs(steps: StepRec[]): number {
  return Math.round(steps.reduce((t, s) => t + s.secs, 0) * 10) / 10;
}

function dotenvLite(t: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of t.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Keep the image file list short: anything inside node_modules or .next/static folds into the folder. */
function collapse(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const m = /^(.*?\/(?:node_modules|\.next\/static|\.git))(\/.*)?$/.exec(p);
    out.add(m ? m[1] : p);
  }
  return [...out].sort().slice(0, 300);
}

/** One BuildKit line: cut to the terminal width, time on the right. */
function row(text: string, secs: number): string {
  const t = `${secs.toFixed(1)}s`;
  const line = ` => ${text}`;
  return (line.length > 78 ? line.slice(0, 78) : line.padEnd(78)) + " " + t;
}

function renderSteps(allSteps: StepRec[], opts: BuildOpts, sizes: Sizes, bases: string[], ok: boolean, ref?: string, id?: string): string[] {
  if (opts.legacy) return renderLegacy(allSteps, ok, ref, id, sizes.ctx);
  const steps = allSteps.filter((s) => !s.hidden);
  const p = opts.service ? `${opts.service} ` : "";
  const total = Math.round((totalSecs(steps) + 1.6) * 10) / 10;
  const count = steps.length + 5;
  const done = ok ? count : count - 2;
  const out = [`[+] Building ${total}s (${done}/${count})${ok ? " FINISHED" : ""}`.padEnd(70) + "docker:default"];
  out.push(row(`[${p}internal] load build definition from ${opts.dockerfile?.split("/").pop() ?? "Dockerfile"}`, 0), row(`=> transferring dockerfile: ${bytesText(sizes.df)}`, 0));
  for (const b of bases) out.push(row(`[${p}internal] load metadata for ${b}`, 1.2));
  out.push(row(`[${p}internal] load .dockerignore`, 0), row(`=> transferring context: ${bytesText(sizes.ignore || 2)}`, 0));
  let ctxShown = false;
  for (const s of steps) {
    if (!ctxShown && /^(COPY|ADD) (?!--from)/.test(s.text)) {
      out.push(row(`[${p}internal] load build context`, 0.1), row(`=> transferring context: ${bytesText(sizes.ctx || 2)}`, 0.1));
      ctxShown = true;
    }
    if (s.failed !== undefined) {
      out.push(row(`ERROR ${s.label} ${s.text}`, s.secs));
      const [msg] = s.failed.split("|");
      if (msg) {
        out.push("------", ` > ${s.label} ${s.text}:`);
        for (const l of msg.split("\n")) out.push(`0.412 ${l}`);
        out.push("------");
      }
      continue;
    }
    out.push(row(`${s.cached ? "CACHED " : ""}${s.label} ${s.text}`, s.secs));
  }
  if (ok && ref && id) {
    out.push(
      row(`exporting to image`, 0.3),
      row(`=> exporting layers`, 0.2),
      row(`=> writing image sha256:${id}${hashHex("img" + id, 52)}`, 0),
      row(`=> naming to ${fullRef(ref)}`, 0),
    );
  }
  return out;
}

function renderLegacy(steps: StepRec[], ok: boolean, ref: string | undefined, id: string | undefined, ctxBytes: number): string[] {
  const out = [
    "DEPRECATED: The legacy builder is deprecated and will be removed in a future release.",
    "            Install the buildx component to build images with BuildKit:",
    "            https://docs.docker.com/go/buildx/",
    "",
    `Sending build context to Docker daemon  ${bytesText(Math.max(ctxBytes, 2048))}`,
  ];
  const total = steps.length;
  steps.forEach((s, i) => {
    out.push(`Step ${i + 1}/${total} : ${s.text.replace(/^FROM (\S+?)@sha256:\S+/, "FROM $1").replace(/^FROM docker\.io\/library\//, "FROM ")}`);
    if (s.failed !== undefined) {
      const [msg, code] = s.failed.split("|");
      out.push(` ---> Running in ${hashHex("run" + i, 12)}`, ...msg.split("\n"));
      out.push(`The command '/bin/sh -c ${s.text.replace(/^RUN /, "")}' returned a non-zero code: ${code ?? 1}`);
      return;
    }
    if (s.cached) out.push(" ---> Using cache");
    else if (s.text.startsWith("RUN")) out.push(` ---> Running in ${hashHex("run" + i + s.text, 12)}`);
    out.push(` ---> ${s.baseId ?? hashHex("layer" + i + s.text, 12)}`);
  });
  if (ok && ref && id) out.push(`Successfully built ${id}`, `Successfully tagged ${ref}`);
  return out;
}
