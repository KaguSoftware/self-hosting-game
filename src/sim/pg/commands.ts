// Wiring: psql, pg_dump and pg_restore as host commands (postgresql-client),
// the same programs inside the db container (docker exec hook), and the hidden
// __pg command that every password prompt and psql session resumes through.
import { registerExecHook, type ExecCtx } from "../docker/behaviour";
import { fsErrorText, getNode, can, readText, resolvePath, writeFile as fsWrite } from "../fs";
import type { Container, Host } from "../types";
import type { Command, Ctx } from "../shell/ctx";
import { writeRedirect } from "../shell/redirect";
import { debianVersion, hostClient, serverVersion } from "./cluster";
import { pgConnect, type PgFrom } from "./connect";
import { runPgDump, runPgRestore } from "./dump";
import { getopt, val, type PgEnv, type PgEnvData } from "./env";
import { resumeSession, runPsql } from "./psql";
import { runSql } from "./sql";

type Program = (e: PgEnv, args: string[], password?: string) => number;

const PROGRAMS: Record<string, Program> = { psql: runPsql, pg_dump: runPgDump, pg_restore: runPgRestore, createdb: (e, a) => createDrop(e, a, "createdb"), dropdb: (e, a) => createDrop(e, a, "dropdb") };

/** Where `> file` in the player's line sends this program's output. */
function redirectOf(ctx: Ctx, prog: string): PgEnv["redirect"] {
  const line = ctx.sh.history[ctx.sh.history.length - 1] ?? "";
  const m = new RegExp(`\\b${prog}\\b[^|;&]*?(>>?)\\s*([^\\s|;&<>]+)`).exec(line);
  return m ? { target: m[2], append: m[1] === ">>" } : undefined;
}

// ---------- files, seen from the host or from inside the container ----------

function hostFiles(ctx: Ctx): Pick<PgEnv, "readFile" | "writeFile"> {
  return {
    readFile(path) {
      const abs = ctx.path(path);
      const node = getNode(ctx.host, abs);
      if (!node) return { error: "No such file or directory" };
      if (node.type === "dir") return { error: "Is a directory" };
      if (!can(ctx.host, ctx.user, node, "r")) return { error: "Permission denied" };
      return { text: node.content };
    },
    writeFile(path, content) {
      const err = fsWrite(ctx.host, ctx.user, ctx.path(path), content.endsWith("\n") ? content : content + "\n");
      return err ? fsErrorText(err) : undefined;
    },
  };
}

/** Inside the container only bind mounts lead back to the host's files. */
function containerFiles(host: Host, c: Container, info: (s: string) => void): Pick<PgEnv, "readFile" | "writeFile"> {
  const onHost = (path: string) => {
    const abs = resolvePath("/", path, "/root");
    for (const m of c.mounts) {
      if (m.type !== "bind") continue;
      if (abs === m.target) return m.source;
      if (abs.startsWith(m.target + "/")) return m.source + abs.slice(m.target.length);
    }
    return undefined;
  };
  return {
    readFile(path) {
      const p = onHost(path);
      const text = p ? readText(host, p) : undefined;
      return text === undefined ? { error: "No such file or directory" } : { text };
    },
    writeFile(path, content) {
      const p = onHost(path);
      if (!p) {
        info(`${path} was written inside the container, not on the server. It is gone when the container is recreated. Use > on your own shell instead, so the file lands on the server.`);
        return undefined;
      }
      const err = fsWrite(host, "root", p, content.endsWith("\n") ? content : content + "\n");
      return err ? fsErrorText(err) : undefined;
    },
  };
}

// ---------- building the environment ----------

function baseEnv(ctx: Ctx): Pick<PgEnv, "w" | "out" | "err" | "info" | "prompt"> {
  return { w: ctx.w, out: (s) => ctx.out(s), err: (s) => ctx.err(s), info: (s) => ctx.info(s), prompt: (p) => ctx.prompt(p) };
}

function hostEnv(ctx: Ctx, prog: string): PgEnv {
  return {
    ...baseEnv(ctx),
    ...hostFiles(ctx),
    from: { kind: "host", host: ctx.host.id },
    client: hostClient(ctx.host),
    osUser: ctx.user,
    env: { ...ctx.env },
    stdin: ctx.stdin,
    terminal: ctx.sh.id !== "detached",
    redirect: redirectOf(ctx, prog),
  };
}

function containerEnv(x: ExecCtx): PgEnv {
  const { host, c } = x;
  const v = serverVersion(host, c);
  const from: PgFrom = { kind: "container", host: host.id, container: c.name };
  return {
    w: x.w,
    out: x.out,
    err: x.err,
    info: x.info,
    prompt: x.prompt,
    ...containerFiles(host, c, x.info),
    from,
    client: { version: v, long: debianVersion(v) },
    osUser: x.user ?? "root",
    env: { ...(x.env ?? {}) },
    stdin: x.stdin,
    terminal: !!x.interactive && x.stdin === undefined && !!x.prompt,
  };
}

/** Rebuild an environment for a resumed prompt, in the same window. */
function resumedEnv(ctx: Ctx, d: PgEnvData): PgEnv {
  const from = d.from;
  let files: Pick<PgEnv, "readFile" | "writeFile"> = hostFiles(ctx);
  if (from.kind === "container") {
    const host = ctx.w.hosts[from.host];
    const c = host.docker.containers[from.container];
    if (c) files = containerFiles(host, c, (s) => ctx.info(s));
  }
  return { ...baseEnv(ctx), ...files, from, client: d.client, osUser: d.osUser, env: d.env, stdin: d.stdin, terminal: true, redirect: d.redirect };
}

// ---------- createdb / dropdb (inside the container) ----------

function createDrop(e: PgEnv, args: string[], prog: "createdb" | "dropdb"): number {
  const o = getopt(prog, args, { valued: "UhpOE", flags: "wWei", long: { "username=": "U", "host=": "h", "port=": "p", "owner=": "O", "if-exists": "IE" } });
  if (o.error) {
    e.err(o.error);
    return 1;
  }
  const user = val(o, "U") ?? e.env.PGUSER ?? e.osUser;
  const name = o.pos[0] ?? user;
  if (prog === "dropdb" && !o.pos[0]) {
    e.err(`dropdb: error: missing required argument database name\ndropdb: hint: Try "dropdb --help" for more information.`);
    return 1;
  }
  const r = pgConnect(e.w, e.from, { user, db: "postgres", host: val(o, "h"), port: val(o, "p") ? Number(val(o, "p")) : undefined, password: e.env.PGPASSWORD });
  if (!r.ok) {
    e.err(`${prog}: error: ${r.error}`);
    return 1;
  }
  const sql = prog === "createdb" ? `create database ${name}${val(o, "O") ? ` owner ${val(o, "O")}` : ""}` : `drop database ${o.bools.has("IE") ? "if exists " : ""}${name}`;
  const res = runSql(e.w, r.conn, sql);
  if (res.error) {
    e.err(`${prog}: error: database ${prog === "createdb" ? "creation" : "removal"} failed: ${res.error[0]}`);
    return 1;
  }
  return 0;
}

// ---------- docker exec ... psql ----------

const IN_CONTAINER = ["psql", "pg_dump", "pg_restore", "createdb", "dropdb"];

registerExecHook("postgres", (x) => {
  if (x.c.kind !== "postgres") return undefined;
  const base = (x.argv[0] ?? "").split("/").pop() ?? "";
  if (!IN_CONTAINER.includes(base)) return undefined;
  const e = containerEnv(x);
  const args = x.argv.slice(1);
  const code = PROGRAMS[base](e, args);
  if (base === "psql" && !code && !x.interactive && x.stdin === undefined && !args.some((a) => /^(-[a-zA-Z]*[clfV?]|--(command|list|file|version|help))/.test(a))) {
    x.info("psql found no keyboard and quit. docker exec needs -it to talk to it, like: docker exec -it NAME psql -U USER");
  }
  return code;
});

// ---------- the commands ----------

function hostCommand(name: string, summary: string): Command {
  return {
    name,
    summary,
    run(ctx) {
      return PROGRAMS[name](hostEnv(ctx, name), ctx.argv.slice(1));
    },
  };
}

export const psql = hostCommand("psql", "talk to a Postgres database (psql -h HOST -U USER -d DB)");
export const pgDump = hostCommand("pg_dump", "copy a database into one file (pg_dump -Fc DB > file.dump)");
export const pgRestore = hostCommand("pg_restore", "load a pg_dump -Fc file into a database");

/** Every password prompt and every psql session comes back through here. */
export const pgResume: Command = {
  name: "__pg",
  summary: "",
  hidden: true,
  run(ctx) {
    ctx.info("__pg: not in this game yet. Type help to see what works.");
    return 127;
  },
  resume(ctx, p, input) {
    const data = p.data as { stage: string; prog?: string; args?: string[]; env: PgEnvData };
    const e = resumedEnv(ctx, data.env);
    if (data.stage === "session") return resumeSession(e, data, input);
    const prog = PROGRAMS[data.prog ?? ""];
    if (!prog) return 0;
    if (!e.redirect || data.prog === "psql") return prog(e, data.args ?? [], input);
    // Keep the player's > file: the prompt broke the original command line in two.
    const buf: string[] = [];
    const code = prog({ ...e, out: (s) => buf.push(s) }, data.args ?? [], input);
    if (buf.length || !ctx.sh.pending) {
      const err = writeRedirect(ctx.w, ctx.frame, e.redirect.target, buf.join("\n"), e.redirect.append);
      if (err) {
        ctx.err(`-bash: ${e.redirect.target}: ${err}`);
        return 1;
      }
    }
    return code;
  },
};

export const PG_COMMANDS: Command[] = [psql, pgDump, pgRestore, pgResume];
