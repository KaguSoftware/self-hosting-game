// Caddy in a container: it reads its Caddyfile when it starts (or on caddy reload),
// and it gets HTTPS certificates from Let's Encrypt over time, once the three green
// lights are on: DNS points here, port 80 or 443 is reachable, and a site block exists.
import { hostOf, parseCaddyfile } from "../caddy";
import { readText } from "../fs";
import { isIp, providerAllows, resolveName } from "../net";
import { registerReconciler } from "../tick";
import { unixTime } from "../time";
import type { Container, Host, World } from "../types";
import { log, metaOf, registerBootHook, registerExecHook } from "./behaviour";

export const CADDYFILE = "/etc/caddy/Caddyfile";
const LE = "acme-v02.api.letsencrypt.org-directory";
/** Let's Encrypt: at most 5 certificates for the same names in 168 hours. */
const RATE_LIMIT = 5;
const WEEK = 168 * 3600;
const RETRY = 60;

/** The image's own Caddyfile, used when nothing is mounted over it. */
const DEFAULT_CADDYFILE = `:80 {\n\troot * /usr/share/caddy\n\tfile_server\n}\n`;

/** The Caddyfile the container sees at a path: a bind mount wins, else the image default. */
function caddyfileAt(host: Host, c: Container, path: string): string | undefined {
  for (const m of c.mounts) {
    if (m.type !== "bind") continue;
    if (path === m.target) return readText(host, m.source);
    if (path.startsWith(m.target + "/")) return readText(host, m.source + path.slice(m.target.length));
  }
  return path === CADDYFILE ? DEFAULT_CADDYFILE : undefined;
}

/** "Caddyfile:3: unrecognized directive: x" in Caddy's real wording, or null if fine. */
export function caddyError(text: string, path: string): string | null {
  const p = parseCaddyfile(text);
  if (!p.errors.length) return null;
  return `Error: adapting config using caddyfile: ${p.errors[0].replace(/^Caddyfile/, path)}`;
}

/** Domains Caddy will try to get a public certificate for. */
export function publicDomains(text: string): string[] {
  const out: string[] = [];
  for (const s of parseCaddyfile(text).sites) {
    if (s.tls === "internal") continue;
    for (const a of s.addresses) {
      if (a.startsWith("http://") || a.startsWith(":")) continue;
      const h = hostOf(a);
      if (!h.includes(".") || isIp(h) || h === "localhost" || h.endsWith(".internal") || h.endsWith(".local")) continue;
      out.push(h);
    }
  }
  return [...new Set(out)];
}

function jlog(c: Container, now: number, obj: Record<string, unknown>) {
  log(c, JSON.stringify({ level: "info", ts: Number(`${unixTime(now)}.${String(now % 1000).padStart(4, "0")}`), ...obj }));
}

registerBootHook("caddy-config", "caddy", (_w, host, c, now) => {
  const text = caddyfileAt(host, c, CADDYFILE) ?? "";
  const err = caddyError(text, CADDYFILE);
  if (err) {
    log(c, err);
    c.caddyConfig = undefined;
    return { exit: 1 };
  }
  c.caddyConfig = text;
  void now;
});

registerExecHook("caddy-cli", (x) => {
  const [bin, sub, ...rest] = x.argv;
  if ((bin ?? "").split("/").pop() !== "caddy" || x.c.kind !== "caddy") return undefined;
  if (sub === "version") {
    x.out(`v${metaOf(x.host, x.c).version ?? "2.10.2"} h1:9ad9FuXw6MBKKgGg1vVCRpK/SLwGfGVu1Ch/8qjk3Z0=`);
    return 0;
  }
  if (sub !== "reload" && sub !== "validate" && sub !== "fmt") {
    x.err(`Error: unknown command "${sub ?? ""}" for "caddy"\nRun 'caddy --help' for usage.`);
    return 1;
  }
  const ci = rest.indexOf("--config");
  const workdir = x.workdir ?? metaOf(x.host, x.c).workdir ?? "/srv";
  const path = ci >= 0 && rest[ci + 1] ? rest[ci + 1] : `${workdir.replace(/\/$/, "")}/Caddyfile`;
  const abs = path.startsWith("/") ? path : `${workdir.replace(/\/$/, "")}/${path}`;
  const text = caddyfileAt(x.host, x.c, abs);
  if (text === undefined) {
    // The official image works in /srv, but the Caddyfile is in /etc/caddy.
    if (ci < 0) x.err("Error: no config file to load");
    else x.err(`Error: reading config from file: open ${path}: no such file or directory`);
    return 1;
  }
  const shown = ci >= 0 ? path : "Caddyfile";
  const err = caddyError(text, shown);
  const now = x.w.clock;
  if (sub === "fmt") {
    x.out(text.replace(/\n$/, ""));
    return err ? 1 : 0;
  }
  x.err(JSON.stringify({ level: "info", ts: Number(`${unixTime(now)}.4402`), msg: "using config from file", file: shown }));
  if (err) {
    // A failed reload keeps the old config running.
    x.err(err);
    return 1;
  }
  x.err(JSON.stringify({ level: "info", ts: Number(`${unixTime(now)}.4418`), msg: "adapted config to JSON", adapter: "caddyfile" }));
  if (sub === "validate") {
    x.out("Valid configuration");
    return 0;
  }
  x.c.caddyConfig = text;
  // A new config makes Caddy try for missing certificates right away.
  if (x.w.acme) for (const d of publicDomains(text)) delete x.w.acme.lastTry[d];
  jlog(x.c, now, { logger: "admin.api", msg: "load complete" });
  return 0;
});

/** Is the cert still where Caddy keeps it? A cert inside a removed container is gone. */
function certStillThere(host: Host, store: string | undefined, c: Container): boolean {
  if (!store) return true;
  if (store.startsWith("volume:")) return !!host.docker.volumes[store.slice(7)];
  return store === `container:${c.id}`;
}

function dataStore(c: Container): string {
  const m = c.mounts.find((x) => x.target === "/data" && x.type === "volume");
  return m ? `volume:${m.source}` : `container:${c.id}`;
}

/** Can Let's Encrypt reach this Caddy on 80 or 443 from the internet? */
function reachable(w: World, c: Container): boolean {
  return c.ports.some((p) => (p.containerPort === 80 || p.containerPort === 443) && p.hostIp !== "127.0.0.1" && providerAllows(w, p.hostPort));
}

function tryIssue(w: World, host: Host, c: Container, domain: string, now: number) {
  const acme = (w.acme ??= { issued: {}, lastTry: {} });
  const last = acme.lastTry[domain];
  if (last !== undefined && now - last < RETRY) return;
  acme.lastTry[domain] = now;
  const fail = (problem: string) =>
    log(
      c,
      JSON.stringify({
        level: "error",
        ts: Number(`${unixTime(now)}.2207`),
        logger: "tls.obtain",
        msg: "could not get certificate from issuer",
        identifier: domain,
        issuer: LE,
        error: `HTTP 400 urn:ietf:params:acme:error:${problem}`,
      }),
    );
  jlog(c, now, { logger: "tls.obtain", msg: "obtaining certificate", identifier: domain });
  const ip = resolveName(w, domain).ip;
  if (!ip) return fail(`dns - DNS problem: NXDOMAIN looking up A for ${domain} - check that a DNS record exists for this domain`);
  if (ip !== host.publicIp) return fail(`connection - ${ip}: Timeout during connect (likely firewall problem)`);
  if (!reachable(w, c)) return fail(`connection - ${ip}: Timeout during connect (likely firewall problem)`);
  const recent = (acme.issued[domain] ?? []).filter((t) => now - t < WEEK);
  if (recent.length >= RATE_LIMIT) {
    return fail(`rateLimited - too many certificates (${RATE_LIMIT}) already issued for this exact set of identifiers in the last 168h0m0s, retry after ${new Date((recent[0] + WEEK) * 1000).toISOString().slice(0, 19)} UTC`);
  }
  acme.issued[domain] = [...recent, now];
  w.certs[domain] = { domain, issuer: "Let's Encrypt", issuedAt: now, store: dataStore(c) };
  jlog(c, now, { logger: "tls.obtain", msg: "certificate obtained successfully", identifier: domain, issuer: LE });
}

/** Every tick: keep certificates in sync with what each running Caddy is configured for. */
export function reconcileCerts(w: World, _from: number, to: number): void {
  for (const host of [w.hosts.vps]) {
    for (const c of Object.values(host.docker.containers)) {
      if (c.kind !== "caddy" || c.status !== "running" || !c.caddyConfig) continue;
      for (const d of publicDomains(c.caddyConfig)) {
        const cert = w.certs[d];
        if (cert && !certStillThere(host, cert.store, c)) delete w.certs[d];
        if (!w.certs[d]) tryIssue(w, host, c, d, to);
      }
    }
  }
}

registerReconciler("caddy-certs", reconcileCerts);
