import { findSite, parseCaddyfile } from "./caddy";
import { readText } from "./fs";
import type { Container, Hop, HopId, Host, TraceResult, World } from "./types";

export interface Resolved {
  ip?: string;
  chain: string[];
}

const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

export function isIp(s: string): boolean {
  return IP_RE.test(s);
}

export function resolveName(w: World, name: string): Resolved {
  if (isIp(name)) return { ip: name, chain: [] };
  if (name === "localhost") return { ip: "127.0.0.1", chain: [] };
  let current = name.replace(/\.$/, "");
  const chain: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a = w.dns.find((r) => r.name === current && r.type === "A");
    if (a) return { ip: a.value, chain: [...chain, `${current} A ${a.value}`] };
    const c = w.dns.find((r) => r.name === current && r.type === "CNAME");
    if (!c) return { chain };
    chain.push(`${current} CNAME ${c.value}`);
    current = c.value.replace(/\.$/, "");
  }
  return { chain };
}

export function providerAllows(w: World, port: number): boolean {
  const fw = w.provider.firewall;
  if (!fw.enabled) return true;
  return fw.rules.some((r) => r.port === port);
}

export function ufwAllows(host: Host, port: number): boolean {
  if (!host.ufw.enabled) return true;
  if (host.ufw.defaultIncoming === "allow") {
    return !host.ufw.rules.some((r) => r.port === port && r.action === "deny");
  }
  return host.ufw.rules.some((r) => r.port === port && (r.action === "allow" || r.action === "limit") && r.proto !== "udp");
}

export interface Listener {
  addr: string;
  port: number;
  proc: string;
  pid: number;
  source: { kind: "service"; name: string } | { kind: "docker"; container: string };
}

export function listeners(host: Host): Listener[] {
  const out: Listener[] = [];
  for (const s of Object.values(host.services)) {
    if (s.state !== "active") continue;
    for (const l of s.listens ?? []) {
      out.push({ addr: l.addr, port: l.port, proc: l.proc, pid: s.pid, source: { kind: "service", name: s.name } });
    }
  }
  if (host.services.docker?.state === "active") {
    for (const c of Object.values(host.docker.containers)) {
      if (c.status !== "running") continue;
      for (const p of c.ports) {
        out.push({
          addr: p.hostIp,
          port: p.hostPort,
          proc: "docker-proxy",
          pid: 2000 + p.hostPort,
          source: { kind: "docker", container: c.name },
        });
      }
    }
  }
  return out;
}

function publicListener(host: Host, port: number): Listener | undefined {
  return listeners(host).find((l) => l.port === port && (l.addr === "0.0.0.0" || l.addr === "::" || l.addr === host.publicIp));
}

function hop(id: HopId, label: string, ok: boolean, note: string, node?: string): Hop {
  return { id, label, ok, note, node: node ?? id };
}

/** Containers that answer to `name` on any network `from` is attached to. The default bridge has no names. */
export function resolveInDocker(host: Host, from: Container, name: string): Container | undefined {
  return Object.values(host.docker.containers).find(
    (c) => (c.service === name || c.name === name) && c.networks.some((n) => n !== "bridge" && from.networks.includes(n)),
  );
}

/** What Caddy is running with: the config it loaded, not whatever the file says now. */
function caddyConfig(host: Host, c: Container): string {
  if (c.caddyConfig !== undefined) return c.caddyConfig;
  const bind = c.mounts.find((m) => m.target === "/etc/caddy/Caddyfile" && m.type === "bind");
  return (bind && readText(host, bind.source)) ?? "";
}

function parseDbUrl(url: string | undefined): { host: string; port: number } | undefined {
  if (!url) return undefined;
  const m = /^postgres(?:ql)?:\/\/(?:[^@]*@)?([^:/?]+)(?::(\d+))?/.exec(url);
  if (!m) return undefined;
  return { host: m[1], port: m[2] ? Number(m[2]) : 5432 };
}

export interface AppCheck {
  ok: boolean;
  hop: "app" | "db";
  note: string;
  status?: number;
}

/** What happens once a request reaches the app container. */
export function appToDb(host: Host, app: Container): AppCheck {
  const url = app.env.DATABASE_URL;
  const db = parseDbUrl(url);
  if (!db) return { ok: true, hop: "app", note: "Next.js answered (no database needed)", status: 200 };
  if (db.host === "localhost" || db.host === "127.0.0.1") {
    return {
      ok: false,
      hop: "db",
      note: `connect ECONNREFUSED 127.0.0.1:${db.port}. Inside a container, localhost is the container itself.`,
      status: 500,
    };
  }
  const target = resolveInDocker(host, app, db.host);
  if (!target) {
    return { ok: false, hop: "db", note: `getaddrinfo ENOTFOUND ${db.host}`, status: 500 };
  }
  if (target.status !== "running") {
    return { ok: false, hop: "db", note: `connect ECONNREFUSED: ${db.host} is not running`, status: 500 };
  }
  return { ok: true, hop: "db", note: `Postgres on ${db.host}:${db.port} answered`, status: 200 };
}

export interface TraceOpts {
  from: "internet" | "laptop" | "vps";
}

/** Walk one HTTP(S) request hop by hop. */
export function traceHttp(w: World, url: string, opts: TraceOpts = { from: "internet" }): TraceResult {
  const m = /^(https?):\/\/([^/:]+)(?::(\d+))?/.exec(url.trim());
  const hops: Hop[] = [];
  const res = (ok: boolean, extra: Partial<TraceResult> = {}): TraceResult => {
    const failed = hops.find((h) => !h.ok);
    return { kind: "http", target: url, hops, ok, failedAt: failed?.id, ...extra };
  };
  if (!m) {
    hops.push(hop("browser", "URL", false, "That is not a valid URL"));
    return res(false, { error: `curl: (3) URL rejected: Malformed input to a URL function` });
  }
  const scheme = m[1];
  const name = m[2];
  const port = m[3] ? Number(m[3]) : scheme === "https" ? 443 : 80;
  const origin = opts.from === "vps" ? "vps" : opts.from === "laptop" ? "laptop" : "browser";
  hops.push(hop(origin === "vps" ? "laptop" : (origin as HopId), origin === "browser" ? "Browser" : origin === "laptop" ? "Your laptop" : "web-1", true, "Request starts here", origin === "vps" ? "vps" : origin === "browser" ? "client" : "laptop"));

  const vps = w.hosts.vps;
  const local = opts.from === "vps" && (name === "localhost" || name === "127.0.0.1");

  if (!local) {
    const r = resolveName(w, name);
    if (!r.ip) {
      hops.push(hop("dns", "DNS", false, `No A record for ${name}`));
      return res(false, { error: `curl: (6) Could not resolve host: ${name}` });
    }
    if (!w.provider.rented || r.ip !== vps.publicIp) {
      hops.push(hop("dns", "DNS", false, `${name} points to ${r.ip}, not your server (${vps.publicIp ?? "none yet"})`));
      return res(false, {
        error: `curl: (28) Failed to connect to ${name} port ${port} after 30002 ms: Timeout was reached`,
      });
    }
    hops.push(hop("dns", "DNS", true, `${name} → ${r.ip}`));
    if (opts.from !== "vps") {
      if (!providerAllows(w, port)) {
        hops.push(hop("provider-fw", "Provider firewall", false, `Port ${port} is not allowed in the provider dashboard`, "pfw"));
        return res(false, {
          error: `curl: (28) Failed to connect to ${name} port ${port} after 30001 ms: Timeout was reached`,
        });
      }
      hops.push(hop("provider-fw", "Provider firewall", true, `Port ${port} allowed`, "pfw"));
    }
  }

  const listener = local
    ? listeners(vps).find((l) => l.port === port && (l.addr === "127.0.0.1" || l.addr === "0.0.0.0"))
    : publicListener(vps, port);

  if (!local && opts.from !== "vps") {
    const viaDocker = listener?.source.kind === "docker";
    if (!ufwAllows(vps, port) && !viaDocker) {
      hops.push(hop("ufw", "ufw", false, `ufw blocks port ${port}`));
      return res(false, {
        error: `curl: (28) Failed to connect to ${name} port ${port} after 30001 ms: Timeout was reached`,
      });
    }
    hops.push(
      hop(
        "ufw",
        "ufw",
        true,
        viaDocker && vps.ufw.enabled && !ufwAllows(vps, port)
          ? `ufw would block ${port}, but Docker published it and skipped ufw`
          : vps.ufw.enabled
            ? `Port ${port} allowed`
            : "ufw is off, everything gets in",
      ),
    );
  }

  if (!listener) {
    hops.push(hop("listener", `Port ${port}`, false, `Nothing is listening on port ${port}`, "vps"));
    return res(false, {
      error: `curl: (7) Failed to connect to ${name} port ${port} after 12 ms: Couldn't connect to server`,
    });
  }

  if (listener.source.kind === "service") {
    const s = vps.services[listener.source.name];
    hops.push(hop("listener", s.name, true, `${s.name} answered on port ${port}`, `svc:${s.name}`));
    return res(true, { status: 200 });
  }

  const front = vps.docker.containers[listener.source.container];
  if (front.kind !== "caddy") {
    const node = front.kind === "nextjs" ? "app" : front.kind === "postgres" ? "db" : `c:${front.name}`;
    // docker-proxy accepts, but nothing inside listens on the published container port (or only on loopback).
    const mapped = front.ports.find((p) => p.hostPort === port);
    if (mapped && front.listenPort && (mapped.containerPort !== front.listenPort || front.listenAddr.startsWith("127."))) {
      hops.push(hop("app", front.name, false, `Port ${port} goes to ${mapped.containerPort} inside ${front.name}, but the program there listens on ${front.listenAddr}:${front.listenPort}`, node));
      return res(false, { error: `curl: (56) Recv failure: Connection reset by peer` });
    }
    if (front.kind === "postgres") {
      hops.push(hop("db", front.name, true, `Postgres is reachable on port ${port}`, node));
      return res(true, { status: 0 });
    }
    hops.push(hop("app", front.name, true, `${front.name} answered directly`, node));
    return res(true, { status: 200 });
  }

  // Caddy
  const conf = parseCaddyfile(caddyConfig(vps, front));
  const site = findSite(conf, name);
  if (scheme === "https") {
    if (!site) {
      hops.push(hop("caddy", "Caddy", false, `No site block for ${name} in the Caddyfile, so no certificate`));
      return res(false, { error: `curl: (35) OpenSSL/3.0.13: error:0A000438:SSL routines::tlsv1 alert internal error` });
    }
    if (!w.certs[name] && site.tls !== "internal") {
      hops.push(hop("caddy", "Caddy", false, `No certificate for ${name} yet. Let's Encrypt could not verify it.`));
      return res(false, { error: `curl: (35) OpenSSL/3.0.13: error:0A000438:SSL routines::tlsv1 alert internal error` });
    }
  } else if (site && !site.addresses.some((a) => a.startsWith("http://"))) {
    hops.push(hop("caddy", "Caddy", true, `HTTP gets redirected to https://${name}`));
    return res(true, { status: 308 });
  } else if (!site) {
    hops.push(hop("caddy", "Caddy", true, `Caddy has no site for ${name}`));
    return res(true, { status: 200 });
  }

  if (site?.respond) {
    hops.push(hop("caddy", "Caddy", true, `Caddy answered by itself`));
    return res(true, { status: 200 });
  }
  const upstream = site?.upstreams[0];
  if (!upstream) {
    hops.push(hop("caddy", "Caddy", true, "Site has no reverse_proxy"));
    return res(true, { status: 200 });
  }
  const [uHost, uPortStr] = upstream.replace(/^https?:\/\//, "").split(":");
  const uPort = Number(uPortStr ?? 80);
  hops.push(hop("caddy", "Caddy", true, `${name} → reverse_proxy ${upstream}`));

  if (uHost === "localhost" || uHost === "127.0.0.1") {
    hops.push(hop("app", "app", false, `Caddy dialed ${upstream}, but inside the Caddy container localhost is Caddy itself`));
    return res(false, { status: 502 });
  }
  const app = resolveInDocker(vps, front, uHost);
  if (!app) {
    hops.push(hop("app", uHost, false, `dial tcp: lookup ${uHost}: no such host`));
    return res(false, { status: 502 });
  }
  if (app.status !== "running") {
    hops.push(
      hop("app", app.service ?? app.name, false, app.status === "restarting" ? `${app.name} keeps crashing and restarting` : `${app.name} is not running`),
    );
    return res(false, { status: 502 });
  }
  if (app.listenPort !== uPort) {
    hops.push(hop("app", app.service ?? app.name, false, `Caddy dialed port ${uPort}, but the app listens on ${app.listenPort}`));
    return res(false, { status: 502 });
  }
  // 0.0.0.0 or the container's own IP are reachable from Caddy. Only loopback is not.
  if (app.listenAddr === "localhost" || app.listenAddr.startsWith("127.")) {
    hops.push(hop("app", app.service ?? app.name, false, `The app listens on ${app.listenAddr}:${app.listenPort}, so only itself can reach it`));
    return res(false, { status: 502 });
  }
  if (app.kind !== "nextjs") {
    hops.push(hop("app", app.service ?? app.name, true, `${app.name} answered`));
    return res(true, { status: 200 });
  }
  const db = appToDb(vps, app);
  if (db.hop === "app") {
    hops.push(hop("app", "app", true, db.note));
    return res(true, { status: db.status });
  }
  hops.push(hop("app", "app", true, "Next.js got the request"));
  hops.push(hop("db", "db", db.ok, db.note));
  return res(db.ok, { status: db.status });
}

export function traceOk(w: World, url: string): boolean {
  return traceHttp(w, url).ok;
}
