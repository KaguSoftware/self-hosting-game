// The whole simulated universe. Pure data, no functions, so it can be
// cloned, snapshotted, replayed and compared in tests.
import type { PgDatabase, PgRole, PgTunnel } from "./pg/types";

export type HostId = "laptop" | "vps";

export interface FsFile {
  type: "file";
  content: string;
  mode: number; // e.g. 0o644
  owner: string;
  group: string;
  /** Extra bytes on top of content length. Used for huge logs. */
  padBytes?: number;
}

export interface FsDir {
  type: "dir";
  children: Record<string, FsNode>;
  mode: number;
  owner: string;
  group: string;
}

export type FsNode = FsFile | FsDir;

export interface User {
  name: string;
  uid: number;
  home: string;
  shell: string;
  password?: string; // plain text in the sim only
  gecos?: string;
}

export interface Group {
  name: string;
  gid: number;
  members: string[];
}

export interface JournalLine {
  t: number; // sim clock seconds
  unit: string; // service name: "ssh", "hello"
  msg: string;
  /** Process label shown in the log line. Defaults from the unit. */
  proc?: string;
}

export interface Service {
  name: string; // "ssh"
  description: string;
  unitPath: string;
  enabled: boolean;
  state: "active" | "inactive" | "failed";
  since: number;
  pid: number;
  /** Port this service listens on when active. */
  listens?: { port: number; addr: string; proc: string }[];
  triggeredBy?: string;
  /** Snapshot of effective config taken at last start/reload (ssh). */
  loaded?: Record<string, string>;
}

export interface UfwRule {
  port: number;
  proto: "tcp" | "udp" | "any";
  action: "allow" | "deny" | "limit";
  label: string; // what the user typed: "OpenSSH", "80/tcp", "443"
}

export interface UfwState {
  enabled: boolean;
  defaultIncoming: "deny" | "allow";
  rules: UfwRule[];
}

export interface PortMap {
  hostIp: string; // "0.0.0.0" | "127.0.0.1"
  hostPort: number;
  containerPort: number;
}

export type AppKind = "caddy" | "nextjs" | "postgres" | "hello" | "generic";

export interface Container {
  id: string;
  name: string;
  image: string;
  kind: AppKind;
  status: "running" | "exited" | "restarting" | "created";
  exitCode?: number;
  ports: PortMap[];
  networks: string[];
  env: Record<string, string>;
  mounts: { source: string; target: string; type: "volume" | "bind" }[];
  restart: "no" | "always" | "unless-stopped" | "on-failure";
  project?: string;
  service?: string;
  /** Address the process inside binds to. */
  listenAddr: string;
  listenPort: number;
  health?: "healthy" | "unhealthy" | "starting";
  logs: string[];
  createdAt: number;
  // docker runtime extras (all optional, see the docker section below)
  restartCount?: number;
  startedAt?: number;
  finishedAt?: number;
  /** When the crash-loop backoff lets it start again. */
  nextRestartAt?: number;
  /** Stopped with docker stop: unless-stopped and always leave it down. */
  manuallyStopped?: boolean;
  /** IP per network name. */
  ips?: Record<string, string>;
  healthcheck?: HealthCheck;
  /** Failed probes in a row. */
  healthFails?: number;
  /** Clock time of the last health probe. */
  lastProbe?: number;
  /** Command override (docker run IMAGE CMD..., compose command:). */
  command?: string[];
  /** Compose config hash, so up -d only recreates what changed. */
  configHash?: string;
  logging?: { driver: string; options: Record<string, string> };
  /** docker run --rm */
  autoRemove?: boolean;
  /** Image id at creation time. */
  imageId?: string;
  /** Compose depends_on, kept for ordering on down and restart. */
  dependsOn?: string[];
}

export interface DockerState {
  images: Record<string, { ref: string; id: string; sizeMb: number; kind: AppKind; createdAt: number; meta?: ImageMeta }>;
  containers: Record<string, Container>;
  volumes: Record<string, { name: string; sizeMb: number; data?: string; createdAt?: number; project?: string; pg?: PgData }>;
  networks: Record<string, { name: string; driver: string; subnet?: string; project?: string }>;
  /** Compose projects that were brought up (docker compose ls). */
  projects?: Record<string, ComposeProject>;
  /** Build cache: layer cache key to the time it was made. */
  buildCache?: Record<string, number>;
}

export interface Host {
  id: HostId;
  hostname: string;
  publicIp?: string;
  privateIp: string;
  os: string;
  cpus: number;
  memMb: number;
  diskGb: number;
  baseUsedMb: number;
  fs: FsDir;
  users: Record<string, User>;
  groups: Record<string, Group>;
  packages: Record<string, { version: string }>;
  aptFresh: boolean;
  /** apt upgrade has been run */
  upgraded?: boolean;
  services: Record<string, Service>;
  ufw: UfwState;
  docker: DockerState;
  journal: JournalLine[];
  crontabs: Record<string, string>;
  /** Extra apt repositories indexed by the last apt update ("docker"). */
  aptRepos?: string[];
}

export interface DnsRecord {
  name: string; // "crumb.shop"
  type: "A" | "AAAA" | "CNAME" | "TXT";
  value: string;
  ttl: number;
}

export interface ProviderRule {
  port: number;
  source: string; // "0.0.0.0/0"
}

export interface ProviderState {
  /** Has the VPS been rented yet. */
  rented: boolean;
  plan?: { name: string; cpus: number; memGb: number; diskGb: number; priceEur: number };
  firewall: { enabled: boolean; rules: ProviderRule[] };
}

export interface CertState {
  domain: string;
  issuer: string;
  issuedAt: number;
}

export interface World {
  clock: number;
  seed: number;
  hosts: Record<HostId, Host>;
  dns: DnsRecord[];
  provider: ProviderState;
  certs: Record<string, CertState>;
  flags: Record<string, string | number | boolean>;
  /** Extra images in remote registries (pushed by CI, or placed by a level). */
  registry?: Record<string, RegistryImage>;
  /** Open SSH tunnels from the laptop (ssh -L). */
  tunnels?: PgTunnel[];
}

// ---------- docker ----------

export interface HealthCheck {
  /** ["CMD-SHELL", "pg_isready -U crumb"] or ["CMD", "wget", ...] */
  test: string[];
  /** Seconds. */
  interval: number;
  timeout: number;
  retries: number;
  startPeriod: number;
}

/** What an image knows about itself (from the registry catalog or a Dockerfile build). */
export interface ImageMeta {
  /** ENV baked into the image. HOSTNAME here sets where a Next.js app listens. */
  env?: Record<string, string>;
  entrypoint?: string[];
  cmd?: string[];
  exposed?: number[];
  /** Env vars the app refuses to start without. */
  requiredEnv?: string[];
  /** NEXT_PUBLIC_* values frozen in at build time. */
  baked?: Record<string, string>;
  /** Paths inside the image worth knowing about (/app/.env, /app/node_modules). */
  files?: string[];
  workdir?: string;
  /** Finer than AppKind: "nginx", "hello-world", "node", "alpine", "postgres", "caddy". */
  flavor?: string;
  /** Upstream version ("17.2", "2.10.2"). */
  version?: string;
  healthcheck?: HealthCheck;
  /** Built here with docker build, not pulled. */
  built?: boolean;
  digest?: string;
}

/** The Postgres data inside a volume, written on first start. */
export interface PgData {
  /** Major version that initialized it ("17"). */
  version: string;
  user: string;
  db: string;
  password: string;
  /** Filled in the first time something changes the cluster (see pg/cluster.ts). Until then
   *  the roles and databases follow from user, db and password above. */
  roles?: Record<string, PgRole>;
  databases?: Record<string, PgDatabase>;
}

export interface ComposeProject {
  name: string;
  dir: string;
  file: string;
  services: string[];
}

export interface RegistryImage {
  ref: string;
  id: string;
  sizeMb: number;
  kind: AppKind;
  ageDays?: number;
  meta?: ImageMeta;
}

// ---------- shell side (per terminal window) ----------

export interface Frame {
  host: HostId;
  user: string;
  cwd: string;
  via: "local" | "ssh" | "su" | "console";
  /** sudo already authenticated in this frame */
  sudoOk?: boolean;
  /** Remote address shown in "Connection to X closed." */
  remote?: string;
  /** Groups as they were at login. New group memberships only count from the next login. */
  loginGroups?: string[];
}

export interface Pending {
  /** Text shown as the prompt, e.g. "[sudo] password for deploy: " */
  prompt: string;
  secret: boolean;
  /** Which command resumes, and its private data. */
  cmd: string;
  data: Record<string, unknown>;
}

export interface Shell {
  id: string;
  frames: Frame[];
  history: string[];
  pending?: Pending;
  /** Shell variables set with NAME=value or export. Passed to commands as their environment. */
  vars?: Record<string, string>;
}

export interface OutLine {
  text: string;
  kind: "out" | "err" | "info";
}

export interface EditorRequest {
  host: HostId;
  path: string;
  content: string;
  canWrite: boolean;
  asUser: string;
  isNew: boolean;
}

// ---------- tracing ----------

export type HopId =
  | "browser"
  | "laptop"
  | "dns"
  | "provider-fw"
  | "ufw"
  | "listener"
  | "sshd"
  | "auth"
  | "caddy"
  | "app"
  | "db";

export interface Hop {
  id: HopId;
  label: string;
  ok: boolean;
  note: string;
  /** Map node id this hop is drawn on. */
  node: string;
}

export interface TraceResult {
  kind: "http" | "ssh";
  target: string;
  hops: Hop[];
  ok: boolean;
  failedAt?: HopId;
  /** curl-style status code when an HTTP response came back. */
  status?: number;
  error?: string;
}
