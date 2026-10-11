import * as P from "@/sim/predicates";
import { DOMAIN, VPS_IP, WRONG_IP } from "@/sim/constants";
import type { MapControl, WorldDef } from "../schema";

const IP = VPS_IP;

const DNS_CONTROLS: MapControl[] = [
  { node: "dns", label: `A ${IP}`, on: { type: "dnsA", name: DOMAIN, value: IP }, off: { type: "dnsA", name: DOMAIN, value: null } },
  { node: "dns", label: `A ${WRONG_IP} (old)`, on: { type: "dnsA", name: DOMAIN, value: WRONG_IP }, off: { type: "dnsA", name: DOMAIN, value: null } },
  { node: "dns", label: "www CNAME", on: { type: "dnsCname", name: "www.crumb.shop", value: DOMAIN }, off: { type: "dnsCname", name: "www.crumb.shop", value: null } },
];

const pfwPort = (port: number, label: string): MapControl => ({
  node: "pfw",
  label,
  on: { type: "pfwRule", port, on: true },
  off: { type: "pfwRule", port, on: false },
});

const COMPOSE_BLANKS = `services:
  db:
    image: postgres:17
    ports:
      - "{{bind}}:5432:5432"
`;

export const world4: WorldDef = {
  id: 4,
  title: "Networking",
  tagline: "IPs, ports, DNS and two firewalls",
  cheatSheet: [
    { cmd: "ip a", what: "this machine's addresses: lo is localhost, then public and private" },
    { cmd: "sudo ss -tlnp", what: "who listens: 127.0.0.1 = only this machine, 0.0.0.0 = everyone" },
    { cmd: "dig crumb.shop +short", what: "what DNS tells the world" },
    { cmd: "A record / CNAME", what: "name to IP / name to another name" },
    { cmd: "TTL", what: "seconds others may keep an old DNS answer. Lower it before a move" },
    { cmd: "sudo ufw allow 80,443/tcp", what: "open the web ports (a list needs /tcp)" },
    { cmd: "Timeout vs refused", what: "timeout = a firewall dropped you, refused = nothing listens" },
    { cmd: "Provider firewall + ufw", what: "both must allow a port" },
    { cmd: '"127.0.0.1:5432:5432"', what: "Docker publishes skip ufw. Bind to 127.0.0.1, or publish nothing" },
  ],
  levels: [
    {
      id: "w4-01",
      world: 4,
      title: "Three kinds of address",
      base: "chain",
      start: "vps-deploy",
      steps: [
        {
          id: "w4-01-a",
          mission: "web-1 has more than one address. Sort these.",
          intel: {
            lines: [
              "A public IP is the server's address on the internet: 203.0.113.10.",
              "A private IP only works inside one network, like 10.0.0.5 or 192.168.1.23.",
              "localhost (127.0.0.1) always means: this same machine.",
            ],
          },
          task: {
            kind: "match",
            prompt: "Tap an address, then a bucket.",
            buckets: ["The whole internet", "Inside one network", "This machine only"],
            items: [
              { text: "203.0.113.10", bucket: 0 },
              { text: "10.0.0.5", bucket: 1 },
              { text: "192.168.1.23", bucket: 1 },
              { text: "127.0.0.1", bucket: 2 },
              { text: "localhost", bucket: 2 },
            ],
            why: "Public reaches the world. Private stays inside one network. localhost never leaves the machine.",
          },
          basis: { taught: ["self"] },
          teaches: ["private IP", "localhost"],
          tags: ["networking"],
        },
        {
          id: "w4-01-b",
          mission: "List web-1's addresses.",
          intel: { lines: ["ip a lists every network card and its address."] },
          task: {
            kind: "terminal",
            goals: [{ describe: "See web-1's three addresses", check: P.saw(/127\.0\.0\.1[\s\S]*203\.0\.113\.10[\s\S]*10\.0\.0\.5/, "vps") }],
            hints: ["It is a two letter command plus one letter: a for address.", "ip a"],
            guide: ["ip a"],
            showMe: ["ip a"],
            chips: ["ip a"],
          },
          after: "lo is localhost. eth0 has the public IP. enp7s0 is the provider's private network.",
          tags: ["networking"],
        },
        {
          id: "w4-01-c",
          mission: "Quick round on addresses.",
          task: {
            kind: "rapid",
            seconds: 30,
            items: [
              { id: "w4-01-c1", q: "127.0.0.1 is...", options: ["this same machine", "your home router", "the server's public address"], answer: 0, why: "127.0.0.1 is localhost.", tag: "networking" },
              { id: "w4-01-c2", q: "Strangers on the internet can reach...", options: ["203.0.113.10", "10.0.0.5", "127.0.0.1"], answer: 0, why: "Only the public IP is reachable from the internet.", tag: "networking" },
              { id: "w4-01-c3", q: "10.0.0.5 works...", options: ["only inside the provider's network", "everywhere", "only on your laptop"], answer: 0, why: "It is a private IP.", tag: "networking" },
              { id: "w4-01-c4", q: "localhost on your laptop means...", options: ["your laptop", "web-1", "the internet"], answer: 0, why: "localhost is always the machine you are on.", tag: "networking" },
              { id: "w4-01-c5", q: "192.168.1.23 is your laptop's...", options: ["private IP at home", "public IP", "localhost"], answer: 0, why: "192.168.x.x addresses are private.", tag: "networking" },
            ],
          },
          basis: { taught: ["w4-01-a", "w4-01-b"] },
          tags: ["networking"],
        },
      ],
    },
    {
      id: "w4-02",
      world: 4,
      title: "Who listens, who can reach",
      base: "chain",
      start: "vps-deploy",
      steps: [
        {
          id: "w4-02-a",
          mission: "Programs wait for visitors on ports. Tap the one only web-1 itself can reach.",
          intel: { lines: ["sudo ss -tlnp lists programs listening on ports.", "0.0.0.0 means every address. An address starting 127. means this machine only."] },
          task: {
            kind: "spot",
            prompt: "sudo ss -tlnp on web-1",
            mono: true,
            lines: [
              "State  Recv-Q Send-Q   Local Address:Port    Peer Address:Port Process",
              'LISTEN 0      4096            0.0.0.0:22        0.0.0.0:*     users:(("sshd",pid=1029,fd=3))',
              'LISTEN 0      4096          0.0.0.0:8080        0.0.0.0:*     users:(("python3",pid=2118,fd=3))',
              'LISTEN 0      4096      127.0.0.53%lo:53        0.0.0.0:*     users:(("systemd-resolve",pid=601,fd=15))',
            ],
            bugs: [3],
            why: "127.0.0.53 is web-1's own DNS helper. Only programs on web-1 can ask it.",
          },
          basis: { taught: ["self", "w4-01-a"] },
          tags: ["networking", "ports"],
        },
        {
          id: "w4-02-b",
          mission: "hello listens on 0.0.0.0:8080.",
          task: {
            kind: "predict",
            question: "Your laptop opens http://203.0.113.10:8080. What happens?",
            options: ["It times out: ufw only allows port 22", "The hello page loads", "It is refused right away"],
            answer: 0,
            why: "0.0.0.0 means hello would answer anyone, but ufw drops the visitor first.",
          },
          basis: { taught: ["w2-07-d", "w3-04-a"] },
          tags: ["networking", "firewall"],
        },
        {
          id: "w4-02-c",
          mission: "Prove it: open hello from web-1, then from your laptop.",
          task: {
            kind: "terminal",
            goals: [
              { describe: "hello answers on web-1 itself", check: P.saw(/Hello from web-1/, "vps") },
              { describe: "Your laptop times out", check: P.saw(/Timeout was reached/, "laptop") },
            ],
            hints: ["On web-1, curl localhost:8080. Then exit and curl the public IP from your laptop.", "curl localhost:8080, exit, curl http://203.0.113.10:8080"],
            guide: ["curl localhost:8080", "exit", `curl http://${IP}:8080`],
            showMe: ["curl localhost:8080", "exit", `curl http://${IP}:8080`],
            chips: ["curl localhost:8080", "exit", `curl http://${IP}:8080`],
          },
          after: "Listening is not the same as reachable. A timeout means a firewall dropped you.",
          review: {
            id: "w4-02-c-q",
            q: "A program listens on 0.0.0.0:8080 but your laptop times out. Most likely?",
            options: ["A firewall drops the visitor", "The program crashed", "DNS is wrong"],
            answer: 0,
            why: "A timeout is the sound of a firewall: no answer at all.",
            tag: "firewall",
          },
          tags: ["networking", "firewall"],
        },
      ],
    },
    {
      id: "w4-03",
      world: 4,
      title: "127.0.0.1 vs 0.0.0.0",
      base: "chain",
      start: "vps-deploy",
      steps: [
        {
          id: "w4-03-a",
          mission: "Someone moves hello to 127.0.0.1:8080 and opens 8080 in ufw.",
          task: {
            kind: "predict",
            question: "Can your laptop load it now?",
            options: ["No. 127.0.0.1 only takes visitors from web-1 itself", "Yes, ufw allows it now", "Only over https"],
            answer: 0,
            why: "A program on 127.0.0.1 never hears outside visitors, whatever the firewall says.",
          },
          basis: { taught: ["w4-01-a", "w4-02-a"] },
          tags: ["networking"],
        },
        {
          id: "w4-03-b",
          mission: "Two containers run on one server: app and a helper.",
          intel: {
            lines: ["Each container is like a tiny computer with its own localhost.", "Inside a container, 127.0.0.1 means that container, not the server."],
          },
          task: {
            kind: "predict",
            question: "The app listens on 127.0.0.1:3000 in its container. The helper connects to app:3000. What happens?",
            options: ["Refused: only the app's own container can reach it", "It works, they share a server", "It times out at ufw"],
            answer: 0,
            why: "To be reachable by other containers, a program must listen on 0.0.0.0.",
          },
          basis: { taught: ["self"] },
          tags: ["networking", "containers"],
        },
        {
          id: "w4-03-c",
          mission: "Who can reach each program?",
          task: {
            kind: "match",
            prompt: "Tap a line, then a bucket.",
            buckets: ["Only its own machine or container", "Others can reach it"],
            items: [
              { text: "web-1 program on 127.0.0.1:8080", bucket: 0 },
              { text: "web-1 program on 0.0.0.0:8080", bucket: 1 },
              { text: "Container app on 127.0.0.1:3000", bucket: 0 },
              { text: "Container app on 0.0.0.0:3000", bucket: 1 },
            ],
            why: "127.0.0.1 keeps it to one place. 0.0.0.0 lets others in, if the firewalls allow.",
          },
          basis: { taught: ["w4-03-a", "w4-03-b"] },
          tags: ["networking", "containers"],
        },
      ],
    },
    {
      id: "w4-04",
      world: 4,
      title: "Point the domain",
      base: "chain",
      start: "laptop",
      steps: [
        {
          id: "w4-04-a",
          mission: "Your shop's name is crumb.shop. Point it at web-1.",
          intel: {
            lines: ["An A record says: this name lives at this IP.", "A CNAME says: this name is another name. www.crumb.shop can follow crumb.shop."],
          },
          task: {
            kind: "map",
            mode: "toggle",
            prompt: "Use the switches on the DNS box.",
            controls: DNS_CONTROLS,
            goals: [
              { describe: "crumb.shop points at web-1", check: P.dnsResolves(DOMAIN, IP) },
              { describe: "www.crumb.shop follows crumb.shop", check: P.dnsHas("www.crumb.shop", "CNAME", DOMAIN) },
            ],
            hints: [`Pick the A record with web-1's public IP, ${IP}.`, `Turn on "A ${IP}" and "www CNAME".`],
            showMe: [
              { type: "dnsA", name: DOMAIN, value: IP },
              { type: "dnsCname", name: "www.crumb.shop", value: DOMAIN },
            ],
            url: "http://crumb.shop",
          },
          review: {
            id: "w4-04-a-q",
            q: "Which record makes www.crumb.shop follow crumb.shop?",
            options: ["CNAME", "A", "TXT"],
            answer: 0,
            why: "A CNAME points a name at another name.",
            tag: "dns",
          },
          teaches: ["A record", "CNAME"],
          tags: ["dns"],
        },
        {
          id: "w4-04-b",
          mission: "Ask DNS from your laptop, the way the whole internet will.",
          intel: { lines: ["dig asks DNS a question. Add +short to print just the answer."] },
          task: {
            kind: "terminal",
            goals: [
              { describe: "DNS answers 203.0.113.10 for crumb.shop", check: P.saw(/^203\.0\.113\.10$/m, "laptop") },
              { describe: "See www's CNAME", check: P.saw(/CNAME\s+crumb\.shop\./, "laptop") },
            ],
            hints: ["dig crumb.shop +short, then dig www.crumb.shop without +short.", "dig crumb.shop +short, then dig www.crumb.shop"],
            guide: ["dig crumb.shop +short", "dig www.crumb.shop"],
            showMe: ["dig crumb.shop +short", "dig www.crumb.shop"],
            chips: ["dig crumb.shop +short", "dig www.crumb.shop"],
          },
          after: "In dig's answer line, the number after the name is the TTL: how many seconds others may remember it.",
          tags: ["dns"],
        },
        {
          id: "w4-04-c",
          mission: "You plan to move crumb.shop to a new server.",
          intel: { lines: ["TTL (time to live) is how many seconds others may keep an old DNS answer."] },
          task: {
            kind: "predict",
            question: "Its A record has a TTL of 3600. You change the IP. What happens?",
            options: ["Some visitors reach the old server for up to an hour", "Everyone moves at once", "The site is down for a day"],
            answer: 0,
            why: "Others keep the old answer until the TTL runs out. Lower the TTL a day before a move.",
          },
          basis: { taught: ["self", "w4-04-a"] },
          tags: ["dns"],
        },
      ],
    },
    {
      id: "w4-05",
      world: 4,
      title: "Open the web ports",
      base: "chain",
      start: "vps-deploy",
      steps: [
        {
          id: "w4-05-a",
          mission: "Next you will let web visitors through ufw on ports 80 and 443.",
          task: {
            kind: "predict",
            question: "After that, does https://crumb.shop load?",
            options: ["No. Nothing on web-1 listens on 443 yet", "Yes, the firewall was the only thing missing", "Only http works"],
            answer: 0,
            why: "A firewall only lets visitors through. Something must still be listening behind it.",
          },
          basis: { taught: ["w4-02-a", "w4-02-c"] },
          tags: ["firewall", "ports"],
        },
        {
          id: "w4-05-b",
          mission: "Open ports 80 (http) and 443 (https) in ufw.",
          intel: { lines: ["sudo ufw allow 80,443/tcp opens both in one rule.", "A list of ports needs /tcp at the end."] },
          task: {
            kind: "terminal",
            goals: [
              { describe: "ufw allows 80", check: P.ufwAllows(80) },
              { describe: "ufw allows 443", check: P.ufwAllows(443) },
            ],
            hints: ["One ufw allow with both ports, separated by a comma, then /tcp.", "sudo ufw allow 80,443/tcp"],
            guide: ["sudo ufw allow 80,443/tcp", "sudo ufw status"],
            showMe: ["sudo ufw allow 80,443/tcp", "{{deployPassword}}"],
            chips: ["sudo ufw allow 80,443/tcp", "sudo ufw status"],
          },
          review: {
            id: "w4-05-b-q",
            q: "Open both web ports in ufw:",
            options: ["sudo ufw allow 80,443/tcp", "sudo ufw allow 80,443", "sudo ufw open web"],
            answer: 0,
            why: "A list of ports needs /tcp or /udp.",
            tag: "firewall",
          },
          tags: ["firewall"],
        },
        {
          id: "w4-05-c",
          mission: "From your laptop, load http://crumb.shop.",
          task: {
            kind: "terminal",
            goals: [{ describe: "The laptop gets through, but nothing answers", check: P.saw(/Couldn't connect to server/, "laptop") }],
            hints: ["Leave web-1 first, then curl the site from your laptop.", "exit, then curl http://crumb.shop"],
            guide: ["exit", "curl http://crumb.shop"],
            showMe: ["exit", "curl http://crumb.shop"],
            chips: ["exit", "curl http://crumb.shop"],
          },
          after: "Refused is fast: you got through, but nothing listens on 80. A timeout is slow: a firewall dropped you.",
          tags: ["firewall", "debugging"],
        },
      ],
    },
    {
      id: "w4-06",
      world: 4,
      title: "Two firewalls in a row",
      base: "chain",
      start: "laptop",
      steps: [
        {
          id: "w4-06-a",
          mission: "The provider firewall is off right now.",
          intel: { lines: ["Your provider has its own firewall in the dashboard, in front of ufw.", "A visitor must get past both."] },
          task: {
            kind: "predict",
            question: "You switch it on with no rules at all. What happens to new SSH logins?",
            options: ["They time out", "They still work, ufw allows 22", "They get Permission denied"],
            answer: 0,
            why: "With no rules, the provider firewall drops everything before ufw even sees it.",
            playout: { actions: [{ type: "pfw", enabled: true }], ssh: { user: "deploy" } },
          },
          basis: { taught: ["self", "w3-04-a"] },
          tags: ["firewall"],
        },
        {
          id: "w4-06-b",
          mission: "Turn on the provider firewall. Open only SSH and the web.",
          task: {
            kind: "map",
            mode: "toggle",
            prompt: "Use the switches on the provider firewall box.",
            controls: [
              { node: "pfw", label: "Firewall on", on: { type: "pfw", enabled: true }, off: { type: "pfw", enabled: false } },
              pfwPort(22, "22 (SSH)"),
              pfwPort(80, "80 (http)"),
              pfwPort(443, "443 (https)"),
              pfwPort(8080, "8080 (hello)"),
              pfwPort(5432, "5432 (database)"),
            ],
            goals: [
              { describe: "The provider firewall is on", check: P.pfwEnabled },
              { describe: "Exactly 22, 80 and 443 are open", check: P.providerOnly([22, 80, 443]) },
            ],
            hints: ["Open 22 before you switch it on, or new SSH logins lock out.", "Turn on 22, 80 and 443, then Firewall on. Leave 8080 and 5432 off."],
            showMe: [
              { type: "pfwRule", port: 22, on: true },
              { type: "pfwRule", port: 80, on: true },
              { type: "pfwRule", port: 443, on: true },
              { type: "pfw", enabled: true },
            ],
            url: "http://crumb.shop",
          },
          review: {
            id: "w4-06-b-q",
            q: "ufw allows 443 but the provider firewall does not. A visitor...",
            options: ["times out", "gets the page", "gets refused"],
            answer: 0,
            why: "Both firewalls must allow a port.",
            tag: "firewall",
          },
          tags: ["firewall"],
        },
        {
          id: "w4-06-c",
          mission: "Put a web visitor's trip in order.",
          task: {
            kind: "order",
            prompt: "Top is first.",
            items: [
              "The browser asks DNS for crumb.shop",
              "DNS answers 203.0.113.10",
              "The provider firewall lets port 443 in",
              "ufw lets port 443 in",
              "The program listening on 443 answers",
            ],
            why: "Every stop must say yes. When a site is down, find the stop that said no.",
          },
          basis: { taught: ["w4-04-a", "w4-06-a"] },
          tags: ["networking", "debugging"],
        },
      ],
    },
    {
      id: "w4-07",
      world: 4,
      title: "The trap: Docker skips ufw",
      base: "side",
      start: "laptop",
      setup: (w) => {
        // A throwaway copy of web-1: provider firewall off, Postgres published on every address.
        w.provider.firewall.enabled = false;
        const vps = w.hosts.vps;
        vps.services.docker = {
          name: "docker",
          description: "Docker Application Container Engine",
          unitPath: "/usr/lib/systemd/system/docker.service",
          enabled: true,
          state: "active",
          since: 0,
          pid: 901,
        };
        vps.docker.networks.test_default = { name: "test_default", driver: "bridge" };
        vps.docker.images["postgres:17"] = { ref: "postgres:17", id: "9b17deadbeef", sizeMb: 435, kind: "postgres", createdAt: 0 };
        vps.docker.containers["test-db-1"] = {
          id: "5e1f0a9b2c3d",
          name: "test-db-1",
          image: "postgres:17",
          kind: "postgres",
          status: "running",
          ports: [{ hostIp: "0.0.0.0", hostPort: 5432, containerPort: 5432 }],
          networks: ["test_default"],
          env: { POSTGRES_USER: "crumb", POSTGRES_DB: "crumb" },
          mounts: [],
          restart: "unless-stopped",
          project: "test",
          service: "db",
          listenAddr: "0.0.0.0",
          listenPort: 5432,
          logs: ["LOG:  database system is ready to accept connections"],
          createdAt: 0,
        };
      },
      steps: [
        {
          id: "w4-07-a",
          mission: "On a test copy of web-1, with its provider firewall off, a teammate started a database with Docker.",
          intel: { lines: ["Docker runs containers. It can publish a container's port on the server so visitors can reach it."] },
          task: {
            kind: "predict",
            question: "ufw blocks 5432. Docker published the database on 0.0.0.0:5432. Can the internet reach it?",
            options: ["Yes. Docker's firewall rules skip ufw", "No, ufw blocks it", "Only from the private network"],
            answer: 0,
            why: "Docker writes its own firewall rules ahead of ufw. A published port is open even when ufw says no.",
            playout: { actions: [], url: "http://crumb.shop:5432" },
          },
          basis: { guess: true },
          tags: ["firewall", "containers"],
        },
        {
          id: "w4-07-b",
          mission: "Fix the port line so only web-1 itself can reach the database.",
          intel: {
            lines: ['In Docker\'s settings, "127.0.0.1:5432:5432" publishes on localhost only.', "For a database, better still: publish nothing at all."],
          },
          task: {
            kind: "config",
            host: "vps",
            path: "/srv/test/compose.yaml",
            lang: "yaml",
            mode: "blanks",
            start: COMPOSE_BLANKS,
            blanks: { bind: { options: ["127.0.0.1", "0.0.0.0", IP], answer: 0 } },
            checks: [{ describe: "Published on 127.0.0.1 only", test: (t) => /"127\.0\.0\.1:5432:5432"/.test(t) }],
            solution: COMPOSE_BLANKS.replace("{{bind}}", "127.0.0.1"),
            hints: ["Which address means this machine only?", "127.0.0.1"],
            writeToSim: false,
          },
          review: {
            id: "w4-07-b-q",
            q: "Docker published 0.0.0.0:5432 and ufw denies 5432. Reachable from the internet?",
            options: ["Yes, Docker skips ufw", "No, ufw wins"],
            answer: 0,
            why: "Bind to 127.0.0.1 or do not publish the port.",
            tag: "firewall",
          },
          tags: ["firewall", "containers"],
        },
        {
          id: "w4-07-c",
          mission: "World 4 review. Go fast.",
          task: {
            kind: "rapid",
            seconds: 40,
            items: [
              { id: "w4-07-c1", q: "A timeout usually means...", options: ["a firewall dropped you", "nothing listens there", "the page is empty"], answer: 0, why: "Firewalls stay silent, so you wait.", tag: "firewall" },
              { id: "w4-07-c2", q: "Refused means...", options: ["you got through, but nothing listens on that port", "a firewall dropped you", "DNS is wrong"], answer: 0, why: "Refused comes back fast from the machine itself.", tag: "debugging" },
              { id: "w4-07-c3", q: "www.crumb.shop should follow crumb.shop. Use...", options: ["a CNAME", "a second server", "a TTL"], answer: 0, why: "A CNAME is a name pointing at a name.", tag: "dns" },
              { id: "w4-07-c4", q: "Moving servers tomorrow? Today...", options: ["lower the TTL", "raise the TTL", "delete the A record"], answer: 0, why: "A short TTL means old answers expire fast.", tag: "dns" },
              { id: "w4-07-c5", q: "Which listener can only web-1 reach?", options: ["127.0.0.1:8080", "0.0.0.0:8080"], answer: 0, why: "127.0.0.1 is localhost.", tag: "networking" },
              { id: "w4-07-c6", q: "To reach port 443, which firewalls must allow it?", options: ["Both the provider firewall and ufw", "Only ufw", "Only the provider firewall"], answer: 0, why: "They sit in a row. Both must say yes.", tag: "firewall" },
            ],
          },
          basis: { taught: ["w4-02-c", "w4-05-c", "w4-04-a", "w4-04-c", "w4-03-c", "w4-06-a"] },
          tags: ["networking"],
        },
      ],
    },
    {
      id: "w4-08",
      world: 4,
      title: "Incidents: DNS and the dashboard",
      base: "chain",
      start: "laptop",
      steps: [
        {
          id: "w4-08-a",
          mission: "Incident! The shop vanished. Fix it before uptime runs out.",
          task: { kind: "incident", incidentId: "dns-wrong-a" },
          tags: ["dns", "debugging"],
        },
        {
          id: "w4-08-b",
          mission: "Incident! Half the site times out.",
          task: { kind: "incident", incidentId: "pfw-blocks-443" },
          tags: ["firewall", "debugging"],
        },
      ],
    },
  ],
};
