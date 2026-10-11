// What each kind of container does when it starts, how healthchecks probe it,
// and the few commands `docker exec` can run inside it.
import { getDir, readText } from "../fs";
import { appToDb, resolveInDocker } from "../net";
import { pgTime, unixTime } from "../time";
import type { AppKind, Container, Host, ImageMeta, World } from "../types";
import { localImage } from "./images";
import { ipOf } from "./network";

export const MAX_LOG_LINES = 2000;

export function log(c: Container, ...lines: string[]): void {
  c.logs.push(...lines);
  if (c.logs.length > MAX_LOG_LINES) c.logs.splice(0, c.logs.length - MAX_LOG_LINES);
}

export function metaOf(host: Host, c: Container): ImageMeta {
  return localImage(host, c.image)?.meta ?? {};
}

export function flavorOf(host: Host, c: Container): string {
  const m = metaOf(host, c);
  if (m.flavor) return m.flavor;
  if (c.kind === "nextjs") return "node";
  if (c.kind === "postgres") return "postgres";
  if (c.kind === "caddy") return "caddy";
  if (c.kind === "hello") return "hello-world";
  return "alpine";
}

/** What starting did: keep running (no exit), exit with a code, or fail to start at all. */
export interface BootResult {
  exit?: number;
  /** The process could not even start (bad command). Daemon error text. */
  startError?: string;
}

export type BootHook = (w: World, host: Host, c: Container, now: number) => BootResult | void;

const BOOT_HOOKS: { name: string; kind: AppKind; run: BootHook }[] = [];

/**
 * Let later worlds add behaviour without touching this file, e.g. World 6 issuing
 * certificates when the Caddy container starts. A hook that returns a result wins.
 */
export function registerBootHook(name: string, kind: AppKind, run: BootHook): void {
  const i = BOOT_HOOKS.findIndex((h) => h.name === name);
  if (i >= 0) BOOT_HOOKS[i] = { name, kind, run };
  else BOOT_HOOKS.push({ name, kind, run });
}

/** Start the process inside `c`. The caller has already set status running. */
export function boot(w: World, host: Host, c: Container, now: number): BootResult {
  let r: BootResult;
  const cmd = c.command?.length ? c.command : undefined;
  switch (c.kind) {
    case "postgres":
      r = bootPostgres(host, c, now);
      break;
    case "nextjs":
      r = bootNext(host, c);
      break;
    case "caddy":
      r = bootCaddy(c, now);
      break;
    case "hello":
      log(c, ...HELLO);
      r = { exit: 0 };
      break;
    default:
      r = bootGeneric(host, c, now, cmd);
  }
  for (const h of BOOT_HOOKS) {
    if (h.kind !== c.kind) continue;
    const res = h.run(w, host, c, now);
    if (res) r = res;
  }
  return r;
}

// ---------- hello-world ----------

export const HELLO = [
  "",
  "Hello from Docker!",
  "This message shows that your installation appears to be working correctly.",
  "",
  "To generate this message, Docker took the following steps:",
  " 1. The Docker client contacted the Docker daemon.",
  ' 2. The Docker daemon pulled the "hello-world" image from the Docker Hub.',
  "    (amd64)",
  " 3. The Docker daemon created a new container from that image which runs the",
  "    executable that produces the output you are currently reading.",
  " 4. The Docker daemon streamed that output to the Docker client, which sent it",
  "    to your terminal.",
  "",
  "To try something more ambitious, you can run an Ubuntu container with:",
  " $ docker run -it ubuntu bash",
  "",
  "Share images, automate workflows, and more with a free Docker ID:",
  " https://hub.docker.com/",
  "",
  "For more examples and ideas, visit:",
  " https://docs.docker.com/get-started/",
  "",
];

// ---------- postgres ----------

export const PG_NO_PASSWORD = [
  "Error: Database is uninitialized and superuser password is not specified.",
  "       You must specify POSTGRES_PASSWORD to a non-empty value for the",
  '       superuser. For example, "-e POSTGRES_PASSWORD=password" on "docker run".',
  "",
  '       You may also use "POSTGRES_HOST_AUTH_METHOD=trust" to allow all',
  "       connections without a password. This is *not* recommended.",
  "",
  '       See PostgreSQL documentation about "trust":',
  "       https://www.postgresql.org/docs/current/auth-trust.html",
];

const PG18_OLD_MOUNT = [
  "Error: in 18+, these Docker images are configured to store database data in a",
  '       format which is compatible with "pg_ctlcluster" (specifically, using',
  "       major-version-specific directory names).  This better reflects how",
  "       PostgreSQL itself works, and how upgrades are to be performed.",
  "",
  "       See also https://github.com/docker-library/postgres/pull/1259",
  "",
  "       Counter to that, there appears to be PostgreSQL data in:",
  "         /var/lib/postgresql/data (unused mount/volume)",
  "",
  "       This is usually the result of upgrading the Docker image without",
  '       upgrading the underlying database using "pg_upgrade" (which requires both',
  "       versions).",
  "",
  "       The suggested container configuration for 18+ is to place a single mount",
  "       at /var/lib/postgresql which will then place PostgreSQL data in a",
  '       subdirectory, allowing usage of "pg_upgrade --link" without mount point',
  "       boundary issues.",
  "",
  "       See https://github.com/docker-library/postgres/issues/37 for a (long)",
  "       discussion around this process, and suggestions for how to do so.",
];

export function pgMajor(host: Host, c: Container): string {
  const v = metaOf(host, c).version;
  if (v) return v.split(".")[0];
  return /:(\d+)/.exec(c.image)?.[1] ?? "17";
}

/** Where this postgres image keeps its data. 18 moved it up one level. */
export function pgDataPath(major: string): string {
  return Number(major) >= 18 ? "/var/lib/postgresql" : "/var/lib/postgresql/data";
}

export function pgVolume(host: Host, c: Container) {
  const target = pgDataPath(pgMajor(host, c));
  const m = c.mounts.find((x) => x.target === target && x.type === "volume");
  return m ? host.docker.volumes[m.source] : undefined;
}

function bootPostgres(host: Host, c: Container, now: number): BootResult {
  const major = pgMajor(host, c);
  const version = metaOf(host, c).version ?? `${major}.0`;
  const L = (pid: number, msg: string) => `${pgTime(now)} [${pid}] ${msg}`;
  if (Number(major) >= 18 && c.mounts.some((m) => m.target === "/var/lib/postgresql/data")) {
    log(c, ...PG18_OLD_MOUNT);
    return { exit: 1 };
  }
  const vol = pgVolume(host, c);
  const ready = [
    L(1, `LOG:  starting PostgreSQL ${version} (Debian ${version}-1.pgdg130+1) on x86_64-pc-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit`),
    L(1, `LOG:  listening on IPv4 address "0.0.0.0", port 5432`),
    L(1, `LOG:  listening on IPv6 address "::", port 5432`),
    L(1, `LOG:  listening on Unix socket "/var/run/postgresql/.s.PGSQL.5432"`),
    L(29, `LOG:  database system was shut down at ${pgTime(now).replace(/\.\d+ /, " ")}`),
    L(1, "LOG:  database system is ready to accept connections"),
  ];
  c.listenAddr = "0.0.0.0";
  c.listenPort = 5432;
  if (vol?.pg) {
    if (vol.pg.version !== major) {
      log(
        c,
        "",
        "PostgreSQL Database directory appears to contain a database; Skipping initialization",
        "",
        L(1, "FATAL:  database files are incompatible with server"),
        L(1, `DETAIL:  The data directory was initialized by PostgreSQL version ${vol.pg.version}, which is not compatible with this version ${version}.`),
      );
      return { exit: 1 };
    }
    // POSTGRES_PASSWORD and friends are only read on the very first start.
    log(c, "", "PostgreSQL Database directory appears to contain a database; Skipping initialization", "", ...ready);
    return {};
  }
  const env = c.env;
  if (!env.POSTGRES_PASSWORD && env.POSTGRES_HOST_AUTH_METHOD !== "trust") {
    log(c, ...PG_NO_PASSWORD);
    return { exit: 1 };
  }
  const user = env.POSTGRES_USER || "postgres";
  const db = env.POSTGRES_DB || user;
  const data = pgDataPath(major) + (Number(major) >= 18 ? `/${major}/docker` : "");
  log(
    c,
    `The files belonging to this database system will be owned by user "postgres".`,
    "This user must also own the server process.",
    "",
    `The database cluster will be initialized with locale "en_US.utf8".`,
    `The default database encoding has accordingly been set to "UTF8".`,
    `The default text search configuration will be set to "english".`,
    "",
    `fixing permissions on existing directory ${data} ... ok`,
    "creating subdirectories ... ok",
    "creating configuration files ... ok",
    "running bootstrap script ... ok",
    "performing post-bootstrap initialization ... ok",
    "syncing data to disk ... ok",
    "",
    "",
    "Success. You can now start the database server using:",
    "",
    `    pg_ctl -D ${data} -l logfile start`,
    "",
    "waiting for server to start.... done",
    "server started",
    ...(db !== "postgres" ? ["CREATE DATABASE", ""] : []),
    "",
    "/usr/local/bin/docker-entrypoint.sh: ignoring /docker-entrypoint-initdb.d/*",
    "",
    "waiting for server to shut down.... done",
    "server stopped",
    "",
    "PostgreSQL init process complete; ready for start up.",
    "",
    ...ready,
  );
  if (vol) {
    vol.pg = { version: major, user, db, password: env.POSTGRES_PASSWORD ?? "" };
    vol.sizeMb = Math.max(vol.sizeMb, 47);
  }
  return {};
}

// ---------- Next.js ----------

/** Where a Next.js standalone server binds. Docker sets HOSTNAME to the container id by default. */
export function nextListenAddr(host: Host, c: Container): string {
  const h = c.env.HOSTNAME;
  if (h === "0.0.0.0" || h === "::") return h;
  if (h === "localhost" || h === "127.0.0.1") return "127.0.0.1";
  // Unset (or anything else): the name resolves to the container's own IP.
  return ipOf(host, c);
}

function bootNext(host: Host, c: Container): BootResult {
  const port = Number(c.env.PORT ?? 3000) || 3000;
  const addr = nextListenAddr(host, c);
  c.listenAddr = addr;
  c.listenPort = port;
  const local = addr === "0.0.0.0" || addr === "::" ? "localhost" : addr === "127.0.0.1" ? "localhost" : c.env.HOSTNAME || c.id.slice(0, 12);
  log(c, "   ▲ Next.js 16.0.0", `   - Local:        http://${local}:${port}`, `   - Network:      http://${addr}:${port}`, "", " ✓ Starting...");
  const required = metaOf(host, c).requiredEnv ?? [];
  const missing = required.find((k) => !c.env[k]);
  if (missing) {
    log(c, `Error: ${missing} is not set`, "    at validateEnv (.next/server/instrumentation.js:1:204)", "    at async register (.next/server/instrumentation.js:1:398)", "", "Node.js v24.11.0");
    return { exit: 1 };
  }
  log(c, ` ✓ Ready in ${380 + (c.id.charCodeAt(0) % 90)}ms`);
  const db = appToDb(host, c);
  if (!db.ok && db.hop === "db") {
    const m = /connect ECONNREFUSED (127\.0\.0\.1:\d+)/.exec(db.note);
    if (m) {
      const [ip, p] = m[1].split(":");
      log(
        c,
        `Error: connect ECONNREFUSED ${m[1]}`,
        "    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1637:16) {",
        "  errno: -111,",
        "  code: 'ECONNREFUSED',",
        "  syscall: 'connect',",
        `  address: '${ip}',`,
        `  port: ${p}`,
        "}",
      );
    }
    const nf = /getaddrinfo ENOTFOUND (\S+)/.exec(db.note);
    if (nf) log(c, `Error: getaddrinfo ENOTFOUND ${nf[1]}`, "    at GetAddrInfoReqWrap.onlookupall [as oncomplete] (node:dns:120:26) {", "  errno: -3008,", "  code: 'ENOTFOUND',", "  syscall: 'getaddrinfo',", `  hostname: '${nf[1]}'`, "}");
  }
  return {};
}

// ---------- Caddy ----------

function bootCaddy(c: Container, now: number): BootResult {
  const ts = unixTime(now);
  c.listenAddr = "0.0.0.0";
  c.listenPort = c.ports.some((p) => p.containerPort === 443) || !c.ports.length ? 443 : (c.ports[0]?.containerPort ?? 80);
  log(
    c,
    `{"level":"info","ts":${ts}.1203,"msg":"using config from file","file":"/etc/caddy/Caddyfile"}`,
    `{"level":"info","ts":${ts}.1219,"msg":"adapted config to JSON","adapter":"caddyfile"}`,
    `{"level":"info","ts":${ts}.1241,"logger":"admin","msg":"admin endpoint started","address":"localhost:2019","enforce_origin":false,"origins":["//localhost:2019","//[::1]:2019","//127.0.0.1:2019"]}`,
    `{"level":"info","ts":${ts}.1307,"logger":"tls.cache.maintenance","msg":"started background certificate maintenance","cache":"0xc0004a2e00"}`,
    `{"level":"info","ts":${ts}.1355,"msg":"serving initial configuration"}`,
  );
  return {};
}

// ---------- everything else (nginx, node, alpine) ----------

function nginxLogs(now: number): string[] {
  const t = pgTime(now).slice(0, 19).replace(/-/g, "/");
  return [
    "/docker-entrypoint.sh: /docker-entrypoint.d/ is not empty, will attempt to perform configuration",
    "/docker-entrypoint.sh: Looking for shell scripts in /docker-entrypoint.d/",
    "/docker-entrypoint.sh: Launching /docker-entrypoint.d/10-listen-on-ipv6-by-default.sh",
    "10-listen-on-ipv6-by-default.sh: info: Getting the checksum of /etc/nginx/conf.d/default.conf",
    "10-listen-on-ipv6-by-default.sh: info: Enabled listen on IPv6 in /etc/nginx/conf.d/default.conf",
    "/docker-entrypoint.sh: Sourcing /docker-entrypoint.d/15-local-resolvers.envsh",
    "/docker-entrypoint.sh: Launching /docker-entrypoint.d/20-envsubst-on-templates.sh",
    "/docker-entrypoint.sh: Launching /docker-entrypoint.d/30-tune-worker-processes.sh",
    "/docker-entrypoint.sh: Configuration complete; ready for start up",
    `${t} [notice] 1#1: using the "epoll" event method`,
    `${t} [notice] 1#1: nginx/1.27.5`,
    `${t} [notice] 1#1: built by gcc 12.2.0 (Debian 12.2.0-14)`,
    `${t} [notice] 1#1: OS: Linux 6.8.0-45-generic`,
    `${t} [notice] 1#1: start worker processes`,
  ];
}

function notFound(bin: string): string {
  return `failed to create task for container: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: exec: "${bin}": executable file not found in $PATH: unknown`;
}

function bootGeneric(host: Host, c: Container, now: number, cmd: string[] | undefined): BootResult {
  const flavor = flavorOf(host, c);
  const meta = metaOf(host, c);
  const argv = cmd ?? meta.cmd ?? ["/bin/sh"];
  const bin = argv[0];
  const base = bin.split("/").pop() ?? bin;
  if (flavor === "nginx" && base === "nginx") {
    c.listenAddr = "0.0.0.0";
    c.listenPort = 80;
    log(c, ...nginxLogs(now));
    return {};
  }
  if (!hasBinary(host, c, base)) return { startError: notFound(bin) };
  c.listenAddr = "0.0.0.0";
  c.listenPort = 0;
  if (base === "sleep" || base === "tail") return {};
  if (base === "echo") {
    log(c, argv.slice(1).join(" "));
    return { exit: 0 };
  }
  if (base === "env" || base === "printenv") {
    log(c, ...envLines(host, c));
    return { exit: 0 };
  }
  if ((base === "sh" || base === "bash") && argv[1] === "-c") {
    const script = argv.slice(2).join(" ");
    if (/\bsleep\b|\btail -f\b/.test(script)) return {};
    const echo = /^echo\s+(.*)$/.exec(script.trim());
    if (echo) log(c, echo[1].replace(/^["']|["']$/g, ""));
    return { exit: 0 };
  }
  if (base === "node" && argv.length > 1) {
    const file = argv[argv.length - 1];
    log(c, `node:internal/modules/cjs/loader:1386`, `  throw err;`, `  ^`, ``, `Error: Cannot find module '/${meta.workdir ? meta.workdir.replace(/^\//, "") + "/" : ""}${file}'`, ``, `Node.js v24.11.0`);
    return { exit: 1 };
  }
  // A shell or REPL with no terminal attached reads nothing and exits at once.
  return { exit: 0 };
}

export function envLines(host: Host, c: Container): string[] {
  const env: Record<string, string> = {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOSTNAME: c.id.slice(0, 12),
    ...c.env,
  };
  if (!env.HOME) env.HOME = "/root";
  void host;
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

// ---------- what is installed inside ----------

const ALPINE = ["sh", "ash", "ls", "cat", "env", "printenv", "echo", "hostname", "wget", "ps", "sleep", "tail", "true", "false", "id", "whoami", "nc", "ping", "which"];
const DEBIAN = ["sh", "bash", "ls", "cat", "env", "printenv", "echo", "hostname", "sleep", "tail", "true", "false", "id", "whoami"];

const BINARIES: Record<string, string[]> = {
  alpine: ALPINE,
  node: [...ALPINE, "node", "npm", "npx", "yarn", "docker-entrypoint.sh"],
  caddy: [...ALPINE, "caddy"],
  postgres: [...DEBIAN, "psql", "pg_isready", "pg_dump", "pg_restore", "postgres", "createdb", "docker-entrypoint.sh"],
  nginx: [...DEBIAN, "curl", "nginx"],
  "hello-world": ["hello", "/hello"],
};

export function hasBinary(host: Host, c: Container, bin: string): boolean {
  const base = bin.split("/").pop() ?? bin;
  return (BINARIES[flavorOf(host, c)] ?? ALPINE).includes(base);
}

// ---------- reaching a container over HTTP from inside another ----------

export interface Reach {
  ok: boolean;
  error?: string;
}

/** Can `from` open url? localhost means `from` itself. Used by healthchecks and exec curl/wget. */
export function reach(host: Host, from: Container, url: string): Reach {
  const m = /^https?:\/\/([^/:]+)(?::(\d+))?/.exec(url);
  if (!m) return { ok: false, error: "bad address" };
  const name = m[1];
  const port = m[2] ? Number(m[2]) : url.startsWith("https") ? 443 : 80;
  const self = name === "localhost" || name === "127.0.0.1";
  const target = self ? from : resolveInDocker(host, from, name);
  if (!target) return { ok: false, error: `bad address '${name}'` };
  if (target.status !== "running" || target.listenPort !== port) return { ok: false, error: "Connection refused" };
  const loopback = target.listenAddr === "127.0.0.1" || target.listenAddr === "localhost";
  const any = target.listenAddr === "0.0.0.0" || target.listenAddr === "::";
  if (self ? !(any || loopback) : loopback) return { ok: false, error: "Connection refused" };
  return { ok: true };
}

// ---------- healthchecks ----------

/** One run of the container's healthcheck test, right now. */
export function probe(host: Host, c: Container): boolean {
  if (c.status !== "running") return false;
  const hc = c.healthcheck;
  if (!hc) return true;
  const [mode, ...rest] = hc.test;
  if (mode === "NONE") return true;
  const cmd = mode === "CMD-SHELL" || mode === "CMD" ? rest.join(" ") : hc.test.join(" ");
  const first = cmd.split(/\|\||&&|;/)[0].trim();
  const bin = first.split(/\s+/)[0] ?? "";
  if (bin === "true" || first === "exit 0") return true;
  if (bin === "false" || /^exit [1-9]/.test(first)) return false;
  if (!hasBinary(host, c, bin)) return false;
  if (bin === "pg_isready") return c.kind === "postgres";
  const url = /https?:\/\/[^\s'"`)]+/.exec(first)?.[0];
  if ((bin === "curl" || bin === "wget" || bin === "node") && url) return reach(host, c, url).ok;
  return true;
}

// ---------- docker exec ----------

export interface ExecCtx {
  w: World;
  host: Host;
  c: Container;
  argv: string[];
  workdir?: string;
  out(s: string): void;
  err(s: string): void;
  info(s: string): void;
}

/** Return a number to handle the command, undefined to pass it on. */
export type ExecHook = (x: ExecCtx) => number | undefined;

const EXEC_HOOKS: { name: string; run: ExecHook }[] = [];

/** Later worlds plug in psql (World 7) or caddy reload (World 6) here. */
export function registerExecHook(name: string, run: ExecHook): void {
  const i = EXEC_HOOKS.findIndex((h) => h.name === name);
  if (i >= 0) EXEC_HOOKS[i] = { name, run };
  else EXEC_HOOKS.push({ name, run });
}

/** What ls shows in the usual folders of any Linux image. */
const STANDARD_DIRS: Record<string, string[]> = {
  "/": ["bin", "dev", "etc", "home", "lib", "media", "mnt", "opt", "proc", "root", "run", "sbin", "srv", "sys", "tmp", "usr", "var"],
  "/usr": ["bin", "lib", "local", "sbin", "share"],
  "/var": ["cache", "lib", "log", "run", "tmp"],
};

function ociNotFound(bin: string): string {
  return `OCI runtime exec failed: exec failed: unable to start container process: exec: "${bin}": executable file not found in $PATH: unknown`;
}

/** Read a file the way the container sees it: bind mounts first. */
function fileInside(host: Host, c: Container, path: string): string | undefined {
  for (const m of c.mounts) {
    if (m.type !== "bind") continue;
    if (path === m.target) return readText(host, m.source);
    if (path.startsWith(m.target + "/")) return readText(host, m.source + path.slice(m.target.length));
  }
  if (path === "/etc/hostname") return c.id.slice(0, 12) + "\n";
  if (path === "/etc/os-release") {
    const f = flavorOf(host, c);
    return f === "postgres" || f === "nginx"
      ? `PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nNAME="Debian GNU/Linux"\nVERSION_ID="13"\nID=debian\n`
      : `NAME="Alpine Linux"\nID=alpine\nVERSION_ID=3.22.2\nPRETTY_NAME="Alpine Linux v3.22"\n`;
  }
  return undefined;
}

export function execIn(x: ExecCtx): number {
  for (const h of EXEC_HOOKS) {
    const r = h.run(x);
    if (r !== undefined) return r;
  }
  const { host, c, argv } = x;
  const bin = argv[0] ?? "";
  const base = bin.split("/").pop() ?? bin;
  if (!hasBinary(host, c, base)) {
    x.err(ociNotFound(bin));
    return 127;
  }
  const alpine = !["postgres", "nginx"].includes(flavorOf(host, c));
  switch (base) {
    case "sh":
    case "ash":
    case "bash": {
      if (argv[1] === "-c" && argv[2]) {
        const words = argv[2].match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
        return execIn({ ...x, argv: words.map((w) => w.replace(/^["']|["']$/g, "")) });
      }
      x.info("A shell inside a container is not in this game. Run one command at a time instead, like: docker exec NAME env");
      return 0;
    }
    case "env":
    case "printenv": {
      const lines = envLines(host, c);
      if (base === "printenv" && argv[1]) {
        const hit = lines.find((l) => l.startsWith(argv[1] + "="));
        if (!hit) return 1;
        x.out(hit.slice(argv[1].length + 1));
        return 0;
      }
      x.out(lines.join("\n"));
      return 0;
    }
    case "hostname":
      x.out(c.id.slice(0, 12));
      return 0;
    case "whoami":
      x.out("root");
      return 0;
    case "id":
      x.out("uid=0(root) gid=0(root) groups=0(root)");
      return 0;
    case "echo":
      x.out(argv.slice(1).join(" "));
      return 0;
    case "cat": {
      let code = 0;
      for (const p of argv.slice(1)) {
        const abs = p.startsWith("/") ? p : `${x.workdir ?? metaOf(host, c).workdir ?? "/"}/${p}`.replace(/\/+/g, "/");
        const text = fileInside(host, c, abs);
        if (text === undefined) {
          x.err(alpine ? `cat: can't open '${p}': No such file or directory` : `cat: ${p}: No such file or directory`);
          code = 1;
        } else x.out(text.replace(/\n$/, ""));
      }
      return code;
    }
    case "ls": {
      const target = argv.slice(1).find((a) => !a.startsWith("-")) ?? x.workdir ?? metaOf(host, c).workdir ?? "/";
      const bind = c.mounts.find((m) => m.type === "bind" && (target === m.target || target.startsWith(m.target + "/")));
      if (bind) {
        const d = getDir(host, bind.source + target.slice(bind.target.length));
        if (d) {
          x.out(Object.keys(d.children).sort().join("\n"));
          return 0;
        }
      }
      const prefix = target.replace(/\/$/, "") + "/";
      const names = new Set((metaOf(host, c).files ?? []).filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length).split("/")[0]));
      for (const n of STANDARD_DIRS[target.replace(/(.)\/$/, "$1")] ?? []) names.add(n);
      if (names.size) x.out([...names].sort().join("\n"));
      return 0;
    }
    case "pg_isready": {
      x.out("/var/run/postgresql:5432 - accepting connections");
      return 0;
    }
    case "psql":
    case "pg_dump":
    case "pg_restore":
    case "createdb":
      x.info(`${base} inside the database container comes in a later world.`);
      return 0;
    case "wget":
    case "curl": {
      const url = argv.find((a) => /^https?:\/\//.test(a)) ?? argv.find((a) => !a.startsWith("-") && a !== base);
      const full = url && !/^https?:\/\//.test(url) ? `http://${url}` : url;
      if (!full) {
        x.err(base === "wget" ? "BusyBox v1.37.0 (2025-06-26) multi-call binary.\n\nUsage: wget [-cqS] [-O FILE] URL" : "curl: try 'curl --help' for more information");
        return 1;
      }
      const r = reach(host, c, full);
      if (!r.ok) {
        const name = /^https?:\/\/([^/:]+)/.exec(full)?.[1] ?? "";
        if (base === "wget") x.err(r.error?.startsWith("bad address") ? `wget: ${r.error}` : `Connecting to ${name}\nwget: can't connect to remote host: Connection refused`);
        else x.err(r.error?.startsWith("bad address") ? `curl: (6) Could not resolve host: ${name}` : `curl: (7) Failed to connect to ${name} port ${/:(\d+)/.exec(full.replace(/^https?:\/\//, ""))?.[1] ?? 80} after 0 ms: Couldn't connect to server`);
        return base === "wget" ? 1 : 7;
      }
      const target = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(full) ? c : resolveInDocker(host, c, /^https?:\/\/([^/:]+)/.exec(full)?.[1] ?? "");
      x.out(target?.kind === "nextjs" ? "<!DOCTYPE html><html lang=\"en\"><head><title>Crumb</title></head><body>...</body></html>" : "<!DOCTYPE html>\n<html>\n<head>\n<title>Welcome to nginx!</title>");
      return 0;
    }
    case "node":
      if (argv[1] === "-v" || argv[1] === "--version") {
        x.out("v24.11.0");
        return 0;
      }
      x.info("Running node scripts inside a container is not in this game.");
      return 0;
    case "nginx":
      if (argv[1] === "-t") {
        x.err("nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful");
        return 0;
      }
      x.err("nginx version: nginx/1.27.5");
      return 0;
    case "caddy":
      if (argv[1] === "version") {
        x.out(`v${metaOf(host, c).version ?? "2.10.2"} h1:abc123=`);
        return 0;
      }
      x.info("That caddy command comes in a later world.");
      return 0;
    default:
      return 0;
  }
}
