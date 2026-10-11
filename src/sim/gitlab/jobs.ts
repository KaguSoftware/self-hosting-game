// Running one CI job, by meaning. Each job gets a brand new container: a clean checkout of
// the commit, its variables, and nothing else (no node_modules from an earlier job unless
// that job passed them on as artifacts). Script lines are interpreted the way the real
// tools would answer, and the log reads like gitlab-runner 17.
import { checkLogin, GITLAB_REGISTRY, jobTokenFor, readAuths, registryOf, saveLogin, withDockerClient } from "../docker/auth";
import { buildImage } from "../docker/dockerfile";
import { digestOf, findRemote, normalizeRef, pullImage, repoOf, tagOf } from "../docker/images";
import { dir, file, getDir, getFile, getNode, mkdirp, put, removeNode, resolvePath, userGroups } from "../fs";
import { resolveName, traceHttp } from "../net";
import { keyBody, sshCheck, strictModesProblem } from "../sshAuth";
import { runningSshd } from "../sshd";
import { parse, ParseError, type Sequence } from "../shell/parse";
import { runDetached } from "../shell/run";
import { hhmmss } from "../time";
import type { FsNode, Host, HostId, World } from "../types";
import { hashB64, hashHex } from "../util";
import { RUNNER_REVISION, RUNNER_VERSION, shortSha } from "./state";
import type { CiJob, GitLabState, Pipeline, Runner } from "./types";

export const BUILDS_DIR = "/builds/crumb/web";
/** Where GitLab.com's runners come from, as the VPS sees them. */
export const RUNNER_IP = "34.74.226.18";

export interface JobResult {
  status: "success" | "failed";
  log: string[];
  artifacts?: Record<string, string>;
  failureReason?: string;
}

interface Env {
  w: World;
  gl: GitLabState;
  p: Pipeline;
  job: CiJob;
  runner: Runner;
  host: Host;
  cwd: string;
  vars: Record<string, string>;
  tools: Set<string>;
  image: string;
  alpine: boolean;
  bash: boolean;
  daemon: boolean;
  agent: boolean;
  agentKeys: string[];
  log: string[];
  line: number;
}

// ---------- images ----------

const BASE_TOOLS = ["sh", "echo", "printf", "cat", "ls", "mkdir", "chmod", "rm", "cd", "export", "pwd", "true", "false", "test", "[", "env", "printenv", "sleep", "set", "unset", "touch", "cp", "tr", "base64", "grep", "eval", "which", "whoami", "id", "uname", "date", "head", "tail", "wc", "exit"];

const KNOWN_IMAGES = /^(node|docker|alpine|ubuntu|debian|python|ruby|busybox|bash|nginx|postgres|caddy|golang)$/;

function imageName(img: string): { name: string; tag: string } {
  const n = normalizeRef(img);
  return { name: repoOf(n).replace(/^library\//, ""), tag: tagOf(n) };
}

function imageKnown(w: World, img: string): boolean {
  const { name, tag } = imageName(img);
  if (findRemote(w, img)) return true;
  if (!KNOWN_IMAGES.test(name)) return false;
  if (name === "node") return /^(latest|lts|lts-alpine|alpine|current|\d{2}(\.\d+)*(-(alpine|slim|bookworm|bullseye|alpine3\.\d+))?)$/.test(tag);
  return /^[\w.-]+$/.test(tag);
}

function imageTools(img: string): { tools: Set<string>; alpine: boolean; bash: boolean } {
  const { name, tag } = imageName(img);
  const tools = new Set(BASE_TOOLS);
  const alpine = name === "alpine" || name === "docker" || name === "busybox" || tag.includes("alpine");
  const debian = !alpine && ["node", "ubuntu", "debian", "python", "ruby", "golang", "bash"].includes(name);
  if (alpine && name !== "busybox") tools.add("apk");
  if (debian) ["apt-get", "apt", "bash"].forEach((t) => tools.add(t));
  if (name === "node") {
    ["node", "npm", "npx", "yarn"].forEach((t) => tools.add(t));
    if (!alpine) ["git", "curl", "ssh", "ssh-keyscan", "ssh-add", "ssh-agent", "scp"].forEach((t) => tools.add(t));
  }
  if (name === "docker") ["docker", "git", "ssh", "ssh-keyscan", "ssh-add", "ssh-agent", "scp"].forEach((t) => tools.add(t));
  if (name === "python") ["python", "python3", "pip", "git", "curl"].forEach((t) => tools.add(t));
  return { tools, alpine, bash: tools.has("bash") };
}

const PKG_TOOLS: Record<string, string[]> = {
  "openssh-client": ["ssh", "ssh-keyscan", "ssh-add", "ssh-agent", "scp"],
  "openssh-client-default": ["ssh", "ssh-keyscan", "ssh-add", "ssh-agent", "scp"],
  openssh: ["ssh", "ssh-keyscan", "ssh-add", "ssh-agent", "scp"],
  git: ["git"],
  curl: ["curl"],
  bash: ["bash"],
  nodejs: ["node"],
  npm: ["npm", "npx"],
  "docker-cli": ["docker"],
  rsync: ["rsync"],
};

function sha256(seed: string): string {
  return `sha256:${hashHex(seed, 64)}`;
}

// ---------- the job's filesystem ----------

function jobHost(): Host {
  return {
    id: "runner" as HostId,
    hostname: "runner",
    privateIp: "172.17.0.3",
    os: "Linux",
    cpus: 2,
    memMb: 8192,
    diskGb: 20,
    baseUsedMb: 0,
    fs: dir(0o755, "root", "root", {}),
    users: { root: { name: "root", uid: 0, home: "/root", shell: "/bin/sh" } },
    groups: { root: { name: "root", gid: 0, members: [] } },
    packages: {},
    aptFresh: true,
    services: {},
    ufw: { enabled: false, defaultIncoming: "allow", rules: [] },
    docker: { images: {}, containers: {}, volumes: {}, networks: {} },
    journal: [],
    crontabs: {},
  };
}

function writeTree(h: Host, root: string, files: Record<string, string>): void {
  for (const [p, c] of Object.entries(files)) put(h, `${root}/${p}`, file(c, 0o644));
}

function collect(h: Host, root: string, rel: string): Record<string, string> {
  const out: Record<string, string> = {};
  const clean = rel.replace(/^\.\//, "").replace(/\/+$/, "");
  const walk = (abs: string, r: string) => {
    const n = getNode(h, abs);
    if (!n) return;
    if (n.type === "file") out[r] = n.content;
    else for (const [name] of Object.entries(n.children)) walk(`${abs}/${name}`, `${r}/${name}`);
  };
  walk(`${root}/${clean}`, clean);
  return out;
}

function countEntries(n: FsNode | undefined): number {
  if (!n) return 0;
  if (n.type === "file") return 1;
  return 1 + Object.values(n.children).reduce((t, c) => t + countEntries(c), 0);
}

// ---------- variables ----------

/** Expand $VAR and ${VAR} inside a variable value, once (GitLab expands file and job variables). */
function expandOnce(v: string, vars: Record<string, string>): string {
  return v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => vars[a ?? b] ?? m);
}

export function slug(ref: string): string {
  return ref.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
}

/** Predefined variables every job of this pipeline sees. */
export function predefinedVars(gl: GitLabState, p: Pipeline, job?: CiJob, runner?: Runner): Record<string, string> {
  const c = gl.commits[p.sha];
  const mr = p.mergeRequest !== undefined ? gl.mergeRequests.find((m) => m.iid === p.mergeRequest) : undefined;
  const v: Record<string, string> = {
    CI: "true",
    GITLAB_CI: "true",
    CI_SERVER_HOST: "gitlab.com",
    CI_SERVER_URL: "https://gitlab.com",
    CI_PROJECT_PATH: gl.project.path,
    CI_PROJECT_NAME: gl.project.name,
    CI_PROJECT_NAMESPACE: gl.project.path.split("/")[0],
    CI_PROJECT_DIR: BUILDS_DIR,
    CI_PROJECT_URL: gl.project.webUrl,
    CI_DEFAULT_BRANCH: gl.project.defaultBranch,
    CI_COMMIT_SHA: p.sha,
    CI_COMMIT_SHORT_SHA: shortSha(p.sha, 8),
    CI_COMMIT_REF_NAME: p.ref,
    CI_COMMIT_REF_SLUG: slug(p.ref),
    CI_COMMIT_REF_PROTECTED: String(p.protectedRef),
    CI_COMMIT_MESSAGE: c?.message ?? "",
    CI_COMMIT_TITLE: (c?.message ?? "").split("\n")[0],
    CI_PIPELINE_ID: String(p.id),
    CI_PIPELINE_IID: String(p.iid),
    CI_PIPELINE_SOURCE: p.source,
    CI_REGISTRY: GITLAB_REGISTRY,
    CI_REGISTRY_IMAGE: `${GITLAB_REGISTRY}/${gl.project.path}`,
    CI_REGISTRY_USER: "gitlab-ci-token",
  };
  if (p.source !== "merge_request_event") v.CI_COMMIT_BRANCH = p.ref;
  if (mr) {
    v.CI_MERGE_REQUEST_IID = String(mr.iid);
    v.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME = mr.source;
    v.CI_MERGE_REQUEST_TARGET_BRANCH_NAME = mr.target;
    v.CI_MERGE_REQUEST_TITLE = mr.title;
  }
  if (job) {
    const token = jobTokenFor(job.id);
    Object.assign(v, {
      CI_JOB_ID: String(job.id),
      CI_JOB_NAME: job.name,
      CI_JOB_STAGE: job.stage,
      CI_JOB_TOKEN: token,
      CI_REGISTRY_PASSWORD: token,
      CI_JOB_URL: `${gl.project.webUrl}/-/jobs/${job.id}`,
    });
  }
  if (runner) {
    v.CI_RUNNER_ID = String(runner.id);
    v.CI_RUNNER_DESCRIPTION = runner.description;
    v.CI_RUNNER_TAGS = JSON.stringify(runner.tags);
  }
  return v;
}

/** Project CI/CD variables this pipeline may see. Protected ones only reach protected refs. */
export function visibleVars(gl: GitLabState, protectedRef: boolean) {
  return gl.variables.filter((v) => !v.protected || protectedRef);
}

/** GitLab only masks single-line values of at least 8 characters. */
export function maskable(value: string): boolean {
  return value.length >= 8 && !/[\n\r]/.test(value);
}

// ---------- output helpers ----------

function out(e: Env, s: string): void {
  for (const l of s.split("\n")) e.log.push(l);
}

function notFound(e: Env, cmd: string): number {
  out(e, e.bash ? `/usr/bin/bash: line ${e.line}: ${cmd}: command not found` : `/bin/sh: eval: line ${e.line}: ${cmd}: not found`);
  return 127;
}

function noSuchFile(e: Env, prog: string, p: string): string {
  return e.alpine ? `${prog}: ${p}: No such file or directory` : `${prog}: cannot access '${p}': No such file or directory`;
}

interface Io {
  stdin?: string;
  stdout: string[];
}

function abs(e: Env, p: string): string {
  return resolvePath(e.cwd, p, "/root");
}

// ---------- the tools ----------

function npmScriptCmd(e: Env, script: string, io: Io): number {
  const first = script.trim().split(/\s+/)[0];
  const hasModules = !!getDir(e.host, `${e.cwd}/node_modules`);
  const local = ["next", "vitest", "jest", "eslint", "tsc", "prisma", "playwright"];
  if (local.includes(first) && !hasModules) {
    out(e, `sh: ${first}: not found`);
    return 127;
  }
  if (first === "next" && /\bbuild\b/.test(script)) return nextBuild(e);
  if (first === "vitest" || first === "jest") return runTests(e);
  if (first === "eslint" || first === "tsc" || first === "next") return 0;
  return runLine(e, script, io.stdout);
}

function nextBuild(e: Env): number {
  const pub = Object.entries(e.vars).filter(([k]) => k.startsWith("NEXT_PUBLIC_"));
  out(
    e,
    [
      `   ▲ Next.js 16.0.0`,
      ...(pub.length ? [`   - Environments: ${pub.map(([k]) => k).join(", ")}`] : []),
      ``,
      `   Creating an optimized production build ...`,
      ` ✓ Compiled successfully in 11.8s`,
      ` ✓ Collecting page data`,
      ` ✓ Generating static pages (4/4)`,
      ` ✓ Collecting build traces`,
      ` ✓ Finalizing page optimization`,
      ``,
      `Route (app)                                 Size  First Load JS`,
      `┌ ○ /                                      142 B         102 kB`,
      `└ ○ /_not-found                            995 B         103 kB`,
      `+ First Load JS shared by all             102 kB`,
      ``,
      `○  (Static)  prerendered as static content`,
    ].join("\n"),
  );
  put(e.host, `${e.cwd}/.next/BUILD_ID`, file(hashHex(e.p.sha + "build", 21)));
  put(e.host, `${e.cwd}/.next/standalone/server.js`, file("// next standalone server"));
  put(e.host, `${e.cwd}/.next/static/chunks/main.js`, file("// chunk"));
  return 0;
}

function runTests(e: Env): number {
  const files: [string, string][] = [];
  const walk = (a: string, r: string) => {
    const d = getDir(e.host, a);
    if (!d) return;
    for (const [n, node] of Object.entries(d.children)) {
      if (n === "node_modules" || n === ".next") continue;
      if (node.type === "dir") walk(`${a}/${n}`, r ? `${r}/${n}` : n);
      else if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(n)) files.push([r ? `${r}/${n}` : n, node.content]);
    }
  };
  walk(e.cwd, "");
  const lines = [``, ` RUN  v3.2.4 ${e.cwd}`, ``];
  if (!files.length) {
    out(e, [...lines, `No test files found, exiting with code 1`].join("\n"));
    return 1;
  }
  let passed = 0;
  let failed = 0;
  let failedFiles = 0;
  for (const [p, c] of files) {
    const n = Math.max(1, (c.match(/\b(it|test)\(/g) ?? []).length);
    // A test that throws, or expects something false, fails.
    const broken = /throw new Error|expect\(false\)\.toBe\(true\)/.test(c);
    if (broken) {
      failed += 1;
      passed += n - 1;
      failedFiles++;
      lines.push(` ❯ ${p} (${n} tests | 1 failed) 7ms`, `   × ${/(?:it|test)\(\s*["'`]([^"'`]+)/.exec(c)?.[1] ?? "test"} 3ms`);
    } else {
      passed += n;
      lines.push(` ✓ ${p} (${n} tests) 4ms`);
    }
  }
  lines.push(
    ``,
    ` Test Files  ${failedFiles ? `${failedFiles} failed | ` : ""}${files.length - failedFiles} passed (${files.length})`,
    `      Tests  ${failed ? `${failed} failed | ` : ""}${passed} passed (${passed + failed})`,
    `   Start at  ${hhmmss(e.w.clock)}`,
    `   Duration  412ms`,
  );
  out(e, lines.join("\n"));
  return failed ? 1 : 0;
}

function readPkg(e: Env): { name: string; version?: string; scripts: Record<string, string> } | number {
  const f = getFile(e.host, `${e.cwd}/package.json`);
  if (!f) {
    out(
      e,
      [
        `npm error code ENOENT`,
        `npm error syscall open`,
        `npm error path ${e.cwd}/package.json`,
        `npm error errno -2`,
        `npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open '${e.cwd}/package.json'`,
        `npm error enoent This is related to npm not being able to find a file.`,
      ].join("\n"),
    );
    return 254;
  }
  try {
    const j = JSON.parse(f.content);
    return { name: j.name ?? "app", version: j.version, scripts: j.scripts ?? {} };
  } catch {
    out(e, `npm error code EJSONPARSE\nnpm error JSON.parse Invalid package.json: JSONParseError: Unexpected token in JSON`);
    return 1;
  }
}

function npm(e: Env, argv: string[], io: Io): number {
  const sub = argv[1];
  if (sub === "-v" || sub === "--version") {
    io.stdout.push("11.6.1");
    return 0;
  }
  const pkg = readPkg(e);
  if (typeof pkg === "number") return pkg;
  if (sub === "ci" || sub === "install" || sub === "i") {
    if (sub === "ci" && !getFile(e.host, `${e.cwd}/package-lock.json`)) {
      out(
        e,
        "npm error code EUSAGE\nnpm error\nnpm error The `npm ci` command can only install with an existing package-lock.json or\nnpm error npm-shrinkwrap.json with lockfileVersion >= 1. Run an install with npm@5 or\nnpm error later to generate a package-lock.json file, then try again.",
      );
      return 1;
    }
    put(e.host, `${e.cwd}/node_modules/.package-lock.json`, file("{}"));
    put(e.host, `${e.cwd}/node_modules/.bin/next`, file("#!/usr/bin/env node", 0o755));
    put(e.host, `${e.cwd}/node_modules/.bin/vitest`, file("#!/usr/bin/env node", 0o755));
    out(e, `\nadded 412 packages, and audited 413 packages in 9s\n\n148 packages are looking for funding\n  run \`npm fund\` for details\n\nfound 0 vulnerabilities`);
    return 0;
  }
  const script = sub === "test" || sub === "t" ? "test" : sub === "run" || sub === "run-script" ? argv[2] : sub === "start" ? "start" : undefined;
  if (!script) {
    out(e, `Unknown command: "${sub ?? ""}"\n\nTo see a list of supported npm commands, run:\n  npm help`);
    return 1;
  }
  const body = pkg.scripts[script];
  if (!body) {
    out(e, `npm error Missing script: "${script}"\nnpm error\nnpm error To see a list of scripts, run:\nnpm error   npm run`);
    return 1;
  }
  out(e, `\n> ${pkg.name}${pkg.version ? "@" + pkg.version : ""} ${script}\n> ${body}\n`);
  return npmScriptCmd(e, body, io);
}

function apk(e: Env, argv: string[]): number {
  const args = argv.slice(1);
  if (args[0] !== "add" && args[0] !== "update") {
    out(e, `apk-tools 2.14.4, compiled for x86_64.`);
    return args[0] ? 1 : 0;
  }
  const pkgs = args.slice(1).filter((a) => !a.startsWith("-"));
  const lines = [`fetch https://dl-cdn.alpinelinux.org/alpine/v3.20/main/x86_64/APKINDEX.tar.gz`, `fetch https://dl-cdn.alpinelinux.org/alpine/v3.20/community/x86_64/APKINDEX.tar.gz`];
  if (args[0] === "update") {
    out(e, [...lines, `v3.20.6-90-g2b0b9b7d3e9 [https://dl-cdn.alpinelinux.org/alpine/v3.20/main]`, `OK: 24170 distinct packages available`].join("\n"));
    return 0;
  }
  const unknown = pkgs.find((p) => !PKG_TOOLS[p] && !["ca-certificates", "jq", "make", "python3", "zip", "unzip"].includes(p));
  if (unknown) {
    out(e, [...lines, `ERROR: unable to select packages:`, `  ${unknown} (no such package):`, `    required by: world[${unknown}]`].join("\n"));
    return 1;
  }
  let i = 0;
  const total = pkgs.length + 2;
  lines.push(`(${++i}/${total}) Installing libedit (20240517.3.1-r0)`, `(${++i}/${total}) Installing libcrypto3 (3.3.3-r0)`);
  for (const p of pkgs) {
    lines.push(`(${++i}/${total}) Installing ${p} (${p.startsWith("openssh") ? "9.7_p1-r5" : "1.0-r0"})`);
    for (const t of PKG_TOOLS[p] ?? []) e.tools.add(t);
  }
  lines.push(`Executing busybox-1.36.1-r29.trigger`, `OK: 14 MiB in ${16 + total} packages`);
  out(e, lines.join("\n"));
  return 0;
}

function aptGet(e: Env, argv: string[]): number {
  const sub = argv.find((a, i) => i > 0 && !a.startsWith("-"));
  if (sub === "update") {
    out(e, [`Get:1 http://deb.debian.org/debian bookworm InRelease [151 kB]`, `Get:2 http://deb.debian.org/debian bookworm/main amd64 Packages [8792 kB]`, `Fetched 8943 kB in 1s (7152 kB/s)`, `Reading package lists...`].join("\n"));
    return 0;
  }
  if (sub === "install") {
    const pkgs = argv.slice(argv.indexOf("install") + 1).filter((a) => !a.startsWith("-"));
    for (const p of pkgs) for (const t of PKG_TOOLS[p] ?? []) e.tools.add(t);
    out(e, [`Reading package lists...`, `Building dependency tree...`, `Reading state information...`, `The following NEW packages will be installed:`, `  ${pkgs.join(" ")}`, `Setting up ${pkgs[pkgs.length - 1] ?? ""} ...`].join("\n"));
    return 0;
  }
  return 0;
}

// ---------- docker inside the job ----------

const DOCKER_ERR = "Cannot connect to the Docker daemon at tcp://docker:2375. Is the docker daemon running?";

function dockerFlag(args: string[], names: string[]): { vals: string[]; rest: string[] } {
  const vals: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = names.find((n) => a.startsWith(n + "="));
    if (eq) vals.push(a.slice(eq.length + 1));
    else if (names.includes(a)) vals.push(args[++i] ?? "");
    else rest.push(a);
  }
  return { vals, rest };
}

const BUILD_VALUED = ["-t", "--tag", "--build-arg", "-f", "--file", "--target", "--platform", "--progress", "--cache-from", "--label", "--network"];

function docker(e: Env, argv: string[], io: Io): number {
  const sub = argv[1];
  const args = argv.slice(2);
  if (sub === "--version" || sub === "-v") {
    io.stdout.push("Docker version 27.3.1, build ce12230");
    return 0;
  }
  if (!e.daemon && sub !== "logout") {
    out(e, sub === "build" ? `ERROR: ${DOCKER_ERR}` : DOCKER_ERR);
    return 1;
  }
  return withDockerClient(e.host, "root", () => {
    switch (sub) {
      case "info":
      case "version":
        io.stdout.push(`Server:\n Engine:\n  Version:          27.3.1\n  API version:      1.47 (minimum version 1.24)\n  OS/Arch:          linux/amd64`);
        return 0;
      case "login":
        return dockerLogin(e, args, io);
      case "logout":
        out(e, `Removing login credentials for ${args[0] ?? "https://index.docker.io/v1/"}`);
        return 0;
      case "build":
      case "buildx":
        return dockerBuild(e, sub === "buildx" ? args.slice(1) : args);
      case "tag": {
        const [src, dst] = args;
        const img = e.host.docker.images[normalizeRef(src ?? "")];
        if (!img || !dst) {
          out(e, `Error response from daemon: No such image: ${src ?? ""}`);
          return 1;
        }
        e.host.docker.images[normalizeRef(dst)] = { ...img, ref: normalizeRef(dst) };
        return 0;
      }
      case "push":
        return dockerPush(e, args);
      case "pull": {
        const ref = args.find((a) => !a.startsWith("-")) ?? "";
        const r = pullImage(e.w, e.host, ref);
        if (!r.ok) {
          out(e, `Error response from daemon: ${r.error}`);
          return 1;
        }
        out(e, [...r.lines, normalizeRef(ref)].join("\n"));
        return 0;
      }
      case "images": {
        const rows = ["REPOSITORY                       TAG       IMAGE ID       CREATED          SIZE"];
        for (const i of Object.values(e.host.docker.images)) rows.push(`${repoOf(i.ref).padEnd(32)} ${tagOf(i.ref).padEnd(9)} ${i.id.slice(0, 12)}   About a minute ago   ${i.sizeMb}MB`);
        io.stdout.push(rows.join("\n"));
        return 0;
      }
      default:
        out(e, `docker: '${sub ?? ""}' is not a docker command.\nSee 'docker --help'`);
        return 1;
    }
  });
}

function dockerLogin(e: Env, args: string[], io: Io): number {
  const u = dockerFlag(args, ["-u", "--username"]);
  const p = dockerFlag(u.rest, ["-p", "--password"]);
  const stdinFlag = p.rest.includes("--password-stdin");
  const server = p.rest.find((a) => !a.startsWith("-")) ?? "https://index.docker.io/v1/";
  const registry = server.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const username = u.vals[u.vals.length - 1] ?? "";
  let password = p.vals[p.vals.length - 1] ?? "";
  if (stdinFlag) password = (io.stdin ?? "").replace(/\n$/, "");
  if (!username || (!password && !stdinFlag)) {
    out(e, "Error: Cannot perform an interactive login from a non TTY device");
    return 1;
  }
  if (p.vals.length) out(e, "WARNING! Using --password via the CLI is insecure. Use --password-stdin.");
  const reg = registry === "index.docker.io" ? "https://index.docker.io/v1/" : registry;
  const check = checkLogin(e.w, registry, { username, password });
  if (!check.ok || !password) {
    out(e, `Error response from daemon: Get "https://${registry === "https://index.docker.io/v1/" ? "registry-1.docker.io" : registry}/v2/": unauthorized: HTTP Basic: Access denied`);
    return 1;
  }
  const path = saveLogin(e.host, "root", reg, { username, password });
  out(
    e,
    [
      `WARNING! Your password will be stored unencrypted in ${path}.`,
      `Configure a credential helper to remove this warning. See`,
      `https://docs.docker.com/engine/reference/commandline/login/#credential-stores`,
      ``,
      `Login Succeeded`,
    ].join("\n"),
  );
  return 0;
}

function dockerBuild(e: Env, args: string[]): number {
  const tags: string[] = [];
  const buildArgs: Record<string, string> = {};
  let dockerfile: string | undefined;
  let target: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const flag = BUILD_VALUED.find((f) => a === f || a.startsWith(f + "="));
    if (!flag) {
      if (!a.startsWith("-")) rest.push(a);
      continue;
    }
    const v = a.includes("=") && a.startsWith(flag + "=") ? a.slice(flag.length + 1) : (args[++i] ?? "");
    if (flag === "-t" || flag === "--tag") tags.push(v);
    else if (flag === "--build-arg") {
      const k = v.indexOf("=");
      if (k < 0) {
        if (v in e.vars) buildArgs[v] = e.vars[v];
      } else buildArgs[v.slice(0, k)] = v.slice(k + 1);
    } else if (flag === "-f" || flag === "--file") dockerfile = v;
    else if (flag === "--target") target = v;
  }
  const ctx = rest[0];
  if (!ctx) {
    out(e, `ERROR: "docker buildx build" requires exactly 1 argument.\nSee 'docker buildx build --help'.\n\nUsage:  docker buildx build [OPTIONS] PATH | URL | -\n\nStart a build`);
    return 1;
  }
  for (const t of tags) {
    if (!/^[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::\d+)?(?:\/[a-z0-9._-]+)*(?::[\w][\w.-]{0,127})?$/.test(t)) {
      out(e, `ERROR: invalid tag "${t}": invalid reference format`);
      return 1;
    }
  }
  const r = buildImage(e.w, e.host, {
    contextDir: abs(e, ctx),
    dockerfile: dockerfile ? abs(e, dockerfile) : undefined,
    tag: tags[0] ?? "<none>:<none>",
    buildArgs,
    target,
    noClock: true,
  });
  if (r.lines.length) out(e, r.lines.join("\n"));
  if (!r.ok) {
    out(e, `ERROR: ${r.error}`);
    return 1;
  }
  const first = e.host.docker.images[normalizeRef(tags[0] ?? "<none>:<none>")];
  if (first) {
    first.meta = { ...(first.meta ?? {}), revision: e.p.sha };
    for (const t of tags.slice(1)) e.host.docker.images[normalizeRef(t)] = { ...first, ref: normalizeRef(t) };
  }
  return 0;
}

function dockerPush(e: Env, args: string[]): number {
  const ref = args.find((a) => !a.startsWith("-"));
  if (!ref) {
    out(e, `"docker push" requires exactly 1 argument.\nSee 'docker push --help'.`);
    return 1;
  }
  const n = normalizeRef(ref);
  const img = e.host.docker.images[n];
  const repo = repoOf(n);
  if (!img) {
    out(e, `An image does not exist locally with the tag: ${ref.includes(":") ? repo : ref}`);
    return 1;
  }
  out(e, `The push refers to repository [${repo.includes("/") && repo.split("/")[0].includes(".") ? repo : `docker.io/${repo.includes("/") ? repo : "library/" + repo}`}]`);
  const registry = registryOf(n);
  const cred = readAuths(e.host, "root")[registry];
  const ownRepo = repo === `${GITLAB_REGISTRY}/${e.gl.project.path}` || repo.startsWith(`${GITLAB_REGISTRY}/${e.gl.project.path}/`);
  if (!cred) {
    out(e, `denied: requested access to the resource is denied`);
    return 1;
  }
  const check = checkLogin(e.w, registry, cred);
  if (!check.ok || !check.push || (registry === GITLAB_REGISTRY && !ownRepo) || registry === "docker.io") {
    out(e, registry === GITLAB_REGISTRY ? `denied: access forbidden` : `denied: requested access to the resource is denied`);
    return 1;
  }
  const already = Object.values(e.w.registry ?? {}).some((x) => x.id === img.id);
  const layers = Array.from({ length: 6 }, (_, i) => hashHex(`${img.id}#push${i}`, 12));
  out(e, layers.map((l) => `${l}: ${already ? "Layer already exists" : "Pushed"}`).join("\n"));
  out(e, `${tagOf(n)}: digest: ${digestOf(n + img.id)} size: 1996`);
  e.w.registry ??= {};
  e.w.registry[n] = { ref: n, id: img.id, sizeMb: img.sizeMb, kind: img.kind, ageDays: 0, meta: { ...(img.meta ?? {}) } };
  return 0;
}

// ---------- ssh from the job to the server ----------

const KEY_BEGIN = "-----BEGIN OPENSSH PRIVATE KEY-----";

function validKey(text: string): boolean {
  return text.includes(KEY_BEGIN) && text.includes("-----END OPENSSH PRIVATE KEY-----") && text.endsWith("\n");
}

/** The public half of a private key, found where ssh-keygen left it (laptop or server). */
export function publicKeyFor(w: World, priv: string): string | undefined {
  const want = priv.trim();
  for (const h of [w.hosts.laptop, w.hosts.vps]) {
    let found: string | undefined;
    const walk = (a: string, n: FsNode) => {
      if (found) return;
      if (n.type === "file") {
        if (n.content.trim() === want) found = getFile(h, a + ".pub")?.content;
        return;
      }
      for (const [name, c] of Object.entries(n.children)) walk(`${a === "/" ? "" : a}/${name}`, c);
    };
    for (const base of ["/home", "/root"]) {
      const d = getDir(h, base);
      if (d) walk(base, d);
    }
    if (found) return found.trim();
  }
  return undefined;
}

function hostKeyLine(target: string): string {
  return `${target} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${hashB64("hostkey", 43)}`;
}

function sshKeyscan(e: Env, argv: string[], io: Io): number {
  const hosts = argv.slice(1).filter((a, i, arr) => !a.startsWith("-") && !(i > 0 && ["-t", "-p", "-T"].includes(arr[i - 1])));
  for (const h of hosts) {
    const ip = resolveName(e.w, h).ip;
    if (!ip || ip !== e.w.hosts.vps.publicIp || !e.w.provider.rented) {
      out(e, ip ? "" : `getaddrinfo ${h}: Name does not resolve`);
      continue;
    }
    out(e, `# ${h}:22 SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.5`);
    io.stdout.push(hostKeyLine(h));
  }
  return 0;
}

function sshAgent(e: Env, io: Io): number {
  e.agent = true;
  io.stdout.push(`SSH_AUTH_SOCK=/tmp/ssh-XXXXXXk3Jq2b/agent.42; export SSH_AUTH_SOCK;\nSSH_AGENT_PID=43; export SSH_AGENT_PID;\necho Agent pid 43;`);
  return 0;
}

function tooOpen(path: string, mode: number): string {
  return [
    `@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@`,
    `@         WARNING: UNPROTECTED PRIVATE KEY FILE!          @`,
    `@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@`,
    `Permissions ${(mode & 0o7777).toString(8).padStart(4, "0")} for '${path}' are too open.`,
    `It is required that your private key files are NOT accessible by others.`,
    `This private key will be ignored.`,
  ].join("\n");
}

function sshAdd(e: Env, argv: string[], io: Io): number {
  if (!e.agent && !e.vars.SSH_AUTH_SOCK) {
    out(e, "Could not open a connection to your authentication agent.");
    return 2;
  }
  const target = argv.slice(1).find((a) => !a.startsWith("-") || a === "-");
  if (!target || target === "-") {
    const text = io.stdin ?? "";
    if (!validKey(text)) {
      out(e, `Error loading key "(stdin)": invalid format`);
      return 1;
    }
    e.agentKeys.push(text);
    out(e, `Identity added: (stdin) (${(publicKeyFor(e.w, text) ?? "").split(/\s+/)[2] ?? "(stdin)"})`);
    return 0;
  }
  const f = getFile(e.host, abs(e, target));
  if (!f) {
    out(e, `${target}: No such file or directory`);
    return 1;
  }
  if (f.mode & 0o077) {
    out(e, tooOpen(target, f.mode));
    return 1;
  }
  if (!validKey(f.content)) {
    out(e, `Error loading key "${target}": invalid format`);
    return 1;
  }
  e.agentKeys.push(f.content);
  out(e, `Identity added: ${target} (${(publicKeyFor(e.w, f.content) ?? "").split(/\s+/)[2] ?? target})`);
  return 0;
}

function ssh(e: Env, argv: string[]): number {
  let identity: string | undefined;
  let strict = "ask";
  let knownFile: string | undefined;
  let dest: string | undefined;
  const remote: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (dest) {
      remote.push(a);
      continue;
    }
    if (a === "-i") identity = argv[++i] ?? "";
    else if (a.startsWith("-o")) {
      const o = a === "-o" ? (argv[++i] ?? "") : a.slice(2);
      const m = /^StrictHostKeyChecking[= ](\S+)$/i.exec(o);
      if (m) strict = m[1].toLowerCase();
      const k = /^UserKnownHostsFile[= ](\S+)$/i.exec(o);
      if (k) knownFile = k[1];
    } else if (a === "-p" || a === "-l" || a === "-F" || a === "-J") i++;
    else if (a.startsWith("-")) continue;
    else dest = a;
  }
  if (!dest) {
    out(e, "usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] [-B bind_interface] [-b bind_address]\n           [-c cipher_spec] [-D [bind_address:]port] [-E log_file]\n           destination [command [argument ...]]");
    return 255;
  }
  const [user, target] = dest.includes("@") ? dest.split("@") : ["root", dest];
  const net = sshCheck(e.w, "you", user, target, { noPubkey: true });
  if (net.netError) {
    out(e, net.netError);
    return 255;
  }

  // ssh checks the identity file exists before it connects...
  const idFile = identity ? getFile(e.host, abs(e, identity)) : undefined;
  if (identity !== undefined && !idFile) out(e, `Warning: Identity file ${identity} not accessible: No such file or directory.`);

  // Host key.
  const kh = knownFile === "/dev/null" ? "" : (getFile(e.host, knownFile ? abs(e, knownFile) : "/root/.ssh/known_hosts")?.content ?? "");
  const known = kh.split("\n").some((l) => l.split(/[\s,]/)[0] === target || l.startsWith(`[${target}]`));
  if (!known) {
    if (strict === "accept-new" || strict === "no" || strict === "off") {
      if (knownFile !== "/dev/null") {
        if (!getDir(e.host, "/root/.ssh")) put(e.host, "/root/.ssh", dir(0o700));
        const cur = getFile(e.host, "/root/.ssh/known_hosts");
        if (cur) cur.content += hostKeyLine(target) + "\n";
        else put(e.host, "/root/.ssh/known_hosts", file(hostKeyLine(target) + "\n"));
      }
      out(e, `Warning: Permanently added '${target}' (ED25519) to the list of known hosts.`);
    } else {
      // No terminal to ask "Are you sure you want to continue connecting?" in CI.
      out(e, "Host key verification failed.");
      return 255;
    }
  }

  // ...and only loads the key when it is time to log in.
  const keys: string[] = [];
  if (identity && idFile) {
    if (idFile.mode & 0o077) out(e, `${tooOpen(identity, idFile.mode)}\nLoad key "${identity}": bad permissions`);
    else if (!validKey(idFile.content)) out(e, `Load key "${identity}": invalid format`);
    else keys.push(idFile.content);
  }
  keys.push(...e.agentKeys);

  const vps = e.w.hosts.vps;
  const u = vps.users[user];
  const cfg = runningSshd(vps);
  const ak = u ? (getFile(vps, `${u.home}/.ssh/authorized_keys`)?.content ?? "") : "";
  const installed = ak.split("\n").map(keyBody);
  const problem = u && cfg.strictmodes !== "no" ? strictModesProblem(vps, user) : undefined;
  const accepted =
    !!u &&
    cfg.pubkeyauthentication !== "no" &&
    !(user === "root" && (cfg.permitrootlogin ?? "prohibit-password") === "no") &&
    !problem &&
    keys.some((k) => {
      const pub = publicKeyFor(e.w, k);
      return !!pub && installed.includes(keyBody(pub));
    });
  const port = 40000 + (e.job.id % 9000);
  if (!accepted) {
    if (problem) vps.journal.push({ t: e.w.clock, unit: "ssh", msg: problem });
    vps.journal.push({ t: e.w.clock, unit: "ssh", msg: `Connection closed by authenticating user ${user} ${RUNNER_IP} port ${port} [preauth]` });
    out(e, `${user}@${target}: Permission denied (${net.methods.join(",")}).`);
    return 255;
  }
  vps.journal.push({ t: e.w.clock, unit: "ssh", msg: `Accepted publickey for ${user} from ${RUNNER_IP} port ${port} ssh2: ED25519 SHA256:${hashB64("ci-key" + user, 43)}` });
  if (u.shell.endsWith("nologin") || u.shell === "/bin/false") {
    out(e, "This account is currently not available.");
    return 1;
  }
  if (!remote.length) {
    out(e, "Pseudo-terminal will not be allocated because stdin is not a terminal.");
    return 0;
  }
  const r = runDetached(e.w, { host: "vps", user, cwd: u.home, via: "ssh", remote: RUNNER_IP, loginGroups: userGroups(vps, user) }, remote.join(" "));
  if (r.out) out(e, r.out);
  return r.code;
}

// ---------- small shell built-ins ----------

function chmod(e: Env, argv: string[]): number {
  const args = argv.slice(1).filter((a) => a !== "-R");
  const [mode, ...paths] = args;
  if (!mode || !paths.length) {
    out(e, "chmod: missing operand");
    return 1;
  }
  let code = 0;
  for (const p of paths) {
    const n = p ? getNode(e.host, abs(e, p)) : undefined;
    if (!n) {
      out(e, noSuchFile(e, "chmod", p));
      code = 1;
      continue;
    }
    if (/^[0-7]{3,4}$/.test(mode)) n.mode = parseInt(mode, 8);
    else {
      const m = /^([ugoa]*)([+-=])([rwx]+)$/.exec(mode);
      if (!m) {
        out(e, `chmod: invalid mode: '${mode}'`);
        return 1;
      }
      const who = m[1] || "a";
      let bits = 0;
      for (const ch of m[3]) bits |= ch === "r" ? 4 : ch === "w" ? 2 : 1;
      let mask = 0;
      if (who.includes("u") || who.includes("a")) mask |= bits << 6;
      if (who.includes("g") || who.includes("a")) mask |= bits << 3;
      if (who.includes("o") || who.includes("a")) mask |= bits;
      n.mode = m[2] === "+" ? n.mode | mask : m[2] === "-" ? n.mode & ~mask : (n.mode & ~0o777) | mask;
    }
  }
  return code;
}

function curl(e: Env, argv: string[], io: Io): number {
  const flags = argv.slice(1).filter((a) => a.startsWith("-")).join("");
  const url = argv.slice(1).find((a, i, arr) => !a.startsWith("-") && !["-o", "--output", "-H", "-X", "-d"].includes(arr[i - 1] ?? ""));
  if (!url) {
    out(e, "curl: try 'curl --help' for more information");
    return 2;
  }
  const t = traceHttp(e.w, /^https?:\/\//.test(url) ? url : `http://${url}`, { from: "internet" });
  const silent = /s/.test(flags) && !/S/.test(flags);
  if (t.error) {
    if (!silent || /S/.test(flags)) out(e, t.error);
    return Number(/\((\d+)\)/.exec(t.error)?.[1] ?? 7);
  }
  if (/f/.test(flags) && (t.status ?? 200) >= 400) {
    if (!silent || /S/.test(flags)) out(e, `curl: (22) The requested URL returned error: ${t.status}`);
    return 22;
  }
  if (/I/.test(flags)) io.stdout.push(`HTTP/2 ${t.status ?? 200}`);
  else io.stdout.push(`<!DOCTYPE html><html lang="en"><head><title>Crumb | Fresh bread, daily</title></head><body><main><h1>Crumb</h1>...</main></body></html>`);
  return 0;
}

function git(e: Env, argv: string[], io: Io): number {
  const c = e.gl.commits[e.p.sha];
  if (argv[1] === "rev-parse") {
    const m = /^--short(?:=(\d+))?$/.exec(argv[2] ?? "");
    io.stdout.push(m ? shortSha(e.p.sha, Number(m[1] ?? 7)) : e.p.sha);
    return 0;
  }
  if (argv[1] === "log") {
    io.stdout.push(`${shortSha(e.p.sha)} ${c?.message.split("\n")[0] ?? ""}`);
    return 0;
  }
  return 0;
}

// ---------- running lines ----------

function runCommand(e: Env, argv: string[], io: Io, envPrefix: Record<string, string> | undefined): number {
  const name = argv[0];
  if (!e.tools.has(name) && name !== "sh" && name !== "bash") return notFound(e, name);
  const saved = envPrefix ? { ...e.vars } : undefined;
  if (envPrefix) Object.assign(e.vars, envPrefix);
  try {
    switch (name) {
      case "echo": {
        const args = argv.slice(1);
        io.stdout.push(args.filter((a, i) => !(i === 0 && (a === "-n" || a === "-e"))).join(" "));
        return 0;
      }
      case "printf": {
        const fmt = argv[1] ?? "";
        let k = 2;
        const s = fmt.replace(/%s/g, () => argv[k++] ?? "").replace(/\\n/g, "\n");
        io.stdout.push(s.replace(/\n$/, ""));
        return 0;
      }
      case "cat": {
        if (argv.length === 1) {
          if (io.stdin !== undefined) io.stdout.push(io.stdin);
          return 0;
        }
        let code = 0;
        for (const p of argv.slice(1)) {
          const f = getFile(e.host, abs(e, p));
          if (!f) {
            out(e, e.alpine ? `cat: can't open '${p}': No such file or directory` : `cat: ${p}: No such file or directory`);
            code = 1;
          } else io.stdout.push(f.content.replace(/\n$/, ""));
        }
        return code;
      }
      case "ls": {
        const paths = argv.slice(1).filter((a) => !a.startsWith("-"));
        let code = 0;
        for (const p of paths.length ? paths : ["."]) {
          const n = getNode(e.host, abs(e, p));
          if (!n) {
            out(e, noSuchFile(e, "ls", p));
            code = e.alpine ? 1 : 2;
          } else if (n.type === "file") io.stdout.push(p);
          else io.stdout.push(Object.keys(n.children).filter((k) => argv.some((a) => /^-\w*a/.test(a)) || !k.startsWith(".")).sort().join("\n"));
        }
        return code;
      }
      case "mkdir": {
        const p = argv.includes("-p");
        for (const d of argv.slice(1).filter((a) => !a.startsWith("-"))) {
          const path = abs(e, d);
          if (getNode(e.host, path) && !p) {
            out(e, e.alpine ? `mkdir: can't create directory '${d}': File exists` : `mkdir: cannot create directory '${d}': File exists`);
            return 1;
          }
          mkdirp(e.host, "root", path, argv.some((a) => a === "-m") ? 0o700 : 0o755);
        }
        return 0;
      }
      case "chmod":
        return chmod(e, argv);
      case "rm":
        for (const p of argv.slice(1).filter((a) => !a.startsWith("-"))) removeNode(e.host, abs(e, p));
        return 0;
      case "touch":
        for (const p of argv.slice(1)) if (!getNode(e.host, abs(e, p))) put(e.host, abs(e, p), file(""));
        return 0;
      case "cp": {
        const [src, dst] = argv.slice(1).filter((a) => !a.startsWith("-"));
        const f = src ? getFile(e.host, abs(e, src)) : undefined;
        if (!f || !dst) {
          out(e, noSuchFile(e, "cp", src ?? ""));
          return 1;
        }
        put(e.host, abs(e, dst), file(f.content, f.mode));
        return 0;
      }
      case "cd": {
        const target = abs(e, argv[1] ?? "/root");
        if (!getDir(e.host, target)) {
          out(e, e.bash ? `/usr/bin/bash: line ${e.line}: cd: ${argv[1]}: No such file or directory` : `/bin/sh: cd: line ${e.line}: can't cd to ${argv[1]}: No such file or directory`);
          return e.bash ? 1 : 2;
        }
        e.cwd = target;
        return 0;
      }
      case "export":
      case "set":
      case "unset":
        if (name === "export") for (const a of argv.slice(1)) if (a.includes("=")) e.vars[a.slice(0, a.indexOf("="))] = a.slice(a.indexOf("=") + 1);
        if (name === "unset") for (const a of argv.slice(1)) delete e.vars[a];
        return 0;
      case "pwd":
        io.stdout.push(e.cwd);
        return 0;
      case "true":
      case "sleep":
        return 0;
      case "false":
      case "exit":
        return name === "exit" ? Number(argv[1] ?? 0) : 1;
      case "test":
      case "[": {
        const a = argv.slice(1).filter((x) => x !== "]");
        if (a[0] === "-f" || a[0] === "-e" || a[0] === "-d") return getNode(e.host, abs(e, a[1] ?? "")) ? 0 : 1;
        if (a[0] === "-n") return a[1] ? 0 : 1;
        if (a[0] === "-z") return a[1] ? 1 : 0;
        if (a[1] === "=" || a[1] === "==") return a[0] === a[2] ? 0 : 1;
        if (a[1] === "!=") return a[0] !== a[2] ? 0 : 1;
        return a.length ? 0 : 1;
      }
      case "env":
      case "printenv":
        io.stdout.push(
          Object.entries(e.vars)
            .map(([k, v]) => `${k}=${v}`)
            .sort()
            .join("\n"),
        );
        return 0;
      case "tr":
        io.stdout.push((io.stdin ?? "").replace(/\r/g, ""));
        return 0;
      case "base64": {
        const text = io.stdin ?? "";
        try {
          io.stdout.push(argv.includes("-d") || argv.includes("--decode") ? atob(text.trim()) : btoa(text));
        } catch {
          out(e, "base64: invalid input");
          return 1;
        }
        return 0;
      }
      case "grep": {
        const args = argv.slice(1).filter((a) => !a.startsWith("-"));
        const lines = (io.stdin ?? "").split("\n").filter((l) => l.includes(args[0] ?? ""));
        if (!argv.includes("-q") && lines.length) io.stdout.push(lines.join("\n"));
        return lines.length ? 0 : 1;
      }
      case "head":
      case "tail":
      case "wc":
        if (io.stdin !== undefined) io.stdout.push(name === "wc" ? String(io.stdin.split("\n").length) : io.stdin);
        return 0;
      case "which":
        for (const t of argv.slice(1)) {
          if (!e.tools.has(t)) return 1;
          io.stdout.push(`/usr/bin/${t}`);
        }
        return 0;
      case "whoami":
        io.stdout.push("root");
        return 0;
      case "id":
        io.stdout.push("uid=0(root) gid=0(root) groups=0(root)");
        return 0;
      case "uname":
        io.stdout.push(argv.includes("-a") ? "Linux runner-t3xqab9c 6.8.0-45-generic #45-Ubuntu SMP x86_64 Linux" : "Linux");
        return 0;
      case "date":
        io.stdout.push(new Date(Date.UTC(2026, 9, 11, 9, 0, 0) + e.w.clock * 1000).toUTCString());
        return 0;
      case "eval":
        return runScriptText(e, argv.slice(1).join(" "), io.stdout);
      case "sh":
      case "bash": {
        const i = argv.indexOf("-c");
        if (i >= 0) return runScriptText(e, argv[i + 1] ?? "", io.stdout);
        const f = argv[1] ? getFile(e.host, abs(e, argv[1])) : undefined;
        if (!f) {
          out(e, `${name}: can't open '${argv[1] ?? ""}': No such file or directory`);
          return 2;
        }
        return runScriptText(e, f.content, io.stdout);
      }
      case "node": {
        if (argv[1] === "-v" || argv[1] === "--version") {
          io.stdout.push("v24.11.0");
          return 0;
        }
        if (argv[1] && !getFile(e.host, abs(e, argv[1]))) {
          out(e, `node:internal/modules/cjs/loader:1386\n  throw err;\n  ^\n\nError: Cannot find module '${abs(e, argv[1])}'`);
          return 1;
        }
        return 0;
      }
      case "npm":
        return npm(e, argv, io);
      case "npx":
      case "yarn":
        return npmScriptCmd(e, argv.slice(1).join(" "), io);
      case "apk":
        return apk(e, argv);
      case "apt-get":
      case "apt":
        return aptGet(e, argv);
      case "docker":
        return docker(e, argv, io);
      case "ssh":
        return ssh(e, argv);
      case "ssh-keyscan":
        return sshKeyscan(e, argv, io);
      case "ssh-agent":
        return sshAgent(e, io);
      case "ssh-add":
        return sshAdd(e, argv, io);
      case "curl":
        return curl(e, argv, io);
      case "git":
        return git(e, argv, io);
      default:
        return 0;
    }
  } finally {
    if (saved) {
      // VAR=x cmd: the variable only lives for that one command.
      for (const k of Object.keys(envPrefix ?? {})) {
        if (k in saved) e.vars[k] = saved[k];
        else delete e.vars[k];
      }
    }
  }
}

function writeRedirect(e: Env, target: string, text: string, append: boolean): boolean {
  const path = abs(e, target);
  if (path === "/dev/null") return true;
  const parent = getDir(e.host, path.slice(0, path.lastIndexOf("/")) || "/");
  if (!parent) {
    out(e, e.bash ? `/usr/bin/bash: line ${e.line}: ${target}: No such file or directory` : `/bin/sh: eval: line ${e.line}: can't create ${target}: nonexistent directory`);
    return false;
  }
  const body = text ? text + "\n" : "";
  const f = getFile(e.host, path);
  if (f) f.content = append ? f.content + body : body;
  else put(e.host, path, file(body));
  return true;
}

/** Run a parsed line. The last command's stdout goes to `cap` when given ($(...), eval), else to the log. */
function runSeq(e: Env, seq: Sequence, cap?: string[], stdin0?: string): number {
  let code = 0;
  let skip: "&&" | "||" | null = null;
  for (const item of seq.items) {
    const go = skip === null || (skip === "&&" && code === 0) || (skip === "||" && code !== 0);
    if (go) {
      let stdin = stdin0;
      const cmds = item.pipeline.cmds;
      for (let i = 0; i < cmds.length; i++) {
        const c = cmds[i];
        if (!c.argv.length) {
          Object.assign(e.vars, c.env ?? {});
          code = 0;
          continue;
        }
        const argv = c.argv.map((w) => (!w.quoted && (w.text === "~" || w.text.startsWith("~/")) ? "/root" + w.text.slice(1) : w.text));
        if (c.stdinFrom) stdin = getFile(e.host, abs(e, c.stdinFrom))?.content;
        const sub: Io = { stdin, stdout: [] };
        code = runCommand(e, argv, sub, c.env);
        const text = sub.stdout.join("\n");
        if (c.redirect) {
          if (!writeRedirect(e, c.redirect.target, text, c.redirect.op === ">>")) code = 1;
          stdin = "";
        } else if (i === cmds.length - 1) {
          if (cap) {
            if (text) cap.push(text);
          } else if (text) out(e, text);
        } else stdin = text ? text + "\n" : "";
      }
    }
    skip = item.next === "&&" || item.next === "||" ? item.next : null;
  }
  return code;
}

function runLine(e: Env, line: string, cap?: string[]): number {
  let seq: Sequence;
  try {
    seq = parse(line, e.vars, (inner) => {
      const c: string[] = [];
      runLine(e, inner, c);
      return c.join("\n");
    });
  } catch (err) {
    out(e, `/bin/sh: eval: line ${e.line}: syntax error: ${err instanceof ParseError ? err.message : String(err)}`);
    return 2;
  }
  return runSeq(e, seq, cap);
}

function runScriptText(e: Env, text: string, cap?: string[]): number {
  let code = 0;
  for (const raw of text.split(/\n|;\s*(?=\S)/)) {
    const l = raw.trim().replace(/;$/, "");
    if (!l || l.startsWith("#")) continue;
    code = runLine(e, l, cap);
    if (code !== 0) break;
  }
  return code;
}

/** Run a list of script entries. Stops at the first failing line (GitLab runs scripts with set -e). */
function runEntries(e: Env, entries: string[]): number {
  for (const entry of entries) {
    const lines = entry.split("\n").filter((l) => l.trim());
    out(e, `$ ${lines[0] ?? ""}${lines.length > 1 ? " # collapsed multi-line command" : ""}`);
    for (const l of lines) {
      e.line += 1;
      const code = runLine(e, l);
      if (code !== 0) return code;
    }
  }
  return 0;
}

// ---------- the whole job ----------

/** The first lines of a job log, shown as soon as a runner picks the job up. */
export function jobHeader(job: CiJob, runner: Runner): string[] {
  const image = job.spec.image ?? runner.defaultImage ?? "alpine:3.20";
  const lines = [
    `Running with gitlab-runner ${RUNNER_VERSION} (${RUNNER_REVISION})`,
    `  on ${runner.description} ${runner.shortToken ?? hashB64("runner" + runner.id, 8)}, system ID: s_${hashHex("system" + runner.id, 12)}`,
    `Preparing the "docker" executor`,
    `Using Docker executor with image ${image} ...`,
  ];
  for (const s of job.spec.services) {
    lines.push(`Starting service ${s.name} ...`, `Pulling docker image ${s.name} ...`, `Using docker image ${sha256(s.name)} for ${s.name} with digest ${imageName(s.name).name}@${sha256("d" + s.name)} ...`);
  }
  if (job.spec.services.length) lines.push(`Waiting for services to be up and running (timeout 30 seconds)...`);
  return lines;
}

function isDind(name: string): boolean {
  return /^docker(:[\w.-]*dind[\w.-]*)$/.test(normalizeRef(name).replace(/^library\//, "")) || /^docker:dind$/.test(name);
}

/** Run the job now. Side effects (registry pushes, deploys on the server) happen on `w`. */
export function executeJob(w: World, p: Pipeline, job: CiJob, runner: Runner, deps: CiJob[]): JobResult {
  const gl = w.gitlab!;
  const spec = job.spec;
  const image = spec.image ?? runner.defaultImage ?? "alpine:3.20";
  const log = jobHeader(job, runner);
  const fail = (reason: string, lines: string[]): JobResult => ({ status: "failed", log: [...log, ...lines], failureReason: reason });

  if (!imageKnown(w, image)) {
    const err = `Error response from daemon: manifest for ${normalizeRef(image)} not found: manifest unknown: manifest unknown (manager.go:250:0s)`;
    return fail("image_pull_failure", [`WARNING: Failed to pull image with policy "always": ${err}`, `ERROR: Job failed: failed to pull image "${image}" with specified policies [always]: ${err}`]);
  }

  const dind = spec.services.find((s) => isDind(s.name));
  if (dind && !runner.privileged) {
    const svc = `runner-${(runner.shortToken ?? "t3xqab9c").toLowerCase()}-project-61904-concurrent-0-docker-0`;
    log.push(
      `*** WARNING: Service ${svc} probably didn't start properly.`,
      ``,
      `Health check error:`,
      `service "${svc}-wait-for-service" timeout`,
      ``,
      `Service container logs:`,
      `2026-10-11T09:00:00.000000000Z mount: permission denied (are you root?)`,
      `2026-10-11T09:00:00.000000000Z Could not mount /sys/kernel/security.`,
      `2026-10-11T09:00:00.000000000Z AppArmor detection and --privileged mode might break.`,
      ``,
      `*********`,
      ``,
    );
  }
  const { tools, alpine, bash } = imageTools(image);
  log.push(
    `Pulling docker image ${image} ...`,
    `Using docker image ${sha256(image)} for ${image} with digest ${imageName(image).name}@${sha256("d" + image)} ...`,
    `Preparing environment`,
    `Running on runner-${(runner.shortToken ?? "t3xqab9c").toLowerCase()}-project-61904-concurrent-0 via ${runner.description}...`,
    `Getting source from Git repository`,
    `Fetching changes with git depth set to 20...`,
    `Initialized empty Git repository in ${BUILDS_DIR}/.git/`,
    `Created fresh repository.`,
    `Checking out ${shortSha(p.sha, 8)} as detached HEAD (ref is ${p.ref})...`,
    ``,
    `Skipping Git submodules setup`,
  );

  // A brand new container: the commit's files and nothing else.
  const host = jobHost();
  put(host, "/root", dir(0o700));
  put(host, "/tmp", dir(0o1777));
  put(host, BUILDS_DIR, dir());
  writeTree(host, BUILDS_DIR, gl.commits[p.sha]?.files ?? {});
  put(host, `${BUILDS_DIR}/.git/HEAD`, file(p.sha + "\n"));

  const withArtifacts = deps.filter((d) => d.status === "success" && d.artifacts && Object.keys(d.artifacts).length);
  if (withArtifacts.length) {
    log.push(`Downloading artifacts`);
    for (const d of withArtifacts) {
      log.push(`Downloading artifacts for ${d.name} (${d.id})...`, `Downloading artifacts from coordinator... ok        host=gitlab.com id=${d.id} responseStatus=200 OK token=glcbt-64`);
      writeTree(host, BUILDS_DIR, d.artifacts!);
    }
  }

  // Variables: predefined, then the file's, then the job's, then the project's settings (those win).
  const vars: Record<string, string> = { ...predefinedVars(gl, p, job, runner), HOME: "/root", PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" };
  // spec.variables already holds the file's global variables with the job's own on top.
  for (const [k, v] of Object.entries(spec.variables)) vars[k] = expandOnce(v, vars);
  const masked: string[] = [jobTokenFor(job.id)];
  for (const v of visibleVars(gl, p.protectedRef)) {
    if (v.type === "file") {
      const path = `${BUILDS_DIR}.tmp/${v.key}`;
      put(host, path, file(v.value, 0o666));
      vars[v.key] = path;
    } else vars[v.key] = v.value;
    if (v.masked && maskable(v.value)) masked.push(v.value);
  }

  // Is there a Docker daemon to talk to? Only a privileged docker:dind service gives one.
  const dockerHost = vars.DOCKER_HOST ?? "tcp://docker:2375";
  const alias = dind ? (dind.alias ?? "docker") : undefined;
  const daemon = !!dind && runner.privileged && (dockerHost.includes(`//${alias}:`) || (!vars.DOCKER_HOST && alias === "docker"));

  const e: Env = { w, gl, p, job, runner, host, cwd: BUILDS_DIR, vars, tools, image, alpine, bash, daemon, agent: false, agentKeys: [], log, line: 150 };
  log.push(`Executing "step_script" stage of the job script`, `Using docker image ${sha256(image)} for ${image} with digest ${imageName(image).name}@${sha256("d" + image)} ...`);
  const code = runEntries(e, [...spec.beforeScript, ...spec.script]);
  if (spec.afterScript.length) {
    log.push(``, `Running after_script`, `Running after script...`);
    e.cwd = BUILDS_DIR;
    runEntries(e, spec.afterScript);
  }

  let artifacts: Record<string, string> | undefined;
  let artifactFail = false;
  const artWhen = spec.artifacts?.when ?? "on_success";
  if (spec.artifacts?.paths.length && (artWhen === "always" || (artWhen === "on_success") === (code === 0))) {
    log.push(``, code === 0 ? `Uploading artifacts for successful job` : `Uploading artifacts for failed job`, `Uploading artifacts...`);
    artifacts = {};
    for (const p0 of spec.artifacts.paths) {
      const node = getNode(host, `${BUILDS_DIR}/${p0.replace(/^\.\//, "").replace(/\/+$/, "")}`);
      if (!node) {
        log.push(`WARNING: ${p0}: no matching files. Ensure that the artifact path is relative to the working directory (${BUILDS_DIR})`);
        continue;
      }
      log.push(`${p0}: found ${countEntries(node)} matching artifact files and directories `);
      Object.assign(artifacts, collect(host, BUILDS_DIR, p0));
    }
    if (!Object.keys(artifacts).length) {
      log.push(`ERROR: No files to upload                          `);
      artifactFail = code === 0;
      artifacts = undefined;
    } else log.push(`Uploading artifacts as "archive" to coordinator... 201 Created  id=${job.id} responseStatus=201 Created token=glcbt-64`);
  }

  log.push(`Cleaning up project directory and file based variables`);
  const ok = code === 0 && !artifactFail;
  log.push(ok ? `Job succeeded` : `ERROR: Job failed: exit code ${code || 1}`);
  const masks = [...new Set(masked)].sort((a, b) => b.length - a.length);
  const final = log.map((l) => masks.reduce((s, m) => s.split(m).join("[MASKED]"), l));
  return ok ? { status: "success", log: final, ...(artifacts ? { artifacts } : {}) } : { status: "failed", log: final, failureReason: "script_failure", ...(artifacts ? { artifacts } : {}) };
}

/** Roughly how many sim seconds a job takes (the runner holds it in "running" this long). */
export function estimateSeconds(job: CiJob): number {
  let s = 6 + (job.spec.services.length ? 4 : 0);
  for (const l of [...job.spec.beforeScript, ...job.spec.script, ...job.spec.afterScript]) {
    if (/\bnpm (ci|install|i)\b/.test(l)) s += 9;
    else if (/\b(npm (run )?test|vitest|jest)\b/.test(l)) s += 4;
    else if (/\b(npm run build|next build)\b/.test(l)) s += 14;
    else if (/\bdocker (buildx )?build\b/.test(l)) s += 18;
    else if (/\bdocker push\b/.test(l)) s += 4;
    else if (/\bdocker pull\b/.test(l)) s += 3;
    else if (/\bssh\b/.test(l)) s += 7;
    else if (/\b(apk|apt-get)\b/.test(l)) s += 2;
    else s += 1;
  }
  return s;
}
