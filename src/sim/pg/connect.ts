// How a Postgres client reaches a server: the socket inside the container,
// TCP through a published port, an SSH tunnel, or Supabase out on the internet.
// Error text matches libpq 16/17 ("connection to server at ... failed: ...").
import { isIp, listeners, providerAllows, resolveInDocker, resolveName, ufwAllows, type Listener } from "../net";
import type { Container, Host, HostId, World } from "../types";
import { containerCluster, debianVersion, serverVersion, SUPABASE_CLUSTER, SUPABASE_HOST, SUPABASE_IP, SUPABASE_VERSION } from "./cluster";
import type { PgCluster, PgTunnel } from "./types";

export const SOCKET = "/var/run/postgresql/.s.PGSQL.5432";

/** Where the client program runs. */
export type PgFrom = { kind: "container"; host: HostId; container: string } | { kind: "host"; host: HostId };

/** The server a connection ended up at. */
export type PgServerRef = { kind: "container"; host: HostId; container: string } | { kind: "external"; name: string };

export interface PgTarget {
  /** -h. Undefined or a path means the Unix socket. */
  host?: string;
  port?: number;
  user: string;
  db: string;
  password?: string;
  sslmode?: string;
}

export interface PgConn {
  server: PgServerRef;
  user: string;
  db: string;
  socket: boolean;
  /** What the client typed for -h (for \conninfo). */
  host?: string;
  port: number;
  ssl: boolean;
}

export type ConnResult = { ok: true; conn: PgConn } | { ok: false; error: string; needPassword?: boolean };

export interface PgServerInfo {
  version: string;
  long: string;
  cluster: PgCluster;
  writable: boolean;
  ssl: boolean;
}

function pgContainer(w: World, ref: { host: HostId; container: string }): Container | undefined {
  const c = w.hosts[ref.host]?.docker.containers[ref.container];
  return c && c.kind === "postgres" && c.status === "running" ? c : undefined;
}

/** Version and data of the server, or undefined when it is gone (stopped, removed). */
export function serverOf(w: World, ref: PgServerRef, write = false): PgServerInfo | undefined {
  if (ref.kind === "external") return { version: SUPABASE_VERSION, long: SUPABASE_VERSION, cluster: SUPABASE_CLUSTER, writable: false, ssl: true };
  const host = w.hosts[ref.host];
  const c = pgContainer(w, ref);
  if (!c) return undefined;
  const v = serverVersion(host, c);
  return { version: v, long: debianVersion(v), cluster: containerCluster(host, c, write), writable: true, ssl: false };
}

const tcpPrefix = (host: string, port: number, ip?: string) => `connection to server at "${host}"${ip && ip !== host ? ` (${ip})` : ""}, port ${port} failed: `;
const socketPrefix = `connection to server on socket "${SOCKET}" failed: `;
const REFUSED = "Connection refused\n\tIs the server running on that host and accepting TCP/IP connections?";
const TIMEOUT = "Connection timed out\n\tIs the server running on that host and accepting TCP/IP connections?";
export const CLOSED = "server closed the connection unexpectedly\n\tThis probably means the server terminated abnormally\n\tbefore or while processing the request.";

const isLoopback = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "::1";

interface Route {
  ref?: PgServerRef;
  /** trust: no password asked (socket and loopback inside the container). */
  method: "trust" | "scram";
  prefix: string;
  error?: string;
}

/** A host listener on `port` that `addr` can reach. */
function hostListener(host: Host, addr: string, port: number): Listener | undefined {
  return listeners(host).find((l) => l.port === port && (l.addr === "0.0.0.0" || l.addr === "::" || l.addr === addr));
}

/** What sits behind a host listener: a postgres container, or something that is not Postgres. */
function behind(w: World, hostId: HostId, l: Listener, prefix: string): Route {
  if (l.source.kind === "docker") {
    const c = w.hosts[hostId].docker.containers[l.source.container];
    const mapped = c?.ports.find((p) => p.hostPort === l.port);
    if (c?.kind === "postgres" && mapped && mapped.containerPort === c.listenPort) {
      // From the container's side the connection comes from the Docker gateway, so pg_hba wants a password.
      return { ref: { kind: "container", host: hostId, container: c.name }, method: "scram", prefix };
    }
    if (c?.kind === "postgres") return { method: "scram", prefix, error: CLOSED };
  }
  return { method: "scram", prefix, error: "received invalid response to SSL negotiation: H" };
}

/**
 * The VPS end of a tunnel: sshd opens remoteHost:remotePort from the VPS itself.
 * Returns the route, or the reason sshd printed ("Connection refused").
 */
function tunnelEnd(w: World, t: PgTunnel, prefix: string): Route | { sshError: string } {
  const vps = w.hosts.vps;
  if (isLoopback(t.remoteHost) || t.remoteHost === vps.publicIp || t.remoteHost === "0.0.0.0") {
    const l = hostListener(vps, isLoopback(t.remoteHost) ? "127.0.0.1" : t.remoteHost, t.remotePort);
    if (!l) return { sshError: "Connection refused" };
    return behind(w, "vps", l, prefix);
  }
  if (isIp(t.remoteHost)) {
    // Docker bridge addresses are reachable from the host itself.
    const c = Object.values(vps.docker.containers).find((x) => Object.values(x.ips ?? {}).includes(t.remoteHost));
    if (!c || c.status !== "running" || c.listenPort !== t.remotePort) return { sshError: "Connection refused" };
    if (c.kind !== "postgres") return { method: "scram", prefix, error: "received invalid response to SSL negotiation: H" };
    return { ref: { kind: "container", host: "vps", container: c.name }, method: "scram", prefix };
  }
  return { sshError: "Name or service not known" };
}

function route(w: World, from: PgFrom, t: PgTarget): Route {
  const port = t.port ?? 5432;
  const h = t.host;
  if (from.kind === "container") {
    const host = w.hosts[from.host];
    const self = host.docker.containers[from.container];
    if (!h || h.startsWith("/")) {
      if (!self || port !== 5432) return { method: "trust", prefix: socketPrefix.replace("5432", String(port)), error: "No such file or directory\n\tIs the server running locally and accepting connections on that socket?" };
      return { ref: { kind: "container", host: from.host, container: from.container }, method: "trust", prefix: socketPrefix };
    }
    if (isLoopback(h)) {
      const prefix = tcpPrefix(h, port, h === "localhost" ? "127.0.0.1" : undefined);
      if (port !== self?.listenPort) return { method: "trust", prefix, error: REFUSED };
      return { ref: { kind: "container", host: from.host, container: from.container }, method: "trust", prefix };
    }
    if (h === SUPABASE_HOST) return { ref: { kind: "external", name: h }, method: "scram", prefix: tcpPrefix(h, port, SUPABASE_IP) };
    const other = self && resolveInDocker(host, self, h);
    if (!other) return { method: "scram", prefix: "", error: `could not translate host name "${h}" to address: Name or service not known` };
    const prefix = tcpPrefix(h, port, other.ips ? Object.values(other.ips)[0] : undefined);
    if (other.status !== "running" || other.listenPort !== port) return { method: "scram", prefix, error: REFUSED };
    if (other.kind !== "postgres") return { method: "scram", prefix, error: "received invalid response to SSL negotiation: H" };
    return { ref: { kind: "container", host: from.host, container: other.name }, method: "scram", prefix };
  }

  // A client on the laptop or on the VPS itself.
  if (!h || h.startsWith("/")) return { method: "trust", prefix: socketPrefix, error: "No such file or directory\n\tIs the server running locally and accepting connections on that socket?" };
  if (h === SUPABASE_HOST) return { ref: { kind: "external", name: h }, method: "scram", prefix: tcpPrefix(h, port, SUPABASE_IP) };
  if (isLoopback(h)) {
    const prefix = tcpPrefix(h, port, h === "localhost" ? "127.0.0.1" : undefined);
    if (from.host === "laptop") {
      const tun = w.tunnels?.find((x) => x.laptopPort === port);
      if (!tun) return { method: "scram", prefix, error: REFUSED };
      const end = tunnelEnd(w, tun, prefix);
      if ("sshError" in end) {
        const ch = tun.channel ?? 2;
        tun.channel = ch + 1;
        (tun.log ??= []).push(`channel ${ch}: open failed: connect failed: ${end.sshError}`);
        return { method: "scram", prefix, error: CLOSED };
      }
      return end;
    }
    const l = hostListener(w.hosts[from.host], "127.0.0.1", port);
    if (!l) return { method: "scram", prefix, error: REFUSED };
    return behind(w, from.host, l, prefix);
  }
  const r = resolveName(w, h);
  if (!r.ip) return { method: "scram", prefix: "", error: `could not translate host name "${h}" to address: Name or service not known` };
  const prefix = tcpPrefix(h, port, r.ip);
  const vps = w.hosts.vps;
  if (!w.provider.rented || r.ip !== vps.publicIp) return { method: "scram", prefix, error: TIMEOUT };
  if (from.host === "vps") {
    const l = hostListener(vps, r.ip, port);
    return l ? behind(w, "vps", l, prefix) : { method: "scram", prefix, error: REFUSED };
  }
  // From the laptop over the internet: provider firewall, then ufw (which Docker skips).
  if (!providerAllows(w, port)) return { method: "scram", prefix, error: TIMEOUT };
  const l = hostListener(vps, r.ip, port);
  if (!l) return { method: "scram", prefix, error: ufwAllows(vps, port) ? REFUSED : TIMEOUT };
  if (l.source.kind !== "docker" && !ufwAllows(vps, port)) return { method: "scram", prefix, error: TIMEOUT };
  return behind(w, "vps", l, prefix);
}

/** Connect and log in. Call on a draft: a failed tunnel channel is written to the tunnel's log. */
export function pgConnect(w: World, from: PgFrom, t: PgTarget): ConnResult {
  const r = route(w, from, t);
  if (r.error || !r.ref) {
    // libpq tries ::1 first for localhost and reports both attempts.
    const v6 = t.host === "localhost" && r.error === REFUSED ? `connection to server at "localhost" (::1), port ${t.port ?? 5432} failed: ${REFUSED}\n` : "";
    return { ok: false, error: v6 + r.prefix + (r.error ?? CLOSED) };
  }
  const info = serverOf(w, r.ref);
  if (!info) return { ok: false, error: r.prefix + (r.method === "trust" ? "No such file or directory" : REFUSED) };
  if (t.sslmode === "require" || t.sslmode === "verify-full" || t.sslmode === "verify-ca") {
    if (!info.ssl) return { ok: false, error: r.prefix + "server does not support SSL, but SSL was required" };
  }
  let method = r.method;
  if (r.ref.kind === "container") {
    const c = w.hosts[r.ref.host].docker.containers[r.ref.container];
    if (c.env.POSTGRES_HOST_AUTH_METHOD === "trust") method = "trust";
  }
  const role = info.cluster.roles[t.user];
  if (method === "scram") {
    if (t.password === undefined) return { ok: false, error: r.prefix + "fe_sendauth: no password supplied", needPassword: true };
    if (!role || role.password === undefined || role.password !== t.password) return { ok: false, error: r.prefix + `FATAL:  password authentication failed for user "${t.user}"` };
  } else if (!role) return { ok: false, error: r.prefix + `FATAL:  role "${t.user}" does not exist` };
  if (!role.login) return { ok: false, error: r.prefix + `FATAL:  role "${t.user}" is not permitted to log in` };
  if (!info.cluster.databases[t.db]) return { ok: false, error: r.prefix + `FATAL:  database "${t.db}" does not exist` };
  return {
    ok: true,
    conn: { server: r.ref, user: t.user, db: t.db, socket: !t.host || t.host.startsWith("/"), host: t.host, port: t.port ?? 5432, ssl: info.ssl && t.sslmode !== "disable" },
  };
}

/** Lines ssh printed in the tunnel window that nobody has seen yet. Clears them. */
export function takeTunnelLog(w: World, shellId: string): string[] {
  const out: string[] = [];
  for (const t of w.tunnels ?? []) {
    if (t.shellId !== shellId || !t.log?.length) continue;
    out.push(...t.log);
    t.log = [];
  }
  return out;
}

/** Parse postgres://user:pass@host:port/db?sslmode=x. */
export function parseConnUri(uri: string): Partial<PgTarget> | undefined {
  const m = /^postgres(?:ql)?:\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^:/?]*)(?::(\d+))?(?:\/([^?]*))?(?:\?(.*))?$/.exec(uri.trim());
  if (!m) return undefined;
  const dec = (s: string | undefined) => {
    if (s === undefined || s === "") return undefined;
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const params = new URLSearchParams(m[6] ?? "");
  return {
    user: dec(m[1]),
    password: m[2] !== undefined ? (dec(m[2]) ?? "") : undefined,
    host: dec(m[3]),
    port: m[4] ? Number(m[4]) : undefined,
    db: dec(m[5]),
    sslmode: params.get("sslmode") ?? undefined,
  };
}
