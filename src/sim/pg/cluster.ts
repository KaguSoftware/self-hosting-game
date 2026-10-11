// Reading and changing the Postgres cluster that lives on a volume, plus the
// pretend Supabase project the player moves away from.
import { localImage } from "../docker/images";
import type { Container, Host, PgData } from "../types";
import type { PgCluster, PgDatabase, PgRole, PgTable } from "./types";

// ---------- versions ----------

/** Newest minor of each major in the image catalog, for images without metadata. */
const MINOR: Record<string, string> = { "15": "15.8", "16": "16.10", "17": "17.6", "18": "18.0" };

/** "17.6" for the server inside this container. */
export function serverVersion(host: Host, c: Container): string {
  const v = localImage(host, c.image)?.meta?.version;
  if (v) return v;
  const major = /:(\d+)/.exec(c.image)?.[1] ?? "17";
  return MINOR[major] ?? `${major}.0`;
}

/** "17.6 (Debian 17.6-1.pgdg130+1)", the way psql and pg_dump print a Docker image's version. */
export function debianVersion(v: string): string {
  return `${v} (Debian ${v}-1.pgdg130+1)`;
}

export const HOST_CLIENT = { version: "16.4", long: "16.4 (Ubuntu 16.4-0ubuntu0.24.04.2)" };

/** Ubuntu 24.04 ships postgresql-client 16. The PGDG repository has 17. */
export function hostClient(host: Host): { version: string; long: string } {
  if (host.packages["postgresql-client-17"]) return { version: "17.6", long: "17.6 (Ubuntu 17.6-1.pgdg24.04+1)" };
  return HOST_CLIENT;
}

export const major = (v: string): number => Number(v.split(".")[0]);

/** Custom-format archive version each pg_dump major writes. pg_restore refuses newer ones. */
export function archiveVersion(v: string): string {
  const m = major(v);
  return m >= 17 ? "1.16" : m >= 16 ? "1.15" : "1.14";
}

// ---------- the cluster on a volume ----------

/** The volume holding this postgres container's data. */
export function dataVolume(host: Host, c: Container) {
  const vols = c.mounts
    .filter((m) => m.type === "volume" && (m.target === "/var/lib/postgresql/data" || m.target === "/var/lib/postgresql"))
    .map((m) => host.docker.volumes[m.source])
    .filter((v) => !!v);
  return vols.find((v) => v.pg) ?? vols[0];
}

function newDb(owner: string): PgDatabase {
  return { owner, schemas: ["public"], tables: {} };
}

/** What the entrypoint makes on first start: one superuser, its database and "postgres". */
function initial(pg: PgData): { roles: Record<string, PgRole>; databases: Record<string, PgDatabase> } {
  const databases: Record<string, PgDatabase> = { postgres: newDb(pg.user) };
  if (pg.db !== "postgres") databases[pg.db] = newDb(pg.user);
  return { roles: { [pg.user]: { password: pg.password || undefined, superuser: true, login: true } }, databases };
}

/** Read-only view. Never writes to `pg`, so it is safe on frozen state. */
export function clusterOf(pg: PgData): PgCluster {
  const init = pg.roles && pg.databases ? undefined : initial(pg);
  return { version: pg.version, roles: pg.roles ?? init!.roles, databases: pg.databases ?? init!.databases };
}

/** Writable view (call on a draft). Fills in the roles and databases the first time. */
export function ensureCluster(pg: PgData): PgCluster {
  if (!pg.roles || !pg.databases) {
    const init = initial(pg);
    pg.roles ??= init.roles;
    pg.databases ??= init.databases;
  }
  return pg as PgData & PgCluster;
}

/** The cluster behind a running postgres container (or a temporary one made from its env). */
export function containerCluster(host: Host, c: Container, write = false): PgCluster {
  const vol = dataVolume(host, c);
  if (vol?.pg) return write ? ensureCluster(vol.pg) : clusterOf(vol.pg);
  const user = c.env.POSTGRES_USER || "postgres";
  return clusterOf({ version: /:(\d+)/.exec(c.image)?.[1] ?? "17", user, db: c.env.POSTGRES_DB || user, password: c.env.POSTGRES_PASSWORD ?? "" });
}

export function createDatabase(cl: PgCluster, name: string, owner: string): void {
  cl.databases[name] = newDb(owner);
}

/** "orders" -> "public.orders". Lowercases unquoted names like Postgres does. */
export function qualify(name: string): string {
  const parts = name.split(".").map(ident);
  return parts.length === 1 ? `public.${parts[0]}` : `${parts[0]}.${parts[1]}`;
}

/** An SQL identifier: "Quoted" keeps its case, anything else is folded to lower case. */
export function ident(s: string): string {
  const t = s.trim();
  return /^".*"$/.test(t) ? t.slice(1, -1) : t.toLowerCase();
}

// ---------- the shop's data ----------

export const ORDERS_COLUMNS = ["id bigint NOT NULL", "user_id uuid NOT NULL", "total_cents integer NOT NULL", "status text DEFAULT 'paid'::text NOT NULL", "created_at timestamp with time zone DEFAULT now() NOT NULL"];
export const PRODUCTS_COLUMNS = ["id bigint NOT NULL", "name text NOT NULL", "price_cents integer NOT NULL", "stock integer DEFAULT 0 NOT NULL"];
export const USERS_COLUMNS = ["id uuid NOT NULL", "email text NOT NULL", "name text", "created_at timestamp with time zone DEFAULT now() NOT NULL"];

/** The shop's own tables, as they were on Supabase. Row counts survive dump and restore. */
export function shopTables(owner?: string, grants?: string[]): Record<string, PgTable> {
  const t = (rows: number, columns: string[]): PgTable => ({ rows, columns, ...(owner ? { owner } : {}), ...(grants ? { grants } : {}) });
  return {
    "public.orders": t(1284, ORDERS_COLUMNS),
    "public.products": t(42, PRODUCTS_COLUMNS),
    "public.users": t(311, USERS_COLUMNS),
  };
}

/** Put the shop's tables into a database (for levels that start after the move). Call on a draft. */
export function seedShop(cl: PgCluster, db: string): void {
  const d = (cl.databases[db] ??= newDb(Object.keys(cl.roles)[0] ?? "postgres"));
  Object.assign(d.tables, shopTables());
}

// ---------- the pretend Supabase project ----------

export const SUPABASE_REF = "abcdefghijklmnop";
export const SUPABASE_HOST = `db.${SUPABASE_REF}.supabase.co`;
export const SUPABASE_PASSWORD = "kX9-supa-crumb";
export const SUPABASE_URL = `postgresql://postgres:${SUPABASE_PASSWORD}@${SUPABASE_HOST}:5432/postgres`;
export const SUPABASE_VERSION = "15.8";
/** A public address for it. Not ours, so the provider firewall never applies. */
export const SUPABASE_IP = "54.93.112.40";

const SB_GRANTS = ["anon", "authenticated", "service_role"];

/** What a Supabase project's Postgres holds. Read-only in the game. */
export const SUPABASE_CLUSTER: PgCluster = {
  version: "15",
  roles: {
    postgres: { password: SUPABASE_PASSWORD, superuser: false, login: true },
    supabase_admin: { superuser: true, login: true },
    supabase_auth_admin: { superuser: false, login: true },
    supabase_storage_admin: { superuser: false, login: true },
    authenticator: { superuser: false, login: true },
    anon: { superuser: false, login: false },
    authenticated: { superuser: false, login: false },
    service_role: { superuser: false, login: false },
  },
  databases: {
    postgres: {
      owner: "postgres",
      schemas: ["public", "auth", "storage", "extensions", "graphql", "vault"],
      schemaOwners: { auth: "supabase_admin", storage: "supabase_admin", extensions: "postgres", graphql: "supabase_admin", vault: "supabase_admin" },
      extensions: { "uuid-ossp": "extensions", pgcrypto: "extensions", pg_stat_statements: "extensions", pg_graphql: "graphql", supabase_vault: "vault" },
      tables: {
        ...shopTables("postgres", SB_GRANTS),
        "auth.users": { rows: 311, owner: "supabase_auth_admin", columns: ["id uuid NOT NULL", "email character varying(255)", "encrypted_password character varying(255)", "created_at timestamp with time zone"], grants: ["postgres"] },
        "auth.identities": { rows: 311, owner: "supabase_auth_admin", columns: ["id uuid NOT NULL", "user_id uuid NOT NULL", "provider text NOT NULL"], grants: ["postgres"] },
        "auth.sessions": { rows: 57, owner: "supabase_auth_admin", columns: ["id uuid NOT NULL", "user_id uuid NOT NULL", "created_at timestamp with time zone"], grants: ["postgres"] },
        "storage.buckets": { rows: 2, owner: "supabase_storage_admin", columns: ["id text NOT NULL", "name text NOT NULL", "public boolean DEFAULT false"], grants: SB_GRANTS },
        "storage.objects": { rows: 96, owner: "supabase_storage_admin", columns: ["id uuid NOT NULL", "bucket_id text", "name text", "created_at timestamp with time zone DEFAULT now()"], grants: SB_GRANTS },
      },
    },
  },
};

/** Extensions the official postgres image can create. Supabase's own ones are missing. */
export const STOCK_EXTENSIONS = ["plpgsql", "uuid-ossp", "pgcrypto", "pg_stat_statements", "citext", "hstore", "pg_trgm", "btree_gin", "btree_gist", "intarray", "unaccent", "postgres_fdw"];
