// Goal predicates. Levels check the resulting STATE, never exact commands.
import { getDir, getFile, userGroups } from "./fs";
import { appToDb, providerAllows, traceHttp, ufwAllows as ufwAllowsPort } from "./net";
import { sshCheck } from "./sshAuth";
import { runningSshd } from "./sshd";
import type { Container, HopId, Host, HostId, Shell, World } from "./types";
import { localImage } from "./docker/images";
import { dockerInstalled as engineInstalled } from "./docker/runtime";

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
