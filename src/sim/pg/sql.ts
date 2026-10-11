// The handful of SQL statements the game understands, run against the cluster model.
// Anything else that looks like SQL gets a friendly note; anything that does not
// gets the real "syntax error at or near" error.
import type { World } from "../types";
import { resolveInDocker } from "../net";
import { createDatabase, ident, qualify, STOCK_EXTENSIONS } from "./cluster";
import { parseConnUri, serverOf, type PgConn } from "./connect";
import { pgError, pgTable, type TableOpts } from "./format";
import type { PgCluster, PgDatabase } from "./types";

export interface SqlResult {
  /** Result table or command tag ("CREATE DATABASE"). */
  lines: string[];
  /** ERROR lines (with LINE 1 and the caret). */
  error?: string[];
  notices?: string[];
  /** Game voice: valid SQL the game does not model. */
  info?: string;
}

const SQL_WORDS = new Set(
  "select insert update delete create drop alter grant revoke begin commit rollback set show truncate with explain copy vacuum analyze comment reindex lock do values table end start savepoint release prepare execute listen notify reset discard cluster checkpoint refresh import call".split(" "),
);

const ok = (...lines: string[]): SqlResult => ({ lines });
const fail = (msg: string, opts: Parameters<typeof pgError>[1] = {}): SqlResult => ({ lines: [], error: pgError(msg, opts) });

/** How Postgres names a relation in errors: lower case unless quoted, schema kept. */
const relName = (raw: string) => raw.split(".").map(ident).join(".");

/** Position of `word` in the statement, for the caret under LINE 1. */
function posOf(sql: string, word: string): number {
  return sql.toLowerCase().indexOf(word.toLowerCase());
}

/** Split at top-level commas (not inside parentheses or quotes). */
export function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let q = "";
  let cur = "";
  for (const ch of s) {
    if (q) {
      if (ch === q) q = "";
    } else if (ch === "'" || ch === '"') q = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The table a name means, or undefined. Unqualified names look in public (the search_path). */
export function findTable(d: PgDatabase, name: string) {
  return d.tables[qualify(name)];
}

/** Running app containers whose DATABASE_URL points at this server and database. */
function otherSessions(w: World, conn: PgConn, db: string): number {
  if (conn.server.kind !== "container") return 0;
  const host = w.hosts[conn.server.host];
  const server = host.docker.containers[conn.server.container];
  let n = 0;
  for (const c of Object.values(host.docker.containers)) {
    if (c === server || c.status !== "running" || !c.env.DATABASE_URL) continue;
    const u = parseConnUri(c.env.DATABASE_URL);
    if (u?.host && (u.db ?? u.user) === db && resolveInDocker(host, c, u.host) === server) n++;
  }
  return n;
}

function roleMissing(cl: PgCluster, name: string): string | undefined {
  const r = ident(name);
  return r === "public" || cl.roles[r] ? undefined : `role "${r}" does not exist`;
}

/** Run one statement (without the trailing ;). Call on a draft: writes go straight into the volume. */
export function runSql(w: World, conn: PgConn, stmt: string, fmt: TableOpts = {}): SqlResult {
  const sql = stmt.trim().replace(/;\s*$/, "").trim();
  if (!sql) return ok();
  /** What psql shows after LINE 1: the statement as typed, with its semicolon. */
  const shown = stmt.trim();
  const first = /^[A-Za-z_]+/.exec(sql)?.[0]?.toLowerCase() ?? sql.split(/\s+/)[0];
  const mutating = /^(create|drop|alter|insert|delete|truncate|update|grant|revoke|comment)$/.test(first);
  const info = serverOf(w, conn.server, mutating);
  if (!info) return { lines: [], error: ["server closed the connection unexpectedly"] };
  const cl = info.cluster;
  const d = cl.databases[conn.db];
  let m: RegExpExecArray | null;
  if (mutating && !info.writable && first !== "grant") {
    return { lines: [], info: "This game keeps Supabase read only. Copy the data out with pg_dump, then change it on your own server." };
  }

  // ---------- reading ----------
  if ((m = /^select\s+count\s*\(\s*(?:\*|1|id)\s*\)\s+from\s+([\w."]+)/i.exec(sql))) {
    const t = findTable(d, m[1]);
    if (!t) return fail(`relation "${relName(m[1])}" does not exist`, { sql: shown, pos: posOf(sql, m[1]) });
    return ok(...pgTable(["count"], [[String(t.rows)]], { ...fmt, right: [0] }));
  }
  if (/^select\s+version\s*\(\s*\)$/i.test(sql)) {
    const v =
      conn.server.kind === "external"
        ? `PostgreSQL ${info.version} on aarch64-unknown-linux-gnu, compiled by gcc (GCC) 13.2.0, 64-bit`
        : `PostgreSQL ${info.long} on x86_64-pc-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit`;
    return ok(...pgTable(["version"], [[v]], fmt));
  }
  if (/^select\s+current_user$/i.test(sql)) return ok(...pgTable(["current_user"], [[conn.user]], fmt));
  if (/^select\s+current_database\s*\(\s*\)$/i.test(sql)) return ok(...pgTable(["current_database"], [[conn.db]], fmt));
  if ((m = /^select\s+(\d+)$/i.exec(sql))) return ok(...pgTable(["?column?"], [[m[1]]], { ...fmt, right: [0] }));
  if (/^show\s+server_version$/i.test(sql)) return ok(...pgTable(["server_version"], [[info.long]], fmt));
  if (/^select\s+pg_catalog\.set_config\(/i.test(sql)) return ok(...pgTable(["set_config"], [[""]], fmt));
  if ((m = /^select\s[\s\S]*?\sfrom\s+([\w."]+)/i.exec(sql))) {
    if (!/^pg_|^information_schema/.test(m[1]) && !findTable(d, m[1])) return fail(`relation "${relName(m[1])}" does not exist`, { sql: shown, pos: posOf(sql, m[1]) });
    return { lines: [], info: "That query is fine, but this game only answers select count(*) from TABLE, select version() and a few more." };
  }

  // ---------- databases ----------
  if ((m = /^create\s+database\s+("[^"]+"|[\w-]+)(?:\s+(?:with\s+)?owner\s*=?\s*("[^"]+"|\w+))?/i.exec(sql))) {
    const name = ident(m[1]);
    if (/-/.test(m[1]) && !m[1].startsWith('"')) return fail(`syntax error at or near "-"`, { sql: shown, pos: sql.indexOf("-") });
    const me = cl.roles[conn.user];
    if (!me?.superuser) return fail("permission denied to create database");
    if (cl.databases[name] || name === "template0" || name === "template1") return fail(`database "${name}" already exists`);
    const owner = m[2] ? ident(m[2]) : conn.user;
    const miss = roleMissing(cl, owner);
    if (miss) return fail(miss);
    createDatabase(cl, name, owner);
    return ok("CREATE DATABASE");
  }
  if ((m = /^drop\s+database\s+(if\s+exists\s+)?("[^"]+"|[\w-]+)(\s+(?:with\s*)?\(\s*force\s*\))?$/i.exec(sql))) {
    const name = ident(m[2]);
    if (!cl.databases[name] && name !== "template0" && name !== "template1") {
      if (m[1]) return { lines: ["DROP DATABASE"], notices: [`NOTICE:  database "${name}" does not exist, skipping`] };
      return fail(`database "${name}" does not exist`);
    }
    if (name === "template0" || name === "template1") return fail(`cannot drop a template database`);
    if (name === conn.db) return fail("cannot drop the currently open database");
    const others = otherSessions(w, conn, name);
    if (others && !m[3]) return fail(`database "${name}" is being accessed by other users`, { detail: `There ${others === 1 ? "is 1 other session" : `are ${others} other sessions`} using the database.` });
    delete cl.databases[name];
    return ok("DROP DATABASE");
  }

  // ---------- schemas and tables ----------
  if ((m = /^create\s+schema\s+(if\s+not\s+exists\s+)?("[^"]+"|\w+)(?:\s+authorization\s+("[^"]+"|\w+))?$/i.exec(sql))) {
    const name = ident(m[2]);
    if (d.schemas.includes(name)) {
      if (m[1]) return { lines: ["CREATE SCHEMA"], notices: [`NOTICE:  schema "${name}" already exists, skipping`] };
      return fail(`schema "${name}" already exists`);
    }
    d.schemas.push(name);
    if (m[3]) (d.schemaOwners ??= {})[name] = ident(m[3]);
    return ok("CREATE SCHEMA");
  }
  if ((m = /^drop\s+schema\s+(if\s+exists\s+)?("[^"]+"|\w+)(\s+cascade)?$/i.exec(sql))) {
    const name = ident(m[2]);
    if (!d.schemas.includes(name)) return m[1] ? { lines: ["DROP SCHEMA"], notices: [`NOTICE:  schema "${name}" does not exist, skipping`] } : fail(`schema "${name}" does not exist`);
    const inside = Object.keys(d.tables).filter((t) => t.startsWith(name + "."));
    if (inside.length && !m[3])
      return fail(`cannot drop schema ${name} because other objects depend on it`, { detail: inside.map((t) => `table ${t} depends on schema ${name}`).join("\n"), hint: "Use DROP ... CASCADE to drop the dependent objects too." });
    for (const t of inside) delete d.tables[t];
    d.schemas = d.schemas.filter((s) => s !== name);
    return { lines: ["DROP SCHEMA"], notices: inside.length ? [`NOTICE:  drop cascades to ${inside.length} other object${inside.length === 1 ? "" : "s"}`] : undefined };
  }
  if ((m = /^create\s+table\s+(if\s+not\s+exists\s+)?([\w."]+)\s*\(([\s\S]*)\)$/i.exec(sql))) {
    const q = qualify(m[2]);
    const schema = q.split(".")[0];
    if (!d.schemas.includes(schema)) return fail(`schema "${schema}" does not exist`, { sql: shown, pos: posOf(sql, m[2]) });
    if (d.tables[q]) {
      if (m[1]) return { lines: ["CREATE TABLE"], notices: [`NOTICE:  relation "${q.split(".")[1]}" already exists, skipping`] };
      return fail(`relation "${q.split(".")[1]}" already exists`);
    }
    const columns = splitTop(m[3]).filter((c) => !/^(primary|foreign|unique|constraint|check)\b/i.test(c));
    d.tables[q] = { rows: 0, owner: conn.user, columns };
    return ok("CREATE TABLE");
  }
  if ((m = /^drop\s+table\s+(if\s+exists\s+)?([\w.",\s]+?)(\s+cascade)?$/i.exec(sql))) {
    for (const raw of splitTop(m[2])) {
      if (!findTable(d, raw)) return m[1] ? { lines: ["DROP TABLE"], notices: [`NOTICE:  table "${ident(raw)}" does not exist, skipping`] } : fail(`table "${ident(raw)}" does not exist`);
    }
    for (const raw of splitTop(m[2])) delete d.tables[qualify(raw)];
    return ok("DROP TABLE");
  }
  if ((m = /^insert\s+into\s+([\w."]+)[\s\S]*?\bvalues\s*([\s\S]+?)(?:\s+(?:returning|on\s+conflict)\b[\s\S]*)?$/i.exec(sql))) {
    const t = findTable(d, m[1]);
    if (!t) return fail(`relation "${relName(m[1])}" does not exist`, { sql: shown, pos: posOf(sql, m[1]) });
    const n = Math.max(1, splitTop(m[2]).length);
    t.rows += n;
    return ok(`INSERT 0 ${n}`);
  }
  if ((m = /^delete\s+from\s+([\w."]+)(\s+where\b[\s\S]*)?$/i.exec(sql))) {
    const t = findTable(d, m[1]);
    if (!t) return fail(`relation "${relName(m[1])}" does not exist`, { sql: shown, pos: posOf(sql, m[1]) });
    if (m[2]) return { lines: [], info: "DELETE with WHERE is not modeled in this game. Without WHERE it empties the whole table, so be careful on a real server." };
    const n = t.rows;
    t.rows = 0;
    return ok(`DELETE ${n}`);
  }
  if ((m = /^truncate\s+(?:table\s+)?([\w.",\s]+?)(\s+restart\s+identity)?(\s+cascade)?$/i.exec(sql))) {
    for (const raw of splitTop(m[1])) if (!findTable(d, raw)) return fail(`relation "${ident(raw)}" does not exist`);
    for (const raw of splitTop(m[1])) d.tables[qualify(raw)].rows = 0;
    return ok("TRUNCATE TABLE");
  }
  if ((m = /^alter\s+table\s+(?:only\s+)?([\w."]+)\s+owner\s+to\s+("[^"]+"|\w+)$/i.exec(sql))) {
    const t = findTable(d, m[1]);
    if (!t) return fail(`relation "${relName(m[1])}" does not exist`);
    const miss = roleMissing(cl, m[2]);
    if (miss) return fail(miss);
    t.owner = ident(m[2]);
    return ok("ALTER TABLE");
  }
  if ((m = /^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w."]+)\s/i.exec(sql))) {
    if (!findTable(d, m[1])) return fail(`relation "${relName(m[1])}" does not exist`);
    return ok("ALTER TABLE");
  }
  if ((m = /^alter\s+schema\s+("[^"]+"|\w+)\s+owner\s+to\s+("[^"]+"|\w+)$/i.exec(sql))) {
    const s = ident(m[1]);
    if (!d.schemas.includes(s)) return fail(`schema "${s}" does not exist`);
    const miss = roleMissing(cl, m[2]);
    if (miss) return fail(miss);
    (d.schemaOwners ??= {})[s] = ident(m[2]);
    return ok("ALTER SCHEMA");
  }

  // ---------- roles ----------
  if ((m = /^create\s+(user|role)\s+("[^"]+"|\w+)(?:\s+with)?([\s\S]*)$/i.exec(sql))) {
    const name = ident(m[2]);
    if (cl.roles[name]) return fail(`role "${name}" already exists`);
    const opts = m[3];
    const pw = /password\s+'([^']*)'/i.exec(opts)?.[1];
    cl.roles[name] = {
      password: pw,
      superuser: /\bsuperuser\b/i.test(opts) && !/\bnosuperuser\b/i.test(opts),
      login: m[1].toLowerCase() === "user" ? !/\bnologin\b/i.test(opts) : /\blogin\b/i.test(opts) && !/\bnologin\b/i.test(opts),
    };
    return ok("CREATE ROLE");
  }
  if ((m = /^alter\s+(user|role)\s+("[^"]+"|\w+)(?:\s+with)?([\s\S]*)$/i.exec(sql))) {
    const name = ident(m[2]);
    const r = cl.roles[name];
    if (!r) return fail(`role "${name}" does not exist`);
    const pw = /password\s+'([^']*)'/i.exec(m[3]);
    if (pw) r.password = pw[1];
    if (/\bnologin\b/i.test(m[3])) r.login = false;
    else if (/\blogin\b/i.test(m[3])) r.login = true;
    if (/\bnosuperuser\b/i.test(m[3])) r.superuser = false;
    else if (/\bsuperuser\b/i.test(m[3])) r.superuser = true;
    return ok("ALTER ROLE");
  }
  if ((m = /^drop\s+(user|role)\s+(if\s+exists\s+)?("[^"]+"|\w+)$/i.exec(sql))) {
    const name = ident(m[3]);
    if (!cl.roles[name]) return m[2] ? { lines: ["DROP ROLE"], notices: [`NOTICE:  role "${name}" does not exist, skipping`] } : fail(`role "${name}" does not exist`);
    if (name === conn.user) return fail("current user cannot be dropped");
    delete cl.roles[name];
    return ok("DROP ROLE");
  }
  if ((m = /^(grant|revoke)\s[\s\S]*?\s(?:to|from)\s+([\w",\s]+)$/i.exec(sql))) {
    for (const r of splitTop(m[2])) {
      const miss = roleMissing(cl, r);
      if (miss) return fail(miss);
    }
    return ok(m[1].toUpperCase());
  }

  // ---------- extensions and session ----------
  if ((m = /^create\s+extension\s+(if\s+not\s+exists\s+)?("[^"]+"|[\w-]+)(?:\s+with)?(?:\s+schema\s+("[^"]+"|\w+))?/i.exec(sql))) {
    const name = ident(m[2]);
    const exts = (d.extensions ??= {});
    if (exts[name]) return m[1] ? { lines: ["CREATE EXTENSION"], notices: [`NOTICE:  extension "${name}" already exists, skipping`] } : fail(`extension "${name}" already exists`);
    if (!STOCK_EXTENSIONS.includes(name)) {
      return fail(`extension "${name}" is not available`, {
        detail: `Could not open extension control file "/usr/share/postgresql/${cl.version}/extension/${name}.control": No such file or directory.`,
        hint: "The extension must first be installed on the system where PostgreSQL is running.",
      });
    }
    const schema = m[3] ? ident(m[3]) : "public";
    if (!d.schemas.includes(schema)) return fail(`schema "${schema}" does not exist`);
    exts[name] = schema;
    return ok("CREATE EXTENSION");
  }
  if (/^(begin|start\s+transaction)$/i.test(sql)) return ok("BEGIN");
  if (/^(commit|end)$/i.test(sql)) return ok("COMMIT");
  if (/^rollback$/i.test(sql)) return ok("ROLLBACK");
  if (/^set\s/i.test(sql)) return ok("SET");
  if (/^reset\s/i.test(sql)) return ok("RESET");
  if (/^comment\s+on\s/i.test(sql)) return ok("COMMENT");

  if (SQL_WORDS.has(first)) return { lines: [], info: "That is real SQL, but this game does not model it. It understands count, version, create and drop (database, table, schema, user) and a few more." };
  const word = sql.split(/[\s(;]+/)[0];
  return fail(`syntax error at or near "${word}"`, { sql: shown, pos: 0 });
}

/** Load COPY data into a table (psql reading a plain dump). Returns the error text or undefined. */
export function copyInto(cl: PgCluster, db: string, table: string, rows: number): string | undefined {
  const d = cl.databases[db];
  const t = d && findTable(d, table);
  if (!t) return `relation "${table.toLowerCase()}" does not exist`;
  if (t.rows > 0) return `duplicate key value violates unique constraint "${table.split(".").pop()}_pkey"`;
  t.rows = rows;
  return undefined;
}
