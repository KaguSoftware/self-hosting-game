import { dir, file, put } from "./fs";
import {
  DOMAIN,
  LAPTOP_IP,
  LAPTOP_USER,
  PLANS,
  ROOT_PASSWORD,
  VPS_HOSTNAME,
  VPS_IP,
  VPS_PRIVATE_IP,
} from "./constants";
import type { Container, Host, Service, World } from "./types";
import { loadSshdConfig } from "./sshd";
import { hashHex } from "./util";

export const SSHD_CONFIG = `# This is the sshd server system-wide configuration file.  See
# sshd_config(5) for more information.

Include /etc/ssh/sshd_config.d/*.conf

#Port 22
#ListenAddress 0.0.0.0

PermitRootLogin yes
#PubkeyAuthentication yes

# Expect .ssh/authorized_keys2 to be disregarded by default in future.
#AuthorizedKeysFile	.ssh/authorized_keys .ssh/authorized_keys2

# To disable tunneled clear text passwords, change to "no" here!
#PasswordAuthentication yes
#PermitEmptyPasswords no

KbdInteractiveAuthentication no
UsePAM yes

X11Forwarding yes
PrintMotd no

AcceptEnv LANG LC_*
Subsystem	sftp	/usr/lib/openssh/sftp-server
`;

export const CLOUD_INIT_SSHD = `PasswordAuthentication yes
`;

const OS_RELEASE = `PRETTY_NAME="Ubuntu 24.04.1 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
VERSION="24.04.1 LTS (Noble Numbat)"
VERSION_CODENAME=noble
ID=ubuntu
ID_LIKE=debian
HOME_URL="https://www.ubuntu.com/"
UBUNTU_CODENAME=noble
`;

const BASHRC = `# ~/.bashrc: executed by bash(1) for non-login shells.
case $- in
    *i*) ;;
      *) return;;
esac
HISTSIZE=1000
alias ll='ls -alF'
`;

function emptyHost(id: Host["id"]): Host {
  return {
    id,
    hostname: id,
    privateIp: "",
    os: "",
    cpus: 1,
    memMb: 1024,
    diskGb: 20,
    baseUsedMb: 2000,
    fs: dir(),
    users: {},
    groups: {},
    packages: {},
    aptFresh: false,
    services: {},
    ufw: { enabled: false, defaultIncoming: "deny", rules: [] },
    docker: { images: {}, containers: {}, volumes: {}, networks: {} },
    journal: [],
    crontabs: {},
  };
}

function baseTree(h: Host) {
  for (const p of ["/bin", "/usr/bin", "/usr/lib", "/usr/sbin", "/opt", "/srv", "/mnt", "/var/lib", "/var/cache", "/run", "/proc", "/boot"]) {
    put(h, p, dir());
  }
  put(h, "/etc", dir());
  put(h, "/var", dir());
  put(h, "/var/log", dir(0o775, "root", "syslog"));
  put(h, "/home", dir());
  put(h, "/root", dir(0o700));
  put(h, "/tmp", dir(0o1777));
  put(h, "/etc/os-release", file(OS_RELEASE));
  put(h, "/etc/shadow", file("root:*:20000:0:99999:7:::\n", 0o640, "root", "shadow"));
  put(h, "/root/.bashrc", file(BASHRC));
}

function addUser(h: Host, name: string, uid: number, home: string, password?: string) {
  h.users[name] = { name, uid, home, shell: "/bin/bash", password };
  h.groups[name] = { name, gid: uid, members: [] };
}

export function createLaptop(): Host {
  const h = emptyHost("laptop");
  h.hostname = "laptop";
  h.privateIp = LAPTOP_IP;
  h.os = "Ubuntu 24.04.1 LTS";
  h.cpus = 8;
  h.memMb = 16384;
  h.diskGb = 512;
  baseTree(h);
  addUser(h, "root", 0, "/root");
  addUser(h, LAPTOP_USER, 1000, `/home/${LAPTOP_USER}`, "laptop-pass");
  h.groups.sudo = { name: "sudo", gid: 27, members: [LAPTOP_USER] };
  put(h, `/home/${LAPTOP_USER}`, dir(0o750, LAPTOP_USER));
  put(h, `/home/${LAPTOP_USER}/.bashrc`, file(BASHRC, 0o644, LAPTOP_USER));
  put(h, `/home/${LAPTOP_USER}/code`, dir(0o755, LAPTOP_USER));
  put(h, `/home/${LAPTOP_USER}/code/crumb`, dir(0o755, LAPTOP_USER));
  put(
    h,
    `/home/${LAPTOP_USER}/code/crumb/package.json`,
    file(`{\n  "name": "crumb",\n  "scripts": { "dev": "next dev", "build": "next build", "start": "next start" }\n}\n`, 0o644, LAPTOP_USER),
  );
  for (const p of ["openssh-client", "curl", "dnsutils", "nano", "git"]) h.packages[p] = { version: "latest" };
  return h;
}

function svc(name: string, description: string, opts: Partial<Service> = {}): Service {
  return {
    name,
    description,
    unitPath: `/usr/lib/systemd/system/${name}.service`,
    enabled: true,
    state: "active",
    since: 0,
    pid: 400 + Math.floor(name.length * 37),
    ...opts,
  };
}

/** A fresh Ubuntu 24.04 VPS the way a typical provider hands it over. */
export function createFreshVps(plan: { cpus: number; memGb: number; diskGb: number } = PLANS[1]): Host {
  const h = emptyHost("vps");
  h.hostname = VPS_HOSTNAME;
  h.publicIp = VPS_IP;
  h.privateIp = VPS_PRIVATE_IP;
  h.os = "Ubuntu 24.04.1 LTS";
  h.cpus = plan.cpus;
  h.memMb = plan.memGb * 1024 - 250;
  h.diskGb = plan.diskGb;
  h.baseUsedMb = 2150;
  baseTree(h);
  addUser(h, "root", 0, "/root", ROOT_PASSWORD);
  h.groups.sudo = { name: "sudo", gid: 27, members: [] };
  h.groups.adm = { name: "adm", gid: 4, members: [] };
  h.groups.shadow = { name: "shadow", gid: 42, members: [] };
  h.groups.syslog = { name: "syslog", gid: 107, members: [] };
  h.groups.users = { name: "users", gid: 100, members: [] };
  h.groups["systemd-journal"] = { name: "systemd-journal", gid: 999, members: [] };
  put(h, "/etc/hostname", file(VPS_HOSTNAME + "\n"));
  put(h, "/etc/ssh", dir());
  put(h, "/etc/ssh/sshd_config", file(SSHD_CONFIG));
  put(h, "/etc/ssh/sshd_config.d", dir());
  put(h, "/etc/ssh/sshd_config.d/50-cloud-init.conf", file(CLOUD_INIT_SSHD, 0o600));
  put(h, "/etc/systemd/system", dir());
  put(h, "/etc/ufw", dir());
  put(h, "/etc/cron.d", dir());
  put(h, "/etc/apt/apt.conf.d", dir());
  put(h, "/etc/apt/keyrings", dir());
  put(h, "/etc/apt/sources.list.d", dir());
  put(
    h,
    "/etc/apt/apt.conf.d/20auto-upgrades",
    file(`APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n`),
  );
  put(h, "/var/log/syslog", file("", 0o640, "syslog", "adm", 180_000));
  put(h, "/var/log/auth.log", file("", 0o640, "syslog", "adm", 24_000));
  put(h, "/var/log/journal", dir(0o2755, "root", "systemd-journal"));
  put(h, "/var/www", dir());
  for (const p of [
    "openssh-server",
    "openssh-client",
    "ufw",
    "curl",
    "nano",
    "vim",
    "cron",
    "sudo",
    "rsyslog",
    "unattended-upgrades",
    "ca-certificates",
    "dnsutils",
  ]) {
    h.packages[p] = { version: "noble" };
  }
  h.services = {
    ssh: svc("ssh", "OpenBSD Secure Shell server", {
      enabled: false,
      triggeredBy: "ssh.socket",
      listens: [{ port: 22, addr: "0.0.0.0", proc: "sshd" }],
      pid: 1012,
    }),
    cron: svc("cron", "Regular background program processing daemon", { pid: 688 }),
    rsyslog: svc("rsyslog", "System Logging Service", { pid: 702 }),
    "systemd-journald": svc("systemd-journald", "Journal Service", { pid: 311 }),
    ufw: svc("ufw", "Uncomplicated firewall", { pid: 0 }),
    "unattended-upgrades": svc("unattended-upgrades", "Unattended Upgrades Shutdown", { pid: 811 }),
  };
  h.services.ssh.loaded = loadSshdConfig(h);
  return h;
}

export function createWorld(): World {
  return {
    clock: 0,
    seed: 7,
    hosts: { laptop: createLaptop(), vps: emptyHost("vps") },
    dns: [],
    provider: { rented: false, firewall: { enabled: false, rules: [] } },
    certs: {},
    flags: {},
  };
}

export function rentVps(w: World, planName = "S"): void {
  const plan = PLANS.find((p) => p.name === planName) ?? PLANS[1];
  w.provider.rented = true;
  w.provider.plan = { ...plan };
  w.hosts.vps = createFreshVps(plan);
}

// ---------- the finished stack, used by World 0 ----------

export const DEMO_COMPOSE = `services:
  caddy:
    image: caddy:2.8
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
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
  caddy_data:
  pgdata:
`;

export const DEMO_CADDYFILE = `${DOMAIN} {
\treverse_proxy app:3000
}
`;

function container(c: Partial<Container> & Pick<Container, "name" | "image" | "kind">): Container {
  return {
    id: hashHex(c.name),
    status: "running",
    ports: [],
    networks: ["crumb_default"],
    env: {},
    mounts: [],
    restart: "unless-stopped",
    listenAddr: "0.0.0.0",
    listenPort: 0,
    logs: [],
    createdAt: 0,
    ...c,
  };
}

export function createDemoWorld(): World {
  const w = createWorld();
  rentVps(w, "S");
  const vps = w.hosts.vps;
  w.provider.firewall = {
    enabled: true,
    rules: [
      { port: 22, source: "0.0.0.0/0" },
      { port: 80, source: "0.0.0.0/0" },
      { port: 443, source: "0.0.0.0/0" },
    ],
  };
  vps.ufw = {
    enabled: true,
    defaultIncoming: "deny",
    rules: [
      { port: 22, proto: "tcp", action: "allow", label: "OpenSSH" },
      { port: 80, proto: "tcp", action: "allow", label: "80/tcp" },
      { port: 443, proto: "tcp", action: "allow", label: "443/tcp" },
    ],
  };
  w.dns.push({ name: DOMAIN, type: "A", value: VPS_IP, ttl: 300 });
  w.certs[DOMAIN] = { domain: DOMAIN, issuer: "Let's Encrypt", issuedAt: 0 };
  vps.packages["docker-ce"] = { version: "27.3.1" };
  vps.packages["docker-compose-plugin"] = { version: "2.29.7" };
  vps.services.docker = svc("docker", "Docker Application Container Engine", { pid: 901 });
  put(vps, "/srv/crumb", dir());
  put(vps, "/srv/crumb/compose.yaml", file(DEMO_COMPOSE));
  put(vps, "/srv/crumb/Caddyfile", file(DEMO_CADDYFILE));
  put(
    vps,
    "/srv/crumb/.env",
    file(
      "POSTGRES_USER=crumb\nPOSTGRES_PASSWORD=s3cret-pg\nPOSTGRES_DB=crumb\nDATABASE_URL=postgres://crumb:s3cret-pg@db:5432/crumb\n",
      0o600,
    ),
  );
  vps.docker.networks.crumb_default = { name: "crumb_default", driver: "bridge" };
  vps.docker.volumes.crumb_caddy_data = { name: "crumb_caddy_data", sizeMb: 1 };
  vps.docker.volumes.crumb_pgdata = { name: "crumb_pgdata", sizeMb: 48, pg: { version: "17", user: "crumb", db: "crumb", password: "s3cret-pg" } };
  vps.docker.images["caddy:2.8"] = { ref: "caddy:2.8", id: "c4dd1e2f3a4b", sizeMb: 48, kind: "caddy", createdAt: 0 };
  vps.docker.images["registry.gitlab.com/crumb/web:latest"] = {
    ref: "registry.gitlab.com/crumb/web:latest",
    id: "a99c0ffee123",
    sizeMb: 212,
    kind: "nextjs",
    createdAt: 0,
  };
  vps.docker.images["postgres:17"] = { ref: "postgres:17", id: "9b17deadbeef", sizeMb: 435, kind: "postgres", createdAt: 0 };
  vps.docker.containers["crumb-caddy-1"] = container({
    name: "crumb-caddy-1",
    image: "caddy:2.8",
    kind: "caddy",
    project: "crumb",
    service: "caddy",
    ports: [
      { hostIp: "0.0.0.0", hostPort: 80, containerPort: 80 },
      { hostIp: "0.0.0.0", hostPort: 443, containerPort: 443 },
    ],
    mounts: [
      { source: "/srv/crumb/Caddyfile", target: "/etc/caddy/Caddyfile", type: "bind" },
      { source: "crumb_caddy_data", target: "/data", type: "volume" },
    ],
    listenPort: 443,
    logs: [`{"level":"info","msg":"certificate obtained successfully","identifier":"${DOMAIN}"}`],
  });
  vps.docker.containers["crumb-app-1"] = container({
    name: "crumb-app-1",
    image: "registry.gitlab.com/crumb/web:latest",
    kind: "nextjs",
    project: "crumb",
    service: "app",
    env: { DATABASE_URL: "postgres://crumb:s3cret-pg@db:5432/crumb", HOSTNAME: "0.0.0.0", PORT: "3000" },
    listenPort: 3000,
    logs: ["   ▲ Next.js 16.0.0", "   - Local:        http://0.0.0.0:3000", " ✓ Ready in 412ms"],
  });
  vps.docker.containers["crumb-db-1"] = container({
    name: "crumb-db-1",
    image: "postgres:17",
    kind: "postgres",
    project: "crumb",
    service: "db",
    mounts: [{ source: "crumb_pgdata", target: "/var/lib/postgresql/data", type: "volume" }],
    env: { POSTGRES_USER: "crumb", POSTGRES_DB: "crumb" },
    listenPort: 5432,
    logs: ["LOG:  database system is ready to accept connections"],
  });
  return w;
}
