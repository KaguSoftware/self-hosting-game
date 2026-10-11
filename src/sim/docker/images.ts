// Images: the remote catalog (Docker Hub and the GitLab registry) and pulling into a host.
import type { AppKind, Host, ImageMeta, RegistryImage, World } from "../types";
import { hashHex } from "../util";
import { pullAuthError } from "./auth";

export interface RemoteImage extends RegistryImage {
  ageDays: number;
  /** Number of layers shown while pulling. */
  layers: number;
  meta: ImageMeta;
}

const PG_ENV = { PGDATA: "/var/lib/postgresql/data", PG_MAJOR: "" };

function pg(major: string, version: string, sizeMb: number, ageDays: number): RemoteImage {
  return {
    ref: `postgres:${major}`,
    id: hashHex(`postgres-${version}`),
    sizeMb,
    kind: "postgres",
    ageDays,
    layers: 14,
    meta: {
      flavor: "postgres",
      version,
      env: { ...PG_ENV, PG_MAJOR: major.replace(/\..*/, ""), ...(Number(major) >= 18 ? { PGDATA: "/var/lib/postgresql/18/docker" } : {}) },
      entrypoint: ["docker-entrypoint.sh"],
      cmd: ["postgres"],
      exposed: [5432],
    },
  };
}

function caddy(tag: string, version: string, sizeMb: number, ageDays: number): RemoteImage {
  return {
    ref: `caddy:${tag}`,
    id: hashHex(`caddy-${version}`),
    sizeMb,
    kind: "caddy",
    ageDays,
    layers: 5,
    meta: {
      flavor: "caddy",
      version,
      env: { XDG_CONFIG_HOME: "/config", XDG_DATA_HOME: "/data", CADDY_VERSION: `v${version}` },
      cmd: ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"],
      exposed: [80, 443, 2019],
      workdir: "/srv",
    },
  };
}

const NODE_META: ImageMeta = {
  flavor: "node",
  version: "24.11.0",
  env: { NODE_VERSION: "24.11.0", YARN_VERSION: "1.22.22" },
  entrypoint: ["docker-entrypoint.sh"],
  cmd: ["node"],
};

/** Everything `docker pull` can find. Keys are normalized refs (repo:tag). */
export const REMOTE_IMAGES: Record<string, RemoteImage> = {
  "hello-world:latest": {
    ref: "hello-world:latest",
    id: "74cc54e27dc4",
    sizeMb: 0.0101,
    kind: "hello",
    ageDays: 250,
    layers: 1,
    meta: { flavor: "hello-world", cmd: ["/hello"] },
  },
  "nginx:1.27": {
    ref: "nginx:1.27",
    id: "fb197595ebe7",
    sizeMb: 192,
    kind: "generic",
    ageDays: 60,
    layers: 7,
    meta: {
      flavor: "nginx",
      version: "1.27.5",
      env: { NGINX_VERSION: "1.27.5" },
      entrypoint: ["/docker-entrypoint.sh"],
      cmd: ["nginx", "-g", "daemon off;"],
      exposed: [80],
    },
  },
  "nginx:latest": {
    ref: "nginx:latest",
    id: "4cad75abc83d",
    sizeMb: 192,
    kind: "generic",
    ageDays: 14,
    layers: 7,
    meta: {
      flavor: "nginx",
      version: "1.29.2",
      env: { NGINX_VERSION: "1.29.2" },
      entrypoint: ["/docker-entrypoint.sh"],
      cmd: ["nginx", "-g", "daemon off;"],
      exposed: [80],
    },
  },
  "postgres:16": pg("16", "16.10", 435, 40),
  "postgres:17": pg("17", "17.6", 438, 40),
  "postgres:18": pg("18", "18.0", 456, 25),
  "postgres:latest": { ...pg("18", "18.0", 456, 25), ref: "postgres:latest" },
  "caddy:2": caddy("2", "2.10.2", 50.5, 30),
  "caddy:2.10": caddy("2.10", "2.10.2", 50.5, 30),
  "caddy:2.8": caddy("2.8", "2.8.4", 48.6, 400),
  "caddy:latest": caddy("latest", "2.10.2", 50.5, 30),
  "node:24-alpine": {
    ref: "node:24-alpine",
    id: "c3a8f1e2b4d6",
    sizeMb: 160,
    kind: "generic",
    ageDays: 12,
    layers: 4,
    meta: NODE_META,
  },
  "alpine:3.20": {
    ref: "alpine:3.20",
    id: "91ef0af61f39",
    sizeMb: 7.8,
    kind: "generic",
    ageDays: 90,
    layers: 1,
    meta: { flavor: "alpine", version: "3.20.6", cmd: ["/bin/sh"] },
  },
  "alpine:latest": {
    ref: "alpine:latest",
    id: "706db57fb206",
    sizeMb: 8.3,
    kind: "generic",
    ageDays: 30,
    layers: 1,
    meta: { flavor: "alpine", version: "3.22.2", cmd: ["/bin/sh"] },
  },
};

/** The app image CI pushes. Any tag exists (CI pushes one per commit). */
export const APP_REPO = "registry.gitlab.com/crumb/web";

function appImage(tag: string): RemoteImage {
  return {
    ref: `${APP_REPO}:${tag}`,
    id: hashHex(`crumb-web-${tag}`),
    sizeMb: 212,
    kind: "nextjs",
    ageDays: 1,
    layers: 9,
    meta: {
      flavor: "node",
      version: "16.0.0",
      env: { NODE_ENV: "production", HOSTNAME: "0.0.0.0", PORT: "3000" },
      entrypoint: ["docker-entrypoint.sh"],
      cmd: ["node", "server.js"],
      exposed: [3000],
      workdir: "/app",
    },
  };
}

/** "nginx" -> "nginx:latest", "docker.io/library/nginx:1.27" -> "nginx:1.27". */
export function normalizeRef(ref: string): string {
  let r = ref.trim().replace(/^docker\.io\//, "").replace(/^library\//, "");
  r = r.replace(/@sha256:[0-9a-f]+$/, "");
  const lastSlash = r.lastIndexOf("/");
  if (!r.slice(lastSlash + 1).includes(":")) r += ":latest";
  return r;
}

export function repoOf(ref: string): string {
  const n = normalizeRef(ref);
  return n.slice(0, n.lastIndexOf(":"));
}

export function tagOf(ref: string): string {
  const n = normalizeRef(ref);
  return n.slice(n.lastIndexOf(":") + 1);
}

/** "nginx:1.27" -> "docker.io/library/nginx:1.27" (what pull and build print). */
export function fullRef(ref: string): string {
  const n = normalizeRef(ref);
  const repo = repoOf(n);
  if (repo.includes(".") && repo.includes("/")) return n;
  return repo.includes("/") ? `docker.io/${n}` : `docker.io/library/${n}`;
}

export function findRemote(w: World, ref: string): RemoteImage | undefined {
  const n = normalizeRef(ref);
  const extra = w.registry?.[n];
  if (extra) return { ageDays: 1, layers: 6, meta: {}, ...extra };
  if (REMOTE_IMAGES[n]) return REMOTE_IMAGES[n];
  // With a GitLab project in the world, only tags CI really pushed exist.
  if (repoOf(n) === APP_REPO && !w.gitlab && /^[\w.-]+$/.test(tagOf(n))) return appImage(tagOf(n));
  return undefined;
}

export function repoExists(w: World, ref: string): boolean {
  const repo = repoOf(ref);
  return (
    repo === APP_REPO ||
    Object.keys(REMOTE_IMAGES).some((k) => repoOf(k) === repo) ||
    Object.keys(w.registry ?? {}).some((k) => repoOf(k) === repo)
  );
}

export type LocalImage = Host["docker"]["images"][string];

/** Find a local image by ref, or by id prefix. */
export function localImage(host: Host, ref: string): LocalImage | undefined {
  const n = normalizeRef(ref);
  if (host.docker.images[n]) return host.docker.images[n];
  if (/^[0-9a-f]{4,64}$/.test(ref)) return Object.values(host.docker.images).find((i) => i.id.startsWith(ref.slice(0, 12)));
  return undefined;
}

export function digestOf(ref: string): string {
  return `sha256:${hashHex("digest:" + normalizeRef(ref), 64)}`;
}

export interface PullResult {
  ok: boolean;
  lines: string[];
  /** Daemon error text, without any "docker: " prefix. */
  error?: string;
  /** True when it downloaded something new. */
  fresh: boolean;
  layers: string[];
}

/** Pull `ref` into the host. Prints Docker 27 style lines. */
export function pullImage(w: World, host: Host, ref: string): PullResult {
  const n = normalizeRef(ref);
  const denied = pullAuthError(w, host, n);
  if (denied) return { ok: false, lines: [], error: denied, fresh: false, layers: [] };
  const remote = findRemote(w, n);
  if (!remote) {
    const repo = repoOf(n);
    const error = repoExists(w, n)
      ? `manifest for ${n} not found: manifest unknown: manifest unknown`
      : `pull access denied for ${repo}, repository does not exist or may require 'docker login': denied: requested access to the resource is denied`;
    return { ok: false, lines: [], error, fresh: false, layers: [] };
  }
  const tag = tagOf(n);
  const repoShown = repoOf(n).includes("/") ? repoOf(n) : `library/${repoOf(n)}`;
  const lines = [`${tag}: Pulling from ${repoShown}`];
  const have = host.docker.images[n];
  const layers = Array.from({ length: remote.layers }, (_, i) => hashHex(`${n}#layer${i}`));
  if (have && have.id === remote.id) {
    lines.push(`Digest: ${digestOf(n)}`, `Status: Image is up to date for ${n}`);
    return { ok: true, lines, fresh: false, layers: [] };
  }
  for (const l of layers) lines.push(`${l}: Pull complete`);
  lines.push(`Digest: ${digestOf(n)}`, `Status: Downloaded newer image for ${n}`);
  host.docker.images[n] = {
    ref: n,
    id: remote.id,
    sizeMb: remote.sizeMb,
    kind: remote.kind as AppKind,
    createdAt: w.clock - remote.ageDays * 86400,
    meta: { ...remote.meta, digest: digestOf(n) },
  };
  return { ok: true, lines, fresh: true, layers };
}

/** Docker's size column: 1000-based, "13.3kB", "192MB", "1.1GB". */
export function sizeText(mb: number): string {
  if (mb <= 0) return "0B";
  if (mb < 1) return `${trim(mb * 1000)}kB`;
  if (mb < 1000) return `${trim(mb)}MB`;
  return `${trim(mb / 1000)}GB`;
}

function trim(n: number): string {
  if (n >= 100) return String(Math.round(n));
  return String(Math.round(n * 10) / 10);
}
