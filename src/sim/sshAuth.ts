import { getDir, getFile, readText } from "./fs";
import { isIp, providerAllows, resolveName, ufwAllows } from "./net";
import { runningSshd } from "./sshd";
import type { Hop, Host, TraceResult, World } from "./types";

export interface SshCheck {
  trace: TraceResult;
  /** Network level failure text, already formatted like OpenSSH. */
  netError?: string;
  ip?: string;
  keyOk: boolean;
  keyOffered: boolean;
  /** Why the key was refused (server side, goes to the journal). */
  keyRefusal?: string;
  passwordPrompt: boolean;
  passwordWorks: boolean;
  methods: string[];
}

export function keyBody(pub: string): string {
  const parts = pub.trim().split(/\s+/);
  return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : pub.trim();
}

function groupOrOtherWritable(mode: number): boolean {
  return (mode & 0o022) !== 0;
}

/** sshd StrictModes check. Returns a refusal message or undefined when fine. */
export function strictModesProblem(host: Host, user: string): string | undefined {
  const u = host.users[user];
  if (!u) return undefined;
  const home = getDir(host, u.home);
  const sshDir = getDir(host, `${u.home}/.ssh`);
  const ak = getFile(host, `${u.home}/.ssh/authorized_keys`);
  const okOwner = (o: string) => o === user || o === "root";
  if (home && (groupOrOtherWritable(home.mode) || !okOwner(home.owner)))
    return `Authentication refused: bad ownership or modes for directory ${u.home}`;
  if (sshDir && (groupOrOtherWritable(sshDir.mode) || !okOwner(sshDir.owner)))
    return `Authentication refused: bad ownership or modes for directory ${u.home}/.ssh`;
  if (ak && (groupOrOtherWritable(ak.mode) || !okOwner(ak.owner)))
    return `Authentication refused: bad ownership or modes for file ${u.home}/.ssh/authorized_keys`;
  return undefined;
}

export function clientKeys(laptop: Host, user: string, identity?: string): { path: string; pub: string }[] {
  const home = laptop.users[user]?.home ?? `/home/${user}`;
  const candidates = identity ? [identity] : [`${home}/.ssh/id_ed25519`, `${home}/.ssh/id_rsa`];
  const out: { path: string; pub: string }[] = [];
  for (const p of candidates) {
    const priv = getFile(laptop, p);
    const pub = readText(laptop, p + ".pub");
    if (priv && pub) out.push({ path: p, pub });
  }
  return out;
}

function h(id: Hop["id"], label: string, ok: boolean, note: string, node: string = id): Hop {
  return { id, label, ok, note, node };
}

export function sshCheck(
  w: World,
  clientUser: string,
  user: string,
  target: string,
  opts: { identity?: string; noPubkey?: boolean } = {},
): SshCheck {
  const hops: Hop[] = [h("laptop", "Your laptop", true, "ssh starts here")];
  const base = (): SshCheck => ({
    trace: { kind: "ssh", target: `${user}@${target}`, hops, ok: false },
    keyOk: false,
    keyOffered: false,
    passwordPrompt: false,
    passwordWorks: false,
    methods: [],
  });
  const done = (c: SshCheck): SshCheck => {
    const failed = hops.find((x) => !x.ok);
    c.trace = { kind: "ssh", target: `${user}@${target}`, hops, ok: !failed, failedAt: failed?.id };
    return c;
  };

  const r = resolveName(w, target);
  if (!r.ip) {
    hops.push(h("dns", "DNS", false, `Cannot resolve ${target}`));
    return done({ ...base(), netError: `ssh: Could not resolve hostname ${target}: Name or service not known` });
  }
  const vps = w.hosts.vps;
  if (!isIp(target)) hops.push(h("dns", "DNS", true, `${target} → ${r.ip}`));
  if (!w.provider.rented || r.ip !== vps.publicIp) {
    hops.push(h("dns", "Network", false, `Nothing at ${r.ip} answers`));
    return done({ ...base(), ip: r.ip, netError: `ssh: connect to host ${target} port 22: Connection timed out` });
  }
  if (!providerAllows(w, 22)) {
    hops.push(h("provider-fw", "Provider firewall", false, "Port 22 is blocked in the provider dashboard", "pfw"));
    return done({ ...base(), ip: r.ip, netError: `ssh: connect to host ${target} port 22: Connection timed out` });
  }
  hops.push(h("provider-fw", "Provider firewall", true, "Port 22 allowed", "pfw"));
  if (!ufwAllows(vps, 22)) {
    hops.push(h("ufw", "ufw", false, "ufw is on and has no rule for port 22"));
    return done({ ...base(), ip: r.ip, netError: `ssh: connect to host ${target} port 22: Connection timed out` });
  }
  hops.push(h("ufw", "ufw", true, vps.ufw.enabled ? "Port 22 allowed" : "ufw is off"));
  if (vps.services.ssh?.state !== "active") {
    hops.push(h("sshd", "sshd", false, "The ssh service is not running", "sshd"));
    return done({ ...base(), ip: r.ip, netError: `ssh: connect to host ${target} port 22: Connection refused` });
  }
  hops.push(h("sshd", "sshd", true, "sshd answered", "sshd"));

  const cfg = runningSshd(vps);
  const u = vps.users[user];
  const keys = opts.noPubkey ? [] : clientKeys(w.hosts.laptop, clientUser, opts.identity);
  const pubkeyOn = cfg.pubkeyauthentication !== "no";
  const rootRule = cfg.permitrootlogin ?? "prohibit-password";
  const rootBlocked = user === "root" && rootRule === "no";

  let keyOk = false;
  let keyRefusal: string | undefined;
  if (pubkeyOn && keys.length && u && !rootBlocked) {
    const akPath = `${u.home}/.ssh/authorized_keys`;
    const ak = readText(vps, akPath) ?? "";
    const installed = ak.split("\n").map(keyBody);
    const match = keys.some((k) => installed.includes(keyBody(k.pub)));
    if (match) {
      const problem = cfg.strictmodes !== "no" ? strictModesProblem(vps, user) : undefined;
      if (problem) keyRefusal = problem;
      else keyOk = true;
    }
  }
  if (rootBlocked) keyRefusal = `ROOT LOGIN REFUSED FROM ${w.hosts.laptop.privateIp}`;

  const passwordPrompt = cfg.passwordauthentication === "yes";
  const passwordWorks =
    passwordPrompt && !!u?.password && (user !== "root" || rootRule === "yes");
  const methods = ["publickey"];
  if (passwordPrompt) methods.push("password");

  hops.push(
    h(
      "auth",
      "Login",
      keyOk || passwordWorks,
      keyOk
        ? `Key accepted for ${user}`
        : keyRefusal
          ? keyRefusal
          : passwordWorks
            ? `Password login is allowed for ${user}`
            : !u
              ? `There is no user called ${user}`
              : keys.length === 0
                ? "You have no key to offer and passwords are off"
                : `Your key is not in ${user}'s authorized_keys`,
      "sshd",
    ),
  );
  return done({
    ...base(),
    ip: r.ip,
    keyOk,
    keyOffered: keys.length > 0,
    keyRefusal,
    passwordPrompt,
    passwordWorks,
    methods,
  });
}

/** Can the laptop user get a shell as `user` on the VPS right now (key or known password)? */
export function canSshWithKey(w: World, user: string): boolean {
  return sshCheck(w, "you", user, w.hosts.vps.publicIp ?? "").keyOk;
}
