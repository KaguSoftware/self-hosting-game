// Goal predicates. Levels check the resulting STATE, never exact commands.
import { getDir, getFile, isSudoer, userGroups } from "./fs";
import { appToDb, providerAllows, resolveName, traceHttp, ufwAllows as ufwAllowsPort } from "./net";
import { sshCheck } from "./sshAuth";
import { runningSshd } from "./sshd";
import type { Container, HopId, Host, HostId, Shell, World } from "./types";
import { APP_REPO, localImage } from "./docker/images";
import { checkLogin, GITLAB_REGISTRY, readAuths } from "./docker/auth";
import { latestPipeline, revisionOfImage } from "./gitlab/state";
import type { JobStatus, PipelineStatus } from "./gitlab/types";
import { dockerInstalled as engineInstalled } from "./docker/runtime";
import { clusterOf, dataVolume } from "./pg/cluster";
import { looksLikeDump } from "./pg/dump";
import type { PgCluster } from "./pg/types";

export interface LogEntry {
  line: string;
  out: string;
  host: HostId;
  user: string;
  code: number;
}

export interface GoalCtx {
  world: World;
  shells: Shell[];
  log: LogEntry[];
}

export type Check = (g: GoalCtx) => boolean;

const top = (sh: Shell) => sh.frames[sh.frames.length - 1];

export const all =
  (...cs: Check[]): Check =>
  (g) =>
    cs.every((c) => c(g));

export const any =
  (...cs: Check[]): Check =>
  (g) =>
    cs.some((c) => c(g));

export const not =
  (c: Check): Check =>
  (g) =>
    !c(g);

export const rented: Check = (g) => g.world.provider.rented;

export const loggedInAs =
  (host: HostId, user?: string): Check =>
  (g) =>
    g.shells.some((s) => top(s).host === host && (!user || top(s).user === user));

export const sshSessionAs =
  (user: string): Check =>
  (g) =>
    g.shells.some((s) => s.frames.some((f) => f.host === "vps" && f.via === "ssh" && f.user === user));

export const cwdIs =
  (path: string): Check =>
  (g) =>
    g.shells.some((s) => top(s).cwd === path);

/** Some command printed output matching re (any approach that shows the info passes). */
export const saw =
  (re: RegExp, host?: HostId, user?: string): Check =>
  (g) =>
    g.log.some((l) => (!host || l.host === host) && (!user || l.user === user) && re.test(l.out));

/** Some window other than the first has an SSH session as `user`. */
export const secondWindowAs =
  (user: string): Check =>
  (g) =>
    g.shells.some((s, i) => i > 0 && s.frames.some((f) => f.host === "vps" && f.via === "ssh" && f.user === user));

/** A command matching re ran successfully. Use only when the action IS the lesson. */
export const ran =
  (re: RegExp, host?: HostId): Check =>
  (g) =>
    g.log.some((l) => (!host || l.host === host) && l.code === 0 && re.test(l.line));

export const userExists =
  (name: string, host: HostId = "vps"): Check =>
  (g) =>
    !!g.world.hosts[host].users[name];

export const inGroup =
  (name: string, group: string, host: HostId = "vps"): Check =>
  (g) =>
    userGroups(g.world.hosts[host], name).includes(group);

export const hasPassword =
  (name: string, host: HostId = "vps"): Check =>
  (g) =>
    !!g.world.hosts[host].users[name]?.password;

export const fileExists =
  (host: HostId, path: string): Check =>
  (g) =>
    !!getFile(g.world.hosts[host], path) || !!getDir(g.world.hosts[host], path);

export const fileMode =
  (host: HostId, path: string, mode: number): Check =>
  (g) => {
    const f = getFile(g.world.hosts[host], path) ?? getDir(g.world.hosts[host], path);
    return !!f && (f.mode & 0o777) === mode;
  };

/** Mode has no bits beyond `max` (e.g. 0o600 means nobody else can read). */
export const modeAtMost =
  (host: HostId, path: string, max: number): Check =>
  (g) => {
    const f = getFile(g.world.hosts[host], path) ?? getDir(g.world.hosts[host], path);
    return !!f && (f.mode & 0o777 & ~max) === 0;
  };

export const fileOwner =
  (host: HostId, path: string, owner: string): Check =>
  (g) => {
    const f = getFile(g.world.hosts[host], path) ?? getDir(g.world.hosts[host], path);
    return f?.owner === owner;
  };

export const fileContains =
  (host: HostId, path: string, re: RegExp): Check =>
  (g) =>
    re.test(getFile(g.world.hosts[host], path)?.content ?? "");

export const pkgInstalled =
  (name: string, host: HostId = "vps"): Check =>
  (g) =>
    !!g.world.hosts[host].packages[name];

export const serviceActive =
  (name: string): Check =>
  (g) =>
    g.world.hosts.vps.services[name]?.state === "active";

export const serviceEnabled =
  (name: string): Check =>
  (g) =>
    !!g.world.hosts.vps.services[name]?.enabled;

export const ufwEnabled: Check = (g) => g.world.hosts.vps.ufw.enabled;

export const ufwAllows =
  (port: number): Check =>
  (g) =>
    g.world.hosts.vps.ufw.enabled && ufwAllowsPort(g.world.hosts.vps, port);

export const providerOpen =
  (port: number): Check =>
  (g) =>
    providerAllows(g.world, port);

/** The RUNNING sshd uses this value (so a restart is needed after editing). */
export const sshdRunning =
  (key: string, value: string): Check =>
  (g) =>
    (runningSshd(g.world.hosts.vps)[key.toLowerCase()] ?? "") === value;

export const laptopHasKey: Check = (g) =>
  !!getFile(g.world.hosts.laptop, "/home/you/.ssh/id_ed25519") && !!getFile(g.world.hosts.laptop, "/home/you/.ssh/id_ed25519.pub");

export const keyLoginWorks =
  (user: string): Check =>
  (g) =>
    sshCheck(g.world, "you", user, g.world.hosts.vps.publicIp ?? "").keyOk;

export const passwordLoginBlocked =
  (user: string): Check =>
  (g) =>
    !sshCheck(g.world, "you", user, g.world.hosts.vps.publicIp ?? "", { noPubkey: true }).passwordWorks;

export const traceOk =
  (url: string): Check =>
  (g) =>
    traceHttp(g.world, url).ok;

export const traceFailsAt =
  (url: string, hop: HopId): Check =>
  (g) =>
    traceHttp(g.world, url).failedAt === hop;

/** DNS answers `name` with `ip` (following CNAMEs). */
export const dnsResolves =
  (name: string, ip: string): Check =>
  (g) =>
    resolveName(g.world, name).ip === ip;

/** A record of this exact type and value exists. */
export const dnsHas =
  (name: string, type: "A" | "CNAME", value: string): Check =>
  (g) =>
    g.world.dns.some((r) => r.name === name && r.type === type && r.value.replace(/\.$/, "") === value);

export const pfwEnabled: Check = (g) => g.world.provider.firewall.enabled;

/** The provider firewall is on and allows exactly these ports. */
export const providerOnly =
  (ports: number[]): Check =>
  (g) => {
    const fw = g.world.provider.firewall;
    const open = [...new Set(fw.rules.map((r) => r.port))].sort((a, b) => a - b);
    return fw.enabled && open.join(",") === [...ports].sort((a, b) => a - b).join(",");
  };

/** ufw is on and allows exactly these ports. */
export const ufwOnly =
  (ports: number[]): Check =>
  (g) => {
    const u = g.world.hosts.vps.ufw;
    const open = [...new Set(u.rules.filter((r) => r.action !== "deny").map((r) => r.port))].sort((a, b) => a - b);
    return u.enabled && open.join(",") === [...ports].sort((a, b) => a - b).join(",");
  };

/** Someone on the internet can open a TCP connection to this port on the VPS. */
export const internetReaches =
  (port: number): Check =>
  (g) => {
    const t = traceHttp(g.world, `http://${g.world.hosts.vps.publicIp}:${port}`);
    return !["provider-fw", "ufw", "listener", "dns"].includes(t.failedAt ?? "");
  };

export const flag =
  (name: string, value: string | number | boolean = true): Check =>
  (g) =>
    g.world.flags[name] === value;

// ---------- docker ----------

/** A container by name, or by compose service name (a running one wins). */
export function findDockerContainer(host: Host, serviceOrName: string): Container | undefined {
  const cs = Object.values(host.docker.containers);
  const byName = cs.find((c) => c.name === serviceOrName);
  if (byName) return byName;
  const bySvc = cs.filter((c) => c.service === serviceOrName);
  return bySvc.find((c) => c.status === "running") ?? bySvc[0];
}

const vpsHost = (g: GoalCtx) => g.world.hosts.vps;

/** The Docker engine is installed and its service is running. */
export const dockerInstalled: Check = (g) => engineInstalled(vpsHost(g)) && vpsHost(g).services.docker?.state === "active";

export const containerRunning =
  (serviceOrName: string): Check =>
  (g) =>
    findDockerContainer(vpsHost(g), serviceOrName)?.status === "running";

/** No container with this name or service exists, in any state. */
export const containerAbsent =
  (name: string): Check =>
  (g) =>
    !findDockerContainer(vpsHost(g), name);

export const containerHealthy =
  (service: string): Check =>
  (g) => {
    const c = findDockerContainer(vpsHost(g), service);
    return c?.status === "running" && c.health === "healthy";
  };

export const imagePresent =
  (ref: string): Check =>
  (g) =>
    !!localImage(vpsHost(g), ref);

/** A volume with exactly this name, or a compose one ending in _name (pgdata matches crumb_pgdata). */
export const volumeExists =
  (name: string): Check =>
  (g) =>
    Object.keys(vpsHost(g).docker.volumes).some((v) => v === name || v.endsWith(`_${name}`));

export const volumeAbsent =
  (name: string): Check =>
  (g) =>
    !volumeExists(name)(g);

export const restartPolicy =
  (service: string, p: Container["restart"]): Check =>
  (g) =>
    findDockerContainer(vpsHost(g), service)?.restart === p;

/** No container publishes a port to the host, except the listed containers or services. */
export const noPublishedPorts =
  (except: string[] = []): Check =>
  (g) =>
    Object.values(vpsHost(g).docker.containers).every(
      (c) => !c.ports.length || except.includes(c.name) || (!!c.service && except.includes(c.service)),
    );

/** The process inside binds this address ("0.0.0.0", "127.0.0.1"). */
export const listensOn =
  (service: string, addr: string): Check =>
  (g) => {
    const c = findDockerContainer(vpsHost(g), service);
    return c?.status === "running" && c.listenAddr === addr;
  };

/** The app's DATABASE_URL reaches a running database container. */
export const appReachesDb =
  (service: string): Check =>
  (g) => {
    const c = findDockerContainer(vpsHost(g), service);
    if (!c || c.status !== "running") return false;
    const r = appToDb(vpsHost(g), c);
    return r.ok && r.hop === "db";
  };

/** A NEXT_PUBLIC_* (or any) value was frozen into the image at build time. */
export const imageBaked =
  (ref: string, key: string, value?: string): Check =>
  (g) => {
    const baked = localImage(vpsHost(g), ref)?.meta?.baked ?? {};
    return value === undefined ? key in baked : baked[key] === value;
  };

// ---------- caddy and https ----------

/** Let's Encrypt issued a certificate for this domain, and Caddy still has it. */
export const certIssued =
  (domain: string): Check =>
  (g) =>
    !!g.world.certs[domain];

/** A running Caddy container has LOADED a config matching re (saving the file is not enough). */
export const caddyLoaded =
  (re: RegExp): Check =>
  (g) =>
    Object.values(g.world.hosts.vps.docker.containers).some((c) => c.kind === "caddy" && c.status === "running" && re.test(c.caddyConfig ?? ""));

/** Only this service publishes ports: everything else stays on the private network. */
export const onlyPublisher =
  (service: string): Check =>
  (g) => {
    const cs = Object.values(g.world.hosts.vps.docker.containers).filter((c) => c.ports.length);
    return cs.length > 0 && cs.every((c) => c.service === service || c.name === service);
  };

/** A container has a volume mounted at this path inside it (caddy_data at /data). */
export const volumeMounted =
  (service: string, target: string): Check =>
  (g) => {
    const c = findDockerContainer(g.world.hosts.vps, service);
    return !!c?.mounts.some((m) => m.type === "volume" && m.target === target);
  };

// ---------- postgres ----------

/** Every Postgres cluster on the VPS: the db container's volume first, then any other volume with data. */
function pgClusters(g: GoalCtx): PgCluster[] {
  const host = vpsHost(g);
  const out: PgCluster[] = [];
  const db = findDockerContainer(host, "db");
  const first = db?.kind === "postgres" ? dataVolume(host, db) : undefined;
  if (first?.pg) out.push(clusterOf(first.pg));
  for (const v of Object.values(host.docker.volumes)) if (v.pg && v !== first) out.push(clusterOf(v.pg));
  return out;
}

/** A database with this name exists in the server's data. */
export const pgDatabase =
  (name: string): Check =>
  (g) =>
    pgClusters(g).some((c) => !!c.databases[name]);

/** A table ("orders" means public.orders) in `db` holds at least `min` rows. */
export const pgTableRows =
  (db: string, table: string, min: number): Check =>
  (g) => {
    const q = table.includes(".") ? table : `public.${table}`;
    return pgClusters(g).some((c) => (c.databases[db]?.tables[q]?.rows ?? -1) >= min);
  };

export const pgRole =
  (name: string): Check =>
  (g) =>
    pgClusters(g).some((c) => !!c.roles[name]);

/** 5432 cannot be reached from the internet, and no container publishes Postgres on 0.0.0.0. */
export const dbNotPublic: Check = (g) => {
  if (internetReaches(5432)(g)) return false;
  return Object.values(vpsHost(g).docker.containers).every(
    (c) => !c.ports.some((p) => (p.hostIp === "0.0.0.0" || p.hostIp === "::") && (p.hostPort === 5432 || (c.kind === "postgres" && p.containerPort === 5432))),
  );
};

/** An ssh -L tunnel listens on this laptop port, and the window holding it is still open. */
export const tunnelOpen =
  (port: number): Check =>
  (g) =>
    (g.world.tunnels ?? []).some((t) => t.laptopPort === port && (!t.shellId || !g.shells.length || g.shells.some((s) => s.id === t.shellId)));

/** A database dump: custom format (starts with PGDMP) or plain SQL with CREATE TABLE. */
export const dumpFile =
  (host: HostId, path: string): Check =>
  (g) =>
    looksLikeDump(getFile(g.world.hosts[host], path)?.content);

// ---------- gitlab ----------

/** The newest pipeline on this ref has this status ("success", "failed", "pending", ...). */
export const pipelineStatus =
  (ref: string, status: PipelineStatus): Check =>
  (g) =>
    latestPipeline(g.world.gitlab, ref)?.status === status;

/** The newest run of the job with this name (in the newest pipeline that has it, optionally on one ref). */
export const jobStatus =
  (name: string, status: JobStatus, ref?: string): Check =>
  (g) => {
    const ps = g.world.gitlab?.pipelines ?? [];
    for (let i = ps.length - 1; i >= 0; i--) {
      if (ref && ps[i].ref !== ref) continue;
      const j = ps[i].jobs.find((x) => x.name === name);
      if (j) return j.status === status;
    }
    return false;
  };

/** A CI/CD variable exists, with these settings when given. */
export const ciVar =
  (key: string, opts: { file?: boolean; protected?: boolean; masked?: boolean } = {}): Check =>
  (g) => {
    const v = g.world.gitlab?.variables.find((x) => x.key === key);
    if (!v) return false;
    if (opts.file !== undefined && (v.type === "file") !== opts.file) return false;
    if (opts.protected !== undefined && v.protected !== opts.protected) return false;
    if (opts.masked !== undefined && v.masked !== opts.masked) return false;
    return true;
  };

function shaMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const hex = /^[0-9a-f]{7,40}$/;
  return hex.test(a) && hex.test(b) && (a.startsWith(b) || b.startsWith(a));
}

/** The GitLab registry has the app image under this tag ("latest", or a commit sha, short or full). */
export const registryHas =
  (tag: string): Check =>
  (g) =>
    Object.keys(g.world.registry ?? {}).some((ref) => ref.startsWith(`${APP_REPO}:`) && shaMatch(ref.slice(APP_REPO.length + 1), tag));

/** The running app container (compose service "app", else any running Next.js container). */
export function liveAppContainer(w: World): Container | undefined {
  const vps = w.hosts.vps;
  const app = findDockerContainer(vps, "app");
  if (app?.status === "running") return app;
  return Object.values(vps.docker.containers).find((c) => c.kind === "nextjs" && c.status === "running");
}

/** The running app container's image was built from this commit (short or full sha). */
export const liveVersion =
  (sha: string): Check =>
  (g) => {
    const c = liveAppContainer(g.world);
    const rev = c ? revisionOfImage(g.world, c.imageId) : undefined;
    return !!rev && shaMatch(rev, sha);
  };

export const runnerOnline: Check = (g) => !!g.world.gitlab?.runners.some((r) => r.online);

/** User ci exists, is in the docker group, and cannot use sudo. */
export const ciUserLimited: Check = (g) => {
  const vps = g.world.hosts.vps;
  return !!vps.users.ci && userGroups(vps, "ci").includes("docker") && !isSudoer(vps, "ci");
};

export const protectedBranch =
  (name: string): Check =>
  (g) =>
    !!g.world.gitlab?.protectedBranches.includes(name);

/** The laptop's key is on the GitLab profile, so a push can get in. */
export const gitlabKeyAdded: Check = (g) => {
  const pub = getFile(g.world.hosts.laptop, "/home/you/.ssh/id_ed25519.pub")?.content;
  return !!pub && !!g.world.gitlab?.userKeys.some((k) => k.split(/\s+/)[1] === pub.split(/\s+/)[1]);
};

/** GitLab's branch is at the laptop's commit (the work is pushed). */
export const pushed =
  (branch = "main"): Check =>
  (g) => {
    const gl = g.world.gitlab;
    return !!gl?.local && !!gl.local.branches[branch] && gl.branches[branch] === gl.local.branches[branch];
  };

/** An active deploy token with this scope exists. */
export const deployTokenActive =
  (scope: "read_registry" | "write_registry" | "read_repository" = "read_registry"): Check =>
  (g) =>
    !!g.world.gitlab?.deployTokens.some((t) => !t.revoked && t.scopes.includes(scope));

/** `user` on the VPS has a working docker login to the GitLab registry that may pull. */
export const registryLoginWorks =
  (user: string): Check =>
  (g) => {
    const cred = readAuths(g.world.hosts.vps, user)[GITLAB_REGISTRY];
    return !!cred && checkLogin(g.world, GITLAB_REGISTRY, cred).pull;
  };
