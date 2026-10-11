import * as P from "@/sim/predicates";
import { VPS_IP } from "@/sim/constants";
import { dir, file, getFile, put } from "@/sim/fs";
import type { World } from "@/sim/types";
import type { WorldDef } from "../schema";

const IP = VPS_IP;

/** The shop's Next.js code, the way a teammate would copy it onto the server. */
function placeApp(w: World) {
  const vps = w.hosts.vps;
  const own = (p: string, content: string, mode = 0o644) => put(vps, p, file(content, mode, "deploy", "deploy"));
  for (const d of ["/srv/crumb/app", "/srv/crumb/app/app", "/srv/crumb/app/lib", "/srv/crumb/app/public"]) put(vps, d, dir(0o755, "deploy", "deploy"));
  own(
    "/srv/crumb/app/package.json",
    `{\n  "name": "crumb",\n  "private": true,\n  "scripts": { "dev": "next dev", "build": "next build", "start": "next start" },\n  "dependencies": { "next": "16.0.0", "react": "19.2.0", "react-dom": "19.2.0", "pg": "8.13.1" }\n}\n`,
  );
  own("/srv/crumb/app/package-lock.json", `{\n  "name": "crumb",\n  "lockfileVersion": 3\n}\n`);
  own("/srv/crumb/app/next.config.ts", `import type { NextConfig } from "next";\n\nconst config: NextConfig = { output: "standalone" };\nexport default config;\n`);
  own("/srv/crumb/app/app/layout.tsx", `export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return <html lang="en"><body>{children}</body></html>;\n}\n`);
  own("/srv/crumb/app/app/page.tsx", `export default function Home() {\n  return <main><h1>{process.env.NEXT_PUBLIC_SHOP_NAME ?? "Crumb"}</h1></main>;\n}\n`);
  own("/srv/crumb/app/lib/env.ts", `if (!process.env.AUTH_SECRET) throw new Error("AUTH_SECRET is not set");\nexport const authSecret = process.env.AUTH_SECRET;\n`);
  own("/srv/crumb/app/public/logo.svg", `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="14"/></svg>\n`);
  own("/srv/crumb/app/.dockerignore", "node_modules\n.next\n.git\n.env*\n");
}

const ENV_LOCALHOST = `POSTGRES_USER=crumb
POSTGRES_PASSWORD=s3cret-pg
POSTGRES_DB=crumb
AUTH_SECRET=7f3c9a1e5b2d8f4a6c0e9b7d3f1a5c8e
DATABASE_URL=postgres://crumb:s3cret-pg@localhost:5432/crumb
`;
const ENV_FIXED = ENV_LOCALHOST.replace("@localhost:", "@db:");

const DOCKERFILE_BLANKS = `FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG {{pub}}
RUN npm run build

FROM node:24-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME={{host}}
ENV PORT=3000
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
CMD ["node", "{{entry}}"]
`;
const DOCKERFILE = DOCKERFILE_BLANKS.replace("{{pub}}", "NEXT_PUBLIC_SHOP_NAME").replace("{{host}}", "0.0.0.0").replace("{{entry}}", "server.js");

const COMPOSE_V1_BLANKS = `services:
  app:
    build: ./app
    env_file: .env
  db:
    image: postgres:{{tag}}
    env_file: .env
    volumes:
      - {{vol}}:/var/lib/postgresql/data

volumes:
  pgdata:
`;
const COMPOSE_V1 = COMPOSE_V1_BLANKS.replace("{{tag}}", "17").replace("{{vol}}", "pgdata");

const COMPOSE_V2_BLANKS = `services:
  app:
    build: ./app
    env_file: .env
    restart: {{rs}}
    depends_on:
      db:
        condition: {{cond}}
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

volumes:
  pgdata:
`;
const COMPOSE_V2 = COMPOSE_V2_BLANKS.replace("{{rs}}", "unless-stopped").replace("{{cond}}", "service_healthy");

const REORDER_SOLUTION = ["FROM node:24-alpine", "WORKDIR /app", "COPY package.json package-lock.json ./", "RUN npm ci", "COPY . .", "RUN npm run build"];
const REORDER_START = ["FROM node:24-alpine", "WORKDIR /app", "COPY . .", "RUN npm ci", "COPY package.json package-lock.json ./", "RUN npm run build"];
const lineAt = (t: string, re: RegExp) => t.split("\n").findIndex((l) => re.test(l));

export const world5: WorldDef = {
  id: 5,
  title: "Docker",
  tagline: "Images, volumes, compose, and the localhost trap",
  cheatSheet: [
    { cmd: "curl -fsSL https://get.docker.com -o get-docker.sh; sudo sh get-docker.sh", what: "install Docker with its official script" },
    { cmd: "sudo usermod -aG docker deploy", what: "docker without sudo. The docker group is as strong as root. Log in again after" },
    { cmd: "docker run -d --name NAME IMAGE", what: "start a container in the background" },
    { cmd: "docker ps / docker ps -a", what: "running containers / all, stopped ones too" },
    { cmd: "docker stop NAME; docker rm NAME", what: "stop it, then remove it. The image stays" },
    { cmd: "docker volume ls / docker volume rm NAME", what: "list volumes / delete one, and its data, for good" },
    { cmd: "COPY package files, RUN npm ci, then COPY . .", what: "Dockerfile order that keeps the npm ci layer cached" },
    { cmd: "HOSTNAME=0.0.0.0", what: "so a Next.js container answers other containers" },
    { cmd: "NEXT_PUBLIC_", what: "frozen in at build time. Secrets come at run time" },
    { cmd: "docker compose up -d --build", what: "build and start every service in compose.yaml" },
    { cmd: "docker compose logs app", what: "read one service's logs" },
    { cmd: "db, not localhost", what: "inside a container, localhost is that container. Use the service name" },
    { cmd: "docker compose up -d", what: "after editing .env: recreates what changed. restart does not" },
    { cmd: "docker compose down / docker compose down -v", what: "remove containers / also delete volumes (your data)" },
  ],
  levels: [
    {
      id: "w5-01",
      world: 5,
      title: "Install Docker",
      base: "chain",
      start: "vps-deploy",
      steps: [
        {
          id: "w5-01-a",
          mission: "Docker runs apps in containers. First, two words.",
          intel: { lines: ["An image is a frozen app plus everything it needs to run.", "A container is one running copy of an image."] },
          task: {
            kind: "predict",
            question: "You start three containers from one image. How many copies of the app run?",
            options: ["Three, each in its own container", "One, shared by all three", "None until you build again"],
            answer: 0,
            why: "One image, many containers. Like one recipe, many cakes.",
          },
          basis: { taught: ["self"] },
          tags: ["docker"],
        },
        {
          id: "w5-01-b",
          mission: "Install Docker on web-1.",
          intel: { lines: ["Docker's own install script sets up Docker and its add-ons in one go.", "curl downloads it. sudo sh runs it as root."] },
          task: {
            kind: "terminal",
            goals: [{ describe: "Docker is installed and running", check: P.dockerInstalled }],
            hints: ["Download the script with curl, then run it with sudo sh.", "curl -fsSL https://get.docker.com -o get-docker.sh, then sudo sh get-docker.sh"],
            guide: ["curl -fsSL https://get.docker.com -o get-docker.sh", "sudo sh get-docker.sh"],
            showMe: ["curl -fsSL https://get.docker.com -o get-docker.sh", "sudo sh get-docker.sh", "{{deployPassword}}"],
            chips: ["curl -fsSL https://get.docker.com -o get-docker.sh", "sudo sh get-docker.sh"],
          },
          after: "On a real server, read a script before you run it as root. This one is Docker's official installer.",
          tags: ["docker"],
        },
        {
          id: "w5-01-c",
          mission: "Run your first container.",
          task: {
            kind: "terminal",
            goals: [{ describe: "hello-world printed its message", check: P.saw(/Hello from Docker!/, "vps") }],
            hints: ["docker run, then the image name. It still needs sudo for now.", "sudo docker run hello-world"],
            guide: ["sudo docker run hello-world"],
            showMe: ["sudo docker run hello-world"],
            chips: ["sudo docker run hello-world"],
          },
          after: "Docker downloaded the hello-world image, made a container from it, the container printed this, then stopped.",
          tags: ["docker"],
        },
      ],
    },
    {
      id: "w5-02",
      world: 5,
      title: "Containers come and go",
      base: "chain",
      start: "vps-deploy",
      steps: [
        {
          id: "w5-02-a",
          mission: "Typing sudo before every docker command gets old. The docker group skips it.",
          task: {
            kind: "predict",
            question: "What does joining the docker group really give deploy?",
            options: ["Root powers: Docker can mount any file of the server into a container", "Only the right to list containers", "Nothing, it is just a label"],
            answer: 0,
            why: "Anyone in the docker group can become root. Only add people you would trust with sudo.",
          },
          basis: { guess: true },
          tags: ["docker", "security"],
        },
        {
          id: "w5-02-b",
          mission: "Add deploy to the docker group, then use docker without sudo.",
          intel: { lines: ["sudo usermod -aG docker deploy adds deploy to the docker group.", "Groups only count from your next login: exit, then ssh back in."] },
          task: {
            kind: "terminal",
            goals: [
              { describe: "deploy is in the docker group", check: P.inGroup("deploy", "docker") },
              { describe: "docker ps works without sudo", check: P.ran(/^docker ps\b/, "vps") },
            ],
            hints: ["After usermod, docker ps still says permission denied until you log in again.", `sudo usermod -aG docker deploy, exit, ssh deploy@${IP}, docker ps`],
            guide: ["sudo usermod -aG docker deploy", "exit", `ssh deploy@${IP}`, "docker ps"],
            showMe: ["sudo usermod -aG docker deploy", "{{deployPassword}}", "exit", `ssh deploy@${IP}`, "docker ps"],
            chips: ["sudo usermod -aG docker deploy", "exit", `ssh deploy@${IP}`, "docker ps"],
          },
          review: {
            id: "w5-02-b-q",
            q: "You just joined the docker group, but docker ps says permission denied. Why?",
            options: ["Groups only count from your next login", "Docker is not installed", "You need sudo forever"],
            answer: 0,
            why: "Log out and back in (exit, then ssh) and it works.",
            tag: "docker",
          },
          tags: ["docker", "users"],
        },
        {
          id: "w5-02-c",
          mission: "Run a real web server in the background.",
          intel: { lines: ["nginx:1.27 means the image nginx, version (tag) 1.27.", "-d runs it in the background. --name gives it a name you choose."] },
          task: {
            kind: "terminal",
            goals: [{ describe: "A container called web is running", check: P.containerRunning("web") }],
            hints: ["docker run with -d and --name web, then the image.", "docker run -d --name web nginx:1.27"],
            guide: ["docker run -d --name web nginx:1.27", "docker ps"],
            showMe: ["docker run -d --name web nginx:1.27", "docker ps"],
            chips: ["docker run -d --name web nginx:1.27", "docker ps"],
          },
          tags: ["docker"],
        },
        {
          id: "w5-02-d",
          mission: "Tap the container that stopped but still exists.",
          intel: { lines: ["docker ps shows running containers. docker ps -a shows stopped ones too."] },
          task: {
            kind: "spot",
            prompt: "docker ps -a",
            mono: true,
            lines: [
              "CONTAINER ID   IMAGE         COMMAND                  CREATED         STATUS                     PORTS    NAMES",
              'a3f2c91d8e7b   nginx:1.27    "/docker-entrypoint.…"   2 minutes ago   Up 2 minutes               80/tcp   web',
              '8b41d0e2a6c5   hello-world   "/hello"                 6 minutes ago   Exited (0) 6 minutes ago            brave_tesla',
            ],
            bugs: [2],
            why: "Exited means it stopped. It stays on the list until you remove it with docker rm.",
          },
          basis: { taught: ["self"] },
          tags: ["docker"],
        },
        {
          id: "w5-02-e",
          mission: "Clean up: stop and remove web. Keep its image.",
          intel: { lines: ["docker stop stops a container. docker rm removes it. The image stays for next time."] },
          task: {
            kind: "terminal",
            goals: [
              { describe: "The web container is gone", check: P.containerAbsent("web") },
              { describe: "The nginx:1.27 image is still here", check: P.imagePresent("nginx:1.27") },
            ],
            hints: ["Stop first, then remove. docker images lists what is left.", "docker stop web, docker rm web, docker images"],
            guide: ["docker stop web", "docker rm web", "docker images"],
            showMe: ["docker stop web", "docker rm web", "docker images"],
            chips: ["docker stop web", "docker rm web", "docker images"],
          },
          review: {
            id: "w5-02-e-q",
            q: "You removed a container. Its image...",
            options: ["stays, ready for the next container", "is deleted too", "keeps running"],
            answer: 0,
            why: "Containers come and go. Images stay until you delete them.",
            tag: "docker",
          },
          tags: ["docker"],
        },
      ],
    },
    {
      id: "w5-03",
      world: 5,
      title: "Volumes keep your data",
      base: "chain",
      start: "vps-deploy",
      steps: [
        {
          id: "w5-03-a",
          mission: "Containers are thrown away all the time. Your database must not be.",
          intel: { lines: ["A container's own files vanish when the container is removed.", "A volume is storage kept outside the container, so it survives."] },
          task: {
            kind: "predict",
            question: "Postgres runs with no volume. You remove the container and start a fresh one. Your orders?",
            options: ["Gone", "Still there", "Copied into the image"],
            answer: 0,
            why: "Without a volume, the data lived inside the container, and the container is gone.",
          },
          basis: { taught: ["self"] },
          tags: ["docker", "volumes"],
        },
        {
          id: "w5-03-b",
          mission: "Run a test database that keeps its data in a volume called pgdata.",
          intel: { lines: ["-e sets a setting inside the container.", "-v pgdata:/var/lib/postgresql/data attaches the pgdata volume where Postgres keeps its files."] },
          task: {
            kind: "terminal",
            goals: [
              { describe: "A container called db is running", check: P.containerRunning("db") },
              { describe: "The pgdata volume exists", check: P.volumeExists("pgdata") },
            ],
            hints: ["One long docker run: -d, --name db, -e for the password, -v for the volume, then postgres:17.", "Tap the Type this button. Then docker volume ls."],
            guide: ["docker run -d --name db -e POSTGRES_PASSWORD=dev -v pgdata:/var/lib/postgresql/data postgres:17", "docker volume ls"],
            showMe: ["docker run -d --name db -e POSTGRES_PASSWORD=dev -v pgdata:/var/lib/postgresql/data postgres:17", "docker volume ls"],
            chips: ["docker volume ls", "docker ps"],
          },
          tags: ["docker", "volumes"],
        },
        {
          id: "w5-03-c",
          mission: "The test database keeps its files in the pgdata volume.",
          intel: { lines: ["docker rm -f removes a container even while it runs."] },
          task: {
            kind: "predict",
            question: "You run docker rm -f db, then the same docker run line again. Your data?",
            options: ["Still there: the volume was never removed", "Gone", "Half of it"],
            answer: 0,
            why: "The new container attaches the same pgdata volume and finds the old files.",
          },
          basis: { taught: ["w5-03-a", "w5-03-b"] },
          tags: ["docker", "volumes"],
        },
        {
          id: "w5-03-d",
          mission: "Clean up the test. This time, really delete the data.",
          task: {
            kind: "terminal",
            goals: [
              { describe: "The db container is gone", check: P.containerAbsent("db") },
              { describe: "The pgdata volume is gone", check: P.volumeAbsent("pgdata") },
            ],
            hints: ["Remove the container first. A volume in use cannot be deleted.", "docker rm -f db, then docker volume rm pgdata"],
            guide: ["docker rm -f db", "docker volume rm pgdata"],
            showMe: ["docker rm -f db", "docker volume rm pgdata"],
            chips: ["docker rm -f db", "docker volume rm pgdata", "docker volume ls"],
          },
          after: "docker volume rm is the command that really deletes data. Treat it like rm on your database.",
          review: {
            id: "w5-03-d-q",
            q: "Which one deletes the data for good?",
            options: ["docker volume rm pgdata", "docker rm -f db", "docker stop db"],
            answer: 0,
            why: "Removing a container leaves its volume. Removing the volume removes the data.",
            tag: "volumes",
          },
          tags: ["docker", "volumes"],
        },
      ],
    },
    {
      id: "w5-04",
      world: 5,
      title: "Layers and the build cache",
      base: "chain",
      start: "vps-deploy",
      steps: [
        {
          id: "w5-04-a",
          mission: "A teammate's Dockerfile takes minutes to build after every tiny code edit.",
          intel: {
            lines: ["A Dockerfile is the recipe for an image. Each line makes a layer.", "Docker reuses saved layers until the first line whose input changed. Every line after it runs again."],
          },
          task: {
            kind: "spot",
            prompt: "Tap the line that makes every code edit reinstall all packages.",
            mono: true,
            lines: ["FROM node:24-alpine", "WORKDIR /app", "COPY . .", "RUN npm ci", "RUN npm run build"],
            bugs: [2],
            why: "COPY . . copies all your code. Any edit changes it, so npm ci runs again every time. Copy the package files first.",
          },
          basis: { taught: ["self"] },
          tags: ["docker", "dockerfile"],
        },
        {
          id: "w5-04-b",
          mission: "Put the lines in the order that keeps npm ci cached.",
          task: {
            kind: "config",
            host: "vps",
            path: "/srv/crumb/app/Dockerfile.draft",
            lang: "dockerfile",
            mode: "reorder",
            start: REORDER_START.join("\n"),
            checks: [
              { describe: "FROM and WORKDIR come first", test: (t) => lineAt(t, /^FROM/) === 0 && lineAt(t, /^WORKDIR/) === 1 },
              { describe: "Package files are copied before npm ci", test: (t) => lineAt(t, /^COPY package/) < lineAt(t, /npm ci/) },
              { describe: "npm ci runs before your code is copied", test: (t) => lineAt(t, /npm ci/) < lineAt(t, /^COPY \. \./) },
              { describe: "The build runs last", test: (t) => lineAt(t, /npm run build/) === 5 },
            ],
            solution: REORDER_SOLUTION.join("\n"),
            hints: ["What changes least goes highest: the package list changes less often than your code.", "FROM, WORKDIR, COPY package files, npm ci, COPY . ., build"],
            writeToSim: false,
          },
          review: {
            id: "w5-04-b-q",
            q: "Why copy package.json before the rest of the code?",
            options: ["So npm ci stays cached when only code changes", "Docker needs it alphabetical", "It makes the image smaller"],
            answer: 0,
            why: "A layer reruns only when its input changes.",
            tag: "dockerfile",
          },
          tags: ["docker", "dockerfile"],
        },
        {
          id: "w5-04-c",
          mission: "With the lines in that order, you change only app/page.tsx and build again.",
          task: {
            kind: "predict",
            question: "Which lines run again?",
            options: ["Only COPY . . and npm run build", "Everything from FROM down", "Nothing, it is all cached"],
            answer: 0,
            why: "Everything above COPY . . has the same input as last time, so Docker reuses it.",
          },
          basis: { taught: ["w5-04-a"] },
          tags: ["docker", "dockerfile"],
        },
      ],
    },
    {
      id: "w5-05",
      world: 5,
      title: "A Dockerfile for Next.js",
      base: "chain",
      start: "vps-deploy",
      setup: placeApp,
      steps: [
        {
          id: "w5-05-a",
          mission: "The shop's code is now on web-1 in /srv/crumb/app. One Vercel habit will bite you.",
          intel: {
            lines: ["On Vercel, your settings exist while the app builds.", "In Docker, the build only sees what you pass in. NEXT_PUBLIC_ values are frozen into the code at build time."],
          },
          task: {
            kind: "predict",
            question: "NEXT_PUBLIC_SHOP_NAME is set only when the container starts. What does the browser get?",
            options: ["An empty value: it was frozen in at build time", "The right value", "An error page"],
            answer: 0,
            why: "Pass NEXT_PUBLIC_ values to the build. Server-only secrets can wait until the container starts.",
          },
          basis: { taught: ["self"] },
          tags: ["docker", "nextjs"],
        },
        {
          id: "w5-05-b",
          mission: "Fill in the shop's Dockerfile. It builds in three stages and keeps only what is needed.",
          intel: {
            lines: ['output: "standalone" makes Next.js build a small server.js.', "HOSTNAME=0.0.0.0 lets other containers reach it.", "Only NEXT_PUBLIC_ values go in the build. Secrets come later."],
          },
          task: {
            kind: "config",
            host: "vps",
            path: "/srv/crumb/app/Dockerfile",
            lang: "dockerfile",
            mode: "blanks",
            start: DOCKERFILE_BLANKS,
            blanks: {
              pub: { options: ["NEXT_PUBLIC_SHOP_NAME", "AUTH_SECRET", "DATABASE_URL"], answer: 0 },
              host: { options: ["0.0.0.0", "127.0.0.1", "localhost"], answer: 0 },
              entry: { options: ["server.js", "app/page.tsx", "package.json"], answer: 0 },
            },
            checks: [
              { describe: "Only a NEXT_PUBLIC_ value is passed to the build", test: (t) => /^ARG NEXT_PUBLIC_\w+\s*$/m.test(t) && !/^ARG (AUTH_SECRET|DATABASE_URL)/m.test(t) },
              { describe: "The server listens on every address", test: (t) => /^ENV HOSTNAME=0\.0\.0\.0\s*$/m.test(t) },
              { describe: "It starts the standalone server", test: (t) => /CMD \["node", "server\.js"\]/.test(t) },
            ],
            solution: DOCKERFILE,
            hints: ["Secrets never go in the build. 0.0.0.0 means every address.", "NEXT_PUBLIC_SHOP_NAME, 0.0.0.0, server.js"],
            writeToSim: true,
          },
          review: {
            id: "w5-05-b-q",
            q: "A Next.js container works alone, but the proxy container gets refused. Likely missing:",
            options: ["ENV HOSTNAME=0.0.0.0", "EXPOSE 80", "NODE_ENV=production"],
            answer: 0,
            why: "Without it, the server only answers inside its own container.",
            tag: "nextjs",
          },
          tags: ["docker", "nextjs", "dockerfile"],
        },
        {
          id: "w5-05-c",
          mission: "Some files should never be copied into an image.",
          intel: { lines: [".dockerignore lists files the build must skip, like .gitignore does for git."] },
          task: {
            kind: "match",
            prompt: "Tap a file, then a bucket.",
            buckets: ["Skip it (.dockerignore)", "The build needs it"],
            items: [
              { text: "node_modules", bucket: 0 },
              { text: ".env (secrets)", bucket: 0 },
              { text: ".git", bucket: 0 },
              { text: "package.json", bucket: 1 },
              { text: "package-lock.json", bucket: 1 },
              { text: "app/", bucket: 1 },
            ],
            why: "Secrets in an image leak to anyone who gets the image. node_modules is rebuilt inside anyway.",
          },
          basis: { taught: ["self"] },
          tags: ["docker", "security"],
        },
      ],
    },
    {
      id: "w5-06",
      world: 5,
      title: "Compose: the whole shop in one file",
      base: "chain",
      start: "vps-deploy",
      setup: (w) => {
        // The intern pasted the laptop's .env, so the database address says localhost.
        const vps = w.hosts.vps;
        const env = getFile(vps, "/srv/crumb/.env");
        if (env) env.content = ENV_LOCALHOST;
        else put(vps, "/srv/crumb/.env", file(ENV_LOCALHOST, 0o600, "deploy", "deploy"));
      },
      steps: [
        {
          id: "w5-06-a",
          mission: "Write the compose file for the shop: the app and its database.",
          intel: {
            lines: ["Compose starts all your containers from one file. Each one is a service.", "A service's name is also its address: the app finds Postgres at db.", "Pin versions: postgres:17, not latest."],
          },
          task: {
            kind: "config",
            host: "vps",
            path: "/srv/crumb/compose.yaml",
            lang: "yaml",
            mode: "blanks",
            start: COMPOSE_V1_BLANKS,
            blanks: {
              tag: { options: ["17", "latest"], answer: 0 },
              vol: { options: ["pgdata", "/tmp"], answer: 0 },
            },
            checks: [
              { describe: "Postgres is pinned to version 17", test: (t) => /image:\s*postgres:17\s*$/m.test(t) },
              { describe: "Its data lives in the pgdata volume", test: (t) => /-\s*pgdata:\/var\/lib\/postgresql\/data/.test(t) },
            ],
            solution: COMPOSE_V1,
            hints: ["latest changes under you one day. /tmp is wiped.", "17 and pgdata"],
            writeToSim: true,
          },
          tags: ["docker", "compose"],
        },
        {
          id: "w5-06-b",
          mission: "Build and start the shop, then read the app's log.",
          intel: { lines: ["docker compose up -d --build builds the app's image and starts every service in the background."] },
          task: {
            kind: "terminal",
            goals: [
              { describe: "The db service is running", check: P.containerRunning("db") },
              { describe: "The app's log shows why it cannot reach the database", check: P.saw(/ECONNREFUSED 127\.0\.0\.1:5432/, "vps") },
            ],
            hints: ["Go to /srv/crumb first. Compose reads compose.yaml from the folder you are in.", "cd /srv/crumb, docker compose up -d --build, docker compose logs app"],
            guide: ["cd /srv/crumb", "docker compose up -d --build", "docker compose logs app"],
            showMe: ["cd /srv/crumb", "docker compose up -d --build", "docker compose logs app"],
            chips: ["cd /srv/crumb", "docker compose up -d --build", "docker compose ps", "docker compose logs app"],
          },
          tags: ["docker", "compose"],
        },
        {
          id: "w5-06-c",
          mission: "Postgres is up and running, yet the app cannot reach it.",
          task: {
            kind: "predict",
            question: "Why does the app knock on 127.0.0.1:5432?",
            options: ["DATABASE_URL says localhost, and inside the app's container that is the app itself", "Postgres is broken", "ufw blocks port 5432"],
            answer: 0,
            why: "Each container has its own localhost. The database lives at its service name: db.",
          },
          basis: { taught: ["w4-03-b", "w5-06-a"] },
          tags: ["docker", "compose", "debugging"],
        },
        {
          id: "w5-06-d",
          mission: "Fix the address in the shop's .env file.",
          task: {
            kind: "config",
            host: "vps",
            path: "/srv/crumb/.env",
            lang: "ini",
            mode: "fix",
            start: ENV_LOCALHOST,
            checks: [
              { describe: "DATABASE_URL points at the db service", test: (t) => /^DATABASE_URL=postgres:\/\/[^@\s]+@db:5432\/crumb\s*$/m.test(t) },
              { describe: "Nothing else changed", test: (t) => /^AUTH_SECRET=\w+/m.test(t) && /^POSTGRES_PASSWORD=s3cret-pg/m.test(t) },
            ],
            solution: ENV_FIXED,
            hints: ["Only one word in the last line is wrong.", "Change @localhost: to @db:"],
            writeToSim: true,
          },
          tags: ["docker", "compose"],
        },
        {
          id: "w5-06-e",
          mission: "Make the app pick up the new .env.",
          intel: {
            lines: ["docker compose restart keeps each container exactly as it was, old settings included.", "docker compose up -d sees what changed and recreates it."],
          },
          task: {
            kind: "terminal",
            goals: [{ describe: "The app reaches the database", check: P.appReachesDb("app") }],
            hints: ["restart will not do it. You want the command that recreates changed containers.", "docker compose up -d, then docker compose logs app"],
            guide: ["docker compose up -d", "docker compose logs app"],
            showMe: ["docker compose up -d", "docker compose logs app"],
            chips: ["docker compose restart app", "docker compose up -d", "docker compose logs app"],
          },
          review: {
            id: "w5-06-e-q",
            q: "You changed .env. Which command makes the app use it?",
            options: ["docker compose up -d", "docker compose restart app", "docker compose logs app"],
            answer: 0,
            why: "restart keeps the old settings. up -d recreates containers whose settings changed.",
            tag: "compose",
          },
          tags: ["docker", "compose"],
        },
      ],
    },
    {
      id: "w5-07",
      world: 5,
      title: "Healthy, restarting, pinned",
      base: "chain",
      start: "vps-deploy",
      steps: [
        {
          id: "w5-07-a",
          mission: "Review a teammate's compose file. Tap every risky line.",
          intel: {
            lines: ["Pin versions, so an update never surprises you.", "A restart policy brings a container back after a crash or a reboot.", "A healthcheck is a test Docker runs to see if the app really works."],
          },
          task: {
            kind: "spot",
            prompt: "Their compose.yaml",
            mono: true,
            lines: ["services:", "  db:", "    image: postgres:latest", '    restart: "no"', "    ports:", '      - "5432:5432"'],
            bugs: [2, 3, 5],
            why: "latest moves under you, \"no\" stays down after a crash, and a published 5432 puts the database on the internet (Docker skips ufw).",
          },
          basis: { taught: ["self", "w4-07-a"] },
          tags: ["docker", "compose", "security"],
        },
        {
          id: "w5-07-b",
          mission: "Make the shop come back by itself, and start the app only once the database is ready.",
          task: {
            kind: "config",
            host: "vps",
            path: "/srv/crumb/compose.yaml",
            lang: "yaml",
            mode: "blanks",
            start: COMPOSE_V2_BLANKS,
            blanks: {
              rs: { options: ["unless-stopped", '"no"'], answer: 0 },
              cond: { options: ["service_healthy", "service_started"], answer: 0 },
            },
            checks: [
              { describe: "The app restarts unless you stopped it", test: (t) => /app:[\s\S]*?restart:\s*unless-stopped/.test(t) },
              { describe: "The app waits for a healthy database", test: (t) => /condition:\s*service_healthy/.test(t) },
            ],
            solution: COMPOSE_V2,
            hints: ["service_started only means the container started, not that Postgres is ready.", "unless-stopped and service_healthy"],
            writeToSim: true,
          },
          tags: ["docker", "compose"],
        },
        {
          id: "w5-07-c",
          mission: "Apply it and check every service.",
          task: {
            kind: "terminal",
            goals: [
              { describe: "db is healthy", check: P.containerHealthy("db") },
              { describe: "app and db restart unless stopped", check: P.all(P.restartPolicy("app", "unless-stopped"), P.restartPolicy("db", "unless-stopped")) },
              { describe: "No container publishes a port", check: P.noPublishedPorts() },
            ],
            hints: ["Same as before: up -d applies the changed file. ps shows health.", "docker compose up -d, then docker compose ps"],
            guide: ["cd /srv/crumb", "docker compose up -d", "docker compose ps"],
            showMe: ["cd /srv/crumb", "docker compose up -d", "docker compose ps"],
            chips: ["cd /srv/crumb", "docker compose up -d", "docker compose ps"],
          },
          tags: ["docker", "compose"],
        },
        {
          id: "w5-07-d",
          mission: "One command in this list destroys data.",
          intel: { lines: ["docker compose down removes the containers. docker compose down -v also deletes the volumes."] },
          task: {
            kind: "predict",
            question: "Which one wipes the shop's orders?",
            options: ["docker compose down -v", "docker compose down", "docker compose restart"],
            answer: 0,
            why: "-v deletes pgdata. Without -v, your data waits in the volume for the next up.",
          },
          basis: { taught: ["self"] },
          tags: ["docker", "volumes"],
        },
        {
          id: "w5-07-e",
          mission: "World 5 review. Go fast.",
          task: {
            kind: "rapid",
            seconds: 45,
            items: [
              { id: "w5-07-e1", q: "Image vs container:", options: ["the recipe vs a running copy", "the same thing", "a VM vs a laptop"], answer: 0, why: "Many containers can come from one image.", tag: "docker" },
              { id: "w5-07-e2", q: "The docker group is as strong as...", options: ["root", "a guest", "the deploy user"], answer: 0, why: "It can mount any file into a container.", tag: "security" },
              { id: "w5-07-e3", q: "Data that must survive a new container goes in...", options: ["a volume", "the image", "/tmp"], answer: 0, why: "Volumes outlive containers.", tag: "volumes" },
              { id: "w5-07-e4", q: "NEXT_PUBLIC_ values are...", options: ["frozen in at build time", "read when the page loads", "secret"], answer: 0, why: "Pass them to the build.", tag: "nextjs" },
              { id: "w5-07-e5", q: "Inside the app container, the database is at...", options: ["db:5432", "localhost:5432", "203.0.113.10:5432"], answer: 0, why: "Use the service name.", tag: "compose" },
              { id: "w5-07-e6", q: "After editing .env, run...", options: ["docker compose up -d", "docker compose restart", "nothing, it reloads"], answer: 0, why: "up -d recreates what changed.", tag: "compose" },
              { id: "w5-07-e7", q: "Which tag is safest for a database?", options: ["postgres:17", "postgres:latest"], answer: 0, why: "Pinned versions do not change under you.", tag: "compose" },
              { id: "w5-07-e8", q: "docker compose down -v...", options: ["deletes your volumes and their data", "only stops containers", "updates images"], answer: 0, why: "Never run it on production by accident.", tag: "volumes" },
            ],
          },
          basis: { taught: ["w5-01-a", "w5-02-a", "w5-03-a", "w5-05-a", "w5-06-c", "w5-06-e", "w5-07-a", "w5-07-d"] },
          tags: ["docker"],
        },
      ],
    },
    {
      id: "w5-08",
      world: 5,
      title: "Incidents: crash loops and localhost",
      base: "chain",
      start: "vps-deploy",
      steps: [
        {
          id: "w5-08-a",
          mission: "Incident! The shop is down after a small change.",
          task: { kind: "incident", incidentId: "crash-loop-env" },
          tags: ["docker", "debugging"],
        },
        {
          id: "w5-08-b",
          mission: "Incident! Orders fail with a 500.",
          task: { kind: "incident", incidentId: "db-localhost" },
          tags: ["docker", "debugging"],
        },
      ],
    },
  ],
};
