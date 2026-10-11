// What psql, pg_dump and pg_restore need from wherever they run: inside the db
// container (docker exec) or on a host that has postgresql-client installed.
import type { HostId, World } from "../types";
import type { PgFrom } from "./connect";

export interface PgPrompt {
  prompt: string;
  secret: boolean;
  cmd: string;
  data: Record<string, unknown>;
}

export interface PgEnv {
  w: World;
  from: PgFrom;
  /** The client programs' version (16.4 on Ubuntu, the server's own inside the container). */
  client: { version: string; long: string };
  /** OS user running the program. Without -U, that is the role it asks for. */
  osUser: string;
  /** PGPASSWORD, PGUSER, PGHOST, PGPORT, PGDATABASE. */
  env: Record<string, string>;
  /** Piped or redirected input. Undefined means the keyboard. */
  stdin?: string;
  /** A keyboard is attached, so psql can ask for a password or run a session. */
  terminal: boolean;
  out(s: string): void;
  err(s: string): void;
  info(s: string): void;
  /** Ask the player something and come back through the __pg command. */
  prompt?(p: PgPrompt): void;
  readFile(path: string): { text?: string; error?: string };
  writeFile(path: string, content: string): string | undefined;
  /** Where > in the player's shell sends stdout, so a password prompt can keep it. */
  redirect?: { target: string; append: boolean };
}

/** Serializable part of an env, kept in a pending prompt. */
export interface PgEnvData {
  from: PgFrom;
  client: { version: string; long: string };
  osUser: string;
  env: Record<string, string>;
  stdin?: string;
  redirect?: { target: string; append: boolean };
}

export function envData(e: PgEnv): PgEnvData {
  return { from: e.from, client: e.client, osUser: e.osUser, env: e.env, stdin: e.stdin, redirect: e.redirect };
}

export const fromHost = (from: PgFrom): HostId => from.host;

// ---------- option parsing (getopt style, like the real tools) ----------

export interface PgOpts {
  /** Values by canonical key. Repeatable options keep every value. */
  vals: Record<string, string[]>;
  bools: Set<string>;
  pos: string[];
  error?: string;
}

export interface OptSpec {
  /** Short letters that take a value ("U", "d", "c"). */
  valued: string;
  /** Short letters without a value. */
  flags: string;
  /** Long name to short key. A long name with a trailing = takes a value. */
  long: Record<string, string>;
}

export function getopt(prog: string, args: string[], spec: OptSpec): PgOpts {
  const o: PgOpts = { vals: {}, bools: new Set(), pos: [] };
  const add = (k: string, v: string) => (o.vals[k] ??= []).push(v);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      o.pos.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const [name, inline] = a.slice(2).split(/=(.*)/s);
      const key = spec.long[name + "="] ?? spec.long[name];
      if (!key) return { ...o, error: `${prog}: unrecognized option '${a}'\n${prog}: hint: Try "${prog} --help" for more information.` };
      if (spec.long[name + "="]) {
        const v = inline ?? args[++i];
        if (v === undefined) return { ...o, error: `${prog}: option '--${name}' requires an argument\n${prog}: hint: Try "${prog} --help" for more information.` };
        add(key, v);
      } else o.bools.add(key);
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if (spec.valued.includes(ch)) {
          const v = a.length > j + 1 ? a.slice(j + 1) : args[++i];
          if (v === undefined) return { ...o, error: `${prog}: option requires an argument -- '${ch}'\n${prog}: hint: Try "${prog} --help" for more information.` };
          add(ch, v);
          break;
        }
        if (!spec.flags.includes(ch)) return { ...o, error: `${prog}: invalid option -- '${ch}'\n${prog}: hint: Try "${prog} --help" for more information.` };
        o.bools.add(ch);
      }
      continue;
    }
    o.pos.push(a);
  }
  return o;
}

export function val(o: PgOpts, key: string): string | undefined {
  const v = o.vals[key];
  return v?.[v.length - 1];
}
