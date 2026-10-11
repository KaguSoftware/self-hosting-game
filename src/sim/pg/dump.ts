// pg_dump and pg_restore. A custom-format dump (-Fc) is "PGDMP" plus a JSON
// description of schemas, tables and row counts. A plain dump is SQL text.
// Row counts survive dump then restore, so a level can check count(*) afterwards.
import { archiveVersion, debianVersion, ident, major, STOCK_EXTENSIONS, SUPABASE_CLUSTER, SUPABASE_VERSION } from "./cluster";
import { serverOf, type PgConn } from "./connect";
import { getopt, val, type PgEnv } from "./env";
import { connectOrAsk } from "./psql";
import type { PgCluster, PgDatabase } from "./types";

export interface ArchiveTable {
  name: string;
  owner: string;
  rows: number;
  columns: string[];
  grants: string[];
  /** false for pg_dump -s (schema only). */
  data: boolean;
}

export interface Archive {
  /** Custom-format version ("1.16" from pg_dump 17). */
  archive: string;
  dumpedBy: string;
  server: string;
  db: string;
  owner: string;
  encoding: string;
  schemas: { name: string; owner: string }[];
  extensions: { name: string; schema: string }[];
  tables: ArchiveTable[];
  /** pg_dump -a: data only, no CREATE statements. */
  dataOnly?: boolean;
}

export interface DumpOpts {
  /** -n patterns. Only these schemas (and their tables). */
  schemas?: string[];
  /** -N patterns. */
  excludeSchemas?: string[];
  /** -t patterns. */
  tables?: string[];
  schemaOnly?: boolean;
  dataOnly?: boolean;
  noAcl?: boolean;
}

const globRe = (p: string) => new RegExp("^" + ident(p).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");

/** Describe one database the way pg_dump sees it. */
export function makeArchive(cl: PgCluster, db: string, versions: { dumpedBy: string; server: string }, o: DumpOpts = {}): Archive {
  const d = cl.databases[db];
  const inc = (s: string) => (!o.schemas?.length || o.schemas.some((p) => globRe(p).test(s))) && !o.excludeSchemas?.some((p) => globRe(p).test(s));
  const tableOk = (q: string) => {
    const [s, n] = q.split(".");
    if (o.tables?.length) return o.tables.some((p) => (p.includes(".") ? globRe(p).test(q) : s === "public" && globRe(p).test(n)));
    return inc(s);
  };
  return {
    archive: archiveVersion(versions.dumpedBy),
    dumpedBy: versions.dumpedBy,
    server: versions.server,
    db,
    owner: d.owner,
    encoding: "UTF8",
    schemas: o.tables?.length ? [] : d.schemas.filter((s) => s !== "public" && inc(s)).map((s) => ({ name: s, owner: d.schemaOwners?.[s] ?? d.owner })),
    extensions: o.tables?.length ? [] : Object.entries(d.extensions ?? {}).filter(([, s]) => inc(s)).map(([name, schema]) => ({ name, schema })),
    tables: Object.entries(d.tables)
      .filter(([q]) => tableOk(q))
      .map(([q, t]) => ({ name: q, owner: t.owner ?? d.owner, rows: t.rows, columns: t.columns ?? ["id bigint NOT NULL"], grants: o.noAcl ? [] : (t.grants ?? []), data: !o.schemaOnly })),
    dataOnly: o.dataOnly || undefined,
  };
}

export function archiveText(a: Archive): string {
  return "PGDMP" + JSON.stringify(a);
}

export function parseArchive(text: string): Archive | undefined {
  if (!text.startsWith("PGDMP")) return undefined;
  try {
    return JSON.parse(text.slice(5).trim()) as Archive;
  } catch {
    return undefined;
  }
}

// ---------- plain SQL ----------

const colName = (c: string) => c.split(/\s+/)[0];

/** A few believable rows for the COPY block. */
function sampleRow(cols: string[], i: number): string {
  return cols
    .map((c) => {
      const [name, type = ""] = c.split(/\s+/);
      if (/uuid/.test(type)) return `${(0x1f3a9c00 + i * 7919).toString(16).padStart(8, "0")}-4b1e-4c2a-9d3f-${(0xa1b2c3d40000 + i).toString(16)}`;
      if (/bigint|integer/.test(type)) return name === "id" ? String(i + 1) : String(1000 + ((i * 937) % 9000));
      if (/timestamp/.test(type)) return `2025-0${1 + (i % 9)}-1${i % 10} 10:2${i % 10}:00+00`;
      if (/boolean/.test(type)) return i % 2 ? "t" : "f";
      if (name === "email") return `user${i + 1}@example.com`;
      if (name === "status") return "paid";
      return `${name}-${i + 1}`;
    })
    .join("\t");
}

function createTableSql(t: ArchiveTable): string {
  return `CREATE TABLE ${t.name} (\n${t.columns.map((c) => `    ${c}`).join(",\n")}\n);`;
}

/** The SQL a plain dump (or pg_restore -f -) prints. */
export function archiveToSql(a: Archive, o: { noOwner?: boolean; noAcl?: boolean; clean?: boolean; ifExists?: boolean } = {}): string {
  const L: string[] = [];
  const v = (x: string) => (x.includes("(") ? x : major(x) >= 16 && x !== SUPABASE_VERSION ? debianVersion(x) : x);
  const head = (name: string, type: string, schema: string, owner: string) => L.push("--", `-- Name: ${name}; Type: ${type}; Schema: ${schema}; Owner: ${owner}`, "--", "");
  L.push("--", "-- PostgreSQL database dump", "--", "", `-- Dumped from database version ${v(a.server)}`, `-- Dumped by pg_dump version ${v(a.dumpedBy)}`, "");
  L.push("SET statement_timeout = 0;", "SET lock_timeout = 0;", "SET idle_in_transaction_session_timeout = 0;", "SET client_encoding = 'UTF8';", "SET standard_conforming_strings = on;");
  L.push("SELECT pg_catalog.set_config('search_path', '', false);", "SET check_function_bodies = false;", "SET xmloption = content;", "SET client_min_messages = warning;", "SET row_security = off;", "");
  const ie = o.ifExists ? "IF EXISTS " : "";
  if (o.clean && !a.dataOnly) {
    for (const t of [...a.tables].reverse()) L.push(`DROP TABLE ${ie}${t.name};`);
    for (const s of [...a.schemas].reverse()) L.push(`DROP SCHEMA ${ie}${s.name};`);
    L.push("");
  }
  if (!a.dataOnly) {
    for (const s of a.schemas) {
      head(s.name, "SCHEMA", "-", s.owner);
      L.push(`CREATE SCHEMA ${s.name};`, "", "");
      if (!o.noOwner) L.push(`ALTER SCHEMA ${s.name} OWNER TO ${s.owner};`, "");
    }
    for (const x of a.extensions) {
      head(x.name, "EXTENSION", "-", "-");
      L.push(`CREATE EXTENSION IF NOT EXISTS ${/-/.test(x.name) ? `"${x.name}"` : x.name} WITH SCHEMA ${x.schema};`, "", "");
    }
    if (a.tables.length) L.push("SET default_tablespace = '';", "", "SET default_table_access_method = heap;", "");
    for (const t of a.tables) {
      const [schema, name] = t.name.split(".");
      head(name, "TABLE", schema, t.owner);
      L.push(createTableSql(t), "", "");
      if (!o.noOwner) L.push(`ALTER TABLE ${t.name} OWNER TO ${t.owner};`, "");
    }
  }
  for (const t of a.tables) {
    if (!t.data) continue;
    const [schema, name] = t.name.split(".");
    // Rows: the true count. The game keeps only a few sample rows to stay small.
    L.push("--", `-- Data for Name: ${name}; Type: TABLE DATA; Schema: ${schema}; Owner: ${t.owner}; Rows: ${t.rows}`, "--", "");
    L.push(`COPY ${t.name} (${t.columns.map(colName).join(", ")}) FROM stdin;`);
    for (let i = 0; i < Math.min(3, t.rows); i++) L.push(sampleRow(t.columns, i));
    L.push("\\.", "", "");
  }
  if (!o.noAcl) {
    for (const t of a.tables) {
      if (!t.grants.length) continue;
      const [schema, name] = t.name.split(".");
      head(`TABLE ${name}`, "ACL", schema, t.owner);
      for (const g of t.grants) L.push(`GRANT ALL ON TABLE ${t.name} TO ${g};`);
      L.push("", "");
    }
  }
  L.push("--", "-- PostgreSQL database dump complete", "--", "");
  return L.join("\n");
}

// ---------- pg_dump ----------

const DUMP_SPEC = {
  valued: "UdhpFfnNtTZj",
  flags: "wWOxasCcvEb",
  long: {
    "username=": "U",
    "dbname=": "d",
    "host=": "h",
    "port=": "p",
    "format=": "F",
    "file=": "f",
    "schema=": "n",
    "exclude-schema=": "N",
    "table=": "t",
    "exclude-table=": "T",
    "compress=": "Z",
    "jobs=": "j",
    "no-password": "w",
    password: "W",
    "no-owner": "O",
    "no-acl": "x",
    "no-privileges": "x",
    "data-only": "a",
    "schema-only": "s",
    create: "C",
    clean: "c",
    "if-exists": "IF",
    verbose: "v",
    "no-comments": "NC",
    "quote-all-identifiers": "QA",
  },
};

export function runPgDump(e: PgEnv, args: string[], password?: string): number {
  const o = getopt("pg_dump", args, DUMP_SPEC);
  if (o.error) {
    e.err(o.error);
    return 1;
  }
  const fmt = (val(o, "F") ?? "p").toLowerCase();
  const custom = fmt === "c" || fmt === "custom";
  if (!custom && !["p", "plain", "t", "tar", "d", "directory"].includes(fmt)) {
    e.err(`pg_dump: error: invalid output format "${val(o, "F")}" specified`);
    return 1;
  }
  if (fmt === "t" || fmt === "tar" || fmt === "d" || fmt === "directory") {
    e.info("This game makes custom (-Fc) and plain dumps. Use -Fc.");
    return 1;
  }
  const conn = connectOrAsk(e, "pg_dump", args, o, password);
  if (typeof conn !== "object") return conn === "asked" ? 0 : conn;
  const info = serverOf(e.w, conn.server)!;
  if (major(info.version) > major(e.client.version)) {
    e.err(`pg_dump: error: aborting because of server version mismatch\npg_dump: detail: server version: ${info.version}; pg_dump version: ${e.client.long}`);
    return 1;
  }
  const a = makeArchive(info.cluster, conn.db, { dumpedBy: e.client.version, server: info.version }, {
    schemas: o.vals.n,
    excludeSchemas: o.vals.N,
    tables: o.vals.t,
    schemaOnly: o.bools.has("s"),
    dataOnly: o.bools.has("a"),
    noAcl: o.bools.has("x"),
  });
  if (o.vals.n?.length && !a.tables.length && !a.schemas.length && !o.vals.n.includes("public")) {
    e.err(`pg_dump: error: no matching schemas were found for pattern "${o.vals.n[0]}"`);
    return 1;
  }
  if (o.vals.t?.length && !a.tables.length) {
    e.err(`pg_dump: error: no matching tables were found for pattern "${o.vals.t[0]}"`);
    return 1;
  }
  if (o.bools.has("v")) e.err(`pg_dump: last built-in OID is 16383\npg_dump: reading extensions\npg_dump: reading schemas\npg_dump: reading user-defined tables\npg_dump: saving database definition`);
  // --no-owner only applies to plain SQL output; archives always remember owners.
  const text = custom ? archiveText(a) : archiveToSql(a, { noOwner: o.bools.has("O"), noAcl: o.bools.has("x"), clean: o.bools.has("c"), ifExists: o.bools.has("IF") });
  const file = val(o, "f");
  if (file && file !== "-") {
    const err = e.writeFile(file, text);
    if (err) {
      e.err(`pg_dump: error: could not open output file "${file}": ${err}`);
      return 1;
    }
    return 0;
  }
  e.out(text);
  return 0;
}

// ---------- pg_restore ----------

const RESTORE_SPEC = {
  valued: "UdhpfnNtjIPLT",
  flags: "wWOxacCe1vls",
  long: {
    "username=": "U",
    "dbname=": "d",
    "host=": "h",
    "port=": "p",
    "file=": "f",
    "schema=": "n",
    "exclude-schema=": "N",
    "table=": "t",
    "jobs=": "j",
    "no-password": "w",
    password: "W",
    "no-owner": "O",
    "no-acl": "x",
    "no-privileges": "x",
    "data-only": "a",
    "schema-only": "s",
    clean: "c",
    create: "C",
    "exit-on-error": "e",
    "single-transaction": "1",
    "if-exists": "IF",
    verbose: "v",
    list: "l",
  },
};

interface RestoreState {
  errors: number;
  printedToc: boolean;
  stop: boolean;
  toc: number;
}

/** Restore an archive into a database. Mutates `cl`. Prints errors the way pg_restore 16/17 does. */
export function restoreArchive(
  e: Pick<PgEnv, "err">,
  cl: PgCluster,
  db: string,
  user: string,
  a: Archive,
  o: { noOwner?: boolean; noAcl?: boolean; clean?: boolean; ifExists?: boolean; exitOnError?: boolean; schemas?: string[]; dataOnly?: boolean; schemaOnly?: boolean; serverMajor: string },
): RestoreState {
  const st: RestoreState = { errors: 0, printedToc: false, stop: false, toc: 3400 };
  const d: PgDatabase = cl.databases[db];
  const fail = (entry: string, msg: string, command: string, extra: string[] = []) => {
    if (st.stop) return;
    const lines: string[] = [];
    if (!st.printedToc) lines.push("pg_restore: while PROCESSING TOC:");
    st.printedToc = true;
    lines.push(`pg_restore: from TOC entry ${st.toc}; ${entry}`, `pg_restore: error: could not execute query: ERROR:  ${msg}`, ...extra, `Command was: ${command}`);
    e.err(lines.join("\n"));
    st.errors++;
    if (o.exitOnError) st.stop = true;
  };
  const step = () => (st.toc += 1);
  const roleOk = (r: string) => !!cl.roles[r];
  const keepSchema = (s: string) => !o.schemas?.length || o.schemas.includes(s);
  const tables = a.tables.filter((t) => keepSchema(t.name.split(".")[0]));
  const schemas = a.schemas.filter((s) => keepSchema(s.name));
  const structure = !a.dataOnly && !o.dataOnly;
  /** Tables that existed before and kept their rows (COPY into them collides). */
  const fresh = new Set<string>();

  if (o.clean && structure) {
    for (const t of [...tables].reverse()) {
      step();
      if (d.tables[t.name]) delete d.tables[t.name];
      else if (!o.ifExists) fail(`1259 16390 TABLE ${t.name.split(".")[1]} ${t.owner}`, `table "${t.name.split(".")[1]}" does not exist`, `DROP TABLE ${t.name};`);
    }
    for (const s of [...schemas].reverse()) {
      step();
      if (d.schemas.includes(s.name) && !Object.keys(d.tables).some((q) => q.startsWith(s.name + "."))) d.schemas = d.schemas.filter((x) => x !== s.name);
      else if (!d.schemas.includes(s.name) && !o.ifExists) fail(`2615 16386 SCHEMA ${s.name} ${s.owner}`, `schema "${s.name}" does not exist`, `DROP SCHEMA ${s.name};`);
    }
  }
  if (structure) {
    for (const s of schemas) {
      if (st.stop) break;
      step();
      const entry = `2615 16386 SCHEMA ${s.name} ${s.owner}`;
      if (d.schemas.includes(s.name)) fail(entry, `schema "${s.name}" already exists`, `CREATE SCHEMA ${s.name};`);
      else {
        d.schemas.push(s.name);
        (d.schemaOwners ??= {})[s.name] = user;
      }
      if (!o.noOwner && !st.stop) {
        if (!roleOk(s.owner)) fail(entry, `role "${s.owner}" does not exist`, `ALTER SCHEMA ${s.name} OWNER TO ${s.owner};`);
        else d.schemaOwners![s.name] = s.owner;
      }
    }
    for (const x of a.extensions) {
      if (st.stop) break;
      step();
      const q = /-/.test(x.name) ? `"${x.name}"` : x.name;
      const cmd = `CREATE EXTENSION IF NOT EXISTS ${q} WITH SCHEMA ${x.schema};`;
      if (!STOCK_EXTENSIONS.includes(x.name)) {
        fail(`3079 16400 EXTENSION ${x.name} -`, `extension "${x.name}" is not available`, cmd, [
          `DETAIL:  Could not open extension control file "/usr/share/postgresql/${o.serverMajor}/extension/${x.name}.control": No such file or directory.`,
          "HINT:  The extension must first be installed on the system where PostgreSQL is running.",
        ]);
      } else if (!d.schemas.includes(x.schema)) fail(`3079 16400 EXTENSION ${x.name} -`, `schema "${x.schema}" does not exist`, cmd);
      else (d.extensions ??= {})[x.name] = x.schema;
    }
    for (const t of tables) {
      if (st.stop) break;
      step();
      const [schema, name] = t.name.split(".");
      const entry = `1259 16410 TABLE ${name} ${t.owner}`;
      if (!d.schemas.includes(schema)) {
        fail(entry, `schema "${schema}" does not exist`, createTableSql(t));
        continue;
      }
      if (d.tables[t.name]) fail(entry, `relation "${name}" already exists`, createTableSql(t));
      else {
        d.tables[t.name] = { rows: 0, owner: user, columns: [...t.columns] };
        fresh.add(t.name);
      }
      if (!o.noOwner && !st.stop) {
        if (!roleOk(t.owner)) fail(entry, `role "${t.owner}" does not exist`, `ALTER TABLE ${t.name} OWNER TO ${t.owner};`);
        else d.tables[t.name].owner = t.owner;
      }
    }
  }
  if (!o.schemaOnly) {
    for (const t of tables) {
      if (st.stop || !t.data) continue;
      step();
      const name = t.name.split(".")[1];
      const target = d.tables[t.name];
      if (!target) continue; // its CREATE already failed and was reported
      if (target.rows > 0 && !fresh.has(t.name)) {
        if (st.stop) continue;
        if (!st.printedToc) e.err("pg_restore: while PROCESSING TOC:");
        st.printedToc = true;
        e.err(
          [
            `pg_restore: from TOC entry ${st.toc}; 0 16410 TABLE DATA ${name} ${t.owner}`,
            `pg_restore: error: COPY failed for table "${name}": ERROR:  duplicate key value violates unique constraint "${name}_pkey"`,
            "DETAIL:  Key (id)=(1) already exists.",
            `CONTEXT:  COPY ${name}, line 1`,
          ].join("\n"),
        );
        st.errors++;
        if (o.exitOnError) st.stop = true;
        continue;
      }
      target.rows = t.rows;
    }
  }
  if (structure && !o.noAcl) {
    for (const t of tables) {
      if (st.stop || !t.grants.length || !d.tables[t.name]) continue;
      step();
      const missing = t.grants.find((g) => !roleOk(g));
      if (missing) fail(`0 0 ACL TABLE ${t.name.split(".")[1]} ${t.owner}`, `role "${missing}" does not exist`, `GRANT ALL ON TABLE ${t.name} TO ${missing};`);
      else d.tables[t.name].grants = [...t.grants];
    }
  }
  return st;
}

export function runPgRestore(e: PgEnv, args: string[], password?: string): number {
  const o = getopt("pg_restore", args, RESTORE_SPEC);
  if (o.error) {
    e.err(o.error);
    return 1;
  }
  const dbOpt = val(o, "d");
  const outFile = val(o, "f");
  if (dbOpt === undefined && outFile === undefined && !o.bools.has("l")) {
    e.err(`pg_restore: error: one of -d/--dbname and -f/--file must be specified\npg_restore: hint: Try "pg_restore --help" for more information.`);
    return 1;
  }
  const file = o.pos[0];
  if (!file && val(o, "j") && Number(val(o, "j")) > 1) {
    e.err("pg_restore: error: parallel restore from standard input is not supported");
    return 1;
  }
  let text: string;
  if (file) {
    const f = e.readFile(file);
    if (f.text === undefined) {
      e.err(`pg_restore: error: could not open input file "${file}": ${f.error ?? "No such file or directory"}`);
      return 1;
    }
    text = f.text;
  } else text = e.stdin ?? "";
  if (text.length < 5) {
    e.err(`pg_restore: error: input file is too short (read ${text.length}, expected 5)`);
    return 1;
  }
  const a = parseArchive(text);
  if (!a) {
    if (/^--|CREATE TABLE|^SET /m.test(text)) e.err("pg_restore: error: input file appears to be a text format dump. Please use psql.");
    else e.err("pg_restore: error: input file does not appear to be a valid archive");
    return 1;
  }
  const supported = archiveVersion(e.client.version);
  if (Number(a.archive.split(".")[1]) > Number(supported.split(".")[1])) {
    e.err(`pg_restore: error: unsupported version (${a.archive}) in file header`);
    return 1;
  }
  const flags = { noOwner: o.bools.has("O"), noAcl: o.bools.has("x"), clean: o.bools.has("c"), ifExists: o.bools.has("IF") };
  if (o.bools.has("l")) {
    e.out(
      [
        ";",
        "; Archive created at 2026-10-11 09:00:00 UTC",
        `;     dbname: ${a.db}`,
        `;     TOC Entries: ${a.schemas.length + a.extensions.length + a.tables.length * 2}`,
        ";     Compression: gzip",
        `;     Dump Version: ${a.archive}-0`,
        ";     Format: CUSTOM",
        `;     Dumped from database version: ${a.server}`,
        `;     Dumped by pg_dump version: ${a.dumpedBy}`,
        ";",
        ";",
        "; Selected TOC Entries:",
        ";",
        ...a.schemas.map((s, i) => `${3400 + i}; 2615 16386 SCHEMA - ${s.name} ${s.owner}`),
        ...a.tables.map((t, i) => `${3500 + i}; 1259 16410 TABLE ${t.name.split(".")[0]} ${t.name.split(".")[1]} ${t.owner}`),
        ...a.tables.filter((t) => t.data).map((t, i) => `${3600 + i}; 0 16410 TABLE DATA ${t.name.split(".")[0]} ${t.name.split(".")[1]} ${t.owner}`),
      ].join("\n"),
    );
    return 0;
  }
  if (dbOpt === undefined) {
    // -f FILE or -f -: turn the archive into SQL.
    const sql = archiveToSql(a, flags);
    if (outFile && outFile !== "-") {
      const err = e.writeFile(outFile, sql);
      if (err) {
        e.err(`pg_restore: error: could not open output file "${outFile}": ${err}`);
        return 1;
      }
    } else e.out(sql);
    return 0;
  }
  // The file was read already: keep it for after a password prompt.
  const env: PgEnv = file ? e : { ...e, stdin: text };
  const conn = connectOrAsk(env, "pg_restore", args, o, password);
  if (typeof conn !== "object") return conn === "asked" ? 0 : conn;
  const info = serverOf(e.w, conn.server, true)!;
  if (!info.writable) {
    e.info("This game keeps Supabase read only. Restore into your own server instead.");
    return 1;
  }
  let target = conn.db;
  if (o.bools.has("C")) {
    if (info.cluster.databases[a.db]) {
      e.err(`pg_restore: while PROCESSING TOC:\npg_restore: error: could not execute query: ERROR:  database "${a.db}" already exists\nCommand was: CREATE DATABASE ${a.db} WITH TEMPLATE = template0 ENCODING = 'UTF8' LOCALE_PROVIDER = libc LOCALE = 'en_US.utf8';`);
      e.err("pg_restore: warning: errors ignored on restore: 1");
      return 1;
    }
    info.cluster.databases[a.db] = { owner: conn.user, schemas: ["public"], tables: {} };
    target = a.db;
  }
  const single = o.bools.has("1");
  const work: PgCluster = single ? JSON.parse(JSON.stringify(info.cluster)) : info.cluster;
  if (o.bools.has("v")) e.err(`pg_restore: connecting to database for restore`);
  const st = restoreArchive(e, work, target, conn.user, a, {
    ...flags,
    exitOnError: o.bools.has("e") || single,
    schemas: o.vals.n,
    dataOnly: o.bools.has("a"),
    schemaOnly: o.bools.has("s"),
    serverMajor: String(major(info.version)),
  });
  if (single && !st.errors) {
    info.cluster.roles = work.roles;
    info.cluster.databases = work.databases;
  }
  if (st.errors && !st.stop) {
    e.err(`pg_restore: warning: errors ignored on restore: ${st.errors}`);
    return 1;
  }
  return st.errors ? 1 : 0;
}

// ---------- ready-made dumps for levels ----------

/**
 * The shop's Supabase database as a dump file, for a level to place on the laptop.
 * publicOnly is what `pg_dump -n public` makes. Owners and grants point at Supabase roles.
 */
export function supabaseDump(opts: { publicOnly?: boolean; format?: "custom" | "plain"; noAcl?: boolean } = {}): string {
  const a = makeArchive(SUPABASE_CLUSTER, "postgres", { dumpedBy: "16.4", server: SUPABASE_VERSION }, { schemas: opts.publicOnly ? ["public"] : undefined, noAcl: opts.noAcl });
  return opts.format === "plain" ? archiveToSql(a, { noAcl: opts.noAcl }) : archiveText(a);
}

/** Does this file look like a database dump (custom or plain)? */
export function looksLikeDump(text: string | undefined): boolean {
  return !!text && (text.startsWith("PGDMP") || /CREATE TABLE/.test(text));
}

export type { PgConn };
