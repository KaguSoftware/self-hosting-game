import * as P from "@/sim/predicates";
import { getFile } from "@/sim/fs";
import type { WorldDef } from "../schema";

const URL = "https://crumb.shop";

const APP_AND_DB = `  app:
    build: ./app
    env_file: .env
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
  db:
    image: postgres:17
    env_file: .env
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U crumb -d crumb"]
      interval: 5s
      retries: 5
    volumes:
      - pgdata:/var/lib/postgresql/data
`;

const COMPOSE_BLANKS = `services:
  caddy:
    image: caddy:{{tag}}
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - {{data}}:/data
${APP_AND_DB}
volumes:
  pgdata:
  caddy_data:
`;
const COMPOSE = COMPOSE_BLANKS.replace("{{tag}}", "2").replace("{{data}}", "caddy_data");

const CADDY_BLANKS = `crumb.shop, www.crumb.shop {
\treverse_proxy {{up}}
}
`;
const CADDYFILE = CADDY_BLANKS.replace("{{up}}", "app:3000");

export const world6: WorldDef = {
  id: 6,
  title: "Reverse proxy and HTTPS",
  tagline: "Caddy owns 443",
  cheatSheet: [
    { cmd: "Caddy", what: "the front door: the only service with ports 80 and 443" },
    { cmd: "caddy_data:/data", what: "keeps certificates when Caddy is recreated" },
    { cmd: "crumb.shop, www.crumb.shop { reverse_proxy app:3000 }", what: "a site block: these names go to the app service" },
    { cmd: "DNS + port 80 or 443 + site block", what: "the three green lights Let's Encrypt needs" },
    { cmd: "docker compose logs caddy", what: "certificate obtained successfully, or the reason it was not" },
    { cmd: "docker compose exec -w /etc/caddy caddy caddy reload", what: "load an edited Caddyfile. A broken one keeps the old config running" },
    { cmd: "curl -I https://crumb.shop", what: "check the status code and headers" },
    { cmd: "502", what: "Caddy is fine, nothing answered behind it: wrong port, app down, or app on 127.0.0.1" },
  ],
  levels: [
    {
      id: "w6-01",
      world: 6,
      title: "One front door",
      base: "chain",
      start: "vps-deploy",
      steps: [
        {
          id: "w6-01-a",
          mission: "Visitors need one way in. Only one program can own a port.",
          intel: {
            lines: ["A reverse proxy is the front door: one program owns ports 80 and 443 and passes each visit to the right app.", "On your server that program is Caddy."],
          },
          task: {
            kind: "predict",
            question: "Two containers both try to publish port 443. What happens to the second one?",
            options: ["It fails: port is already allocated", "They share it", "The newest one wins"],
            answer: 0,
            why: "One port, one owner. So Caddy owns 443, and the app and database stay private behind it.",
          },
          basis: { taught: ["self"] },
          tags: ["proxy"],
        },
        {
          id: "w6-01-b",
          mission: "Who does what in the finished shop?",
          task: {
            kind: "match",
            prompt: "Tap a job, then the service that does it.",
            buckets: ["Caddy (front door)", "app (your Next.js code)", "db (Postgres)"],
            items: [
              { text: "Owns ports 80 and 443", bucket: 0 },
              { text: "HTTPS certificates", bucket: 0 },
              { text: "Pages and API routes", bucket: 1 },
              { text: "Talks to the database", bucket: 1 },
              { text: "Stores orders and users", bucket: 2 },
            ],
            why: "Caddy is the only door. Everything behind it talks on Docker's private network.",
          },
          basis: { taught: ["w0-01-a", "w6-01-a"] },
          tags: ["proxy"],
        },
      ],
    },
    {
      id: "w6-02",
      world: 6,
      title: "Caddy joins the compose file",
      base: "chain",
      start: "vps-deploy",
      steps: [
        {
          id: "w6-02-a",
          mission: "Add Caddy to the shop's compose file.",
          intel: {
            lines: ["Caddy is the only service with ports. app and db stay private.", "Its settings live in a file called the Caddyfile, shared in from the server.", "caddy_data keeps Caddy's certificates when the container is recreated."],
          },
          task: {
            kind: "config",
            host: "vps",
            path: "/srv/crumb/compose.yaml",
            lang: "yaml",
            mode: "blanks",
            start: COMPOSE_BLANKS,
            blanks: {
              tag: { options: ["2", "latest"], answer: 0 },
              data: { options: ["caddy_data", "/tmp"], answer: 0 },
            },
            checks: [
              { describe: "Caddy is pinned to version 2", test: (t) => /image:\s*caddy:2\s*$/m.test(t) },
              { describe: "Certificates live in the caddy_data volume", test: (t) => /-\s*caddy_data:\/data/.test(t) },
              { describe: "Only Caddy publishes ports", test: (t) => (t.match(/^\s+ports:/gm) ?? []).length === 1 },
            ],
            solution: COMPOSE,
            hints: ["Pin the major version, and keep certificates in a volume.", "2 and caddy_data"],
            writeToSim: true,
          },
          tags: ["proxy", "compose"],
        },
        {
          id: "w6-02-b",
          mission: "Why bother with the caddy_data volume?",
          intel: { lines: ["Let's Encrypt gives free certificates, but at most 5 for the same names per week."] },
          task: {
            kind: "predict",
            question: "No caddy_data volume. You recreate Caddy six times in one day. What happens?",
            options: ["Let's Encrypt refuses: too many certificates for the same names", "Nothing, certificates are kept anyway", "The site gets faster"],
            answer: 0,
            why: "Without the volume, each new container forgets its certificate and asks again. The sixth ask is refused for a week.",
          },
          basis: { taught: ["self", "w6-02-a"] },
          tags: ["proxy", "https"],
        },
      ],
    },
    {
      id: "w6-03",
      world: 6,
      title: "Three green lights",
      base: "chain",
      start: "vps-deploy",
      steps: [
        {
          id: "w6-03-a",
          mission: "A friend's site never got its padlock. Tap the line that says why.",
          intel: {
            lines: [
              "A certificate proves to browsers that a site really is crumb.shop. Caddy gets one from Let's Encrypt.",
              "Let's Encrypt checks three things: DNS points here, port 80 or 443 is reachable, and Caddy has the name.",
            ],
          },
          task: {
            kind: "spot",
            prompt: "docker compose logs caddy, on your friend's server",
            mono: true,
            lines: [
              '{"level":"info","msg":"serving initial configuration"}',
              '{"level":"info","logger":"tls.obtain","msg":"obtaining certificate","identifier":"bakery.example"}',
              '{"level":"error","logger":"tls.obtain","msg":"could not get certificate from issuer","identifier":"bakery.example","error":"HTTP 400 urn:ietf:params:acme:error:connection - 198.51.100.20: Timeout during connect (likely firewall problem)"}',
            ],
            bugs: [2],
            why: "Timeout during connect: Let's Encrypt could not reach port 80 or 443. A firewall is in the way.",
          },
          basis: { taught: ["self"] },
          tags: ["https", "debugging"],
        },
        {
          id: "w6-03-b",
          mission: "Write the Caddyfile: both names go to the app.",
          intel: { lines: ["A site block is a name, then { }. Inside, reverse_proxy says where to send visitors.", "The app service listens on port 3000."] },
          task: {
            kind: "config",
            host: "vps",
            path: "/srv/crumb/Caddyfile",
            lang: "caddy",
            mode: "blanks",
            start: CADDY_BLANKS,
            blanks: { up: { options: ["app:3000", "localhost:3000", "127.0.0.1:3000"], answer: 0 } },
            checks: [{ describe: "Visitors go to the app service on port 3000", test: (t) => /^\s*reverse_proxy\s+app:3000\s*$/m.test(t) }],
            solution: CADDYFILE,
            hints: ["Inside the Caddy container, localhost is Caddy itself.", "app:3000"],
            writeToSim: true,
          },
          review: {
            id: "w6-03-b-q",
            q: "In the Caddyfile, how does Caddy reach the app?",
            options: ["reverse_proxy app:3000", "reverse_proxy localhost:3000", "reverse_proxy 203.0.113.10"],
            answer: 0,
            why: "Use the compose service name, just like the app uses db.",
            tag: "proxy",
          },
          teaches: ["site block"],
          tags: ["proxy"],
        },
      ],
    },
    {
      id: "w6-04",
      world: 6,
      title: "Go live",
      base: "chain",
      start: "vps-deploy",
      steps: [
        {
          id: "w6-04-a",
          mission: "Start Caddy and watch it get a certificate.",
          intel: { lines: ["docker compose up -d starts the new caddy service. The app and db are already running."] },
          task: {
            kind: "terminal",
            goals: [
              { describe: "crumb.shop has a certificate", check: P.certIssued("crumb.shop") },
              { describe: "https://crumb.shop answers", check: P.traceOk(URL) },
            ],
            hints: ["Start it from /srv/crumb, then read Caddy's log.", "cd /srv/crumb, docker compose up -d, docker compose logs caddy, curl -I https://crumb.shop"],
            guide: ["cd /srv/crumb", "docker compose up -d", "docker compose logs caddy", "curl -I https://crumb.shop"],
            showMe: ["cd /srv/crumb", "docker compose up -d", "docker compose logs caddy", "curl -I https://crumb.shop"],
            chips: ["cd /srv/crumb", "docker compose up -d", "docker compose logs caddy", "curl -I https://crumb.shop"],
            url: URL,
          },
          after: "That padlock used to be Vercel's job. Now Caddy renews it by itself, every couple of months.",
          tags: ["https"],
        },
        {
          id: "w6-04-b",
          mission: "Someone types http://crumb.shop, without the s.",
          task: {
            kind: "predict",
            question: "What does Caddy do?",
            options: ["Sends them on to https://crumb.shop", "Shows the page without encryption", "Refuses the connection"],
            answer: 0,
            why: "Caddy redirects http to https by itself (status 308). Port 80 stays open for that, and for Let's Encrypt.",
            playout: { actions: [], url: "http://crumb.shop" },
          },
          basis: { guess: true },
          tags: ["https"],
        },
      ],
    },
    {
      id: "w6-05",
      world: 6,
      title: "502: nothing answered",
      base: "chain",
      start: "vps-deploy",
      setup: (w) => {
        // A teammate "tidied" the Caddyfile and reloaded Caddy.
        const vps = w.hosts.vps;
        const f = getFile(vps, "/srv/crumb/Caddyfile");
        if (f) f.content = f.content.replace("app:3000", "app:8080");
        const caddy = Object.values(vps.docker.containers).find((c) => c.kind === "caddy");
        if (caddy && f) caddy.caddyConfig = f.content;
      },
      steps: [
        {
          id: "w6-05-a",
          mission: "The shop shows 502 Bad Gateway. Find out why and fix it.",
          intel: {
            lines: ["502 means Caddy works, but nothing answered behind it.", "After editing the Caddyfile, reload it: docker compose exec -w /etc/caddy caddy caddy reload."],
          },
          task: {
            kind: "terminal",
            goals: [
              { describe: "Caddy sends visitors to port 3000 again", check: P.caddyLoaded(/reverse_proxy\s+app:3000/) },
              { describe: "https://crumb.shop answers", check: P.traceOk(URL) },
            ],
            hints: [
              "cat the Caddyfile and compare its port with the one the app listens on (3000).",
              "sed -i 's/app:8080/app:3000/' Caddyfile, then docker compose exec -w /etc/caddy caddy caddy reload",
            ],
            guide: ["cd /srv/crumb", "curl -I https://crumb.shop", "cat Caddyfile", "sed -i 's/app:8080/app:3000/' Caddyfile", "docker compose exec -w /etc/caddy caddy caddy reload"],
            showMe: ["cd /srv/crumb", "sed -i 's/app:8080/app:3000/' Caddyfile", "docker compose exec -w /etc/caddy caddy caddy reload"],
            chips: ["cd /srv/crumb", "curl -I https://crumb.shop", "cat Caddyfile", "docker compose logs caddy"],
            url: URL,
          },
          after: "-w /etc/caddy matters: Caddy's image starts in /srv, and caddy reload looks for a Caddyfile in the folder it is in.",
          review: {
            id: "w6-05-a-q",
            q: "You edited the Caddyfile. Caddy still uses the old one. Why?",
            options: ["Caddy only reads it at start or on caddy reload", "The file needs chmod 777", "Caddy reads it once a day"],
            answer: 0,
            why: "Saving the file changes nothing until you reload.",
            tag: "proxy",
          },
          tags: ["proxy", "debugging"],
        },
        {
          id: "w6-05-b",
          mission: "Next time, the log tells you straight away.",
          task: {
            kind: "spot",
            prompt: "Tap the line that explains a 502.",
            mono: true,
            lines: [
              '{"level":"info","logger":"admin.api","msg":"load complete"}',
              '{"level":"error","logger":"http.log.error","msg":"dial tcp 172.18.0.3:8080: connect: connection refused","request":{"host":"crumb.shop","uri":"/"},"status":502}',
              '{"level":"info","logger":"tls","msg":"certificate is valid","identifier":"crumb.shop"}',
            ],
            bugs: [1],
            why: "Caddy dialed the app on 8080 and nothing answered there. connection refused = wrong port, or the app is down.",
          },
          basis: { taught: ["w6-05-a"] },
          tags: ["proxy", "debugging"],
        },
      ],
    },
    {
      id: "w6-06",
      world: 6,
      title: "Incidents: the front door",
      base: "chain",
      start: "vps-deploy",
      steps: [
        {
          id: "w6-06-a",
          mission: "Incident! Browsers show a scary error for crumb.shop.",
          task: { kind: "incident", incidentId: "caddy-typo" },
          tags: ["proxy", "debugging"],
        },
        {
          id: "w6-06-b",
          mission: "Quick review before the next call.",
          task: {
            kind: "rapid",
            seconds: 40,
            items: [
              { id: "w6-06-b1", q: "Which service publishes ports 80 and 443?", options: ["caddy", "app", "db"], answer: 0, why: "One front door.", tag: "proxy" },
              { id: "w6-06-b2", q: "Let's Encrypt needs DNS, a site block, and...", options: ["port 80 or 443 reachable", "a paid plan", "port 5432 open"], answer: 0, why: "It connects to your server to check.", tag: "https" },
              { id: "w6-06-b3", q: "502 Bad Gateway means...", options: ["nothing answered behind Caddy", "DNS is wrong", "the certificate expired"], answer: 0, why: "Caddy is fine. The app is not answering.", tag: "proxy" },
              { id: "w6-06-b4", q: "Edited the Caddyfile. Next:", options: ["caddy reload, with -w /etc/caddy", "nothing, it notices", "reboot the server"], answer: 0, why: "Caddy reads it at start or on reload.", tag: "proxy" },
              { id: "w6-06-b5", q: "caddy_data is for...", options: ["keeping certificates", "the app's uploads", "logs"], answer: 0, why: "Lose it, and Caddy asks for new certificates.", tag: "https" },
              { id: "w6-06-b6", q: "http://crumb.shop gets...", options: ["redirected to https", "the page, unencrypted", "refused"], answer: 0, why: "Caddy does that by itself.", tag: "https" },
            ],
          },
          basis: { taught: ["w6-01-a", "w6-03-a", "w6-05-a", "w6-02-b", "w6-04-b"] },
          tags: ["proxy", "https"],
        },
        {
          id: "w6-06-c",
          mission: "Incident! A new address shows a certificate error.",
          task: { kind: "incident", incidentId: "cert-new-domain" },
          tags: ["https", "dns", "debugging"],
        },
        {
          id: "w6-06-d",
          mission: "Incident! 502 after a rebuild.",
          task: { kind: "incident", incidentId: "app-127" },
          tags: ["proxy", "docker", "debugging"],
        },
      ],
    },
  ],
};
