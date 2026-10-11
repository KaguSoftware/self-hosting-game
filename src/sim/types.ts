// The whole simulated universe. Pure data, no functions, so it can be
// cloned, snapshotted, replayed and compared in tests.

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
}

export interface DockerState {
  images: Record<string, { ref: string; id: string; sizeMb: number; kind: AppKind; createdAt: number }>;
  containers: Record<string, Container>;
  volumes: Record<string, { name: string; sizeMb: number; data?: string }>;
  networks: Record<string, { name: string; driver: string }>;
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
