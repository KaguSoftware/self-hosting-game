import type { WorldDef } from "../schema";

const INTERNAL_BLANKS = `crumb.internal {
\ttls {{tls}}
\treverse_proxy app:3000
}
`;

const BOSS_CHECKLIST = `Questions before I set up an app on the work VM

Getting in
- How do I reach the VM: VPN, a jump host, or directly?
- Do I get my own user with an SSH key? Do I get sudo?

What I may install
- May I install Docker? Is the docker group allowed (it is as strong as root)?
- Is there a dashboard already (Coolify, Dokploy, Portainer), or do we set things up by hand?
- Are there house rules for where apps live (/srv, /opt) and how they are named?

Who can reach it
- Should it be reachable from the internet, or only inside the company network?
- Which ports are open in the company firewall? Who changes them?
- Who manages DNS for internal names?

HTTPS
- Public certificates (Let's Encrypt), or does IT run its own certificate authority?
- If we use tls internal, will IT trust its root certificate on everyone's machines?

Keeping it safe
- Does the VM get snapshots? How often, and how fast can it be restored?
- Where should database backups go, and who checks the restore test?
- Who gets paged when it goes down?

Deploys
- Is there a GitLab runner we may use, or do we register our own?
- Which container registry do we push images to?
`;

export const world10: WorldDef = {
  id: 10,
  title: "Coolify and the work VM",
  tagline: "Dashboards, and what to ask your boss",
  cheatSheet: [
    { cmd: "Coolify / Dokploy", what: "dashboards that do Docker, a proxy, HTTPS and deploys for you, on your server" },
    { cmd: "Coolify's footprint", what: "dashboard on port 8000, its proxy owns 80 and 443, it manages Docker itself" },
    { cmd: "A dashboard says Running, the site says 502", what: "same debugging as by hand: proxy logs, then app logs" },
    { cmd: "tls internal", what: "HTTPS inside a company network. Browsers warn until the root certificate is trusted" },
    { cmd: "Ask first", what: "access, sudo, Docker, exposure, ports, DNS, HTTPS, snapshots, runners, registry" },
  ],
  levels: [
    {
      id: "w10-01",
      world: 10,
      title: "What a dashboard does underneath",
      base: "chain",
      start: "laptop",
      steps: [
        {
          id: "w10-01-a",
          mission: "At work you may meet a dashboard instead of a bare server.",
          intel: {
            lines: ["Coolify and Dokploy are dashboards you install on your own server.", "Underneath, they do what you just did by hand: Docker, a reverse proxy, HTTPS and deploys."],
          },
          task: {
            kind: "match",
            prompt: "Tap a Coolify feature, then the part you built that does the same job.",
            buckets: ["Docker and compose", "The reverse proxy", "Let's Encrypt certificates"],
            items: [
              { text: "Starts your app from its Dockerfile", bucket: 0 },
              { text: "Restarts a crashed app", bucket: 0 },
              { text: "Sends app.example.com to the right container", bucket: 1 },
              { text: "One program owns ports 80 and 443", bucket: 1 },
              { text: "The padlock for each domain", bucket: 2 },
            ],
            why: "Same parts, with buttons on top. Knowing the parts is what lets you fix it when a button fails.",
          },
          basis: { taught: ["self", "w6-01-b", "w6-03-a"] },
          tags: ["coolify"],
        },
        {
          id: "w10-01-b",
          mission: "Coolify runs as containers too. Tap the one that is the front door.",
          intel: { lines: ["Coolify's own proxy plays the part your Caddy plays."] },
          task: {
            kind: "spot",
            prompt: "docker ps on a server running Coolify",
            mono: true,
            lines: [
              "NAMES              IMAGE                                  PORTS",
              "coolify            ghcr.io/coollabsio/coolify:4           0.0.0.0:8000->8080/tcp",
              "coolify-proxy      traefik:v3.1                           0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp",
              "coolify-db         postgres:15-alpine                     5432/tcp",
              "shop-app           shop:latest                            3000/tcp",
            ],
            bugs: [2],
            why: "coolify-proxy owns 80 and 443, like Caddy. The dashboard itself is on 8000.",
          },
          basis: { taught: ["self", "w6-01-a"] },
          tags: ["coolify"],
        },
      ],
    },
    {
      id: "w10-02",
      world: 10,
      title: "Dashboard or by hand",
      base: "chain",
      start: "laptop",
      steps: [
        {
          id: "w10-02-a",
          mission: "Your boss asks which way to go.",
          intel: { lines: ["A dashboard is quick to set up and easy for a team that avoids the terminal.", "By hand, you control every file and nothing is hidden."] },
          task: {
            kind: "predict",
            question: "Five small apps on one server, looked after by people who never used a terminal. Which fits?",
            options: ["A dashboard like Coolify", "Everything by hand", "Five separate servers"],
            answer: 0,
            why: "Dashboards shine for many small apps and mixed teams. By hand shines when you need to know exactly what runs.",
          },
          basis: { taught: ["self"] },
          tags: ["coolify"],
        },
        {
          id: "w10-02-b",
          mission: "Someone wants to try Coolify on web-1, next to your Caddy.",
          task: {
            kind: "predict",
            question: "What breaks when Coolify starts?",
            options: ["Its proxy cannot start: Caddy already owns 80 and 443", "Nothing, they share the ports", "Your database is deleted"],
            answer: 0,
            why: "One port, one owner. A dashboard wants the whole server, so give it its own.",
          },
          basis: { taught: ["w6-01-a", "w10-01-b"] },
          tags: ["coolify"],
        },
        {
          id: "w10-02-c",
          mission: "Quick round on dashboards.",
          task: {
            kind: "rapid",
            seconds: 30,
            items: [
              { id: "w10-02-c1", q: "Coolify's dashboard listens on...", options: ["8000", "443", "22"], answer: 0, why: "Its proxy takes 80 and 443.", tag: "coolify" },
              { id: "w10-02-c2", q: "Underneath, Coolify runs apps with...", options: ["Docker", "magic", "a VM per app"], answer: 0, why: "It manages Docker for you.", tag: "coolify" },
              { id: "w10-02-c3", q: "Site gives 502 in Coolify. First look at...", options: ["the proxy and app logs", "the billing page", "DNS only"], answer: 0, why: "Same machine, same debugging.", tag: "debugging" },
              { id: "w10-02-c4", q: "Best fit for one app you must know inside out:", options: ["by hand", "a dashboard"], answer: 0, why: "Nothing hidden.", tag: "coolify" },
            ],
          },
          basis: { taught: ["w10-01-a", "w10-01-b", "w10-02-a"] },
          tags: ["coolify"],
        },
      ],
    },
    {
      id: "w10-03",
      world: 10,
      title: "Questions for your boss",
      base: "chain",
      start: "laptop",
      steps: [
        {
          id: "w10-03-a",
          mission: "Before you touch the work VM, ask. Sort these questions.",
          intel: { lines: ["A VPN is a private tunnel into the company network. Work VMs often hide behind one."] },
          task: {
            kind: "match",
            prompt: "Tap a question, then where it belongs.",
            buckets: ["Can I get in?", "What may I install?", "Who can reach it?", "How is it kept safe?"],
            items: [
              { text: "Do I reach it over a VPN?", bucket: 0 },
              { text: "Do I get sudo?", bucket: 1 },
              { text: "May I install Docker?", bucket: 1 },
              { text: "Internet, or company network only?", bucket: 2 },
              { text: "Which ports are open, and who opens them?", bucket: 2 },
              { text: "Does the VM get snapshots?", bucket: 3 },
            ],
            why: "Ask before you build. Each answer changes the plan.",
          },
          basis: { taught: ["self", "w5-02-a", "w4-06-a"] },
          copy: { label: "Copy the full checklist", text: BOSS_CHECKLIST },
          tags: ["work-vm"],
        },
      ],
    },
    {
      id: "w10-04",
      world: 10,
      title: "HTTPS inside the company",
      base: "side",
      start: "laptop",
      steps: [
        {
          id: "w10-04-a",
          mission: "The work VM is only reachable inside the company network, at crumb.internal.",
          intel: {
            lines: ["Let's Encrypt cannot reach a server hidden inside a company network.", "tls internal makes Caddy sign its own certificate instead."],
          },
          task: {
            kind: "config",
            host: "vps",
            path: "/srv/work/Caddyfile",
            lang: "caddy",
            mode: "blanks",
            start: INTERNAL_BLANKS,
            blanks: { tls: { options: ["internal", "you@crumb.shop"], answer: 0 } },
            checks: [{ describe: "Caddy signs its own certificate", test: (t) => /^\s*tls internal\s*$/m.test(t) }],
            solution: INTERNAL_BLANKS.replace("{{tls}}", "internal"),
            hints: ["An email address would ask Let's Encrypt, which cannot reach this VM.", "internal"],
            writeToSim: false,
          },
          tags: ["https", "work-vm"],
        },
        {
          id: "w10-04-b",
          mission: "Colleagues open https://crumb.internal for the first time.",
          task: {
            kind: "predict",
            question: "What does their browser show?",
            options: ["A warning, until IT trusts Caddy's root certificate on their machines", "The padlock, no warning", "Nothing loads"],
            answer: 0,
            why: "Browsers only trust certificates from authorities they know. IT can add Caddy's root certificate to company machines once.",
          },
          basis: { guess: true },
          tags: ["https", "work-vm"],
        },
      ],
    },
  ],
};
