import { createDraft, finishDraft, setAutoFreeze } from "immer";
import { can, getDir, getNode, isSudoer, resolvePath, userGroups } from "../fs";
import { advance } from "../tick";
import type { Frame, OutLine, Pending, Shell, World } from "../types";
import { globMatch } from "../util";
import type { Ctx, RunResult } from "./ctx";
import { parse, ParseError, type Sequence, type SimpleCommand, type Word } from "./parse";
import { COMMANDS, NEEDS_ANY_PACKAGE, NEEDS_PACKAGE, NOT_INSTALLED_HINT } from "./registry";
import { writeRedirect } from "./redirect";

setAutoFreeze(false);

export function createShell(id: string, frame: Frame): Shell {
  return { id, frames: [frame], history: [] };
}

export function topFrame(sh: Shell): Frame {
  return sh.frames[sh.frames.length - 1];
}

export function homeOf(w: World, f: Frame): string {
  return w.hosts[f.host].users[f.user]?.home ?? "/";
}

export function promptText(w: World, sh: Shell): string {
  if (sh.pending) return sh.pending.prompt;
  const f = topFrame(sh);
  const host = w.hosts[f.host];
  const home = homeOf(w, f);
  let cwd = f.cwd;
  if (cwd === home) cwd = "~";
  else if (home !== "/" && cwd.startsWith(home + "/")) cwd = "~" + cwd.slice(home.length);
  return `${f.user}@${host.hostname}:${cwd}${f.user === "root" ? "#" : "$"} `;
}

interface Exec {
  w: World;
  sh: Shell;
  out: OutLine[];
  emit: Ctx["emit"];
  vars: Record<string, string>;
  stopped: boolean;
  /** When set, the last command's stdout goes here instead of the screen ($(...)). */
  capture?: string[];
  /** Script nesting depth, to stop runaway recursion. */
  depth?: number;
}

function baseVars(ex: Exec): Record<string, string> {
  const f = topFrame(ex.sh);
  return {
    ...(ex.sh.vars ?? {}),
    ...ex.vars,
    HOME: homeOf(ex.w, f),
    USER: f.user,
    PWD: f.cwd,
    HOSTNAME: ex.w.hosts[f.host].hostname,
    SHELL: "/bin/bash",
    "?": ex.vars["?"] ?? "0",
  };
}

function makeCtx(
  ex: Exec,
  argv: string[],
  opts: { sudo: boolean; stdin?: string; outBuf: string[]; errNull?: boolean; env?: Record<string, string> },
): Ctx {
  const frame = topFrame(ex.sh);
  const host = ex.w.hosts[frame.host];
  const user = opts.sudo ? "root" : frame.user;
  const home = host.users[frame.user]?.home ?? "/";
  return {
    w: ex.w,
    sh: ex.sh,
    frame,
    host,
    user,
    realUser: frame.user,
    sudo: opts.sudo,
    argv,
    stdin: opts.stdin,
    home,
    vars: baseVars(ex),
    env: { ...(ex.sh.vars ?? {}), ...(opts.env ?? {}) },
    script: (text, args, name) => {
      // sudo sh file.sh: every line of the script runs as root.
      if (!opts.sudo || frame.user === "root") return runScriptText(ex, text, args, name);
      const depth = ex.sh.frames.length;
      ex.sh.frames.push({ ...frame, user: "root", via: "su", sudoOk: true });
      try {
        return runScriptText(ex, text, args, name);
      } finally {
        ex.sh.frames.length = depth;
      }
    },
    out: (s) => opts.outBuf.push(s),
    err: (s) => {
      if (!opts.errNull) ex.out.push({ text: s, kind: "err" });
    },
    info: (s) => ex.out.push({ text: s, kind: "info" }),
    prompt: (p) => {
      ex.sh.pending = { cmd: argv[0], ...p, data: { ...p.data, sudo: opts.sudo } } as Pending;
      ex.stopped = true;
    },
    emit: ex.emit,
    path: (p) => resolvePath(frame.cwd, p, home),
    journal: (unit, msg, proc) => {
      host.journal.push({ t: ex.w.clock, unit, msg, proc });
      if (host.journal.length > 600) host.journal.splice(0, host.journal.length - 600);
    },
  };
}

function expandWord(ex: Exec, w: Word): string[] {
  let text = w.text;
  const f = topFrame(ex.sh);
  const host = ex.w.hosts[f.host];
  if (!w.quoted) {
    const home = homeOf(ex.w, f);
    if (text === "~") text = home;
    else if (text.startsWith("~/")) text = home + text.slice(1);
  }
  if (w.quoted || !/[*?]/.test(text)) return [text];
  const abs = resolvePath(f.cwd, text, homeOf(ex.w, f));
  const slash = abs.lastIndexOf("/");
  const dirPath = abs.slice(0, slash) || "/";
  const pattern = abs.slice(slash + 1);
  const d = getDir(host, dirPath);
  if (!d) return [text];
  const matches = Object.keys(d.children)
    .filter((n) => (pattern.startsWith(".") || !n.startsWith(".")) && globMatch(pattern, n))
    .sort();
  if (!matches.length) return [text];
  const prefix = text.slice(0, text.lastIndexOf("/") + 1);
  return matches.map((m) => prefix + m);
}

/** Run the inside of $(...) and return what it printed. */
function captureSubst(ex: Exec, inner: string): string {
  const prev = ex.capture;
  ex.capture = [];
  try {
    runSequence(ex, parse(inner, baseVars(ex), (i) => captureSubst(ex, i)));
    return ex.capture.join("\n");
  } finally {
    ex.capture = prev;
  }
}

function parseLine(ex: Exec, line: string): Sequence {
  return parse(line, baseVars(ex), (inner) => captureSubst(ex, inner));
}

/**
 * Run a script's text line by line, the way bash runs a file: in its own copy of the
 * shell, so a cd inside the script does not move you. Supports set -e.
 */
function runScriptText(ex: Exec, text: string, args: string[], name: string): number {
  if ((ex.depth ?? 0) > 6) {
    ex.out.push({ text: `${name}: too many nested scripts`, kind: "err" });
    return 1;
  }
  const frame = topFrame(ex.sh);
  const savedCwd = frame.cwd;
  const savedVars = { ...ex.vars };
  const frames = ex.sh.frames.length;
  ex.depth = (ex.depth ?? 0) + 1;
  args.forEach((a, i) => (ex.vars[String(i + 1)] = a));
  ex.vars["0"] = name;
  let code = 0;
  let stopOnError = false;
  try {
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (/^set\s+-[a-z]*e/.test(line)) {
        stopOnError = true;
        continue;
      }
      if (/^set\s/.test(line)) continue;
      let seq: Sequence;
      try {
        seq = parseLine(ex, line);
      } catch (e) {
        ex.out.push({ text: `${name}: ${e instanceof ParseError ? e.message : String(e)}`, kind: "err" });
        code = 2;
        if (stopOnError) break;
        continue;
      }
      code = runSequence(ex, seq);
      if (ex.stopped || (stopOnError && code !== 0)) break;
    }
  } finally {
    ex.depth = (ex.depth ?? 1) - 1;
    ex.sh.frames.length = Math.min(ex.sh.frames.length, Math.max(frames, 1));
    topFrame(ex.sh).cwd = savedCwd;
    ex.vars = savedVars;
  }
  return code;
}

function sudoUsed(seq: Sequence): boolean {
  return seq.items.some((it) => it.pipeline.cmds.some((c) => c.argv[0]?.text === "sudo"));
}

function runSimple(ex: Exec, cmd: SimpleCommand, stdin: string | undefined, isLast: boolean): { code: number; stdout: string } {
  if (!cmd.argv.length) {
    // NAME=value on its own sets a shell variable.
    ex.sh.vars = { ...(ex.sh.vars ?? {}), ...(cmd.env ?? {}) };
    return { code: 0, stdout: "" };
  }
  let argv = cmd.argv.flatMap((w) => expandWord(ex, w));
  let sudo = false;
  const frame = topFrame(ex.sh);
  const host = ex.w.hosts[frame.host];
  const outBuf: string[] = [];

  if (argv[0] === "sudo") {
    argv = argv.slice(1);
    let asUser = "root";
    let login = false;
    while (argv[0]?.startsWith("-")) {
      const fl = argv.shift()!;
      if (fl === "-u") asUser = argv.shift() ?? "root";
      else if (fl === "-i" || fl === "-s" || fl === "-is") login = true;
    }
    if (!isSudoer(host, frame.user)) {
      ex.out.push({ text: `${frame.user} is not in the sudoers file.`, kind: "err" });
      ex.out.push({ text: `Tip: only users in the sudo group can use sudo. Log in as root, then: usermod -aG sudo ${frame.user}`, kind: "info" });
      return { code: 1, stdout: "" };
    }
    if (login) {
      const target = asUser;
      const u = host.users[target];
      ex.sh.frames.push({ host: frame.host, user: target, cwd: u?.home ?? "/root", via: "su", loginGroups: userGroups(host, target) });
      return { code: 0, stdout: "" };
    }
    if (!argv.length) {
      ex.out.push({ text: "usage: sudo command", kind: "err" });
      return { code: 1, stdout: "" };
    }
    if (argv[0] === "su") {
      const rest = argv.slice(1).filter((a) => a !== "-" && a !== "-l");
      const target = rest[0] ?? "root";
      const u = host.users[target];
      if (!u) {
        ex.out.push({ text: `su: user ${target} does not exist or the user entry does not contain all the required fields`, kind: "err" });
        return { code: 1, stdout: "" };
      }
      ex.sh.frames.push({ host: frame.host, user: target, cwd: u.home, via: "su", loginGroups: userGroups(host, target) });
      return { code: 0, stdout: "" };
    }
    sudo = asUser === "root";
  }

  if (cmd.stdinFrom) {
    const path = resolvePath(frame.cwd, cmd.stdinFrom, homeOf(ex.w, frame));
    const node = getNode(host, path);
    if (!node || node.type !== "file") {
      ex.out.push({ text: `-bash: ${cmd.stdinFrom}: ${node ? "Is a directory" : "No such file or directory"}`, kind: "err" });
      return { code: 1, stdout: "" };
    }
    if (!can(host, frame.user, node, "r")) {
      ex.out.push({ text: `-bash: ${cmd.stdinFrom}: Permission denied`, kind: "err" });
      return { code: 1, stdout: "" };
    }
    stdin = node.content;
  }

  const name = argv[0];
  if (name.includes("/")) return runPath(ex, cmd, argv, sudo, isLast);
  const command = COMMANDS[name];
  const pkg = NEEDS_PACKAGE[name];
  const pkgs = NEEDS_ANY_PACKAGE[name] ?? (pkg ? [pkg] : []);
  const missing = pkgs.length > 0 && !pkgs.some((p) => host.packages[p]);
  if (!command || missing) {
    if (missing && pkg) {
      const hint = NOT_INSTALLED_HINT[name] ?? `sudo apt install ${pkg}`;
      ex.out.push({ text: `Command '${name}' not found, but can be installed with:\n${hint}`, kind: "err" });
    } else if (name === "vim" || name === "vi") {
      ex.out.push({ text: `vim works on a real server. In this game, use nano.`, kind: "info" });
    } else {
      ex.out.push({ text: `${name}: not in this game yet. Type help to see what works.`, kind: "info" });
    }
    return { code: 127, stdout: "" };
  }
  const ctx = makeCtx(ex, argv, { sudo, stdin, outBuf, errNull: cmd.stderrNull, env: cmd.env });
  let code: number;
  try {
    code = command.run(ctx);
  } catch (e) {
    ex.out.push({ text: `${name}: internal sim error: ${(e as Error).message}`, kind: "err" });
    code = 1;
  }
  let stdout = outBuf.join("\n");
  if (cmd.redirect) {
    // The redirect is done by YOUR shell, not by sudo. Classic gotcha.
    const err = writeRedirect(ex.w, topFrame(ex.sh), cmd.redirect.target, stdout, cmd.redirect.op === ">>");
    if (err) {
      ex.out.push({ text: `-bash: ${cmd.redirect.target}: ${err}`, kind: "err" });
      code = 1;
    }
    stdout = "";
  } else if (isLast && stdout) {
    if (ex.capture) ex.capture.push(stdout);
    else ex.out.push({ text: stdout, kind: "out" });
  }
  return { code, stdout };
}

/** ./backup.sh or /srv/crumb/backup.sh: run a script file. Needs the x bit, like real bash. */
function runPath(ex: Exec, cmd: SimpleCommand, argv: string[], sudo: boolean, isLast: boolean): { code: number; stdout: string } {
  const frame = topFrame(ex.sh);
  const host = ex.w.hosts[frame.host];
  const name = argv[0];
  const path = resolvePath(frame.cwd, name, homeOf(ex.w, frame));
  const node = getNode(host, path);
  if (!node) {
    ex.out.push({ text: `-bash: ${name}: No such file or directory`, kind: "err" });
    return { code: 127, stdout: "" };
  }
  if (node.type === "dir") {
    ex.out.push({ text: `-bash: ${name}: Is a directory`, kind: "err" });
    return { code: 126, stdout: "" };
  }
  const user = sudo ? "root" : frame.user;
  if (!can(host, user, node, "x") || !can(host, user, node, "r")) {
    ex.out.push({ text: `-bash: ${name}: Permission denied`, kind: "err" });
    if (!(node.mode & 0o111)) ex.out.push({ text: `Tip: a script needs the x (execute) bit. chmod +x ${name}`, kind: "info" });
    return { code: 126, stdout: "" };
  }
  const prevCapture = ex.capture;
  const buf: string[] = [];
  if (cmd.redirect || !isLast) ex.capture = buf;
  const code = runScriptText(ex, node.content, argv.slice(1), name);
  ex.capture = prevCapture;
  let stdout = buf.join("\n");
  if (cmd.redirect) {
    const err = writeRedirect(ex.w, frame, cmd.redirect.target, stdout, cmd.redirect.op === ">>");
    if (err) {
      ex.out.push({ text: `-bash: ${cmd.redirect.target}: ${err}`, kind: "err" });
      return { code: 1, stdout: "" };
    }
    stdout = "";
  }
  return { code, stdout };
}

function runSequence(ex: Exec, seq: Sequence): number {
  let code = 0;
  let skip: "&&" | "||" | null = null;
  for (const item of seq.items) {
    if (ex.stopped) break;
    const shouldRun = skip === null || (skip === "&&" && code === 0) || (skip === "||" && code !== 0);
    if (shouldRun) {
      let stdin: string | undefined;
      const cmds = item.pipeline.cmds;
      for (let i = 0; i < cmds.length; i++) {
        const r = runSimple(ex, cmds[i], stdin, i === cmds.length - 1);
        stdin = r.stdout;
        code = r.code;
        if (ex.stopped) break;
      }
      ex.vars["?"] = String(code);
    }
    skip = item.next === "&&" || item.next === "||" ? item.next : null;
  }
  return code;
}

function finish(ex: Exec, wDraft: World, shDraft: Shell, code: number): RunResult {
  const world = finishDraft(wDraft) as World;
  const shell = finishDraft(shDraft) as Shell;
  return { world, shell, out: ex.out, code, ...ex.emit };
}

export function runLine(world: World, shell: Shell, line: string, vars: Record<string, string> = {}): RunResult {
  const w = createDraft(world) as World;
  const sh = createDraft(shell) as Shell;
  const ex: Exec = { w, sh, out: [], emit: {}, vars: { ...vars }, stopped: false };

  if (sh.pending) {
    const p = sh.pending;
    sh.pending = undefined;
    const code = resumePending(ex, p, line);
    return finish(ex, w, sh, code);
  }

  const trimmed = line.trim();
  if (!trimmed) return finish(ex, w, sh, 0);
  sh.history.push(trimmed);
  if (sh.history.length > 300) sh.history.splice(0, sh.history.length - 300);
  captureLogin(w, sh);
  advance(w, w.clock + 4);

  let seq: Sequence;
  try {
    seq = parseLine(ex, trimmed);
  } catch (e) {
    const msg = e instanceof ParseError ? e.message : String(e);
    ex.out.push({ text: `-bash: ${msg}`, kind: "err" });
    return finish(ex, w, sh, 2);
  }

  const frame = topFrame(sh);
  const host = w.hosts[frame.host];
  if (sudoUsed(seq) && frame.user !== "root" && !frame.sudoOk && isSudoer(host, frame.user)) {
    sh.pending = {
      prompt: `[sudo] password for ${frame.user}: `,
      secret: true,
      cmd: "__sudo",
      data: { line: trimmed, tries: 0 },
    };
    return finish(ex, w, sh, 0);
  }
  const code = runSequence(ex, seq);
  return finish(ex, w, sh, code);
}

/**
 * A session's groups are fixed when it logs in. Windows that started before this was
 * tracked get their groups on their first command, which is the same thing.
 */
function captureLogin(w: World, sh: Shell): void {
  const f = topFrame(sh);
  if (!f.loginGroups && w.hosts[f.host]?.users[f.user]) f.loginGroups = userGroups(w.hosts[f.host], f.user);
}

function resumePending(ex: Exec, p: Pending, input: string): number {
  if (p.cmd === "__sudo") {
    const frame = topFrame(ex.sh);
    const host = ex.w.hosts[frame.host];
    const pw = host.users[frame.user]?.password;
    const ok = frame.host === "laptop" ? input.length > 0 : pw !== undefined && input === pw;
    if (!ok) {
      const tries = Number(p.data.tries) + 1;
      if (tries >= 3) {
        ex.out.push({ text: "sudo: 3 incorrect password attempts", kind: "err" });
        ex.out.push({ text: `Hint: sudo wants ${frame.user}'s own password, not root's.`, kind: "info" });
        return 1;
      }
      ex.out.push({ text: "Sorry, try again.", kind: "err" });
      ex.sh.pending = { ...p, data: { ...p.data, tries } };
      return 1;
    }
    frame.sudoOk = true;
    advance(ex.w, ex.w.clock + 2);
    const seq = parseLine(ex, String(p.data.line));
    return runSequence(ex, seq);
  }
  const command = COMMANDS[p.cmd];
  if (!command?.resume) return 0;
  const frame = topFrame(ex.sh);
  const outBuf: string[] = [];
  const ctx = makeCtx(ex, [p.cmd], { sudo: Boolean(p.data.sudo), outBuf });
  ctx.user = p.data.sudo ? "root" : frame.user;
  const code = command.resume(ctx, p, input);
  if (outBuf.length) ex.out.push({ text: outBuf.join("\n"), kind: "out" });
  return code;
}

export function cancelPending(world: World, shell: Shell): RunResult {
  const sh = createDraft(shell) as Shell;
  const w = createDraft(world) as World;
  sh.pending = undefined;
  return { world: finishDraft(w) as World, shell: finishDraft(sh) as Shell, out: [{ text: "^C", kind: "out" }], code: 130 };
}

/**
 * Run one line on a world that is ALREADY a draft (inside a reconciler: cron, CI jobs).
 * Uses its own throwaway window. Returns the exit code and everything printed.
 */
export function runDetached(w: World, frame: Frame, line: string, vars: Record<string, string> = {}): { code: number; out: string } {
  const sh: Shell = { id: "detached", frames: [{ ...frame }], history: [] };
  const ex: Exec = { w, sh, out: [], emit: {}, vars: { ...vars }, stopped: false };
  let code: number;
  try {
    code = runSequence(ex, parseLine(ex, line));
  } catch (e) {
    ex.out.push({ text: `sh: 1: ${e instanceof ParseError ? e.message : String(e)}`, kind: "err" });
    code = 2;
  }
  // Nothing can answer a prompt here (no terminal), like cron.
  if (sh.pending) code = code || 1;
  return { code, out: ex.out.map((o) => o.text).join("\n") };
}

/** Run many lines in a row (show me, replays, tests). */
export function runScript(
  world: World,
  shell: Shell,
  lines: string[],
  vars: Record<string, string> = {},
): { world: World; shell: Shell; out: OutLine[]; lastCode: number } {
  let w = world;
  let sh = shell;
  const out: OutLine[] = [];
  let lastCode = 0;
  for (const raw of lines) {
    const line = raw.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
    const r = runLine(w, sh, line, vars);
    w = r.world;
    sh = r.shell;
    out.push(...r.out);
    lastCode = r.code;
  }
  return { world: w, shell: sh, out, lastCode };
}
