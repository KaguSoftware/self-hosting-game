// psql: one command with -c, a script from stdin or -f, or an interactive
// session (a pending prompt "crumb=# ") with the usual backslash commands.
import { pgConnect, serverOf, SOCKET, parseConnUri, CLOSED, type PgConn, type PgTarget } from "./connect";
import { envData, getopt, val, type PgEnv, type PgEnvData, type PgOpts } from "./env";
import { pgTable, type TableOpts } from "./format";
import { copyInto, runSql, splitTop } from "./sql";
import { ident, major, SUPABASE_IP } from "./cluster";
import type { PgCluster } from "./types";

const PSQL_SPEC = {
  valued: "UdhpcfvF",
  flags: "wWqtAXexl1?V",
  long: {
    "username=": "U",
    "dbname=": "d",
    "host=": "h",
    "port=": "p",
    "command=": "c",
    "file=": "f",
    "set=": "v",
    "variable=": "v",
    "field-separator=": "F",
    "no-password": "w",
    password: "W",
    quiet: "q",
    "tuples-only": "t",
    "no-align": "A",
    "no-psqlrc": "X",
    "echo-all": "e",
    list: "l",
    "single-transaction": "1",
    help: "?",
    version: "V",
  },
};

// ---------- connecting (shared with pg_dump and pg_restore) ----------

/** Work out user, database, host and port from options, a connection URI and PG* variables. */
export function targetFrom(e: PgEnv, o: PgOpts, password?: string): PgTarget {
  const dOpt = val(o, "d");
  const uriText = [dOpt, o.pos[0]].find((x) => x && /^postgres(ql)?:\/\//.test(x));
  const uri = uriText ? (parseConnUri(uriText) ?? {}) : {};
  const posDb = o.pos[0] && o.pos[0] !== uriText ? o.pos[0] : undefined;
  const user = val(o, "U") ?? uri.user ?? e.env.PGUSER ?? (uriText ? undefined : o.pos[1]) ?? e.osUser;
  const db = (dOpt && dOpt !== uriText ? dOpt : undefined) ?? posDb ?? uri.db ?? e.env.PGDATABASE ?? user;
  const portText = val(o, "p") ?? (uri.port ? String(uri.port) : undefined) ?? e.env.PGPORT;
  return {
    user,
    db,
    host: val(o, "h") ?? uri.host ?? e.env.PGHOST,
    port: portText ? Number(portText) : 5432,
    password: password ?? uri.password ?? e.env.PGPASSWORD,
    sslmode: uri.sslmode ?? e.env.PGSSLMODE,
  };
}

/**
 * Connect, or ask for a password and come back later. Returns the connection,
 * an exit code after printing the error, or "asked" when a password prompt is showing.
 */
export function connectOrAsk(e: PgEnv, prog: string, args: string[], o: PgOpts, password?: string): PgConn | number | "asked" {
  const t = targetFrom(e, o, password);
  const ask = () => {
    e.prompt!({ prompt: `Password for user ${t.user}: `, secret: true, cmd: "__pg", data: { stage: "password", prog, args, env: envData(e) } });
    return "asked" as const;
  };
  if (o.bools.has("W") && password === undefined && e.terminal && e.prompt) return ask();
  const r = pgConnect(e.w, e.from, t);
  if (r.ok) return r.conn;
  if (r.needPassword && e.terminal && e.prompt && !o.bools.has("w") && password === undefined) return ask();
  e.err(`${prog}: error: ${r.error}`);
  return prog === "psql" ? 2 : 1;
}

// ---------- psql ----------

function fmtOf(o: PgOpts): TableOpts {
  return { tuplesOnly: o.bools.has("t"), unaligned: o.bools.has("A") };
}

export function runPsql(e: PgEnv, args: string[], password?: string): number {
  const o = getopt("psql", args, PSQL_SPEC);
  if (o.error) {
    e.err(o.error);
    return 1;
  }
  if (o.bools.has("V")) {
    e.out(`psql (PostgreSQL) ${e.client.long}`);
    return 0;
  }
  if (o.bools.has("?")) {
    e.out(PSQL_HELP);
    return 0;
  }
  const conn = connectOrAsk(e, "psql", args, o, password);
  if (typeof conn !== "object") return conn === "asked" ? 0 : conn;
  const fmt = fmtOf(o);
  const commands = o.vals.c ?? [];
  if (o.bools.has("l")) {
    e.out(listDatabases(e, conn, fmt).join("\n"));
    return 0;
  }
  if (commands.length) {
    let code = 0;
    for (const c of commands) {
      const r = c.trim().startsWith("\\") ? meta(e, conn, c.trim(), fmt) : runText(e, conn, c, fmt, undefined);
      if (r.code) code = r.code;
    }
    return code;
  }
  const file = val(o, "f");
  if (file !== undefined) {
    if (file === "-") return runScript(e, conn, e.stdin ?? "", "<stdin>", fmt);
    const f = e.readFile(file);
    if (f.text === undefined) {
      e.err(`psql: error: ${file}: ${f.error ?? "No such file or directory"}`);
      return 1;
    }
    return runScript(e, conn, f.text, file, fmt);
  }
  if (e.stdin !== undefined) return runScript(e, conn, e.stdin, "<stdin>", fmt);
  if (!e.terminal || !e.prompt) return 0;
  // An interactive session.
  const info = serverOf(e.w, conn.server)!;
  const lines = [`psql (${e.client.long}${info.long !== e.client.long ? `, server ${info.long}` : ""})`];
  if (major(info.version) !== major(e.client.version)) {
    lines.push(`WARNING: psql major version ${major(e.client.version)}, server major version ${major(info.version)}.`, "         Some psql features might not work.");
  }
  if (conn.ssl) lines.push("SSL connection (protocol: TLSv1.3, cipher: TLS_AES_256_GCM_SHA384, compression: off)");
  lines.push(`Type "help" for help.`, "");
  e.out(lines.join("\n"));
  askNext(e, { conn, buf: "", fmt });
  return 0;
}

interface Session {
  conn: PgConn;
  buf: string;
  fmt: TableOpts;
  /** \password in progress. */
  pw?: { user: string; first?: string };
}

function isSuper(e: PgEnv, conn: PgConn): boolean {
  return !!serverOf(e.w, conn.server)?.cluster.roles[conn.user]?.superuser;
}

function askNext(e: PgEnv, s: Session): void {
  const mark = isSuper(e, s.conn) ? "#" : ">";
  let prompt = `${s.conn.db}${s.buf ? (/\([^)]*$/.test(s.buf) ? "(" : "-") : "="}${mark} `;
  let secret = false;
  if (s.pw) {
    secret = true;
    prompt = s.pw.first === undefined ? `Enter new password for user "${s.pw.user}": ` : "Enter it again: ";
  }
  e.prompt!({ prompt, secret, cmd: "__pg", data: { stage: "session", session: s as unknown as Record<string, unknown>, env: envData(e) } });
}

/** One line typed at the psql prompt. */
export function psqlLine(e: PgEnv, s: Session, input: string): number {
  if (!serverOf(e.w, s.conn.server)) {
    e.err(`${CLOSED}\nThe connection to the server was lost. Attempting reset: Failed.`);
    return 2;
  }
  if (s.pw) {
    if (s.pw.first === undefined) {
      askNext(e, { ...s, pw: { ...s.pw, first: input } });
      return 0;
    }
    if (input !== s.pw.first) e.err("Passwords didn't match.");
    else {
      const role = serverOf(e.w, s.conn.server, true)!.cluster.roles[s.pw.user];
      if (role) role.password = input;
    }
    askNext(e, { ...s, pw: undefined });
    return 0;
  }
  const line = input.trim();
  if (!s.buf && (line === "\\q" || line === "exit" || line === "quit" || line === "\\quit")) return 0;
  if (!s.buf && line === "help") {
    e.out(SESSION_HELP);
    askNext(e, s);
    return 0;
  }
  if (!s.buf && line.startsWith("\\")) {
    if (line.startsWith("\\password")) {
      askNext(e, { ...s, pw: { user: line.split(/\s+/)[1] ?? s.conn.user } });
      return 0;
    }
    const r = meta(e, s.conn, line, s.fmt);
    askNext(e, { ...s, conn: r.conn ?? s.conn });
    return 0;
  }
  if (line === "\\r") {
    e.out("Query buffer reset (cleared).");
    askNext(e, { ...s, buf: "" });
    return 0;
  }
  const text = s.buf ? `${s.buf}\n${input}` : input;
  const { done, rest } = splitStatements(text);
  for (const stmt of done) runText(e, s.conn, stmt, s.fmt, undefined);
  askNext(e, { ...s, buf: rest.trim() ? rest : "" });
  return 0;
}

/** Complete statements (ending in ; outside quotes) and the unfinished rest. */
export function splitStatements(text: string): { done: string[]; rest: string } {
  const done: string[] = [];
  let q = "";
  let cur = "";
  for (const ch of text) {
    cur += ch;
    if (q) {
      if (ch === q) q = "";
    } else if (ch === "'" || ch === '"') q = ch;
    else if (ch === ";") {
      done.push(cur.trim());
      cur = "";
    }
  }
  return { done: done.filter((d) => d !== ";"), rest: cur };
}

function show(e: PgEnv, r: { lines: string[]; error?: string[]; notices?: string[]; info?: string }, prefix = ""): number {
  if (r.notices?.length) e.err(r.notices.join("\n"));
  if (r.error) {
    e.err(prefix ? r.error.map((l, i) => (i === 0 ? prefix + l : l)).join("\n") : r.error.join("\n"));
    return 1;
  }
  if (r.info) e.info(r.info);
  if (r.lines.length) e.out(r.lines.join("\n"));
  return 0;
}

/** Run SQL text that may hold several statements (psql -c, or a finished line). */
function runText(e: PgEnv, conn: PgConn, text: string, fmt: TableOpts, prefix: string | undefined): { code: number } {
  const { done, rest } = splitStatements(text);
  const stmts = [...done, ...(rest.trim() ? [rest] : [])];
  let code = 0;
  for (const st of stmts) {
    const r = runSql(e.w, conn, st, fmt);
    if (show(e, r, prefix)) code = 1;
  }
  return { code };
}

/** psql reading a whole file or stdin, the way a plain pg_dump is restored. */
function runScript(e: PgEnv, conn: PgConn, text: string, name: string, fmt: TableOpts): number {
  if (text.startsWith("PGDMP")) {
    e.err("The input is a PostgreSQL custom-format dump.\nUse the pg_restore command-line client to restore this dump to a database.");
    return 1;
  }
  const lines = text.split("\n");
  let buf = "";
  let startLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!buf && (!line || line.startsWith("--"))) continue;
    if (!buf && line.startsWith("\\")) {
      if (/^\\(connect|c)\s/.test(line)) {
        const r = meta(e, conn, line, fmt);
        if (r.conn) conn = r.conn;
      }
      continue;
    }
    if (!buf) startLine = i + 1;
    buf = buf ? `${buf}\n${raw}` : raw;
    if (!/;\s*$/.test(line)) continue;
    const stmt = buf;
    buf = "";
    const copy = /^copy\s+([\w."]+)\s*(?:\([^)]*\))?\s+from\s+stdin;?$/i.exec(stmt.trim());
    if (copy) {
      // Rows follow until \. on its own line.
      let n = 0;
      let j = i + 1;
      for (; j < lines.length && lines[j] !== "\\."; j++) if (lines[j]) n++;
      const marked = /Rows: (\d+)/.exec(lines.slice(Math.max(0, i - 4), i).join("\n"));
      const rows = marked ? Number(marked[1]) : n;
      const cl = serverOf(e.w, conn.server, true)?.cluster;
      const err = cl ? copyInto(cl, conn.db, copy[1], rows) : "server closed the connection unexpectedly";
      if (err) e.err(`psql:${name}:${startLine}: ERROR:  ${err}`);
      else e.out(`COPY ${rows}`);
      i = j;
      continue;
    }
    const r = runSql(e.w, conn, stmt, fmt);
    show(e, r, `psql:${name}:${startLine}: `);
  }
  return 0;
}

// ---------- backslash commands ----------

function listDatabases(e: PgEnv, conn: PgConn, fmt: TableOpts): string[] {
  const info = serverOf(e.w, conn.server)!;
  const cl = info.cluster;
  const sup = Object.keys(cl.roles).find((r) => cl.roles[r].superuser && r !== "supabase_admin") ?? "postgres";
  const tmplOwner = conn.server.kind === "external" ? "supabase_admin" : sup;
  const locale = conn.server.kind === "external" ? "C.UTF-8" : "en_US.utf8";
  const names = [...new Set([...Object.keys(cl.databases), "template0", "template1"])].sort();
  const rows = names.map((n) => {
    const owner = cl.databases[n]?.owner ?? tmplOwner;
    const acl = n.startsWith("template") ? `=c/${owner}\n${owner}=CTc/${owner}` : "";
    return [n, owner, "UTF8", "libc", locale, locale, "", "", acl];
  });
  const loc = major(e.client.version) >= 17 ? "Locale" : "ICU Locale";
  return pgTable(["Name", "Owner", "Encoding", "Locale Provider", "Collate", "Ctype", loc, "ICU Rules", "Access privileges"], rows, { ...fmt, title: "List of databases" });
}

/** \dt [pattern]: tables in public (the search_path), or in the schemas a pattern names. */
function listTables(cl: PgCluster, conn: PgConn, pattern: string | undefined, fmt: TableOpts): string[] {
  const d = cl.databases[conn.db];
  let schemaRe = /^(public)$/;
  let nameRe = /.*/;
  if (pattern) {
    const toRe = (p: string) => new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
    const [a, b] = pattern.includes(".") ? pattern.split(".") : [undefined, pattern];
    if (a !== undefined) schemaRe = toRe(ident(a));
    nameRe = toRe(ident(b ?? "*"));
  }
  const rows = Object.entries(d.tables)
    .map(([q, t]) => ({ schema: q.split(".")[0], name: q.split(".")[1], owner: t.owner ?? d.owner }))
    .filter((t) => schemaRe.test(t.schema) && nameRe.test(t.name))
    .sort((x, y) => x.schema.localeCompare(y.schema) || x.name.localeCompare(y.name))
    .map((t) => [t.schema, t.name, "table", t.owner]);
  if (!rows.length) return [pattern ? `Did not find any relation named "${pattern}".` : "Did not find any relations."];
  return pgTable(["Schema", "Name", "Type", "Owner"], rows, { ...fmt, title: "List of relations" });
}

/** \d TABLE: the columns, parsed from their definitions. */
function describeTable(cl: PgCluster, conn: PgConn, name: string, fmt: TableOpts): string[] {
  const d = cl.databases[conn.db];
  const parts = name.split(".").map(ident);
  const q = parts.length === 1 ? `public.${parts[0]}` : parts.join(".");
  const t = d.tables[q];
  if (!t) return [`Did not find any relation named "${name}".`];
  const rows = (t.columns ?? []).map((c) => {
    const m = /^("?[\w]+"?)\s+(.*?)(?:\s+DEFAULT\s+(.*?))?(\s+NOT NULL)?$/i.exec(splitTop(c)[0] ?? c);
    if (!m) return [c, "", "", "", ""];
    return [m[1].replace(/"/g, ""), m[2].replace(/\s+NOT NULL$/i, ""), "", m[4] || /NOT NULL/i.test(m[2]) ? "not null" : "", m[3] ?? ""];
  });
  const out = pgTable(["Column", "Type", "Collation", "Nullable", "Default"], rows, { ...fmt, title: `Table "${q}"` });
  out.pop();
  out.pop(); // \d prints no "(N rows)" footer
  return [...out, ""];
}

const ATTRS = "Superuser, Create role, Create DB, Replication, Bypass RLS";

export function meta(e: PgEnv, conn: PgConn, line: string, fmt: TableOpts): { code: number; conn?: PgConn } {
  const info = serverOf(e.w, conn.server);
  if (!info) {
    e.err(CLOSED);
    return { code: 2 };
  }
  const cl = info.cluster;
  const [cmd, ...rest] = line.split(/\s+/);
  const base = cmd.replace(/\+$/, "");
  switch (base) {
    case "\\l":
    case "\\list":
      e.out(listDatabases(e, conn, fmt).join("\n"));
      return { code: 0 };
    case "\\dt":
      e.out(listTables(cl, conn, rest[0], fmt).join("\n"));
      return { code: 0 };
    case "\\d":
      e.out((rest[0] ? describeTable(cl, conn, rest[0], fmt) : listTables(cl, conn, undefined, fmt)).join("\n"));
      return { code: 0 };
    case "\\dn": {
      const d = cl.databases[conn.db];
      const rows = [...d.schemas].sort().map((s) => [s, s === "public" ? "pg_database_owner" : (d.schemaOwners?.[s] ?? d.owner)]);
      e.out(pgTable(["Name", "Owner"], rows, { ...fmt, title: "List of schemas" }).join("\n"));
      return { code: 0 };
    }
    case "\\du":
    case "\\dg": {
      const rows = Object.entries(cl.roles)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([n, r]) => [n, [r.superuser ? ATTRS : "", r.login ? "" : "Cannot login"].filter(Boolean).join(", ")]);
      e.out(pgTable(["Role name", "Attributes"], rows, { ...fmt, title: "List of roles" }).join("\n"));
      return { code: 0 };
    }
    case "\\c":
    case "\\connect": {
      const db = rest[0] && rest[0] !== "-" ? ident(rest[0]) : conn.db;
      const user = rest[1] && rest[1] !== "-" ? rest[1] : conn.user;
      const where = conn.socket ? `on socket "${SOCKET}"` : `at "${conn.host}", port ${conn.port}`;
      if (!cl.roles[user]) {
        e.err(`connection to server ${where} failed: FATAL:  role "${user}" does not exist\nPrevious connection kept`);
        return { code: 1 };
      }
      if (!cl.databases[db]) {
        e.err(`connection to server ${where} failed: FATAL:  database "${db}" does not exist\nPrevious connection kept`);
        return { code: 1 };
      }
      e.out(`You are now connected to database "${db}" as user "${user}".`);
      return { code: 0, conn: { ...conn, db, user } };
    }
    case "\\conninfo": {
      if (conn.socket) e.out(`You are connected to database "${conn.db}" as user "${conn.user}" via socket in "/var/run/postgresql" at port "${conn.port}".`);
      else {
        const addr = conn.server.kind === "external" ? ` (address "${SUPABASE_IP}")` : "";
        e.out(`You are connected to database "${conn.db}" as user "${conn.user}" on host "${conn.host}"${addr} at port "${conn.port}".`);
        if (conn.ssl) e.out("SSL connection (protocol: TLSv1.3, cipher: TLS_AES_256_GCM_SHA384, compression: off)");
      }
      return { code: 0 };
    }
    case "\\x":
      e.out("Expanded display is on.");
      return { code: 0 };
    case "\\timing":
      e.out("Timing is on.");
      return { code: 0 };
    case "\\?":
      e.out(META_HELP);
      return { code: 0 };
    case "\\q":
      return { code: 0 };
    default:
      e.err(`invalid command ${cmd}\nTry \\? for help.`);
      return { code: 1 };
  }
}

/** Resume an interactive session after the player typed a line. */
export function resumeSession(e: PgEnv, data: Record<string, unknown>, input: string): number {
  return psqlLine(e, data.session as unknown as Session, input);
}

export type { PgEnvData };

const SESSION_HELP = `You are using psql, the command-line interface to PostgreSQL.
Type:  \\copyright for distribution terms
       \\h for help with SQL commands
       \\? for help with psql commands
       \\g or terminate with semicolon to execute query
       \\q to quit`;

const META_HELP = `General
  \\q                     quit psql

Informational
  \\d      NAME           describe table
  \\dn                    list schemas
  \\dt     [PATTERN]      list tables
  \\du                    list roles
  \\l                     list databases

Connection
  \\c      DBNAME         connect to another database
  \\conninfo              display information about current connection
  \\password [USERNAME]   securely change the password for a user`;

const PSQL_HELP = `psql is the PostgreSQL interactive terminal.

Usage:
  psql [OPTION]... [DBNAME [USERNAME]]

General options:
  -c, --command=COMMAND    run only single command (SQL or internal) and exit
  -d, --dbname=DBNAME      database name to connect to
  -f, --file=FILENAME      execute commands from file, then exit
  -l, --list               list available databases, then exit

Output format options:
  -A, --no-align           unaligned table output mode
  -t, --tuples-only        print rows only

Connection options:
  -h, --host=HOSTNAME      database server host or socket directory
  -p, --port=PORT          database server port
  -U, --username=USERNAME  database user name
  -w, --no-password        never prompt for password
  -W, --password           force password prompt (should happen automatically)`;
