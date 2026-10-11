// The Postgres model. A cluster lives on the db container's data volume
// (`volumes[name].pg`), so it survives `docker compose down` and dies with `down -v`.
// Pure data, like the rest of the World.

export interface PgRole {
  /** Plain text in the sim only. Undefined means no password (cannot log in over TCP). */
  password?: string;
  superuser: boolean;
  login: boolean;
}

export interface PgTable {
  rows: number;
  /** Role that owns it. Defaults to the database owner. */
  owner?: string;
  /** Column definitions as pg_dump prints them ("id bigint NOT NULL"). */
  columns?: string[];
  /** Roles granted access (pg_dump writes these as GRANT lines, unless --no-acl). */
  grants?: string[];
}

export interface PgDatabase {
  owner: string;
  /** Schemas besides pg_catalog. Every database starts with "public". */
  schemas: string[];
  /** Owner per schema when it is not the database owner ("auth": "supabase_admin"). */
  schemaOwners?: Record<string, string>;
  /** Keyed by qualified name: "public.orders". */
  tables: Record<string, PgTable>;
  /** Extension name to the schema it lives in ("pgcrypto": "extensions"). */
  extensions?: Record<string, string>;
}

/** The whole server's data: what `\du` and `\l` show. */
export interface PgCluster {
  /** Major version that initialized it ("17"). */
  version: string;
  roles: Record<string, PgRole>;
  databases: Record<string, PgDatabase>;
}

/** An `ssh -L laptopPort:remoteHost:remotePort user@vps` that is open right now. */
export interface PgTunnel {
  laptopPort: number;
  remoteHost: string;
  remotePort: number;
  user: string;
  /** The window holding it. Ctrl+C there closes it. Missing for ssh -f (background). */
  shellId?: string;
  /** Next channel number ssh prints ("channel 2: open failed"). */
  channel?: number;
  /** Lines ssh printed in its own window since the last look (connect failures). */
  log?: string[];
}
