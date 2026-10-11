import { HOME_PUBLIC_IP, HOST_KEY_FP } from "../../constants";
import { dir, file, getDir, getFile, put, readText, userGroups, writeFile } from "../../fs";
import { resolveName } from "../../net";
import { keyBody, sshCheck, type SshCheck } from "../../sshAuth";
import { parseSshd, sshdDump } from "../../sshd";
import { dateTime } from "../../time";
import { hashB64 } from "../../util";
import type { Command, Ctx } from "../ctx";

interface SshOpts {
  user: string;
  target: string;
  verbose: boolean;
  identity?: string;
  noPubkey: boolean;
}

function parseSshArgs(ctx: Ctx, argv: string[]): SshOpts | string {
  let verbose = false;
  let identity: string | undefined;
  let noPubkey = false;
  let dest: string | undefined;
  let loginUser: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (/^-v+$/.test(a)) verbose = true;
    else if (a === "-i") identity = ctx.path(argv[++i] ?? "");
    else if (a === "-l") loginUser = argv[++i];
    else if (a === "-p") {
      const port = argv[++i];
      if (port !== "22") return `ssh: connect to host port ${port}: Connection refused`;
    } else if (a === "-o") {
      const opt = argv[++i] ?? "";
      if (/^PubkeyAuthentication=no$/i.test(opt)) noPubkey = true;
      if (/^PreferredAuthentications=password$/i.test(opt)) noPubkey = true;
    } else if (a === "-L" || a === "-R" || a === "-N") {
      return "Tunnels arrive in a later world. For now: ssh user@host";
    } else if (!a.startsWith("-") && !dest) dest = a;
    else if (!a.startsWith("-") && dest) return "Running a single remote command arrives in a later world. Log in first, then type it.";
  }
  if (!dest) return "usage: ssh [-v] [-i identity_file] [-o option] destination";
  let user = loginUser ?? ctx.realUser;
  let target = dest;
  if (dest.includes("@")) [user, target] = dest.split("@");
  return { user, target, verbose, identity, noPubkey };
}

function knownHostsPath(ctx: Ctx) {
  return `${ctx.home}/.ssh/known_hosts`;
}

function isKnown(ctx: Ctx, target: string, ip: string): boolean {
  const kh = readText(ctx.host, knownHostsPath(ctx)) ?? "";
  return kh.split("\n").some((l) => l.startsWith(target + " ") || l.startsWith(ip + " "));
}

function ensureSshDir(ctx: Ctx) {
  if (!getDir(ctx.host, `${ctx.home}/.ssh`)) put(ctx.host, `${ctx.home}/.ssh`, dir(0o700, ctx.realUser, ctx.realUser));
}

function addKnown(ctx: Ctx, target: string) {
  ensureSshDir(ctx);
  const line = `${target} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${hashB64("hostkey", 43)}\n`;
  const existing = getFile(ctx.host, knownHostsPath(ctx));
  if (existing) existing.content += line;
  else put(ctx.host, knownHostsPath(ctx), file(line, 0o644, ctx.realUser, ctx.realUser));
}

function verboseLines(ctx: Ctx, o: SshOpts, c: SshCheck): string {
  const lines = [
    "OpenSSH_9.6p1 Ubuntu-3ubuntu13.5, OpenSSL 3.0.13 30 Jan 2024",
    `debug1: Connecting to ${o.target} [${c.ip ?? "?"}] port 22.`,
  ];
  if (c.netError) return lines.join("\n");
  lines.push(
    `debug1: Connection established.`,
    `debug1: Remote protocol version 2.0, remote software version OpenSSH_9.6p1 Ubuntu-3ubuntu13.5`,
    `debug1: Authenticating to ${o.target}:22 as '${o.user}'`,
    `debug1: Server host key: ssh-ed25519 ${HOST_KEY_FP}`,
    `debug1: Authentications that can continue: ${c.methods.join(",")}`,
    `debug1: Next authentication method: publickey`,
  );
  if (c.keyOffered) {
    lines.push(`debug1: Offering public key: ${ctx.home}/.ssh/id_ed25519 ED25519 SHA256:${hashB64(ctx.realUser + "key", 43)}`);
    if (c.keyOk) lines.push(`debug1: Server accepts key: ${ctx.home}/.ssh/id_ed25519 ED25519`);
    else lines.push(`debug1: Authentications that can continue: ${c.methods.join(",")}`);
  } else {
    lines.push(`debug1: Will attempt key: ${ctx.home}/.ssh/id_ed25519 (no such file)`, `debug1: No more authentication methods to try.`);
  }
  return lines.join("\n");
}

function motd(ctx: Ctx): string {
  const vps = ctx.w.hosts.vps;
  return [
    `Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-45-generic x86_64)`,
    ``,
    ` * Documentation:  https://help.ubuntu.com`,
    ` * Management:     https://landscape.canonical.com`,
    ` * Support:        https://ubuntu.com/pro`,
    ``,
    ` System information as of ${dateTime(ctx.w.clock)}`,
    ``,
    `  System load:  0.08              Processes:             112`,
    `  Usage of /:   6.1% of ${vps.diskGb - 2}.23GB   Users logged in:       0`,
    `  Memory usage: 11%               IPv4 address for eth0: ${vps.publicIp}`,
    ``,
    vps.upgraded ? `0 updates can be applied immediately.` : `12 updates can be applied immediately.\nTo see these additional updates run: apt list --upgradable`,
  ].join("\n");
}

function login(ctx: Ctx, o: SshOpts, method: "publickey" | "password") {
  const vps = ctx.w.hosts.vps;
  const u = vps.users[o.user];
  const fp = method === "publickey" ? ` ssh2: ED25519 SHA256:${hashB64(ctx.realUser + "key", 43)}` : " ssh2";
  vps.journal.push({ t: ctx.w.clock, unit: "ssh", msg: `Accepted ${method} for ${o.user} from ${HOME_PUBLIC_IP} port 51234${fp}` });
  vps.journal.push({ t: ctx.w.clock, unit: "ssh", msg: `pam_unix(sshd:session): session opened for user ${o.user}(uid=${u.uid}) by ${o.user}(uid=0)` });
  ctx.out(motd(ctx));
  ctx.sh.frames.push({ host: "vps", user: o.user, cwd: u.home, via: "ssh", remote: o.target, loginGroups: userGroups(vps, o.user) });
  ctx.emit.trace = { ...(ctx.emit.trace ?? sshCheck(ctx.w, ctx.realUser, o.user, o.target).trace), ok: true };
}

function refuse(ctx: Ctx, o: SshOpts, c: SshCheck) {
  const vps = ctx.w.hosts.vps;
  if (c.keyRefusal) vps.journal.push({ t: ctx.w.clock, unit: "ssh", msg: c.keyRefusal });
  vps.journal.push({
    t: ctx.w.clock,
    unit: "ssh",
    msg: `Connection closed by authenticating user ${o.user} ${HOME_PUBLIC_IP} port 51234 [preauth]`,
  });
  ctx.err(`${o.user}@${o.target}: Permission denied (${c.methods.join(",")}).`);
}

/** Continue an ssh attempt after the host key step. */
function authenticate(ctx: Ctx, o: SshOpts): number {
  const c = sshCheck(ctx.w, ctx.realUser, o.user, o.target, { identity: o.identity, noPubkey: o.noPubkey });
  ctx.emit.trace = c.trace;
  if (c.keyOk) {
    const priv = getFile(ctx.host, o.identity ?? `${ctx.home}/.ssh/id_ed25519`);
    if (priv?.content.includes("ENCRYPTED")) {
      ctx.prompt({ prompt: `Enter passphrase for key '${o.identity ?? ctx.home + "/.ssh/id_ed25519"}': `, secret: true, data: { ...o, stage: "passphrase" } });
      return 0;
    }
    login(ctx, o, "publickey");
    return 0;
  }
  if (c.passwordPrompt) {
    if (c.keyRefusal) ctx.w.hosts.vps.journal.push({ t: ctx.w.clock, unit: "ssh", msg: c.keyRefusal });
    ctx.prompt({ prompt: `${o.user}@${o.target}'s password: `, secret: true, data: { ...o, stage: "password", tries: 0 } });
    return 0;
  }
  refuse(ctx, o, c);
  return 255;
}

export const ssh: Command = {
  name: "ssh",
  summary: "log in to another machine (ssh user@ip)",
  run(ctx) {
    if (ctx.frame.host !== "laptop") {
      ctx.info("Hop back to your laptop first (type exit). In this game you ssh from your laptop.");
      return 1;
    }
    const o = parseSshArgs(ctx, ctx.argv.slice(1));
    if (typeof o === "string") {
      ctx.err(o);
      return 255;
    }
    if (o.identity && !getFile(ctx.host, o.identity)) {
      ctx.err(`Warning: Identity file ${o.identity} not accessible: No such file or directory.`);
    }
    const c = sshCheck(ctx.w, ctx.realUser, o.user, o.target, { identity: o.identity, noPubkey: o.noPubkey });
    ctx.emit.trace = c.trace;
    if (o.verbose) ctx.err(verboseLines(ctx, o, c));
    if (c.netError) {
      ctx.err(c.netError);
      return 255;
    }
    const ip = c.ip ?? resolveName(ctx.w, o.target).ip ?? o.target;
    if (!isKnown(ctx, o.target, ip)) {
      ctx.out(
        `The authenticity of host '${o.target} (${ip})' can't be established.\nED25519 key fingerprint is ${HOST_KEY_FP}.\nThis key is not known by any other names.`,
      );
      ctx.prompt({ prompt: "Are you sure you want to continue connecting (yes/no/[fingerprint])? ", secret: false, data: { ...o, stage: "hostkey" } });
      return 0;
    }
    return authenticate(ctx, o);
  },
  resume(ctx, p, input) {
    const o = p.data as unknown as SshOpts & { stage: string; tries?: number };
    if (o.stage === "hostkey") {
      const a = input.trim();
      if (a === "no") {
        ctx.err("Host key verification failed.");
        return 255;
      }
      if (a !== "yes" && a !== HOST_KEY_FP) {
        ctx.prompt({ prompt: "Please type 'yes', 'no' or the fingerprint: ", secret: false, data: p.data });
        return 0;
      }
      addKnown(ctx, o.target);
      ctx.err(`Warning: Permanently added '${o.target}' (ED25519) to the list of known hosts.`);
      return authenticate(ctx, o);
    }
    if (o.stage === "passphrase") {
      const priv = getFile(ctx.host, o.identity ?? `${ctx.home}/.ssh/id_ed25519`);
      const want = /ENCRYPTED:(.*)/.exec(priv?.content ?? "")?.[1]?.trim();
      if (input !== want) {
        ctx.prompt({ prompt: `Enter passphrase for key '${o.identity ?? ctx.home + "/.ssh/id_ed25519"}': `, secret: true, data: p.data });
        return 1;
      }
      login(ctx, o, "publickey");
      return 0;
    }
    if (o.stage === "password") {
      const c = sshCheck(ctx.w, ctx.realUser, o.user, o.target, { identity: o.identity, noPubkey: true });
      const pw = ctx.w.hosts.vps.users[o.user]?.password;
      if (c.passwordWorks && input === pw) {
        login(ctx, o, "password");
        return 0;
      }
      ctx.w.hosts.vps.journal.push({
        t: ctx.w.clock,
        unit: "ssh",
        msg: `Failed password for ${ctx.w.hosts.vps.users[o.user] ? "" : "invalid user "}${o.user} from ${HOME_PUBLIC_IP} port 51234 ssh2`,
      });
      const tries = (o.tries ?? 0) + 1;
      ctx.emit.trace = { ...c.trace, ok: false, failedAt: "auth", hops: c.trace.hops.map((hp) => (hp.id === "auth" ? { ...hp, ok: false, note: "Wrong password, or this login is not allowed" } : hp)) };
      if (tries >= 3) {
        refuse(ctx, o, c);
        return 255;
      }
      ctx.err("Permission denied, please try again.");
      ctx.prompt({ prompt: `${o.user}@${o.target}'s password: `, secret: true, data: { ...p.data, tries } });
      return 0;
    }
    return 0;
  },
};

function randomart(seed: string): string {
  const chars = " .o+=*BOX@%&#/^";
  const rows: string[] = [];
  for (let r = 0; r < 9; r++) {
    let row = "";
    for (let c = 0; c < 17; c++) {
      const v = parseInt(hashB64(`${seed}${r}${c}`, 1).charCodeAt(0).toString(), 10) % 23;
      row += v < chars.length ? chars[v] : " ";
    }
    rows.push(`|${row}|`);
  }
  return ["+--[ED25519 256]--+", ...rows, "+----[SHA256]-----+"].join("\n");
}

export const sshKeygen: Command = {
  name: "ssh-keygen",
  summary: "make a key pair (ssh-keygen -t ed25519)",
  run(ctx) {
    const args = ctx.argv.slice(1);
    let type = "ed25519";
    let comment = `${ctx.realUser}@${ctx.host.hostname}`;
    let path: string | undefined;
    let pass: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-t") type = args[++i] ?? "";
      else if (a === "-C") comment = args[++i] ?? "";
      else if (a === "-f") path = ctx.path(args[++i] ?? "");
      else if (a === "-N") pass = args[++i] ?? "";
      else if (a === "-l" || a === "-R") {
        ctx.info("This ssh-keygen option is not in the game yet.");
        return 0;
      }
    }
    if (type !== "ed25519" && type !== "rsa") {
      ctx.err(`unknown key type ${type}`);
      return 1;
    }
    const def = `${ctx.home}/.ssh/id_${type}`;
    ctx.out(`Generating public/private ${type} key pair.`);
    const data = { type, comment, path: path ?? "", pass: pass ?? null, stage: "path" };
    if (path) return afterPath(ctx, { ...data, stage: "path" }, path, def);
    ctx.prompt({ prompt: `Enter file in which to save the key (${def}): `, secret: false, data });
    return 0;
  },
  resume(ctx, p, input) {
    const d = p.data as { type: string; comment: string; path: string; pass: string | null; stage: string; first?: string };
    const def = `${ctx.home}/.ssh/id_${d.type}`;
    if (d.stage === "path") return afterPath(ctx, d, input.trim() ? ctx.path(input.trim()) : def, def);
    if (d.stage === "overwrite") {
      if (!/^y/i.test(input.trim())) {
        ctx.out("");
        return 1;
      }
      return askPass(ctx, d);
    }
    if (d.stage === "pass1") {
      ctx.prompt({ prompt: "Enter same passphrase again: ", secret: true, data: { ...d, stage: "pass2", first: input } });
      return 0;
    }
    if (d.stage === "pass2") {
      if (input !== d.first) {
        ctx.out("Passphrases do not match.  Try again.");
        return askPass(ctx, d);
      }
      return writeKeys(ctx, d.path, d.type, d.comment, input);
    }
    return 0;
  },
};

function afterPath(ctx: Ctx, d: { type: string; comment: string; path: string; pass: string | null; stage: string }, path: string, def: string): number {
  void def;
  const next = { ...d, path };
  if (getFile(ctx.host, path)) {
    ctx.out(`${path} already exists.`);
    ctx.prompt({ prompt: "Overwrite (y/n)? ", secret: false, data: { ...next, stage: "overwrite" } });
    return 0;
  }
  return askPass(ctx, next);
}

function askPass(ctx: Ctx, d: { type: string; comment: string; path: string; pass: string | null }): number {
  if (d.pass !== null) return writeKeys(ctx, d.path, d.type, d.comment, d.pass);
  ctx.prompt({ prompt: `Enter passphrase for "${d.path}" (empty for no passphrase): `, secret: true, data: { ...d, stage: "pass1" } });
  return 0;
}

function writeKeys(ctx: Ctx, path: string, type: string, comment: string, passphrase: string): number {
  const slash = path.lastIndexOf("/");
  const dirPath = path.slice(0, slash) || "/";
  if (!getDir(ctx.host, dirPath)) {
    if (dirPath === `${ctx.home}/.ssh`) put(ctx.host, dirPath, dir(0o700, ctx.realUser, ctx.realUser));
    else {
      ctx.err(`Saving key "${path}" failed: No such file or directory`);
      return 1;
    }
  }
  const blob = type === "ed25519" ? `AAAAC3NzaC1lZDI1NTE5AAAAI${hashB64(ctx.realUser + "key" + path, 43)}` : `AAAAB3NzaC1yc2EAAAADAQABAAABgQ${hashB64(ctx.realUser + "rsa", 120)}`;
  const pub = `ssh-${type} ${blob} ${comment}`;
  const priv = `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA${hashB64(path + "priv", 60)}\n${passphrase ? `ENCRYPTED:${passphrase}\n` : ""}-----END OPENSSH PRIVATE KEY-----\n`;
  const e1 = writeFile(ctx.host, ctx.user, path, priv, { mode: 0o600 });
  const e2 = writeFile(ctx.host, ctx.user, path + ".pub", pub + "\n", { mode: 0o644 });
  if (e1 || e2) {
    ctx.err(`Saving key "${path}" failed: Permission denied`);
    return 1;
  }
  const f = getFile(ctx.host, path);
  if (f) {
    f.mode = 0o600;
    f.content = priv;
  }
  const fp = getFile(ctx.host, path + ".pub");
  if (fp) fp.content = pub + "\n";
  ctx.out(
    [
      `Your identification has been saved in ${path}`,
      `Your public key has been saved in ${path}.pub`,
      `The key fingerprint is:`,
      `SHA256:${hashB64(ctx.realUser + "key", 43)} ${comment}`,
      `The key's randomart image is:`,
      randomart(path),
    ].join("\n"),
  );
  return 0;
}

export const sshCopyId: Command = {
  name: "ssh-copy-id",
  summary: "install your public key on a server (ssh-copy-id user@ip)",
  run(ctx) {
    const args = ctx.argv.slice(1);
    let identity = `${ctx.home}/.ssh/id_ed25519.pub`;
    let dest: string | undefined;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-i") {
        identity = ctx.path(args[++i] ?? "");
        if (!identity.endsWith(".pub")) identity += ".pub";
      } else if (!args[i].startsWith("-")) dest = args[i];
    }
    if (!dest) {
      ctx.err("Usage: /usr/bin/ssh-copy-id [-i [identity_file]] [user@]hostname");
      return 1;
    }
    const pub = readText(ctx.host, identity);
    if (!pub) {
      ctx.err(`/usr/bin/ssh-copy-id: ERROR: failed to open ID file '${identity.replace(/\.pub$/, "")}': No such file or directory`);
      ctx.info("Make a key first: ssh-keygen -t ed25519");
      return 1;
    }
    const [user, target] = dest.includes("@") ? dest.split("@") : [ctx.realUser, dest];
    const c = sshCheck(ctx.w, ctx.realUser, user, target);
    ctx.emit.trace = c.trace;
    ctx.out(`/usr/bin/ssh-copy-id: INFO: Source of key(s) to be installed: "${identity}"`);
    if (c.netError) {
      ctx.err(c.netError);
      return 1;
    }
    const vps = ctx.w.hosts.vps;
    const u = vps.users[user];
    const installed = u ? (readText(vps, `${u.home}/.ssh/authorized_keys`) ?? "").split("\n").map(keyBody) : [];
    ctx.out(`/usr/bin/ssh-copy-id: INFO: attempting to log in with the new key(s), to filter out any that are already installed`);
    if (installed.includes(keyBody(pub)) && c.keyOk) {
      ctx.out(`\n/usr/bin/ssh-copy-id: WARNING: All keys were skipped because they already exist on the remote system.\n\t\t(if you think this is a mistake, you may want to use -f option)`);
      return 0;
    }
    ctx.out(`/usr/bin/ssh-copy-id: INFO: 1 key(s) remain to be installed -- if you are prompted now it is to install the new keys`);
    if (!c.passwordPrompt) {
      ctx.err(`${user}@${target}: Permission denied (publickey).`);
      ctx.info("ssh-copy-id needs password login to work once. Passwords are off here, so paste the key into authorized_keys from a session that works.");
      return 1;
    }
    ctx.prompt({ prompt: `${user}@${target}'s password: `, secret: true, data: { user, target, pub, tries: 0 } });
    return 0;
  },
  resume(ctx, p, input) {
    const { user, target, pub } = p.data as { user: string; target: string; pub: string };
    const c = sshCheck(ctx.w, ctx.realUser, user, target, { noPubkey: true });
    const vps = ctx.w.hosts.vps;
    const u = vps.users[user];
    if (!c.passwordWorks || !u || input !== u.password) {
      const tries = Number(p.data.tries) + 1;
      if (tries >= 3) {
        ctx.err(`${user}@${target}: Permission denied (${c.methods.join(",")}).`);
        return 1;
      }
      ctx.err("Permission denied, please try again.");
      ctx.prompt({ prompt: `${user}@${target}'s password: `, secret: true, data: { ...p.data, tries } });
      return 0;
    }
    const sshDirPath = `${u.home}/.ssh`;
    if (!getDir(vps, sshDirPath)) put(vps, sshDirPath, dir(0o700, user, user));
    const akPath = `${sshDirPath}/authorized_keys`;
    const ak = getFile(vps, akPath);
    if (ak) ak.content += pub.endsWith("\n") ? pub : pub + "\n";
    else put(vps, akPath, file(pub.endsWith("\n") ? pub : pub + "\n", 0o600, user, user));
    ctx.out(`\nNumber of key(s) added: 1\n\nNow try logging into the machine, with: "ssh '${user}@${target}'"\nand check to make sure that only the key(s) you wanted were added.`);
    return 0;
  },
};

export const sshd: Command = {
  name: "sshd",
  summary: "check SSH server config (sudo sshd -t, sudo sshd -T)",
  run(ctx) {
    if (ctx.host.id !== "vps") {
      ctx.err("sshd: run this on the server.");
      return 1;
    }
    if (ctx.user !== "root") {
      ctx.err("sshd: no hostkeys available -- exiting.");
      ctx.info("sshd needs root to read its host keys. Use sudo.");
      return 1;
    }
    const parse = parseSshd(ctx.host);
    if (parse.errors.length) {
      ctx.err(parse.errors.join("\n"));
      return 255;
    }
    if (ctx.argv.includes("-T")) ctx.out(sshdDump(ctx.host));
    return 0;
  },
};

export const SSH_COMMANDS = [ssh, sshKeygen, sshCopyId, sshd];
