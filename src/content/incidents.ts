import { getDir, getFile } from "@/sim/fs";
import * as P from "@/sim/predicates";
import { DOMAIN, VPS_IP, WRONG_IP } from "@/sim/constants";
import { runDetached } from "@/sim/shell/run";
import { advance } from "@/sim/tick";
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
    oncall: { layer: "app" },
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

export function incidentById(id: string): Incident | undefined {
  return INCIDENTS.find((i) => i.id === id);
}
