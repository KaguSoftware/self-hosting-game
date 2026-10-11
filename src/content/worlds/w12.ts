import * as P from "@/sim/predicates";
import type { Check } from "@/sim/predicates";
import { DOMAIN, ROOT_PASSWORD, VPS_IP } from "@/sim/constants";
import { getDir, getFile } from "@/sim/fs";
import { createGitLab, deployTokenValue, liveRevision } from "@/sim/gitlab";
import { rentVps, SSHD_CONFIG } from "@/sim/worlds";
import type { MapControl, MissionMove, WorldDef } from "../schema";
import { CI_FULL } from "./w9";

const IP = VPS_IP;
const SUPABASE = "postgres://postgres:kX9-supa-crumb@db.abcdefghijklmnop.supabase.co:5432/postgres";
const TOKEN = deployTokenValue("crumb-pull", 1);
const CI_PASSWORD = "temp-ci-pass-7";

const SSHD_SOLUTION = SSHD_CONFIG.replace("PermitRootLogin yes", "PermitRootLogin no").replace("#PasswordAuthentication yes", "PasswordAuthentication no");

const LOGGING = `    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: "3"
`;

const COMPOSE = `services:
  caddy:
    image: caddy:2
    restart: unless-stopped
${LOGGING}    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
  app:
    image: registry.gitlab.com/crumb/web:\${APP_TAG:-latest}
    env_file: .env
    restart: unless-stopped
${LOGGING}    depends_on:
      db:
        condition: service_healthy
  db:
    image: postgres:17
    env_file: .env
    restart: unless-stopped
${LOGGING}    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U crumb -d crumb"]
      interval: 5s
      retries: 5
    ports:
      - "127.0.0.1:5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
  caddy_data:
`;

const CADDYFILE = `${DOMAIN}, www.${DOMAIN} {
\treverse_proxy app:3000
}
`;

const ENV = `POSTGRES_USER=crumb
POSTGRES_PASSWORD=s3cret-pg
POSTGRES_DB=crumb
AUTH_SECRET=7f3c9a1e5b2d8f4a6c0e9b7d3f1a5c8e
DATABASE_URL=postgres://crumb:s3cret-pg@db:5432/crumb
`;

const BACKUP = `#!/bin/sh
set -e
cd /srv/crumb
docker compose exec -T db pg_dump -U crumb -Fc crumb > /home/deploy/backups/crumb-$(date +%F).dump
rclone copy /home/deploy/backups offsite:crumb-backups
`;

const RCLONE = "[offsite]\ntype = s3\nprovider = Other\nendpoint = https://s3.example-storage.eu\naccess_key_id = AKEXAMPLE7Q2\nsecret_access_key = example-secret-not-real\n";

// ---------- checks ----------

const running = (svc: string) => P.containerRunning(svc);
const onlyCaddyFacesInternet: Check = (g) =>
  Object.values(g.world.hosts.vps.docker.containers).every((c) => c.ports.every((p) => p.hostIp === "127.0.0.1" || c.service === "caddy"));
const liveIsHead: Check = (g) => !!g.world.gitlab && liveRevision(g.world) === g.world.gitlab.branches.main;
const cronBackup: Check = (g) => /^[^#].*backup\.sh/m.test(getFile(g.world.hosts.vps, "/var/spool/cron/crontabs/deploy")?.content ?? "");
const backupExists: Check = (g) =>
  Object.entries(getDir(g.world.hosts.vps, "/home/deploy/backups")?.children ?? {}).some(([n, f]) => n.endsWith(".dump") && f.type === "file" && f.content.startsWith("PGDMP"));
const offsite: Check = (g) => Object.entries(g.world.storage?.buckets ?? {}).some(([k, b]) => k.startsWith("offsite:") && Object.keys(b).some((n) => n.endsWith(".dump")));
const logsCapped: Check = (g) => {
  const cs = Object.values(g.world.hosts.vps.docker.containers).filter((c) => c.project === "crumb" && c.status === "running");
  return cs.length >= 3 && cs.every((c) => !!c.logging?.options?.["max-size"]);
};

// ---------- the dashboard ----------

const c = (node: string, label: string, on: MapControl["on"], off: MapControl["off"]): MapControl => ({ node, label, on, off });
const CONTROLS: MapControl[] = [
  c("dns", `A ${IP}`, { type: "dnsA", name: DOMAIN, value: IP }, { type: "dnsA", name: DOMAIN, value: null }),
  c("dns", "www CNAME", { type: "dnsCname", name: `www.${DOMAIN}`, value: DOMAIN }, { type: "dnsCname", name: `www.${DOMAIN}`, value: null }),
  c("pfw", "Firewall on", { type: "pfw", enabled: true }, { type: "pfw", enabled: false }),
  ...[22, 80, 443, 5432, 8080].map((port) => c("pfw", `Port ${port}`, { type: "pfwRule", port, on: true }, { type: "pfwRule", port, on: false })),
  c("gitlab", "Laptop SSH key", { type: "userKey", on: true }, { type: "userKey", on: false }),
  c(
    "gitlab",
    "SSH_KEY: File + Protected",
    { type: "ciVar", key: "SSH_KEY", value: "", varType: "file", protected: true, fromFile: { host: "laptop", path: "/home/you/.ssh/crumb_ci" } },
    { type: "ciVar", key: "SSH_KEY", value: null },
  ),
  c("gitlab", "Deploy token", { type: "deployToken", name: "crumb-pull", on: true }, { type: "deployToken", name: "crumb-pull", on: false }),
  c("gitlab", "Runner online", { type: "runner", id: 1, online: true }, { type: "runner", id: 1, online: false }),
];

// ---------- one full solution (never shown, the test replays it) ----------

const PW = "{{deployPassword}}";
const SOLUTION: MissionMove[] = [
  { actions: [{ type: "dnsA", name: DOMAIN, value: IP }, { type: "dnsCname", name: `www.${DOMAIN}`, value: DOMAIN }] },
  { actions: [22, 80, 443].map((port) => ({ type: "pfwRule" as const, port, on: true })) },
  { actions: [{ type: "pfw", enabled: true }] },
  // Keys on the laptop, first login as root, a sudo user
  { run: ["ssh-keygen -t ed25519", "", "", "", 'ssh-keygen -t ed25519 -f /home/you/.ssh/crumb_ci -N "" -C ci@crumb'] },
  { run: [`ssh root@${IP}`, "yes", ROOT_PASSWORD, "adduser deploy", PW, PW, "usermod -aG sudo deploy", "exit"] },
  { run: [`ssh-copy-id deploy@${IP}`, PW, `ssh deploy@${IP}`] },
  // Updates and the firewall
  { run: ["sudo apt update", PW, "sudo apt upgrade -y", "sudo ufw allow OpenSSH", "sudo ufw allow 80,443/tcp", "sudo ufw enable", "y"] },
  // Docker, the ci user (key installed while passwords still work), then lock the doors
  { run: ["curl -fsSL https://get.docker.com -o get-docker.sh", "sudo sh get-docker.sh", "sudo usermod -aG docker deploy", "sudo useradd -m -s /bin/bash -G docker ci", "sudo passwd ci", CI_PASSWORD, CI_PASSWORD, "exit"] },
  { run: [`ssh-copy-id -i /home/you/.ssh/crumb_ci.pub ci@${IP}`, CI_PASSWORD] },
  { config: { host: "vps", path: "/etc/ssh/sshd_config", content: SSHD_SOLUTION } },
  { run: [`ssh deploy@${IP}`, "sudo rm /etc/ssh/sshd_config.d/50-cloud-init.conf", PW, "sudo systemctl restart ssh", "sudo passwd -l ci"] },
  // The shop's files
  { run: ["sudo mkdir -p /srv/crumb /home/deploy/backups /home/deploy/.config/rclone", "sudo chown -R deploy:deploy /srv/crumb /home/deploy/backups /home/deploy/.config"] },
  { config: { host: "vps", path: "/srv/crumb/compose.yaml", content: COMPOSE } },
  { config: { host: "vps", path: "/srv/crumb/Caddyfile", content: CADDYFILE } },
  { config: { host: "vps", path: "/srv/crumb/.env", content: ENV } },
  { config: { host: "vps", path: "/home/deploy/backup.sh", content: BACKUP } },
  { config: { host: "vps", path: "/home/deploy/.config/rclone/rclone.conf", content: RCLONE } },
  { run: ["sudo chown deploy:docker /srv/crumb/.env", "sudo chmod 640 /srv/crumb/.env", "chmod +x /home/deploy/backup.sh", "exit"] },
  // GitLab: key, secrets, token, then registry logins on web-1 (relogin so the docker group counts)
  {
    actions: [
      { type: "userKey", on: true },
      { type: "ciVar", key: "SSH_KEY", value: "", varType: "file", protected: true, fromFile: { host: "laptop", path: "/home/you/.ssh/crumb_ci" } },
      { type: "deployToken", name: "crumb-pull", on: true },
    ],
  },
  { run: [`ssh -i /home/you/.ssh/crumb_ci ci@${IP}`, `docker login registry.gitlab.com -u gitlab+deploy-token-1 -p ${TOKEN}`, "exit"] },
  { run: [`ssh deploy@${IP}`, `docker login registry.gitlab.com -u gitlab+deploy-token-1 -p ${TOKEN}`, "exit"] },
  // Push: test, build, deploy
  { run: ["cd ~/code/crumb", 'echo "// go live" >> lib/cart.ts', "git add lib/cart.ts", 'git commit -m "Go live"', "git push", "sleep 240"] },
  // Start the rest, then move the data in through a tunnel
  { run: [`ssh deploy@${IP}`, "cd /srv/crumb", "docker compose up -d", "sleep 30", "exit"] },
  { run: [`ssh -N -L 5433:127.0.0.1:5432 deploy@${IP}`], shell: 1 },
  { run: [`pg_dump -Fc -n public "${SUPABASE}" -f /home/you/supabase.dump`, "pg_restore --no-owner --no-acl -h 127.0.0.1 -p 5433 -U crumb -d crumb /home/you/supabase.dump", "s3cret-pg"] },
  // Backups: rclone, a first run, cron at 03:15, skip to the morning
  { run: [`ssh deploy@${IP}`, "sudo apt install -y rclone", PW, "/home/deploy/backup.sh", "echo '15 3 * * * /home/deploy/backup.sh' | crontab -", "sleep 20h"] },
];

export const world12: WorldDef = {
  id: 12,
  title: "Final mission",
  tagline: "Zero to deployed",
  cheatSheet: [
    { cmd: "Access", what: "a sudo user with your key; no root login, no passwords (check sshd_config.d)" },
    { cmd: "Network", what: "DNS for both names; ufw and the provider firewall both allow only 22, 80, 443" },
    { cmd: "Docker", what: "caddy, app and db, restart unless-stopped, db healthy, only Caddy faces the internet" },
    { cmd: "HTTPS", what: "certificates for both names, https://crumb.shop answers" },
    { cmd: "Data, backups, logs, CI", what: "the stars: Supabase data in, nightly backup offsite, logs capped, deploy on push" },
  ],
  levels: [
    {
      id: "w12-01",
      world: 12,
      title: "Zero to deployed",
      base: "fresh",
      start: "laptop",
      setup: (w) => {
        // A fresh VPS (plan S) is rented. The code is on GitLab with a full pipeline. The data is still in Supabase.
        rentVps(w, "S");
        createGitLab(w, { ci: CI_FULL });
        w.hosts.laptop.packages["postgresql-client"] = { version: "16+257build1" };
      },
      steps: [
        {
          id: "w12-01-a",
          mission: "A brand new client. Take crumb.shop from nothing to a safe, live shop. Everything you need, you have learned.",
          task: {
            kind: "mission",
            brief: [
              `A fresh Ubuntu VPS, web-1 at ${IP}. root's password: ${ROOT_PASSWORD}.`,
              "The code is on GitLab (crumb/web, cloned in ~/code/crumb) with a test, build and deploy pipeline. CI should deploy as a user called ci, with the key ~/.ssh/crumb_ci.",
              `The data is in Supabase: ${SUPABASE}`,
              "Offsite storage: an rclone remote named offsite, type s3, provider Other, endpoint https://s3.example-storage.eu, key AKEXAMPLE7Q2, secret example-secret-not-real.",
            ],
            goals: [
              { area: "Access", core: true, describe: "deploy exists and may use sudo", check: P.all(P.userExists("deploy"), P.inGroup("deploy", "sudo")) },
              { area: "Access", core: true, describe: "deploy logs in with your key", check: P.keyLoginWorks("deploy") },
              { area: "Access", core: true, describe: "root cannot log in over SSH", check: P.sshdRunning("permitrootlogin", "no") },
              { area: "Access", core: true, describe: "Passwords are off for SSH", check: P.sshdRunning("passwordauthentication", "no") },
              { area: "Network", core: true, describe: "crumb.shop and www point at web-1", check: P.all(P.dnsResolves(DOMAIN, IP), P.dnsResolves(`www.${DOMAIN}`, IP)) },
              { area: "Network", core: true, describe: "ufw allows only 22, 80 and 443", check: P.ufwOnly([22, 80, 443]) },
              { area: "Network", core: true, describe: "The provider firewall allows only 22, 80 and 443", check: P.providerOnly([22, 80, 443]) },
              { area: "Docker", core: true, describe: "caddy, app and db run, db is healthy", check: P.all(running("caddy"), running("app"), P.containerHealthy("db")) },
              {
                area: "Docker",
                core: true,
                describe: "Every service restarts unless stopped",
                check: P.all(P.restartPolicy("caddy", "unless-stopped"), P.restartPolicy("app", "unless-stopped"), P.restartPolicy("db", "unless-stopped")),
              },
              { area: "Docker", core: true, describe: "Only Caddy faces the internet", check: P.all(running("caddy"), onlyCaddyFacesInternet, P.dbNotPublic) },
              { area: "HTTPS", core: true, describe: "Certificates for both names", check: P.all(P.certIssued(DOMAIN), P.certIssued(`www.${DOMAIN}`)) },
              { area: "HTTPS", core: true, describe: "https://crumb.shop answers", check: P.traceOk(`https://${DOMAIN}`) },
              { area: "Data", describe: "The Supabase orders are in your database", check: P.pgTableRows("crumb", "orders", 1000) },
              { area: "Backups", describe: "A cron job runs the backup every night", check: cronBackup },
              { area: "Backups", describe: "A backup file exists", check: backupExists },
              { area: "Backups", describe: "A copy sits offsite", check: offsite },
              { area: "Operations", describe: "Every service's logs are capped", check: logsCapped },
              { area: "CI/CD", describe: "The deploy job passed", check: P.jobStatus("deploy", "success") },
              { area: "CI/CD", describe: "The live shop runs the latest commit", check: liveIsHead },
            ],
            controls: CONTROLS,
            solution: SOLUTION,
            console: true,
          },
          tags: ["final"],
        },
      ],
    },
  ],
};
