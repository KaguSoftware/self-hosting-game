import { describe, expect, it } from "vitest";
import { produce } from "immer";
import { createShell, runScript, topFrame } from "./shell/run";
import { createWorld, rentVps } from "./worlds";
import { dir, file, getDir, getFile, put } from "./fs";
import { traceHttp } from "./net";
import * as P from "./predicates";
import type { GoalCtx } from "./predicates";
import { INSTALL_SCRIPT_MARKER } from "./docker/install";
import type { Shell, World } from "./types";

const DEPLOY_PW = "correct-horse-42";

/** A rented VPS with a sudo user `deploy` (like the end of World 3), Docker not installed. */
function baseWorld(): World {
  return produce(createWorld(), (d) => {
    rentVps(d);
    const h = d.hosts.vps;
    h.users.deploy = { name: "deploy", uid: 1000, home: "/home/deploy", shell: "/bin/bash", password: DEPLOY_PW };
    h.groups.deploy = { name: "deploy", gid: 1000, members: [] };
    h.groups.sudo.members.push("deploy");
    put(h, "/home/deploy", dir(0o750, "deploy"));
    put(h, "/srv/crumb", dir(0o755, "deploy"));
  });
}

const rootSh = (): Shell => createShell("t", { host: "vps", user: "root", cwd: "/root", via: "console" });
const deploySh = (cwd = "/home/deploy"): Shell => createShell("t", { host: "vps", user: "deploy", cwd, via: "ssh", remote: "203.0.113.10" });

function run(lines: string[], w: World, sh: Shell = rootSh()) {
  const r = runScript(w, sh, lines);
  return { ...r, text: r.out.map((o) => o.text).join("\n") };
}

/** Docker installed with the convenience script, as root. */
function dockerWorld(): World {
  return run(["curl -fsSL https://get.docker.com -o get-docker.sh", "sh get-docker.sh"], baseWorld()).world;
}

function withFiles(w: World, files: Record<string, string>): World {
  return produce(w, (d) => {
    for (const [p, c] of Object.entries(files)) put(d.hosts.vps, p, file(c, 0o644, "deploy", "deploy"));
  });
}

const g = (w: World, shells: Shell[] = []): GoalCtx => ({ world: w, shells, log: [] });

describe("installing docker", () => {
  it("the official apt repository needs the key, the list file and apt update", () => {
    let r = run(["apt update", "apt install -y docker-ce"], baseWorld());
    expect(r.text).toContain("E: Unable to locate package docker-ce");
    r = run(
      [
        `echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" | tee /etc/apt/sources.list.d/docker.list`,
        "apt update",
      ],
      r.world,
      r.shell,
    );
    expect(r.text).toContain("NO_PUBKEY 7EA0A9C3F273FCD8");
    r = run(
      [
        "curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc",
        "apt update",
        "apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin",
        "docker --version",
        "docker compose version",
        "systemctl is-active docker",
      ],
      r.world,
      r.shell,
    );
    expect(r.text).toContain("https://download.docker.com/linux/ubuntu noble InRelease");
    expect(r.text).toContain("Docker version 27.3.1, build ce12230");
    expect(r.text).toContain("Docker Compose version v2.29.7");
    expect(r.text).toMatch(/^active$/m);
    const vps = r.world.hosts.vps;
    expect(vps.groups.docker).toBeTruthy();
    expect(getDir(vps, "/var/lib/docker")?.mode).toBe(0o710);
    expect(P.dockerInstalled(g(r.world))).toBe(true);
  });

  it("get.docker.com: download the script, then run it with sudo", () => {
    let r = run(["curl -fsSL https://get.docker.com -o get-docker.sh"], baseWorld(), deploySh());
    expect(getFile(r.world.hosts.vps, "/home/deploy/get-docker.sh")?.content).toContain(INSTALL_SCRIPT_MARKER);
    r = run(["sudo sh get-docker.sh", DEPLOY_PW], r.world, r.shell);
    expect(r.text).toContain("# Executing docker install script, commit:");
    expect(r.text).toContain("+ sh -c apt-get -qq update >/dev/null");
    expect(r.text).toContain("Server: Docker Engine - Community");
    expect(r.text).toContain("Access to the remote API on a privileged Docker daemon is equivalent");
    expect(P.dockerInstalled(g(r.world))).toBe(true);
    expect(P.pkgInstalled("docker-compose-plugin")(g(r.world))).toBe(true);
    // The script ran as root, so the deploy shell is still deploy afterwards.
    expect(topFrame(r.shell).user).toBe("deploy");
  });

  it("Ubuntu's docker.io has no compose until docker-compose-v2 is installed", () => {
    let r = run(["apt update", "apt install -y docker.io", "docker compose version"], baseWorld());
    expect(r.text).toContain("docker: 'compose' is not a docker command.");
    r = run(["apt install -y docker-compose-v2", "docker compose version"], r.world, r.shell);
    expect(r.text).toContain("Docker Compose version 2.24.6");
  });
});

describe("docker run, ps, stop, rm", () => {
  it("hello-world prints the real message and exits 0", () => {
    const r = run(["docker run hello-world", "docker ps -a"], dockerWorld());
    expect(r.text).toContain("Unable to find image 'hello-world:latest' locally");
    expect(r.text).toContain("latest: Pulling from library/hello-world");
    expect(r.text).toContain("Hello from Docker!");
    expect(r.text).toContain("This message shows that your installation appears to be working correctly.");
    expect(r.text).toMatch(/hello-world\s+"\/hello"\s+.*Exited \(0\)/);
  });

  it("runs, lists, stops and removes a container", () => {
    let r = run(["docker run -d --name web nginx:1.27"], dockerWorld());
    expect(r.text).toMatch(/^[0-9a-f]{64}$/m);
    r = run(["docker ps"], r.world, r.shell);
    expect(r.text).toMatch(/^CONTAINER ID\s+IMAGE\s+COMMAND\s+CREATED\s+STATUS\s+PORTS\s+NAMES$/m);
    expect(r.text).toMatch(/nginx:1\.27\s+"\/docker-entrypoint\.…"\s+.*Up \d+ seconds\s+80\/tcp\s+web/);
    expect(P.containerRunning("web")(g(r.world))).toBe(true);
    r = run(["docker rm web"], r.world, r.shell);
    expect(r.text).toContain('cannot remove container "/web": container is running');
    r = run(["docker stop web", "docker ps", "docker ps -a"], r.world, r.shell);
    expect(r.text).toMatch(/^web$/m);
    expect(r.text).toMatch(/Exited \(0\) \d+ seconds ago\s+web/);
    r = run(["docker rm web", "docker images"], r.world, r.shell);
    expect(P.containerAbsent("web")(g(r.world))).toBe(true);
    expect(r.text).toMatch(/nginx\s+1\.27\s+fb197595ebe7/);
    expect(P.imagePresent("nginx:1.27")(g(r.world))).toBe(true);
  });

  it("unknown images and name clashes give the daemon's errors", () => {
    const r = run(["docker run -d --name web nginx:1.27", "docker run -d --name web nginx:1.27", "docker pull crumb/nope", "docker pull nginx:9.9"], dockerWorld());
    expect(r.text).toContain('Conflict. The container name "/web" is already in use');
    expect(r.text).toContain("pull access denied for crumb/nope, repository does not exist or may require 'docker login'");
    expect(r.text).toContain("manifest for nginx:9.9 not found: manifest unknown");
  });

  it("a published port can only have one owner", () => {
    let w = produce(dockerWorld(), (d) => {
      d.hosts.vps.services.hello = {
        name: "hello",
        description: "hello",
        unitPath: "/etc/systemd/system/hello.service",
        enabled: true,
        state: "active",
        since: 0,
        pid: 2100,
        listens: [{ port: 8080, addr: "0.0.0.0", proc: "python3" }],
      };
    });
    const r = run(["docker run -d -p 80:80 --name web1 nginx:1.27", "docker run -d -p 80:80 --name web2 nginx:1.27", "docker run -d -p 8080:80 --name web3 nginx:1.27"], w);
    expect(r.text).toContain("Bind for 0.0.0.0:80 failed: port is already allocated");
    expect(r.text).toMatch(/failed to bind host port for 0\.0\.0\.0:8080:172\.17\.0\.\d+:80\/tcp: address already in use/);
    w = r.world;
    expect(w.hosts.vps.docker.containers.web2.status).toBe("created");
    expect(P.noPublishedPorts()(g(w))).toBe(false);
    expect(P.noPublishedPorts(["web1", "web2", "web3"])(g(w))).toBe(true);
  });

  it("curl reaches a published container; a wrong container port resets the connection", () => {
    const r = run(["docker run -d -p 8080:80 --name web nginx:1.27", "docker run -d -p 8081:8080 --name oops nginx:1.27", "curl localhost:8080", "curl localhost:8081"], dockerWorld());
    expect(r.text).toContain("<title>Welcome to nginx!</title>");
    expect(r.text).toContain("curl: (56) Recv failure: Connection reset by peer");
  });

  it("without -d the container holds the terminal and stops on Ctrl+C", () => {
    const r = run(["docker run --name fg nginx:1.27", "docker ps -a"], dockerWorld());
    expect(r.text).toContain("Configuration complete; ready for start up");
    expect(r.text).toContain("Add -d to run it in the background.");
    expect(r.text).toMatch(/Exited \(0\) .*fg/);
  });

  it("the default bridge has no names; exec shows the env", () => {
    const r = run(
      ["docker run -d --name one nginx:1.27", "docker run -d --name two nginx:1.27", "docker exec one curl -s http://two", "docker exec -e X=1 one printenv HOSTNAME", "docker exec one bash -c 'echo hi'"],
      dockerWorld(),
    );
    expect(r.text).toContain("curl: (6) Could not resolve host: two");
    expect(r.text).toMatch(/^[0-9a-f]{12}$/m);
    expect(r.text).toMatch(/^hi$/m);
  });
});

describe("who may use docker", () => {
  it("permission denied until the next login after joining the docker group", () => {
    let r = run(["su - deploy", "docker ps"], dockerWorld());
    expect(r.text).toContain(
      'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/containers/json": dial unix /var/run/docker.sock: connect: permission denied',
    );
    r = run(["exit", "usermod -aG docker deploy", "su - deploy", "docker ps"], r.world, r.shell);
    expect(r.text).toMatch(/CONTAINER ID\s+IMAGE/);
  });

  it("the same session keeps its old groups, newgrp or a new login fixes it", () => {
    let r = run(["sudo usermod -aG docker deploy", DEPLOY_PW, "docker ps"], dockerWorld(), deploySh());
    expect(r.text).toContain("connect: permission denied");
    expect(P.inGroup("deploy", "docker")(g(r.world))).toBe(true);
    r = run(["newgrp docker", "docker ps"], r.world, r.shell);
    expect(r.text).toMatch(/CONTAINER ID\s+IMAGE/);
    // A window opened later counts as a new login.
    r = run(["docker images"], r.world, deploySh());
    expect(r.text).toMatch(/REPOSITORY\s+TAG/);
  });

  it("docker run spells the error its own way", () => {
    const r = run(["docker run hello-world"], dockerWorld(), deploySh());
    expect(r.text).toContain('docker: permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Head "http://%2Fvar%2Frun%2Fdocker.sock/_ping"');
    expect(r.text).toContain("See 'docker run --help'.");
  });
});

const DB_COMPOSE = `services:
  db:
    image: postgres:17
    restart: unless-stopped
    env_file: .env
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
`;

const PG_ENV = "POSTGRES_USER=crumb\nPOSTGRES_PASSWORD=s3cret\nPOSTGRES_DB=crumb\n";

describe("compose basics", () => {
  it("finds no file, warns about version, validates keys and env files", () => {
    let r = run(["cd /srv/crumb", "docker compose up -d"], dockerWorld());
    expect(r.text).toContain("no configuration file provided: not found");
    let w = withFiles(r.world, { "/srv/crumb/compose.yaml": `version: "3.8"\nservices:\n  app:\n    image: nginx:1.27\n    enviroment:\n      A: b\n` });
    r = run(["docker compose up -d"], w, r.shell);
    expect(r.text).toContain("WARN[0000] /srv/crumb/compose.yaml: the attribute `version` is obsolete, it will be ignored, please remove it to avoid potential confusion");
    expect(r.text).toContain("validating /srv/crumb/compose.yaml: services.app Additional property enviroment is not allowed");
    w = withFiles(r.world, { "/srv/crumb/compose.yaml": DB_COMPOSE });
    r = run(["docker compose up -d"], w, r.shell);
    expect(r.text).toContain("env file /srv/crumb/.env not found: stat /srv/crumb/.env: no such file or directory");
  });

  it("interpolates ${VAR} from .env and the shell, warns when unset", () => {
    const w = withFiles(dockerWorld(), { "/srv/crumb/compose.yaml": "services:\n  app:\n    image: registry.gitlab.com/crumb/web:${TAG}\n    environment:\n      PORT: ${PORT:-3000}\n" });
    let r = run(["cd /srv/crumb", "docker compose config"], w);
    expect(r.text).toContain('WARN[0000] The "TAG" variable is not set. Defaulting to a blank string.');
    expect(r.text).toContain("PORT: \"3000\"");
    r = run(["TAG=abc123 docker compose config"], r.world, r.shell);
    expect(r.text).toContain("image: registry.gitlab.com/crumb/web:abc123");
    expect(r.text).not.toContain("variable is not set");
    const w2 = withFiles(r.world, { "/srv/crumb/.env": "TAG=from-env\n" });
    r = run(["docker compose config"], w2, r.shell);
    expect(r.text).toContain("image: registry.gitlab.com/crumb/web:from-env");
  });

  it("up -d prints Compose 2.29 lines and creates network, volume and container", () => {
    const w = withFiles(dockerWorld(), { "/srv/crumb/compose.yaml": DB_COMPOSE, "/srv/crumb/.env": PG_ENV });
    const r = run(["cd /srv/crumb", "docker compose up -d", "docker compose ps"], w);
    expect(r.text).toMatch(/\[\+\] Running 3\/3/);
    expect(r.text).toMatch(/ ✔ Network crumb_default\s+Created/);
    expect(r.text).toMatch(/ ✔ Volume "crumb_pgdata"\s+Created/);
    expect(r.text).toMatch(/ ✔ Container crumb-db-1\s+Started/);
    expect(r.text).toMatch(/^NAME\s+IMAGE\s+COMMAND\s+SERVICE\s+CREATED\s+STATUS\s+PORTS$/m);
    expect(r.text).toMatch(/crumb-db-1\s+postgres:17\s+"docker-entrypoint\.s…"\s+db\s+/);
    expect(r.world.hosts.vps.docker.volumes.crumb_pgdata.pg?.user).toBe("crumb");
    const again = run(["docker compose up -d"], r.world, r.shell);
    expect(again.text).toMatch(/ ✔ Container crumb-db-1\s+Running/);
  });

  it("the volume survives down, but not down -v", () => {
    const w = withFiles(dockerWorld(), { "/srv/crumb/compose.yaml": DB_COMPOSE, "/srv/crumb/.env": PG_ENV });
    let r = run(["cd /srv/crumb", "docker compose up -d", "docker compose down"], w);
    expect(r.text).toMatch(/ ✔ Container crumb-db-1\s+Removed/);
    expect(r.text).toMatch(/ ✔ Network crumb_default\s+Removed/);
    expect(P.containerAbsent("db")(g(r.world))).toBe(true);
    expect(P.volumeExists("pgdata")(g(r.world))).toBe(true);
    r = run(["docker compose up -d", "docker compose logs db"], r.world, r.shell);
    expect(r.text).toContain("db-1  | PostgreSQL Database directory appears to contain a database; Skipping initialization");
    r = run(["docker compose down -v", "docker volume ls"], r.world, r.shell);
    expect(r.text).toMatch(/ ✔ Volume crumb_pgdata\s+Removed/);
    expect(P.volumeAbsent("pgdata")(g(r.world))).toBe(true);
  });

  it("missing POSTGRES_PASSWORD: crash loop with the real error", () => {
    const w = withFiles(dockerWorld(), { "/srv/crumb/compose.yaml": DB_COMPOSE, "/srv/crumb/.env": "POSTGRES_USER=crumb\n" });
    const r = run(["cd /srv/crumb", "docker compose up -d", "sleep 10", "docker compose ps", "docker logs crumb-db-1"], w);
    expect(r.text).toMatch(/crumb-db-1\s+.*Restarting \(1\) \d+ seconds? ago/);
    expect(r.text).toContain("Error: Database is uninitialized and superuser password is not specified.");
    expect(r.text).toContain('       superuser. For example, "-e POSTGRES_PASSWORD=password" on "docker run".');
    const c = r.world.hosts.vps.docker.containers["crumb-db-1"];
    expect(c.status).toBe("restarting");
    expect(c.restartCount).toBeGreaterThan(1);
    expect(P.containerRunning("db")(g(r.world))).toBe(false);
  });
});

const APP_DB_COMPOSE = `services:
  app:
    image: registry.gitlab.com/crumb/web:latest
    restart: unless-stopped
    env_file: .env
  db:
    image: postgres:17
    restart: unless-stopped
    env_file: .env
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
`;

describe("compose: the app and its database", () => {
  it("localhost in DATABASE_URL is the app container itself; restart keeps the old env, up -d applies it", () => {
    const w = withFiles(dockerWorld(), {
      "/srv/crumb/compose.yaml": APP_DB_COMPOSE,
      "/srv/crumb/.env": PG_ENV + "DATABASE_URL=postgres://crumb:s3cret@localhost:5432/crumb\n",
    });
    let r = run(["cd /srv/crumb", "docker compose up -d", "docker compose logs app"], w);
    expect(r.text).toContain("app-1  | Error: connect ECONNREFUSED 127.0.0.1:5432");
    expect(P.appReachesDb("app")(g(r.world))).toBe(false);
    r = run(["sed -i 's/@localhost:/@db:/' .env", "docker compose restart app"], r.world, r.shell);
    expect(r.text).toMatch(/\[\+\] Restarting 1\/1/);
    expect(r.world.hosts.vps.docker.containers["crumb-app-1"].env.DATABASE_URL).toContain("@localhost:");
    expect(P.appReachesDb("app")(g(r.world))).toBe(false);
    r = run(["docker compose up -d"], r.world, r.shell);
    expect(r.text).toMatch(/ ✔ Container crumb-app-1\s+Recreated/);
    // db reads the same .env, so its config changed too and it is recreated as well (its data stays in the volume).
    expect(r.text).toMatch(/ ✔ Container crumb-db-1\s+Recreated/);
    expect(r.world.hosts.vps.docker.containers["crumb-app-1"].env.DATABASE_URL).toContain("@db:");
    expect(P.appReachesDb("app")(g(r.world))).toBe(true);
    expect(P.listensOn("app", "0.0.0.0")(g(r.world))).toBe(true);
  });

  it("healthcheck goes from starting to healthy as time passes; depends_on service_healthy waits", () => {
    const compose = `services:
  db:
    image: postgres:17
    env_file: .env
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U crumb -d crumb"]
      interval: 10s
      timeout: 5s
      retries: 5
volumes:
  pgdata:
`;
    let r = run(["cd /srv/crumb", "docker compose up -d", "docker compose ps"], withFiles(dockerWorld(), { "/srv/crumb/compose.yaml": compose, "/srv/crumb/.env": PG_ENV }));
    expect(r.text).toContain("(health: starting)");
    expect(P.containerHealthy("db")(g(r.world))).toBe(false);
    r = run(["sleep 30", "docker compose ps"], r.world, r.shell);
    expect(r.text).toMatch(/Up \d+ seconds \(healthy\)/);
    expect(P.containerHealthy("db")(g(r.world))).toBe(true);

    const withApp =
      compose.replace("volumes:\n  pgdata:\n", "") +
      `  app:
    image: registry.gitlab.com/crumb/web:latest
    env_file: .env
    depends_on:
      db:
        condition: service_healthy
volumes:
  pgdata:
`;
    r = run(["cd /srv/crumb", "docker compose up -d"], withFiles(dockerWorld(), { "/srv/crumb/compose.yaml": withApp, "/srv/crumb/.env": PG_ENV + "DATABASE_URL=postgres://crumb:s3cret@db:5432/crumb\n" }));
    const healthy = r.text.search(/✔ Container crumb-db-1\s+Healthy/);
    const appStarted = r.text.search(/✔ Container crumb-app-1\s+Started/);
    expect(healthy).toBeGreaterThan(0);
    expect(appStarted).toBeGreaterThan(healthy);
    expect(P.containerHealthy("db")(g(r.world))).toBe(true);
    expect(P.appReachesDb("app")(g(r.world))).toBe(true);
  });

  it("an unhealthy dependency stops up", () => {
    const compose = `services:
  db:
    image: postgres:17
    env_file: .env
    healthcheck:
      test: ["CMD-SHELL", "curl -f http://localhost:5432"]
      interval: 5s
      retries: 3
  app:
    image: registry.gitlab.com/crumb/web:latest
    depends_on:
      db:
        condition: service_healthy
`;
    const r = run(["cd /srv/crumb", "docker compose up -d"], withFiles(dockerWorld(), { "/srv/crumb/compose.yaml": compose, "/srv/crumb/.env": PG_ENV }));
    expect(r.text).toContain("dependency failed to start: container crumb-db-1 is unhealthy");
    expect(P.containerAbsent("app")(g(r.world))).toBe(true);
  });

  it("restart policy and published ports are visible to goals", () => {
    const compose = APP_DB_COMPOSE.replace("    env_file: .env\n    volumes:", '    env_file: .env\n    ports:\n      - "127.0.0.1:5432:5432"\n    volumes:');
    const r = run(["cd /srv/crumb", "docker compose up -d", "docker ps"], withFiles(dockerWorld(), { "/srv/crumb/compose.yaml": compose, "/srv/crumb/.env": PG_ENV }));
    expect(r.text).toContain("127.0.0.1:5432->5432/tcp");
    expect(P.restartPolicy("db", "unless-stopped")(g(r.world))).toBe(true);
    expect(P.noPublishedPorts()(g(r.world))).toBe(false);
    expect(P.noPublishedPorts(["db"])(g(r.world))).toBe(true);
  });
});

const PKG = `{\n  "name": "crumb",\n  "scripts": { "build": "next build", "start": "next start" },\n  "dependencies": { "next": "16.0.0" }\n}\n`;

function appContext(w: World, dockerfile: string, extra: Record<string, string> = {}): World {
  return withFiles(w, {
    "/srv/crumb/app/package.json": PKG,
    "/srv/crumb/app/package-lock.json": `{ "lockfileVersion": 3 }\n`,
    "/srv/crumb/app/next.config.ts": `export default { output: "standalone" };\n`,
    "/srv/crumb/app/app/page.tsx": `export default function Page() { return <h1>Crumb</h1>; }\n`,
    "/srv/crumb/app/.env": "DATABASE_URL=postgres://crumb:s3cret@localhost:5432/crumb\n",
    "/srv/crumb/app/node_modules/next/package.json": "{}\n",
    "/srv/crumb/app/Dockerfile": dockerfile,
    ...extra,
  });
}

const SLOW_DOCKERFILE = `FROM node:24-alpine
WORKDIR /app
COPY . .
RUN npm ci
RUN npm run build
CMD ["npm", "start"]
`;

const FAST_DOCKERFILE = `FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
CMD ["npm", "start"]
`;

const MULTI_STAGE = `FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_API_URL
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
EXPOSE 3000
CMD ["node", "server.js"]
`;

const npmCiLine = (text: string) => text.split("\n").filter((l) => l.includes("RUN npm ci")).pop() ?? "";

describe("docker build", () => {
  it("COPY . . above npm ci reruns npm ci after any code edit; the right order keeps it cached", () => {
    let r = run(["cd /srv/crumb/app", "docker build -t crumb-app ."], appContext(dockerWorld(), SLOW_DOCKERFILE));
    expect(r.text).toMatch(/\[\+\] Building [\d.]+s \(\d+\/\d+\) FINISHED/);
    expect(r.text).toContain("naming to docker.io/library/crumb-app:latest");
    expect(npmCiLine(r.text)).not.toContain("CACHED");
    r = run(["docker build -t crumb-app ."], r.world, r.shell);
    expect(npmCiLine(r.text)).toContain("CACHED [4/5] RUN npm ci");
    r = run([`echo 'export default function Page() { return <h1>New</h1>; }' > app/page.tsx`, "docker build -t crumb-app ."], r.world, r.shell);
    expect(npmCiLine(r.text)).not.toContain("CACHED");

    r = run(["cd /srv/crumb/app", "docker build -t crumb-app ."], appContext(dockerWorld(), FAST_DOCKERFILE));
    r = run([`echo 'export default function Page() { return <h1>New</h1>; }' > app/page.tsx`, "docker build -t crumb-app ."], r.world, r.shell);
    expect(npmCiLine(r.text)).toContain("CACHED [4/6] RUN npm ci");
    expect(r.text).toMatch(/=> \[5\/6\] COPY \. \./);
  });

  it("NEXT_PUBLIC_ values are baked in at build time; .env and node_modules ride along without .dockerignore", () => {
    let r = run(["cd /srv/crumb/app", "docker build --build-arg NEXT_PUBLIC_API_URL=https://api.crumb.shop -t crumb-app ."], appContext(dockerWorld(), MULTI_STAGE));
    expect(r.text).toContain("[deps 3/4] COPY package.json package-lock.json ./");
    expect(P.imageBaked("crumb-app", "NEXT_PUBLIC_API_URL", "https://api.crumb.shop")(g(r.world))).toBe(true);
    const img = r.world.hosts.vps.docker.images["crumb-app:latest"];
    expect(img.kind).toBe("nextjs");
    expect(img.meta?.env?.HOSTNAME).toBe("0.0.0.0");

    r = run(["docker build -t fat ."], appContext(dockerWorld(), SLOW_DOCKERFILE));
    r = run(["cd /srv/crumb/app", "docker build -t fat ."], r.world, r.shell);
    const files = r.world.hosts.vps.docker.images["fat:latest"].meta?.files ?? [];
    expect(files).toContain("/app/.env");
    expect(files).toContain("/app/node_modules");

    r = run(["cd /srv/crumb/app", "docker build -t slim ."], appContext(dockerWorld(), SLOW_DOCKERFILE, { "/srv/crumb/app/.dockerignore": ".env\nnode_modules\n.git\n" }));
    const slim = r.world.hosts.vps.docker.images["slim:latest"].meta?.files ?? [];
    expect(slim).not.toContain("/app/.env");
  });

  it("npm ci without a lock file fails the build like the real one", () => {
    const w = withFiles(dockerWorld(), { "/srv/crumb/app/package.json": PKG, "/srv/crumb/app/Dockerfile": "FROM node:24-alpine\nWORKDIR /app\nCOPY package.json ./\nRUN npm ci\n" });
    const r = run(["cd /srv/crumb/app", "docker build -t x ."], w);
    expect(r.text).toContain("The `npm ci` command can only install with an existing package-lock.json");
    expect(r.text).toContain('ERROR: failed to solve: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1');
  });

  it("compose build + a Next.js image without HOSTNAME binds the container IP, so a localhost healthcheck fails", () => {
    const df = MULTI_STAGE.replace("ENV HOSTNAME=0.0.0.0\n", "");
    const compose = `services:
  app:
    build: ./app
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3000 || exit 1"]
      interval: 10s
      retries: 3
`;
    let r = run(["cd /srv/crumb", "docker compose up -d --build", "sleep 60", "docker compose ps"], appContext(withFiles(dockerWorld(), { "/srv/crumb/compose.yaml": compose }), df));
    expect(r.text).toMatch(/ ✔ Service app\s+Built/);
    expect(r.text).toContain("(unhealthy)");
    const c = r.world.hosts.vps.docker.containers["crumb-app-1"];
    expect(c.listenAddr).toMatch(/^172\.18\.0\.\d+$/);
    expect(P.listensOn("app", "0.0.0.0")(g(r.world))).toBe(false);
    r = run(["docker compose logs app"], r.world, r.shell);
    expect(r.text).toMatch(/- Network:\s+http:\/\/172\.18\.0\.\d+:3000/);
  });

  it("required env missing: the app crashes and restarts", () => {
    const w = appContext(
      withFiles(dockerWorld(), { "/srv/crumb/compose.yaml": "services:\n  app:\n    build: ./app\n    restart: unless-stopped\n" }),
      MULTI_STAGE,
      { "/srv/crumb/app/src/env.ts": `if (!process.env.AUTH_SECRET) throw new Error("AUTH_SECRET is not set");\n` },
    );
    const r = run(["cd /srv/crumb", "docker compose up -d", "sleep 5", "docker compose logs app"], w);
    expect(r.text).toContain("app-1  | Error: AUTH_SECRET is not set");
    expect(r.world.hosts.vps.docker.containers["crumb-app-1"].status).toBe("restarting");
  });
});

describe("the demo world still works with the docker sim loaded", () => {
  it("a recreated demo app keeps the trace green", async () => {
    const { createDemoWorld } = await import("./worlds");
    const w = createDemoWorld();
    expect(traceHttp(w, "https://crumb.shop").ok).toBe(true);
    const r = run(["cd /srv/crumb", "docker compose up -d", "docker compose ps"], w);
    expect(r.text).toMatch(/crumb-app-1\s+registry\.gitlab\.com\/crumb\/web:latest/);
    expect(traceHttp(r.world, "https://crumb.shop").ok).toBe(true);
  });
});
