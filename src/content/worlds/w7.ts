import * as P from "@/sim/predicates";
import { VPS_IP } from "@/sim/constants";
import type { WorldDef } from "../schema";

const IP = VPS_IP;
const SUPABASE = "postgres://postgres:kX9-supa-crumb@db.abcdefghijklmnop.supabase.co:5432/postgres";
const TUNNEL = `ssh -N -L 5433:127.0.0.1:5432 deploy@${IP}`;
const RESTORE = "pg_restore --no-owner --no-acl -h 127.0.0.1 -p 5433 -U crumb -d crumb supabase.dump";

const COMPOSE_DB_PORT = (bind: string) => `services:
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
  app:
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
    ports:
      - "${bind}:5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
  caddy_data:
`;

/** Only this machine may reach Postgres: a 127.0.0.1 publish and nothing on 0.0.0.0. */
const dbOnLocalhost = P.all(P.dbNotPublic, (g) =>
  Object.values(g.world.hosts.vps.docker.containers).some((c) => c.service === "db" && c.status === "running" && c.ports.some((p) => p.hostIp === "127.0.0.1" && p.containerPort === 5432)),
);

export const world7: WorldDef = {
  id: 7,
  title: "Life after Supabase",
  tagline: "Postgres, auth, storage, migrations",
  cheatSheet: [
    { cmd: "docker compose exec db psql -U crumb -d crumb", what: "Postgres's own command line, inside the db container" },
    { cmd: "\\l   \\dt   \\q", what: "inside psql: list databases, list tables, quit" },
    { cmd: "postgres://user:password@db:5432/crumb", what: "a connection string. From the app, the host is the service name db" },
    { cmd: "POSTGRES_PASSWORD", what: "only read the first time the volume is empty. Change it later with ALTER USER" },
    { cmd: '"127.0.0.1:5432:5432"', what: "publish the database to web-1 only, never to the internet" },
    { cmd: "ssh -N -L 5433:127.0.0.1:5432 deploy@IP", what: "a tunnel: laptop port 5433 reaches Postgres on web-1, for a GUI or psql" },
    { cmd: "pg_dump -Fc -n public URL -f file.dump", what: "copy the public schema out of Supabase into one file" },
    { cmd: "pg_restore --no-owner --no-acl ... file.dump", what: "load it, skipping Supabase's owners and permissions" },
    { cmd: "RLS is gone", what: "your app connects as one user. Check who may see what in your server code" },
  ],
  levels: [
    {
      id: "w7-01",
      world: 7,
      title: "What moves, what changes",
      base: "chain",
      start: "vps-deploy",
      steps: [
        {
          id: "w7-01-a",
          mission: "Supabase was more than a database. Sort what happens to each part.",
          intel: {
            lines: [
              "Supabase is Postgres plus extras: logins, file storage, an instant API and RLS rules.",
              "RLS (row level security) rules inside Postgres decide which rows each logged-in user may see.",
              "Postgres comes along as it is. The extras get rebuilt or replaced.",
            ],
          },
          task: {
            kind: "match",
            prompt: "Tap a part, then where it goes.",
            buckets: ["Moves as it is", "Rebuilt in your app", "Becomes a separate service"],
            items: [
              { text: "Your tables and rows", bucket: 0 },
              { text: "Logins and sessions (Supabase Auth)", bucket: 1 },
              { text: "Who may see which rows (RLS)", bucket: 1 },
              { text: "The instant REST API", bucket: 1 },
              { text: "Uploaded images (Supabase Storage)", bucket: 2 },
            ],
            why: "Data moves. Auth and permission checks move into your code (or a library). Files go to an S3-compatible storage service.",
          },
          basis: { taught: ["self"] },
          tags: ["postgres", "supabase"],
        },
      ],
    },
    {
      id: "w7-02",
      world: 7,
      title: "Meet your database",
      base: "chain",
      start: "vps-deploy",
      steps: [
        {
          id: "w7-02-a",
          mission: "One Postgres habit surprises everyone once.",
          intel: { lines: ["The postgres image reads POSTGRES_USER, POSTGRES_PASSWORD and POSTGRES_DB only once: the first time its volume is empty."] },
          task: {
            kind: "predict",
            question: "You change POSTGRES_PASSWORD in .env and run docker compose up -d. What happens?",
            options: ["The app gets password authentication failed: the database kept the old password", "Postgres switches to the new password", "All the data is wiped"],
            answer: 0,
            why: "The password lives inside the data now. Change it with ALTER USER in psql, then update .env to match.",
          },
          basis: { taught: ["self"] },
          tags: ["postgres"],
        },
        {
          id: "w7-02-b",
          mission: "Open your database and look around. It should be empty.",
          intel: {
            lines: ["psql is Postgres's own command line. docker compose exec db psql -U crumb -d crumb runs it inside the db container.", "Inside psql: \\l lists databases, \\dt lists tables, \\q quits."],
          },
          task: {
            kind: "terminal",
            goals: [
              { describe: "See the list of databases", check: P.saw(/List of databases/, "vps") },
              { describe: "See that there are no tables yet", check: P.saw(/Did not find any relations\./, "vps") },
            ],
            hints: ["Start psql from /srv/crumb, then type \\l and \\dt at its prompt.", "cd /srv/crumb, docker compose exec db psql -U crumb -d crumb, then \\l, \\dt, \\q"],
            guide: ["cd /srv/crumb", "docker compose exec db psql -U crumb -d crumb", "\\l", "\\dt", "\\q"],
            showMe: ["cd /srv/crumb", "docker compose exec db psql -U crumb -d crumb", "\\l", "\\dt", "\\q"],
            chips: ["cd /srv/crumb", "docker compose exec db psql -U crumb -d crumb", "\\l", "\\dt", "\\q"],
          },
          after: "Empty, as expected. The shop's real data still lives in Supabase. You will move it at the end of this world.",
          review: {
            id: "w7-02-b-q",
            q: "Inside psql, which lists the tables?",
            options: ["\\dt", "\\l", "\\q"],
            answer: 0,
            why: "\\l lists databases, \\q quits.",
            tag: "postgres",
          },
          tags: ["postgres"],
        },
      ],
    },
    {
      id: "w7-03",
      world: 7,
      title: "Connection strings",
      base: "chain",
      start: "vps-deploy",
      steps: [
        {
          id: "w7-03-a",
          mission: "Which of these work from inside the app container? Tap every one that fails.",
          intel: { lines: ["A connection string packs everything into one line: postgres://user:password@host:port/database."] },
          task: {
            kind: "spot",
            prompt: "DATABASE_URL candidates",
            mono: true,
            lines: [
              "postgres://crumb:s3cret-pg@db:5432/crumb",
              "postgres://crumb:s3cret-pg@localhost:5432/crumb",
              "postgres://crumb:s3cret-pg@203.0.113.10:5432/crumb",
              "postgres://crumb:s3cret-pg@db:5433/crumb",
            ],
            bugs: [1, 2, 3],
            why: "localhost is the app itself, the public IP is not published (good), and Postgres listens on 5432, not 5433. Only db:5432 works.",
          },
          basis: { taught: ["self", "w5-06-c", "w5-07-a"] },
          tags: ["postgres", "compose"],
        },
      ],
    },
    {
      id: "w7-04",
      world: 7,
      title: "A tunnel for your laptop",
      base: "chain",
      start: "vps-deploy",
      steps: [
        {
          id: "w7-04-a",
          mission: "You want to browse the database from your laptop with a GUI. First, let web-1 itself reach Postgres.",
          intel: { lines: ['"127.0.0.1:5432:5432" publishes Postgres on web-1 only. The internet still cannot reach it.'] },
          task: {
            kind: "config",
            host: "vps",
            path: "/srv/crumb/compose.yaml",
            lang: "yaml",
            mode: "blanks",
            start: COMPOSE_DB_PORT("{{bind}}"),
            blanks: { bind: { options: ["127.0.0.1", "0.0.0.0"], answer: 0 } },
            checks: [{ describe: "Postgres is published on 127.0.0.1 only", test: (t) => /-\s*"127\.0\.0\.1:5432:5432"/.test(t) }],
            solution: COMPOSE_DB_PORT("127.0.0.1"),
            hints: ["Remember World 4: Docker publishes skip ufw.", "127.0.0.1"],
            writeToSim: true,
          },
          tags: ["postgres", "security"],
        },
        {
          id: "w7-04-b",
          mission: "Apply it.",
          task: {
            kind: "terminal",
            goals: [{ describe: "Postgres listens on web-1's 127.0.0.1 only", check: dbOnLocalhost }],
            hints: ["Compose only applies a changed file when you run up again.", "cd /srv/crumb, docker compose up -d"],
            guide: ["cd /srv/crumb", "docker compose up -d", "docker compose ps"],
            showMe: ["cd /srv/crumb", "docker compose up -d"],
            chips: ["cd /srv/crumb", "docker compose up -d", "docker compose ps"],
          },
          tags: ["postgres", "compose"],
        },
        {
          id: "w7-04-c",
          mission: "Now dig a tunnel. Open window 2 (the + tab) and run it from your laptop.",
          intel: {
            lines: ["An SSH tunnel carries a port through your SSH login.", "ssh -N -L 5433:127.0.0.1:5432 makes laptop port 5433 lead to Postgres on web-1. The window stays busy while it is open."],
          },
          task: {
            kind: "terminal",
            goals: [{ describe: "A tunnel listens on laptop port 5433", check: P.tunnelOpen(5433) }],
            hints: ["Run it in window 2, from your laptop. It shows nothing: a quiet tunnel is a working tunnel.", TUNNEL],
            guide: [TUNNEL],
            showMe: [TUNNEL],
            showMeShell: 1,
            windows: true,
            chips: [TUNNEL],
          },
          after: "A GUI like TablePlus or DBeaver now connects to localhost:5433. Ctrl+C in window 2 closes the tunnel.",
          review: {
            id: "w7-04-c-q",
            q: "In ssh -L 5433:127.0.0.1:5432, what is 5433?",
            options: ["The port on your laptop", "The port on web-1", "The SSH port"],
            answer: 0,
            why: "Left side: your laptop. Right side: where it leads, seen from web-1.",
            tag: "postgres",
          },
          tags: ["postgres", "ssh"],
        },
      ],
    },
    {
      id: "w7-05",
      world: 7,
      title: "Auth without RLS",
      base: "chain",
      start: "laptop",
      steps: [
        {
          id: "w7-05-a",
          mission: "On Supabase, RLS kept users out of each other's orders. Your app now connects as one database user, crumb, for everyone.",
          task: {
            kind: "predict",
            question: "A logged-in user asks your API for someone else's order. What stops them now?",
            options: ["Only the checks you write in your server code", "RLS, same as before", "Postgres knows who is logged in"],
            answer: 0,
            why: "Postgres sees one user, crumb. Every route must check who is asking before it reads or writes.",
          },
          basis: { taught: ["w7-01-a"] },
          tags: ["postgres", "security"],
        },
        {
          id: "w7-05-b",
          mission: "Quick round on life after Supabase.",
          task: {
            kind: "rapid",
            seconds: 35,
            items: [
              { id: "w7-05-b1", q: "Supabase Auth becomes...", options: ["login code in your app (or a library)", "a Postgres setting", "nothing, it moves as is"], answer: 0, why: "Sessions and passwords are now your app's job.", tag: "supabase" },
              { id: "w7-05-b2", q: "Uploaded files go to...", options: ["an S3-compatible storage service", "the Postgres volume", "the app's container"], answer: 0, why: "Containers are thrown away. Files need a real home.", tag: "supabase" },
              { id: "w7-05-b3", q: "From the app container, the database host is...", options: ["db", "localhost", "203.0.113.10"], answer: 0, why: "The compose service name.", tag: "postgres" },
              { id: "w7-05-b4", q: "Postgres published as 127.0.0.1:5432 is reachable from...", options: ["web-1 only", "the whole internet", "nowhere"], answer: 0, why: "127.0.0.1 is this machine.", tag: "postgres" },
              { id: "w7-05-b5", q: "Changed POSTGRES_PASSWORD after the first start. The database...", options: ["keeps the old password", "takes the new one", "wipes itself"], answer: 0, why: "Those settings are read once.", tag: "postgres" },
            ],
          },
          basis: { taught: ["w7-01-a", "w7-03-a", "w7-04-a", "w7-02-a"] },
          tags: ["postgres", "supabase"],
        },
      ],
    },
    {
      id: "w7-06",
      world: 7,
      title: "Migrations live in git",
      base: "chain",
      start: "laptop",
      steps: [
        {
          id: "w7-06-a",
          mission: "No more clicking columns into being. Changes travel with your code.",
          intel: {
            lines: ["A migration is a small file that changes the database's shape, like adding a column.", "Tools like Prisma or Drizzle write them. They live in git, so every server gets the same changes in the same order."],
          },
          task: {
            kind: "order",
            prompt: "Put a new column's journey in order. Top is first.",
            items: [
              "Write the migration on your laptop",
              "Commit it to git with the code that uses it",
              "Push and deploy the new code",
              "Run the migration against the server's database",
              "Start the new version of the app",
            ],
            why: "The database changes first, then the code that needs the new column starts.",
          },
          basis: { taught: ["self"] },
          tags: ["postgres", "migrations"],
        },
      ],
    },
    {
      id: "w7-07",
      world: 7,
      title: "Move the data from Supabase",
      base: "chain",
      start: "laptop",
      setup: (w) => {
        w.hosts.laptop.packages["postgresql-client"] = { version: "16+257build1" };
      },
      steps: [
        {
          id: "w7-07-a",
          mission: "Copy the shop's data out of Supabase onto your laptop.",
          intel: {
            lines: ["Supabase's Connect button shows the connection string.", "pg_dump copies a database into one file. -Fc makes a compact file, -n public takes only your own tables."],
          },
          task: {
            kind: "terminal",
            goals: [{ describe: "supabase.dump is on your laptop", check: P.dumpFile("laptop", "/home/you/supabase.dump") }],
            hints: ["Run it on your laptop. Tap the Type this button: the string is long.", `pg_dump -Fc -n public "${SUPABASE}" -f supabase.dump`],
            guide: [`pg_dump -Fc -n public "${SUPABASE}" -f supabase.dump`, "ls -la"],
            showMe: [`pg_dump -Fc -n public "${SUPABASE}" -f supabase.dump`],
            chips: ["ls -la"],
          },
          tags: ["postgres", "supabase", "backups"],
        },
        {
          id: "w7-07-b",
          mission: "Supabase's tables belong to roles like postgres and anon. Your server has only one role: crumb.",
          intel: { lines: ["pg_restore loads a dump file. --no-owner and --no-acl tell it to skip who owned things and who was granted what."] },
          task: {
            kind: "predict",
            question: "You restore without --no-owner --no-acl. What happens?",
            options: ["Errors like role \"anon\" does not exist, though the rows still load", "It refuses to start", "It creates Supabase's roles for you"],
            answer: 0,
            why: "Owners and grants point at roles your server does not have. Skip them, and the restore runs clean.",
          },
          basis: { taught: ["self", "w7-01-a"] },
          tags: ["postgres", "supabase"],
        },
        {
          id: "w7-07-c",
          mission: "Open the tunnel again in window 2.",
          task: {
            kind: "terminal",
            goals: [{ describe: "A tunnel listens on laptop port 5433", check: P.tunnelOpen(5433) }],
            hints: ["Same as before, in window 2 (the + tab).", TUNNEL],
            guide: [TUNNEL],
            showMe: [TUNNEL],
            showMeShell: 1,
            windows: true,
            chips: [TUNNEL],
          },
          tags: ["postgres", "ssh"],
        },
        {
          id: "w7-07-d",
          mission: "Back in window 1, restore the dump through the tunnel. The password is POSTGRES_PASSWORD from .env: s3cret-pg.",
          task: {
            kind: "terminal",
            goals: [{ describe: "The orders are in your own database", check: P.pgTableRows("crumb", "orders", 1000) }],
            hints: ["-h 127.0.0.1 -p 5433 is the laptop end of the tunnel.", RESTORE],
            guide: [RESTORE],
            showMe: [RESTORE, "s3cret-pg"],
            chips: [RESTORE],
          },
          after: "1,284 orders moved off Supabase. From now on, backups are your job too. That is World 8.",
          review: {
            id: "w7-07-d-q",
            q: "Restoring a Supabase dump into your own Postgres, add...",
            options: ["--no-owner --no-acl", "--force", "-U postgres"],
            answer: 0,
            why: "Supabase's roles do not exist on your server.",
            tag: "postgres",
          },
          tags: ["postgres", "supabase"],
        },
      ],
    },
    {
      id: "w7-08",
      world: 7,
      title: "Incident: the database is on the internet",
      base: "chain",
      start: "vps-deploy",
      steps: [
        {
          id: "w7-08-a",
          mission: "Incident! A security scanner emailed you.",
          task: { kind: "incident", incidentId: "db-port-public" },
          tags: ["postgres", "security", "debugging"],
        },
      ],
    },
  ],
};
