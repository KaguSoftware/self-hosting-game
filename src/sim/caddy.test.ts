import { describe, expect, it } from "vitest";
import { produce } from "immer";
import { replay } from "@/content";
import { file, put } from "./fs";
import { traceHttp } from "./net";
import { createShell, runScript } from "./shell/run";
import type { Shell, World } from "./types";

const VARS = { deployPassword: "test-pass-1" };

const COMPOSE = (dataVolume = true) => `services:
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
${dataVolume ? "      - caddy_data:/data\n" : ""}  app:
    build: ./app
    env_file: .env
    restart: unless-stopped
  db:
    image: postgres:17
    env_file: .env
    restart: unless-stopped
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
${dataVolume ? "  caddy_data:\n" : ""}`;

const SITE = `crumb.shop, www.crumb.shop {\n\treverse_proxy app:3000\n}\n`;

function server(opts: { dataVolume?: boolean; caddyfile?: string } = {}): { w: World; sh: Shell } {
  const end = replay.levelEndWorld(replay.levelById("w5-08")!, VARS);
  const w = produce(end, (d) => {
    put(d.hosts.vps, "/srv/crumb/compose.yaml", file(COMPOSE(opts.dataVolume ?? true), 0o644, "deploy", "deploy"));
    put(d.hosts.vps, "/srv/crumb/Caddyfile", file(opts.caddyfile ?? SITE, 0o644, "deploy", "deploy"));
  });
  const sh = createShell("t", { host: "vps", user: "deploy", cwd: "/srv/crumb", via: "ssh", remote: "203.0.113.10" });
  return { w, sh };
}

function run(state: { w: World; sh: Shell }, lines: string[]) {
  const r = runScript(state.w, state.sh, lines);
  return { w: r.world, sh: r.shell, text: r.out.map((o) => o.text).join("\n") };
}

describe("caddy and https", () => {
  it("gets certificates once DNS, ports and a site block are in place", () => {
    const r = run(server(), ["docker compose up -d", "sleep 5", "docker compose logs caddy"]);
    expect(r.w.certs["crumb.shop"]?.issuer).toBe("Let's Encrypt");
    expect(r.w.certs["www.crumb.shop"]).toBeDefined();
    expect(r.text).toContain("certificate obtained successfully");
    expect(traceHttp(r.w, "https://crumb.shop").ok).toBe(true);
    expect(traceHttp(r.w, "http://crumb.shop").status).toBe(308);
  });

  it("only uses a new Caddyfile after a reload, and the reload needs -w /etc/caddy", () => {
    let r = run(server(), ["docker compose up -d", "sleep 5"]);
    r = { ...r, w: produce(r.w, (d) => void put(d.hosts.vps, "/srv/crumb/Caddyfile", file(SITE.replace("app:3000", "app:8080"), 0o644, "deploy", "deploy"))) };
    expect(traceHttp(r.w, "https://crumb.shop").ok).toBe(true);
    const bad = run(r, ["docker compose exec caddy caddy reload"]);
    expect(bad.text).toContain("Error: no config file to load");
    const good = run(r, ["docker compose exec -w /etc/caddy caddy caddy reload"]);
    const t = traceHttp(good.w, "https://crumb.shop");
    expect(t.status).toBe(502);
    expect(t.failedAt).toBe("app");
  });

  it("keeps the old config when a reload has a typo", () => {
    let r = run(server(), ["docker compose up -d", "sleep 5"]);
    r = { ...r, w: produce(r.w, (d) => void put(d.hosts.vps, "/srv/crumb/Caddyfile", file(SITE.replace("reverse_proxy", "reverse_prxy"), 0o644, "deploy", "deploy"))) };
    const after = run(r, ["docker compose exec -w /etc/caddy caddy caddy reload"]);
    expect(after.text).toContain("Error: adapting config using caddyfile: Caddyfile:2: unrecognized directive: reverse_prxy");
    expect(traceHttp(after.w, "https://crumb.shop").ok).toBe(true);
  });

  it("cannot get a certificate for a name with no DNS record", () => {
    const r = run(server({ caddyfile: SITE + `shop.crumb.shop {\n\treverse_proxy app:3000\n}\n` }), ["docker compose up -d", "sleep 5", "docker compose logs caddy"]);
    expect(r.w.certs["shop.crumb.shop"]).toBeUndefined();
    expect(r.text).toContain("NXDOMAIN looking up A for shop.crumb.shop");
    expect(traceHttp(r.w, "https://crumb.shop").ok).toBe(true);
  });

  it("times out when the provider firewall blocks the web ports", () => {
    const s = server();
    const w = produce(s.w, (d) => {
      d.provider.firewall.rules = d.provider.firewall.rules.filter((x) => x.port === 22);
    });
    const r = run({ ...s, w }, ["docker compose up -d", "sleep 5", "docker compose logs caddy"]);
    expect(r.w.certs["crumb.shop"]).toBeUndefined();
    expect(r.text).toContain("Timeout during connect (likely firewall problem)");
  });

  it("without caddy_data, every recreate asks for new certificates until the rate limit", () => {
    let r = run(server({ dataVolume: false }), ["docker compose up -d", "sleep 5"]);
    for (let i = 0; i < 5; i++) r = run(r, ["docker compose up -d --force-recreate caddy", "sleep 70"]);
    const logs = run(r, ["docker compose logs caddy"]).text;
    expect(logs).toContain("rateLimited");
    expect(r.w.certs["crumb.shop"]).toBeUndefined();
  });

  it("with caddy_data, a recreate keeps the certificate", () => {
    let r = run(server(), ["docker compose up -d", "sleep 5"]);
    const first = r.w.certs["crumb.shop"]?.issuedAt;
    r = run(r, ["docker compose up -d --force-recreate caddy", "sleep 5"]);
    expect(r.w.certs["crumb.shop"]?.issuedAt).toBe(first);
  });
});
