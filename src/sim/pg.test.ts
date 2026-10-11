import { describe, expect, it } from "vitest";
import { produce } from "immer";
import { cancelPending, createShell, promptText, runScript, topFrame } from "./shell/run";
import { createDemoWorld, createWorld, rentVps } from "./worlds";
import { dir, file, getFile, put } from "./fs";
import { appToDb, traceHttp } from "./net";
import * as P from "./predicates";
import type { GoalCtx } from "./predicates";
import { dataVolume, ensureCluster, seedShop, SUPABASE_HOST, SUPABASE_PASSWORD } from "./pg/cluster";
import { supabaseDump } from "./pg/dump";
import type { Shell, World } from "./types";

const VPS = "203.0.113.10";
const PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIlaptopkeyfortests you@laptop";

/** End of World 5, more or less: Docker, deploy in the docker group, the laptop's key installed. */
function baseWorld(): World {
  return produce(createWorld(), (d) => {
    rentVps(d);
    const h = d.hosts.vps;
    h.users.deploy = { name: "deploy", uid: 1000, home: "/home/deploy", shell: "/bin/bash", password: "deploy-pw" };
    h.groups.deploy = { name: "deploy", gid: 1000, members: [] };
    h.groups.sudo.members.push("deploy");
    put(h, "/home/deploy", dir(0o750, "deploy"));
    put(h, "/home/deploy/.ssh", dir(0o700, "deploy"));
    put(h, "/home/deploy/.ssh/authorized_keys", file(PUB + "\n", 0o600, "deploy"));
    put(h, "/srv/crumb", dir(0o755, "deploy"));
    const l = d.hosts.laptop;
    put(l, "/home/you/.ssh", dir(0o700, "you"));
    put(l, "/home/you/.ssh/id_ed25519", file("-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n-----END OPENSSH PRIVATE KEY-----\n", 0o600, "you"));
    put(l, "/home/you/.ssh/id_ed25519.pub", file(PUB + "\n", 0o644, "you"));
    put(l, "/home/you/.ssh/known_hosts", file(`${VPS} ssh-ed25519 AAAAhostkey\n`, 0o644, "you"));
  });
}

const rootSh = (): Shell => createShell("t", { host: "vps", user: "root", cwd: "/srv/crumb", via: "console" });
const laptopSh = (id = "w1"): Shell => createShell(id, { host: "laptop", user: "you", cwd: "/home/you", via: "local" });

function run(lines: string[], w: World, sh: Shell = rootSh()) {
  const r = runScript(w, sh, lines);
  return { ...r, text: r.out.map((o) => o.text).join("\n") };
}

const g = (w: World, shells: Shell[] = []): GoalCtx => ({ world: w, shells, log: [] });

const COMPOSE = (ports = "") => `services:
  app:
    image: registry.gitlab.com/crumb/web:latest
    restart: unless-stopped
    env_file: .env
  db:
    image: postgres:17
    restart: unless-stopped
    env_file: .env
${ports}    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
`;
const LOCAL_PORT = `    ports:\n      - "127.0.0.1:5432:5432"\n`;
const ENV = "POSTGRES_USER=crumb\nPOSTGRES_PASSWORD=s3cret-pg\nPOSTGRES_DB=crumb\nDATABASE_URL=postgres://crumb:s3cret-pg@db:5432/crumb\n";

/** Docker installed, compose.yaml and .env written, `docker compose up -d` done. */
function crumbWorld(opts: { ports?: string; env?: string; seed?: boolean } = {}): World {
  let w = run(["curl -fsSL https://get.docker.com -o get-docker.sh", "sh get-docker.sh"], baseWorld()).world;
  w = produce(w, (d) => {
    const h = d.hosts.vps;
    h.groups.docker.members.push("deploy");
    put(h, "/srv/crumb/compose.yaml", file(COMPOSE(opts.ports), 0o644, "deploy"));
    put(h, "/srv/crumb/.env", file(opts.env ?? ENV, 0o600, "deploy"));
    put(h, "/srv/backups", dir(0o755, "root"));
  });
  w = run(["docker compose up -d", "sleep 20"], w).world;
  if (opts.seed) {
    w = produce(w, (d) => {
      const h = d.hosts.vps;
      seedShop(ensureCluster(dataVolume(h, h.docker.containers["crumb-db-1"])!.pg!), "crumb");
    });
  }
  return w;
}

describe("first start only", () => {
  it("POSTGRES_PASSWORD changes later do not change the role: the app gets password authentication failed", () => {
    let r = run([], crumbWorld());
    expect(P.appReachesDb("app")(g(r.world))).toBe(true);
    expect(P.pgRole("crumb")(g(r.world))).toBe(true);
    expect(P.pgDatabase("crumb")(g(r.world))).toBe(true);
    r = run(["sed -i 's/s3cret-pg/n3w-secret/g' .env", "docker compose up -d", "docker compose logs app"], r.world);
    expect(r.text).toContain('app-1  | error: password authentication failed for user "crumb"');
    expect(P.appReachesDb("app")(g(r.world))).toBe(false);
    expect(appToDb(r.world.hosts.vps, r.world.hosts.vps.docker.containers["crumb-app-1"]).note).toBe('password authentication failed for user "crumb"');
    // The fix: change the role's password to match.
    r = run([`docker compose exec db psql -U crumb -c "alter user crumb with password 'n3w-secret';"`], r.world);
    expect(r.text).toContain("ALTER ROLE");
    expect(P.appReachesDb("app")(g(r.world))).toBe(true);
  });

  it("17 data under postgres:18 does not start", () => {
    const w = produce(crumbWorld(), (d) => {
      const f = getFile(d.hosts.vps, "/srv/crumb/compose.yaml")!;
      f.content = f.content.replace("postgres:17", "postgres:18").replace("/var/lib/postgresql/data", "/var/lib/postgresql");
    });
    const r = run(["docker compose up -d", "docker compose logs db"], w);
    expect(r.text).toContain("FATAL:  database files are incompatible with server");
  });
});

describe("psql inside the container", () => {
  it("without -U it asks for role root", () => {
    const r = run(["docker compose exec db psql"], crumbWorld());
    expect(r.text).toContain('psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  role "root" does not exist');
  });

  it("an interactive session: \\l, \\dt, count, create and drop database", () => {
    let r = run(["docker compose exec db psql -U crumb"], crumbWorld());
    expect(r.text).toContain("psql (17.6 (Debian 17.6-1.pgdg130+1))");
    expect(r.text).toContain('Type "help" for help.');
    expect(promptText(r.world, r.shell)).toBe("crumb=# ");
    r = run(["\\l"], r.world, r.shell);
    expect(r.text).toContain("List of databases");
    expect(r.text).toMatch(/^ {3}Name {4}\| Owner \| Encoding \| Locale Provider \| {2}Collate {3}\| {3}Ctype {4}\| Locale \| ICU Rules \| Access privileges $/m);
    expect(r.text).toMatch(/^ crumb {5}\| crumb \| UTF8 {5}\| libc {12}\| en_US\.utf8 \| en_US\.utf8 \| {8}\| {11}\| $/m);
    expect(r.text).toContain(" template0 | crumb | UTF8     | libc            | en_US.utf8 | en_US.utf8 |        |           | =c/crumb         +");
    expect(r.text).toContain("(4 rows)");
    r = run(["\\dt"], r.world, r.shell);
    expect(r.text).toContain("Did not find any relations.");
    r = run(["select count(*) from orders;"], r.world, r.shell);
    expect(r.text).toContain('ERROR:  relation "orders" does not exist\nLINE 1: select count(*) from orders;\n                             ^');
    r = run(["select count(*)"], r.world, r.shell);
    expect(promptText(r.world, r.shell)).toBe("crumb-# ");
    r = run(["from orders;", "create database shop;", "drop database crumb;", "drop database shop;", "\\du", "\\conninfo"], r.world, r.shell);
    expect(r.text).toContain("CREATE DATABASE");
    expect(r.text).toContain("ERROR:  cannot drop the currently open database");
    expect(r.text).toContain("DROP DATABASE");
    expect(r.text).toContain(" crumb     | Superuser, Create role, Create DB, Replication, Bypass RLS");
    expect(r.text).toContain('You are connected to database "crumb" as user "crumb" via socket in "/var/run/postgresql" at port "5432".');
    r = run(["\\c postgres", "drop database crumb;", "hello there;", "\\q"], r.world, r.shell);
    expect(r.text).toContain('You are now connected to database "postgres" as user "crumb".');
    // The app is connected to crumb.
    expect(r.text).toContain('ERROR:  database "crumb" is being accessed by other users\nDETAIL:  There is 1 other session using the database.');
    expect(r.text).toContain('ERROR:  syntax error at or near "hello"');
    expect(r.shell.pending).toBeUndefined();
    expect(promptText(r.world, r.shell)).toBe("root@web-1:/srv/crumb# ");
  });

  it("counts restored tables, and docker exec needs -it for a session", () => {
    const w = crumbWorld({ seed: true });
    let r = run([`docker compose exec db psql -U crumb -d crumb -c "select count(*) from orders;"`, "docker compose exec db psql -U crumb -c '\\dt'"], w);
    expect(r.text).toContain(" count \n-------\n  1284\n(1 row)");
    expect(r.text).toContain(" public | orders   | table | crumb");
    r = run(["docker exec crumb-db-1 psql -U crumb"], w);
    expect(r.shell.pending).toBeUndefined();
    expect(r.text).toContain("docker exec needs -it");
    r = run(["docker exec -it crumb-db-1 psql -U crumb -d crumb"], w);
    expect(promptText(r.world, r.shell)).toBe("crumb=# ");
    r = run(["docker exec -it -u postgres crumb-db-1 psql"], w);
    expect(r.text).toContain('FATAL:  role "postgres" does not exist');
  });
});

describe("pg_dump and pg_restore", () => {
  it("dump on the host through exec -T, restore into a new database: row counts survive", () => {
    let r = run(["docker compose exec -T db pg_dump -U crumb -Fc crumb > /srv/backups/crumb.dump"], crumbWorld({ seed: true }));
    expect(getFile(r.world.hosts.vps, "/srv/backups/crumb.dump")?.content.startsWith("PGDMP")).toBe(true);
    expect(P.dumpFile("vps", "/srv/backups/crumb.dump")(g(r.world))).toBe(true);
    r = run(["docker compose exec db pg_restore -U crumb -d crumb_test < /srv/backups/crumb.dump"], r.world);
    expect(r.text).toContain("the input device is not a TTY");
    r = run(["docker compose exec -T db pg_restore -U crumb -d crumb_test < /srv/backups/crumb.dump"], r.world);
    expect(r.text).toContain('FATAL:  database "crumb_test" does not exist');
    r = run(["docker compose exec db createdb -U crumb crumb_test", "docker compose exec -T db pg_restore -U crumb -d crumb_test < /srv/backups/crumb.dump"], r.world);
    expect(r.lastCode).toBe(0);
    expect(P.pgDatabase("crumb_test")(g(r.world))).toBe(true);
    expect(P.pgTableRows("crumb_test", "orders", 1284)(g(r.world))).toBe(true);
    expect(P.pgTableRows("crumb_test", "users", 311)(g(r.world))).toBe(true);
    // Restoring again over the same tables collides.
    r = run(["docker compose exec -T db pg_restore -U crumb -d crumb_test < /srv/backups/crumb.dump"], r.world);
    expect(r.text).toContain('ERROR:  relation "orders" already exists');
    expect(r.text).toMatch(/pg_restore: warning: errors ignored on restore: \d+/);
  });

  it("plain dumps are SQL: psql restores them, pg_restore refuses", () => {
    let r = run(["docker compose exec -T db pg_dump -U crumb crumb > /srv/backups/crumb.sql"], crumbWorld({ seed: true }));
    const sql = getFile(r.world.hosts.vps, "/srv/backups/crumb.sql")!.content;
    expect(sql).toContain("CREATE TABLE public.orders (");
    expect(sql).toContain("COPY public.orders (id, user_id, total_cents, status, created_at) FROM stdin;");
    expect(P.dumpFile("vps", "/srv/backups/crumb.sql")(g(r.world))).toBe(true);
    r = run(["docker compose exec -T db pg_restore -U crumb -d crumb < /srv/backups/crumb.sql"], r.world);
    expect(r.text).toContain("pg_restore: error: input file appears to be a text format dump. Please use psql.");
    r = run(["docker compose exec db createdb -U crumb copy", "docker compose exec -T db psql -U crumb -d copy < /srv/backups/crumb.sql"], r.world);
    expect(r.text).toContain("CREATE TABLE");
    expect(r.text).toContain("COPY 1284");
    expect(P.pgTableRows("copy", "orders", 1284)(g(r.world))).toBe(true);
  });

  it("a Supabase dump: owner and grant errors without --no-owner --no-acl, but the data loads; clean with them", () => {
    const w = produce(crumbWorld(), (d) => {
      put(d.hosts.vps, "/srv/backups/supabase.dump", file(supabaseDump(), 0o644, "deploy"));
      put(d.hosts.vps, "/srv/backups/public.dump", file(supabaseDump({ publicOnly: true }), 0o644, "deploy"));
    });
    let r = run(["docker compose exec -T db pg_restore -U crumb -d crumb < /srv/backups/supabase.dump"], w);
    expect(r.text).toContain("pg_restore: while PROCESSING TOC:");
    expect(r.text).toContain('pg_restore: error: could not execute query: ERROR:  role "supabase_admin" does not exist\nCommand was: ALTER SCHEMA auth OWNER TO supabase_admin;');
    expect(r.text).toContain('ERROR:  extension "pg_graphql" is not available');
    expect(r.text).toMatch(/pg_restore: warning: errors ignored on restore: \d+/);
    expect(r.lastCode).toBe(1);
    expect(P.pgTableRows("crumb", "orders", 1284)(g(r.world))).toBe(true);

    r = run(["docker compose exec db createdb -U crumb shop", "docker compose exec -T db pg_restore -U crumb -d shop --no-owner --no-acl < /srv/backups/public.dump"], w);
    expect(r.text).not.toContain("error");
    expect(r.lastCode).toBe(0);
    expect(P.pgTableRows("shop", "orders", 1284)(g(r.world))).toBe(true);
    r = run([`docker compose exec db psql -U crumb -d shop -c "\\dt"`], r.world);
    expect(r.text).toContain(" public | products | table | crumb");

    // The whole database still drags in Supabase's own extensions.
    r = run(["docker compose exec db createdb -U crumb all", "docker compose exec -T db pg_restore -U crumb -d all -O -x < /srv/backups/supabase.dump"], w);
    expect(r.text).toContain('extension "supabase_vault" is not available');
    expect(r.text).not.toContain("does not exist");
  });

  it("host pg_dump 16 refuses a 17 server; host psql 16 connects with a warning", () => {
    let w = crumbWorld({ ports: LOCAL_PORT, seed: true });
    w = produce(w, (d) => {
      d.hosts.vps.packages["postgresql-client"] = { version: "16+257build1" };
    });
    let r = run(["PGPASSWORD=s3cret-pg pg_dump -h 127.0.0.1 -U crumb -Fc crumb > /srv/backups/x.dump"], w);
    expect(r.text).toContain("pg_dump: error: aborting because of server version mismatch\npg_dump: detail: server version: 17.6; pg_dump version: 16.4 (Ubuntu 16.4-0ubuntu0.24.04.2)");
    r = run(["psql -U crumb"], w);
    expect(r.text).toContain('psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: No such file or directory');
    r = run(["psql -h 127.0.0.1 -U crumb -d crumb"], w);
    expect(promptText(r.world, r.shell)).toBe("Password for user crumb: ");
    r = run(["wrong"], r.world, r.shell);
    expect(r.text).toContain('psql: error: connection to server at "127.0.0.1", port 5432 failed: FATAL:  password authentication failed for user "crumb"');
    r = run(["psql -h 127.0.0.1 -U crumb -d crumb", "s3cret-pg"], w);
    expect(r.text).toContain("psql (16.4 (Ubuntu 16.4-0ubuntu0.24.04.2), server 17.6 (Debian 17.6-1.pgdg130+1))");
    expect(r.text).toContain("WARNING: psql major version 16, server major version 17.");
    expect(promptText(r.world, r.shell)).toBe("crumb=# ");
    r = run(["psql -h db -U crumb"], w);
    expect(r.text).toContain('psql: error: could not translate host name "db" to address: Name or service not known');
  });
});

describe("ssh tunnels and remote commands", () => {
  function withClient(w: World): World {
    return produce(w, (d) => {
      d.hosts.laptop.packages["postgresql-client"] = { version: "16+257build1" };
    });
  }

  it("ssh -N -L keeps the window busy; psql on the laptop reaches the db published on 127.0.0.1", () => {
    const w = withClient(crumbWorld({ ports: LOCAL_PORT, seed: true }));
    const t = run(["ssh -N -L 5433:127.0.0.1:5432 deploy@203.0.113.10"], w, laptopSh("w2"));
    expect(t.shell.pending).toBeDefined();
    expect(promptText(t.world, t.shell)).toBe("");
    expect(t.world.tunnels).toEqual([{ laptopPort: 5433, remoteHost: "127.0.0.1", remotePort: 5432, user: "deploy", shellId: "w2", channel: 2 }]);
    expect(P.tunnelOpen(5433)(g(t.world, [laptopSh(), t.shell]))).toBe(true);
    expect(P.dbNotPublic(g(t.world))).toBe(true);
    let r = run([`PGPASSWORD=s3cret-pg psql -h 127.0.0.1 -p 5433 -U crumb -d crumb -c "select count(*) from orders;"`], t.world, laptopSh());
    expect(r.text).toContain("  1284\n(1 row)");
    r = run(["psql -h localhost -p 5433 -U crumb -d crumb", "s3cret-pg", "\\conninfo"], t.world, laptopSh());
    expect(r.text).toContain('You are connected to database "crumb" as user "crumb" on host "localhost" at port "5433".');
    // Ctrl+C closes it.
    const c = cancelPending(t.world, t.shell);
    expect(c.world.tunnels).toEqual([]);
    r = run(["psql -h 127.0.0.1 -p 5433 -U crumb"], c.world, laptopSh());
    expect(r.text).toContain('psql: error: connection to server at "127.0.0.1", port 5433 failed: Connection refused');
    expect(c.shell.pending).toBeUndefined();
  });

  it("the tunnel fails at the far end when nothing listens on the VPS's 127.0.0.1:5432", () => {
    const w = withClient(crumbWorld());
    const t = run(["ssh -N -L 5433:127.0.0.1:5432 deploy@203.0.113.10"], w, laptopSh("w2"));
    const r = run(["PGPASSWORD=s3cret-pg psql -h 127.0.0.1 -p 5433 -U crumb -d crumb"], t.world, laptopSh());
    expect(r.text).toContain('psql: error: connection to server at "127.0.0.1", port 5433 failed: server closed the connection unexpectedly\n\tThis probably means the server terminated abnormally\n\tbefore or while processing the request.');
    expect(r.world.tunnels?.[0].log).toEqual(["channel 2: open failed: connect failed: Connection refused"]);
    // The tunnel window shows it when you look (press Enter there), or when you close it.
    const seen = run([""], r.world, t.shell);
    expect(seen.text).toBe("channel 2: open failed: connect failed: Connection refused");
    expect(seen.shell.pending).toBeDefined();
  });

  it("a published 0.0.0.0:5432 is reachable from the internet", () => {
    const w = crumbWorld({ ports: `    ports:\n      - "5432:5432"\n` });
    expect(P.dbNotPublic(g(w))).toBe(false);
    expect(traceHttp(w, `http://${VPS}:5432`).ok).toBe(true);
  });

  it("ssh host 'cmd' runs one command on the server and comes back", () => {
    const w = crumbWorld();
    let r = run(["ssh deploy@203.0.113.10 'docker ps'"], w, laptopSh());
    expect(r.text).toMatch(/CONTAINER ID\s+IMAGE/);
    expect(r.text).toContain("crumb-db-1");
    expect(topFrame(r.shell).host).toBe("laptop");
    expect(r.shell.frames).toHaveLength(1);
    r = run([`ssh deploy@203.0.113.10 'cd /srv/crumb && docker compose exec db psql -U crumb -c "select 1"'`], w, laptopSh());
    expect(r.text).toContain("the input device is not a TTY");
    r = run([`ssh deploy@203.0.113.10 'cd /srv/crumb && docker compose exec -T db psql -U crumb -tAc "select version()"'`], w, laptopSh());
    expect(r.text).toContain("PostgreSQL 17.6 (Debian 17.6-1.pgdg130+1) on x86_64-pc-linux-gnu");
    // No keyboard over plain ssh: psql reads nothing and quits instead of opening a session.
    r = run(["ssh deploy@203.0.113.10 'cd /srv/crumb && docker compose exec -T db psql -U crumb'"], w, laptopSh());
    expect(r.shell.pending).toBeUndefined();
    expect(r.lastCode).toBe(0);
    r = run(["ssh deploy@203.0.113.10 'sudo systemctl restart ssh'"], w, laptopSh());
    expect(r.text).toContain("sudo: a terminal is required to read the password");
    r = run(["ssh deploy@203.0.113.10 'cd /srv/crumb && docker compose exec -T db pg_dump -U crumb -Fc crumb' > crumb.dump"], w, laptopSh());
    expect(P.dumpFile("laptop", "/home/you/crumb.dump")(g(r.world))).toBe(true);
  });
});

describe("the app's DATABASE_URL", () => {
  it("wrong password, missing database and sslmode=require", () => {
    const check = (url: string) => {
      const w = crumbWorld({ env: ENV.replace(/DATABASE_URL=.*/, `DATABASE_URL=${url}`) });
      return appToDb(w.hosts.vps, w.hosts.vps.docker.containers["crumb-app-1"]);
    };
    expect(check("postgres://crumb:nope@db:5432/crumb").note).toBe('password authentication failed for user "crumb"');
    expect(check("postgres://crumb:s3cret-pg@db:5432/shop").note).toBe('database "shop" does not exist');
    expect(check("postgres://crumb:s3cret-pg@db:5432/crumb?sslmode=require").note).toBe("The server does not support SSL connections");
    expect(check("postgres://crumb:s3cret-pg@db:5432/crumb").ok).toBe(true);
  });

  it("the World 0 demo still works end to end", () => {
    const w = createDemoWorld();
    expect(appToDb(w.hosts.vps, w.hosts.vps.docker.containers["crumb-app-1"]).ok).toBe(true);
    expect(traceHttp(w, "https://crumb.shop").ok).toBe(true);
  });
});

describe("Supabase from the laptop", () => {
  it("host pg_dump 16 works against Supabase's 15, and the dump restores through the tunnel", () => {
    const w = produce(crumbWorld({ ports: LOCAL_PORT }), (d) => {
      d.hosts.laptop.packages["postgresql-client"] = { version: "16+257build1" };
    });
    let r = run([`pg_dump "postgresql://postgres:${SUPABASE_PASSWORD}@${SUPABASE_HOST}:5432/postgres" -Fc -n public --no-owner --no-acl > supabase.dump`], w, laptopSh());
    expect(r.text).toBe("");
    expect(getFile(r.world.hosts.laptop, "/home/you/supabase.dump")?.content.startsWith("PGDMP")).toBe(true);
    const t = run(["ssh -N -L 5433:127.0.0.1:5432 deploy@203.0.113.10"], r.world, laptopSh("w2"));
    r = run(["PGPASSWORD=s3cret-pg pg_restore -h 127.0.0.1 -p 5433 -U crumb -d crumb --no-owner --no-acl supabase.dump"], t.world, laptopSh());
    expect(r.text).toBe("");
    expect(P.pgTableRows("crumb", "orders", 1284)(g(r.world))).toBe(true);
    expect(P.pgTableRows("crumb", "auth.users", 1)(g(r.world))).toBe(false);
  });
});
