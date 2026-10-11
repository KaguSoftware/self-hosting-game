import { getDir, getFile, put } from "@/sim/fs";
import * as P from "@/sim/predicates";
import { DOMAIN, VPS_IP, WRONG_IP } from "@/sim/constants";
import { runDetached } from "@/sim/shell/run";
import { advance } from "@/sim/tick";
import { liveRevision, seedRegistry } from "@/sim/gitlab";
import type { Frame } from "@/sim/types";

/** deploy on web-1, in the shop's folder, as a fresh login (so the docker group counts). */
const DEPLOY_SHOP: Frame = { host: "vps", user: "deploy", cwd: "/srv/crumb", via: "ssh", remote: VPS_IP, loginGroups: ["deploy", "sudo", "docker"] };
import type { Incident } from "./schema";

const IP = "203.0.113.10";

export const INCIDENTS: Incident[] = [
  {
    id: "publickey",
    title: "Permission denied (publickey)",
    client: {
      name: "Maya, your teammate",
      message:
        "Can't SSH in anymore: Permission denied (publickey). Deploys are stuck! Only thing I did today was run a script that 'shares' home folders with the team.",
    },
    after: "w3-06",
    start: "laptop",
    breakIt: (w) => {
      const vps = w.hosts.vps;
      const sshDir = getDir(vps, "/home/deploy/.ssh");
      const ak = getFile(vps, "/home/deploy/.ssh/authorized_keys");
      if (sshDir) sshDir.mode = 0o775;
      if (ak) ak.mode = 0o664;
    },
    goals: [{ describe: "deploy can log in with the key again", check: P.keyLoginWorks("deploy") }],
    hints: [
      "Passwords are off and root login is off. You need another way in: the provider console.",
      "In the console: journalctl -u ssh -n 20. Then fix the modes: .ssh needs 700, authorized_keys needs 600.",
    ],
    fastestPath: [
      `ssh -v deploy@${IP}   → the key is offered and refused`,
      "Open the provider console (a root shell that does not need SSH)",
      "journalctl -u ssh -n 20   → bad ownership or modes",
      "chmod 700 /home/deploy/.ssh",
      "chmod 600 /home/deploy/.ssh/authorized_keys",
    ],
    fix: ["chmod 700 /home/deploy/.ssh", "chmod 600 /home/deploy/.ssh/authorized_keys"],
    fixShell: 1,
    debrief: [
      "sshd ignores keys if the .ssh folder or authorized_keys can be written by others.",
      "Your screen only says Permission denied. The reason is in the server log.",
      "Locked out of SSH? The provider's web console is the back door.",
    ],
    timeLimit: 300,
    console: true,
    sshUser: "deploy",
  },
];

// ---------- World 4 ----------
INCIDENTS.push(
  {
    id: "dns-wrong-a",
    oncall: { layer: "dns", conflicts: ["cert-new-domain"] },
    title: "The shop vanished",
    client: {
      name: "Riya, who runs the shop",
      message: "I fixed our email settings in the DNS panel last night. Now people say crumb.shop and www both time out!",
    },
    after: "w4-06",
    start: "laptop",
    breakIt: (w) => {
      w.dns = w.dns.filter((r) => !(r.name === DOMAIN && r.type === "A"));
      w.dns.push({ name: DOMAIN, type: "A", value: WRONG_IP, ttl: 3600 });
    },
    goals: [
      { describe: "crumb.shop points at web-1 again", check: P.dnsResolves(DOMAIN, VPS_IP) },
      { describe: "www.crumb.shop reaches web-1 too", check: P.dnsResolves("www.crumb.shop", VPS_IP) },
    ],
    hints: [
      "Ask DNS what the world sees: dig crumb.shop +short. Compare it with web-1's IP.",
      `In the dashboard, switch crumb.shop's A record back to ${VPS_IP}.`,
    ],
    fastestPath: [
      "dig crumb.shop +short   → 198.51.100.7, not web-1",
      `DNS panel: point the A record back to ${VPS_IP}`,
      `dig crumb.shop +short   → ${VPS_IP}`,
    ],
    fix: ["dig crumb.shop +short"],
    fixMap: [{ type: "dnsA", name: DOMAIN, value: VPS_IP }],
    controls: [
      { node: "dns", label: `A ${VPS_IP}`, on: { type: "dnsA", name: DOMAIN, value: VPS_IP }, off: { type: "dnsA", name: DOMAIN, value: null } },
      { node: "dns", label: `A ${WRONG_IP}`, on: { type: "dnsA", name: DOMAIN, value: WRONG_IP, ttl: 3600 }, off: { type: "dnsA", name: DOMAIN, value: null } },
    ],
    debrief: [
      "dig shows what the world sees, not what you meant to set.",
      "www came back by itself because it is a CNAME that follows crumb.shop.",
      "Some visitors keep the wrong answer until its TTL runs out.",
    ],
    timeLimit: 240,
  },
  {
    id: "pfw-blocks-443",
    oncall: { layer: "firewall" },
    title: "443 times out",
    client: {
      name: "Your uptime checker",
      message: "ALERT: crumb.shop port 443 timed out. Port 80 answers 'connection refused' as usual. Nobody logged in to web-1, but someone was in the provider dashboard.",
    },
    after: "w4-06",
    start: "laptop",
    breakIt: (w) => {
      w.provider.firewall.rules = w.provider.firewall.rules.filter((r) => r.port !== 443);
    },
    goals: [
      { describe: "The provider firewall is still on", check: P.pfwEnabled },
      { describe: "22, 80 and 443 are open in it", check: P.all(P.providerOpen(22), P.providerOpen(80), P.providerOpen(443)) },
    ],
    hints: [
      "A timeout means something dropped the visitor. ufw on web-1 has not changed. What else sits in front?",
      "In the provider dashboard, turn port 443 back on.",
    ],
    fastestPath: [
      "curl -v https://crumb.shop   → timeout on 443",
      "curl http://crumb.shop   → refused on 80, so web-1 is reachable",
      "sudo ufw status on web-1   → 443 is allowed",
      "Provider dashboard: 443 is missing. Turn it back on.",
    ],
    fix: ["curl -v https://crumb.shop"],
    fixMap: [{ type: "pfwRule", port: 443, on: true }],
    controls: [
      { node: "pfw", label: "Firewall", on: { type: "pfw", enabled: true }, off: { type: "pfw", enabled: false } },
      { node: "pfw", label: "22", on: { type: "pfwRule", port: 22, on: true }, off: { type: "pfwRule", port: 22, on: false } },
      { node: "pfw", label: "80", on: { type: "pfwRule", port: 80, on: true }, off: { type: "pfwRule", port: 80, on: false } },
      { node: "pfw", label: "443", on: { type: "pfwRule", port: 443, on: true }, off: { type: "pfwRule", port: 443, on: false } },
    ],
    debrief: [
      "A timeout is a firewall. Refused is an empty port.",
      "Check both firewalls: the provider's and ufw.",
      "Never fix it by switching a firewall off.",
    ],
    timeLimit: 240,
  },
);

// ---------- World 5 ----------
INCIDENTS.push(
  {
    id: "crash-loop-env",
    oncall: { layer: "app" },
    title: "The app keeps restarting",
    client: {
      name: "Sam, your teammate",
      message: "I cleaned up the .env on web-1 last night, removed some old lines. Now the shop is down and docker ps says Restarting over and over?",
    },
    after: "w5-07",
    start: "vps-deploy",
    breakIt: (w) => {
      const env = getFile(w.hosts.vps, "/srv/crumb/.env");
      if (env) env.content = env.content.replace(/^AUTH_SECRET=.*\n/m, "");
      runDetached(w, DEPLOY_SHOP, "docker compose up -d");
      advance(w, w.clock + 40);
    },
    goals: [
      { describe: "The app container stays up", check: P.containerRunning("app") },
      { describe: "The app reaches the database", check: P.appReachesDb("app") },
    ],
    hints: [
      "Restarting over and over means it crashes right at start. The reason is in its logs: docker compose logs --tail 20 app",
      "The log says AUTH_SECRET is not set. Add it back to .env, then docker compose up -d (restart keeps the old settings).",
    ],
    fastestPath: [
      "cd /srv/crumb; docker compose ps   → app is Restarting",
      "docker compose logs --tail 20 app   → AUTH_SECRET is not set",
      "echo 'AUTH_SECRET=long-random-value' >> .env",
      "docker compose up -d   → app recreated with the setting",
    ],
    fix: ["cd /srv/crumb", "echo 'AUTH_SECRET=long-random-value' >> .env", "docker compose up -d"],
    debrief: [
      "Restarting over and over means it crashes on start.",
      "The reason is in the first lines of its logs.",
      "Changed .env? docker compose up -d recreates the container. restart does not.",
    ],
    timeLimit: 300,
  },
  {
    id: "db-localhost",
    oncall: { layer: "db" },
    title: "Every order fails",
    client: {
      name: "Riya, who runs the shop",
      message: "The shop loads but every order fails! Sam says he 'copied the working .env from his laptop' this morning.",
    },
    after: "w5-07",
    start: "vps-deploy",
    breakIt: (w) => {
      runDetached(w, DEPLOY_SHOP, "sed -i 's/@db:/@localhost:/' .env");
      runDetached(w, DEPLOY_SHOP, "docker compose up -d");
      advance(w, w.clock + 20);
    },
    goals: [{ describe: "The app reaches the database", check: P.appReachesDb("app") }],
    hints: [
      "Read the app's log: docker compose logs --tail 20 app. Which address does it try?",
      "On a laptop the database is at localhost. In compose it is at db. Fix DATABASE_URL in .env, then docker compose up -d.",
    ],
    fastestPath: [
      "cd /srv/crumb; docker compose logs --tail 20 app   → ECONNREFUSED 127.0.0.1:5432",
      "grep DATABASE_URL .env   → @localhost:5432",
      "sed -i 's/@localhost:/@db:/' .env",
      "docker compose up -d",
    ],
    fix: ["cd /srv/crumb", "sed -i 's/@localhost:/@db:/' .env", "docker compose up -d"],
    debrief: [
      "Inside a container, localhost is that container.",
      "Use the service name: db.",
      "After editing .env, docker compose up -d recreates the container.",
    ],
    timeLimit: 300,
  },
);

// ---------- World 6 ----------
const HTTPS = "https://crumb.shop";
const reloadCaddy = (w: Parameters<Incident["breakIt"]>[0]) =>
  runDetached(w, DEPLOY_SHOP, "docker compose exec -T -w /etc/caddy caddy caddy reload");

INCIDENTS.push(
  {
    id: "caddy-typo",
    oncall: { layer: "proxy" },
    title: "Your connection is not private",
    client: {
      name: "Riya, who runs the shop",
      message: "Customers get a scary browser error on crumb.shop! Sam says he only 'cleaned up the Caddyfile' and reloaded it.",
    },
    after: "w6-05",
    start: "vps-deploy",
    breakIt: (w) => {
      const f = getFile(w.hosts.vps, "/srv/crumb/Caddyfile");
      if (f) f.content = f.content.replace("crumb.shop, www", "crumb.shp, www");
      reloadCaddy(w);
    },
    goals: [{ describe: "https://crumb.shop answers again", check: P.traceOk(HTTPS) }],
    hints: [
      "curl -I https://crumb.shop gives a TLS error: Caddy has no site for that name. Read the Caddyfile closely.",
      "The first name is misspelled. sed -i 's/crumb.shp/crumb.shop/' Caddyfile, then reload Caddy with -w /etc/caddy.",
    ],
    fastestPath: [
      "curl -I https://crumb.shop   → tlsv1 alert internal error",
      "cat /srv/crumb/Caddyfile   → crumb.shp, www.crumb.shop {",
      "sed -i 's/crumb.shp/crumb.shop/' Caddyfile",
      "docker compose exec -w /etc/caddy caddy caddy reload",
    ],
    fix: ["cd /srv/crumb", "sed -i 's/crumb.shp/crumb.shop/' Caddyfile", "docker compose exec -w /etc/caddy caddy caddy reload"],
    debrief: [
      "No site block for a name means no certificate for it, so browsers refuse.",
      "A typo in a name is still valid Caddyfile, so reload does not complain.",
      "Read the file you changed first.",
    ],
    timeLimit: 300,
    url: HTTPS,
  },
  {
    id: "cert-new-domain",
    oncall: { layer: "proxy", conflicts: ["dns-wrong-a"] },
    title: "The new address is not secure",
    client: {
      name: "Riya, who runs the shop",
      message: "We added shop.crumb.shop for the new storefront. Sam put it in the Caddyfile and reloaded, but browsers say the connection is not secure!",
    },
    after: "w6-05",
    start: "vps-deploy",
    breakIt: (w) => {
      const f = getFile(w.hosts.vps, "/srv/crumb/Caddyfile");
      if (f) f.content += "\nshop.crumb.shop {\n\treverse_proxy app:3000\n}\n";
      reloadCaddy(w);
      advance(w, w.clock + 10);
    },
    goals: [
      { describe: "shop.crumb.shop has a certificate", check: P.certIssued("shop.crumb.shop") },
      { describe: "https://shop.crumb.shop answers", check: P.traceOk("https://shop.crumb.shop") },
    ],
    hints: [
      "docker compose logs caddy shows why there is no certificate. Then ask DNS about the new name with dig.",
      "There is no DNS record for shop.crumb.shop. Add one in the dashboard, then reload Caddy so it tries again.",
    ],
    fastestPath: [
      "docker compose logs --tail 5 caddy   → NXDOMAIN looking up A for shop.crumb.shop",
      "dig shop.crumb.shop +short   → nothing",
      "DNS panel: shop CNAME crumb.shop",
      "docker compose exec -w /etc/caddy caddy caddy reload   → certificate obtained successfully",
    ],
    fix: ["cd /srv/crumb", "docker compose exec -w /etc/caddy caddy caddy reload", "docker compose logs --tail 5 caddy"],
    fixMap: [{ type: "dnsCname", name: "shop.crumb.shop", value: DOMAIN }],
    controls: [
      { node: "dns", label: "shop CNAME crumb.shop", on: { type: "dnsCname", name: "shop.crumb.shop", value: DOMAIN }, off: { type: "dnsCname", name: "shop.crumb.shop", value: null } },
      { node: "dns", label: `shop A ${WRONG_IP}`, on: { type: "dnsA", name: "shop.crumb.shop", value: WRONG_IP }, off: { type: "dnsA", name: "shop.crumb.shop", value: null } },
    ],
    debrief: [
      "A site block alone is not enough. DNS must point the new name at your server first.",
      "Caddy's log says exactly which light is red: NXDOMAIN means no DNS record.",
      "After fixing DNS, a reload makes Caddy try again right away.",
    ],
    timeLimit: 360,
    url: "https://shop.crumb.shop",
  },
  {
    id: "app-127",
    title: "502 after a rebuild",
    client: {
      name: "Sam, your teammate",
      message: "I copied a 'safer' Dockerfile from a blog and rebuilt the app. It says Ready in the logs, but the shop gives 502!",
    },
    after: "w6-05",
    start: "vps-deploy",
    breakIt: (w) => {
      const f = getFile(w.hosts.vps, "/srv/crumb/app/Dockerfile");
      if (f) f.content = f.content.replace("ENV HOSTNAME=0.0.0.0", "ENV HOSTNAME=127.0.0.1");
      runDetached(w, DEPLOY_SHOP, "docker compose up -d --build");
      advance(w, w.clock + 10);
    },
    goals: [{ describe: "https://crumb.shop answers again", check: P.traceOk(HTTPS) }],
    hints: [
      "The app runs, so Caddy cannot reach it. Where does it listen? docker compose logs app shows the address.",
      "HOSTNAME=127.0.0.1 means only the app's own container can reach it. Set it back to 0.0.0.0 in app/Dockerfile and rebuild.",
    ],
    fastestPath: [
      "curl -I https://crumb.shop   → 502",
      "docker compose logs app   → Network: http://127.0.0.1:3000",
      "sed -i 's/HOSTNAME=127.0.0.1/HOSTNAME=0.0.0.0/' app/Dockerfile",
      "docker compose up -d --build",
    ],
    fix: ["cd /srv/crumb", "sed -i 's/HOSTNAME=127.0.0.1/HOSTNAME=0.0.0.0/' app/Dockerfile", "docker compose up -d --build"],
    debrief: [
      "Inside a container, 127.0.0.1 means only that container.",
      "Caddy is another container, so the app must listen on 0.0.0.0.",
      "Ready in the logs does not mean reachable. 502 means Caddy could not get through.",
    ],
    timeLimit: 300,
    url: HTTPS,
  },
);

// ---------- World 7 ----------
INCIDENTS.push({
  id: "db-port-public",
  oncall: { layer: "db", conflicts: ["db-localhost"] },
  title: "The database is on the internet",
  client: {
    name: "A security scanner",
    message: "Your server 203.0.113.10 has PostgreSQL open to the internet on port 5432. Bots are already trying passwords. (Sam opened it 'so the analytics tool can connect'.)",
  },
  after: "w7-07",
  start: "vps-deploy",
  breakIt: (w) => {
    const f = getFile(w.hosts.vps, "/srv/crumb/compose.yaml");
    if (f) f.content = f.content.replace('"127.0.0.1:5432:5432"', '"5432:5432"');
    if (!w.provider.firewall.rules.some((r) => r.port === 5432)) w.provider.firewall.rules.push({ port: 5432, source: "0.0.0.0/0" });
    runDetached(w, DEPLOY_SHOP, "docker compose up -d");
    advance(w, w.clock + 10);
  },
  goals: [
    { describe: "Postgres cannot be reached from the internet", check: P.dbNotPublic },
    { describe: "The provider firewall no longer opens 5432", check: P.not(P.providerOpen(5432)) },
    { describe: "The app still reaches the database", check: P.appReachesDb("app") },
  ],
  hints: [
    "Two doors are open: the compose file publishes 5432 on every address, and the provider firewall lets it in.",
    "Close 5432 in the dashboard. Then put \"127.0.0.1:5432:5432\" back in compose.yaml and docker compose up -d.",
  ],
  fastestPath: [
    "grep -n 5432 /srv/crumb/compose.yaml   → \"5432:5432\" (every address)",
    "Provider dashboard: 5432 is open. Turn it off",
    "sed -i 's/\"5432:5432\"/\"127.0.0.1:5432:5432\"/' compose.yaml",
    "docker compose up -d",
  ],
  fix: ["cd /srv/crumb", "sed -i 's/\"5432:5432\"/\"127.0.0.1:5432:5432\"/' compose.yaml", "docker compose up -d"],
  fixMap: [{ type: "pfwRule", port: 5432, on: false }],
  controls: [
    { node: "pfw", label: "22", on: { type: "pfwRule", port: 22, on: true }, off: { type: "pfwRule", port: 22, on: false } },
    { node: "pfw", label: "80", on: { type: "pfwRule", port: 80, on: true }, off: { type: "pfwRule", port: 80, on: false } },
    { node: "pfw", label: "443", on: { type: "pfwRule", port: 443, on: true }, off: { type: "pfwRule", port: 443, on: false } },
    { node: "pfw", label: "5432", on: { type: "pfwRule", port: 5432, on: true }, off: { type: "pfwRule", port: 5432, on: false } },
  ],
  debrief: [
    "A database should never face the internet. Bots find it within minutes.",
    "Docker publishes skip ufw, so the compose file and the provider firewall are the doors that matter.",
    "Tools that need the database can use an SSH tunnel instead.",
  ],
  timeLimit: 300,
});

// ---------- World 8 ----------
INCIDENTS.push({
  id: "disk-full-logs",
  oncall: { layer: "host", conflicts: ["db-port-public"] },
  title: "The disk is full",
  client: {
    name: "Sam, your teammate",
    message: "Orders fail and the database keeps restarting! A month ago I removed the 'noisy logging lines' from compose.yaml. I kept the old file as compose.yaml.bak, if that matters.",
  },
  after: "w8-08",
  start: "vps-deploy",
  breakIt: (w) => {
    const f = getFile(w.hosts.vps, "/srv/crumb/compose.yaml");
    if (f) {
      put(w.hosts.vps, "/srv/crumb/compose.yaml.bak", { ...f });
      f.content = f.content.replace(/(\n  app:\n(?:    .*\n)*?)    logging:\n      driver: json-file\n      options:\n        max-size: 10m\n        max-file: "3"\n/, "$1");
    }
    runDetached(w, DEPLOY_SHOP, "docker compose up -d");
    const app = Object.values(w.hosts.vps.docker.containers).find((c) => c.service === "app" && c.status === "running");
    if (app) app.logBytes = 40 * 1024 ** 3;
    advance(w, w.clock + 30);
  },
  goals: [
    { describe: "The disk has room again", check: P.diskNotFull },
    { describe: "The database is healthy", check: P.containerHealthy("db") },
    { describe: "The app's logs are capped again", check: (g) => !!Object.values(g.world.hosts.vps.docker.containers).find((c) => c.service === "app" && c.status === "running")?.logging?.options?.["max-size"] },
    { describe: "The app reaches the database", check: P.appReachesDb("app") },
  ],
  hints: [
    "df -h shows the disk at 100%. sudo du -sh /var/lib/docker/containers/* shows which container's log is huge.",
    "Free space first: sudo truncate -s 0 $(docker inspect --format '{{.LogPath}}' crumb-app-1). Then cp compose.yaml.bak compose.yaml, give the database half a minute to come back (sleep 30), and docker compose up -d.",
  ],
  fastestPath: [
    "df -h   → / is 100% full",
    "sudo du -sh /var/lib/docker/containers/*   → one container log is 40G",
    "sudo truncate -s 0 $(docker inspect --format '{{.LogPath}}' crumb-app-1)   → 40G freed",
    "cp compose.yaml.bak compose.yaml   → the logging limits are back",
    "sleep 30   → the database restarts now that there is room",
    "docker compose up -d   → app recreated with its log limits",
  ],
  fix: ["cd /srv/crumb", "sudo truncate -s 0 $(docker inspect --format '{{.LogPath}}' crumb-app-1)", "{{deployPassword}}", "cp compose.yaml.bak compose.yaml", "sleep 30", "docker compose up -d"],
  debrief: [
    "Container logs live on the server's disk, and by default they never stop growing.",
    "A full disk usually breaks the database first. Free space before restarting anything.",
    "Cap logs on every service, and let an uptime monitor tell you before customers do.",
  ],
  timeLimit: 360,
});

// ---------- World 9 ----------
const LAPTOP_REPO: Frame = { host: "laptop", user: "you", cwd: "/home/you/code/crumb", via: "local" };
const liveIsHead = (g: Parameters<Incident["goals"][number]["check"]>[0]) => !!g.world.gitlab && liveRevision(g.world) === g.world.gitlab.branches.main;
/** A teammate's small fix, committed and pushed from the laptop's clone. */
const pushFix = (w: Parameters<Incident["breakIt"]>[0], msg: string) =>
  runDetached(w, LAPTOP_REPO, `echo "// ${msg}" >> lib/cart.ts && git add lib/cart.ts && git commit -m "${msg}" && git push`);
const runnerSwitch = {
  node: "gitlab",
  label: "Runner online",
  on: { type: "runner" as const, id: 1, online: true },
  off: { type: "runner" as const, id: 1, online: false },
};

INCIDENTS.push(
  {
    id: "runner-pending",
    oncall: { layer: "ci" },
    title: "Stuck on pending",
    client: {
      name: "Riya, who runs the shop",
      message: "Sam pushed the checkout fix an hour ago. GitLab just says pending. Is it live or not?",
    },
    after: "w9-08",
    start: "laptop",
    breakIt: (w) => {
      const r = w.gitlab?.runners.find((x) => x.id === 1);
      if (r) r.online = false;
      pushFix(w, "Fix checkout rounding");
      advance(w, w.clock + 120);
    },
    goals: [
      { describe: "The latest pipeline on main passed", check: P.pipelineStatus("main", "success") },
      { describe: "The live shop runs the fix", check: liveIsHead },
    ],
    hints: ["Open the pending job in the pipeline panel. It says why it is stuck.", "No runner is online. Switch crumb-runner back on, then give the pipeline a few minutes."],
    fastestPath: ["Pipeline panel: test job pending, stuck: no active runners", "GitLab settings: crumb-runner is offline. Bring it back", "sleep 240   → test, build, deploy pass"],
    fix: ["sleep 240"],
    fixMap: [{ type: "runner", id: 1, online: true }],
    controls: [runnerSwitch],
    debrief: ["Pending means waiting for a runner, not running.", "No runner online, no pipeline. It is a machine like any other: watch it.", "The job's page always says why it is stuck."],
    timeLimit: 300,
  },
  {
    id: "pinned-tag",
    oncall: { layer: "ci", conflicts: ["ci-var-protected", "crash-loop-env", "db-localhost", "app-127", "disk-full-logs"] },
    title: "Green pipeline, old shop",
    client: {
      name: "Sam, your teammate",
      message: "My fix passed every job, deploy is green, but the shop still shows the old cart. During last week's outage someone 'pinned' something on web-1?",
    },
    after: "w9-08",
    start: "laptop",
    breakIt: (w) => {
      const g = w.gitlab;
      const old = g && Object.values(g.commits).find((c) => c.message === "Add Dockerfile and compose.yaml")?.sha;
      if (old) seedRegistry(w, old, ["v1.0"]);
      const f = getFile(w.hosts.vps, "/srv/crumb/compose.yaml");
      if (f) f.content = f.content.replace("web:${APP_TAG:-latest}", "web:v1.0");
      runDetached(w, { host: "vps", user: "ci", cwd: "/srv/crumb", via: "ssh", remote: VPS_IP, loginGroups: ["ci", "docker"] }, "docker compose up -d app");
      pushFix(w, "Fix cart totals");
      advance(w, w.clock + 240);
    },
    goals: [{ describe: "The live shop runs the latest commit", check: liveIsHead }],
    hints: [
      "curl -I https://crumb.shop shows x-app-version. Compare it with git log --oneline --abbrev=8. Then read compose.yaml on web-1.",
      "compose.yaml says web:v1.0, so APP_TAG is ignored. Put ${APP_TAG:-latest} back, then retry the deploy job.",
    ],
    fastestPath: [
      "curl -I https://crumb.shop   → x-app-version is an old commit",
      "grep image /srv/crumb/compose.yaml   → web:v1.0 (pinned)",
      "sed -i 's/web:v1.0/web:${APP_TAG:-latest}/' compose.yaml",
      "Pipeline panel: retry the deploy job",
    ],
    fix: ["ssh deploy@203.0.113.10", "cd /srv/crumb", "sed -i 's/web:v1.0/web:${APP_TAG:-latest}/' compose.yaml", "exit"],
    fixMapAfter: [{ type: "retryJob", job: "deploy" }],
    controls: [{ node: "gitlab", label: "Retry deploy", on: { type: "retryJob", job: "deploy" }, off: { type: "flag", name: "noop", value: false } }],
    debrief: [
      "A green deploy only proves the commands ran. Check what is live: x-app-version.",
      "A hard-coded tag in compose.yaml silently wins over APP_TAG.",
      "Pin during an outage if you must, then unpin.",
    ],
    timeLimit: 360,
    url: "https://crumb.shop",
  },
  {
    id: "ci-var-protected",
    oncall: { layer: "ci", conflicts: ["pinned-tag", "crash-loop-env", "db-localhost", "db-port-public", "disk-full-logs"] },
    title: "The deploy job fails",
    client: {
      name: "Sam, your teammate",
      message: "I 'tidied up' the CI/CD variables in GitLab yesterday. Now every deploy job fails at the ssh line.",
    },
    after: "w9-08",
    start: "laptop",
    breakIt: (w) => {
      const v = w.gitlab?.variables.find((x) => x.key === "SSH_KEY");
      if (v) v.type = "env_var";
      pushFix(w, "Tidy cart code");
      advance(w, w.clock + 240);
    },
    goals: [
      { describe: "The deploy job passed", check: P.jobStatus("deploy", "success") },
      { describe: "The live shop runs the latest commit", check: liveIsHead },
    ],
    hints: [
      "Read the deploy job's log in the pipeline panel. What does ssh say about the identity file?",
      "SSH_KEY was changed to a plain variable. ssh -i needs a file. Set it back to File (and Protected), then retry the deploy job.",
    ],
    fastestPath: [
      "Pipeline panel: deploy job log   → Identity file not accessible",
      "GitLab settings: SSH_KEY is now a plain variable. Make it a File again",
      "Retry the deploy job",
    ],
    fix: ["sleep 240"],
    fixMap: [
      { type: "ciVar", key: "SSH_KEY", value: "", varType: "file", protected: true, fromFile: { host: "laptop", path: "/home/you/.ssh/crumb_ci" } },
      { type: "retryJob", job: "deploy" },
    ],
    controls: [
      { node: "gitlab", label: "Key: File + Protected", on: { type: "ciVar", key: "SSH_KEY", value: "", varType: "file", protected: true, fromFile: { host: "laptop", path: "/home/you/.ssh/crumb_ci" } }, off: { type: "ciVar", key: "SSH_KEY", value: null } },
      { node: "gitlab", label: "Retry deploy", on: { type: "retryJob", job: "deploy" }, off: { type: "flag", name: "noop", value: false } },
    ],
    debrief: [
      "A File variable hands the job a path to a file. A plain one hands it the text.",
      "ssh -i wants a file, so a plain variable fails with Identity file not accessible.",
      "The job log tells you which line failed and why. Read it before changing anything.",
    ],
    timeLimit: 300,
  },
);

export function incidentById(id: string): Incident | undefined {
  return INCIDENTS.find((i) => i.id === id);
}
