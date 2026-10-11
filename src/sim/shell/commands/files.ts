import {
  basename,
  can,
  canTraverse,
  dir,
  dirname,
  file,
  fsErrorText,
  getDir,
  getNode,
  mkdirp,
  modeString,
  nodeSize,
  writeFile,
} from "../../fs";
import type { FsNode } from "../../types";
import { humanBytes, pad, padL } from "../../util";
import { lsTime } from "../../time";
import { flagSet, type Command, type Ctx } from "../ctx";
import { virtualRead } from "../virtual";

function deny(ctx: Ctx, cmd: string, what: string, err: string) {
  ctx.err(`${cmd}: ${what}: ${err}`);
}

/** Look up a node, checking traverse permission. */
function lookup(ctx: Ctx, path: string): { node?: FsNode; err?: string } {
  if (!canTraverse(ctx.host, ctx.user, path)) return { err: "Permission denied" };
  const node = getNode(ctx.host, path);
  if (!node) return { err: "No such file or directory" };
  return { node };
}

export const pwd: Command = {
  name: "pwd",
  summary: "print the folder you are in",
  run(ctx) {
    ctx.out(ctx.frame.cwd);
    return 0;
  },
};

export const cd: Command = {
  name: "cd",
  summary: "change folder (cd /etc, cd .., cd ~)",
  run(ctx) {
    const target = ctx.argv[1] === "-" ? (ctx.vars.OLDPWD ?? ctx.frame.cwd) : ctx.path(ctx.argv[1] ?? ctx.home);
    const { node, err } = lookup(ctx, target);
    if (err) {
      ctx.err(`-bash: cd: ${ctx.argv[1]}: ${err}`);
      return 1;
    }
    if (node!.type !== "dir") {
      ctx.err(`-bash: cd: ${ctx.argv[1]}: Not a directory`);
      return 1;
    }
    if (!can(ctx.host, ctx.user, node!, "x")) {
      ctx.err(`-bash: cd: ${ctx.argv[1]}: Permission denied`);
      return 1;
    }
    ctx.frame.cwd = target;
    return 0;
  },
};

function lsLine(name: string, n: FsNode, human: boolean, clock: number): string {
  const size = n.type === "dir" ? 4096 : nodeSize(n);
  const links = n.type === "dir" ? Object.values(n.children).filter((c) => c.type === "dir").length + 2 : 1;
  const sizeStr = human ? humanBytes(size) : String(size);
  return `${modeString(n)} ${padL(String(links), 2)} ${pad(n.owner, 6)} ${pad(n.group, 6)} ${padL(sizeStr, 6)} ${lsTime(clock)} ${name}`;
}

export const ls: Command = {
  name: "ls",
  summary: "list files (ls -la shows hidden files and permissions)",
  run(ctx) {
    const { flags, args } = flagSet(ctx.argv.slice(1));
    const long = flags.has("l");
    const all = flags.has("a") || flags.has("A");
    const human = flags.has("h");
    const targets = args.length ? args : ["."];
    let code = 0;
    const blocks: string[] = [];
    for (const t of targets) {
      const path = ctx.path(t);
      const { node, err } = lookup(ctx, path);
      if (err) {
        ctx.err(`ls: cannot access '${t}': ${err}`);
        code = 2;
        continue;
      }
      if (node!.type === "file") {
        blocks.push(long ? lsLine(t, node!, human, ctx.w.clock) : t);
        continue;
      }
      if (!can(ctx.host, ctx.user, node!, "r")) {
        ctx.err(`ls: cannot open directory '${t}': Permission denied`);
        code = 2;
        continue;
      }
      const d = node as Extract<FsNode, { type: "dir" }>;
      let names = Object.keys(d.children).sort();
      if (!all) names = names.filter((n) => !n.startsWith("."));
      const lines: string[] = [];
      if (targets.length > 1) lines.push(`${t}:`);
      if (long) {
        const total = Math.ceil(names.reduce((s, n) => s + nodeSize(d.children[n]), 0) / 1024) + 4;
        lines.push(`total ${total}`);
        if (all) {
          lines.push(lsLine(".", d, human, ctx.w.clock));
          const parent = getNode(ctx.host, dirname(path)) ?? d;
          lines.push(lsLine("..", parent, human, ctx.w.clock));
        }
        for (const n of names) lines.push(lsLine(n, d.children[n], human, ctx.w.clock));
      } else {
        const shown = all && !flags.has("A") ? [".", "..", ...names] : names;
        if (shown.length) lines.push(shown.join("  "));
      }
      blocks.push(lines.join("\n"));
    }
    if (blocks.length) ctx.out(blocks.join("\n\n"));
    return code;
  },
};

export const cat: Command = {
  name: "cat",
  summary: "print a file",
  run(ctx) {
    const { args } = flagSet(ctx.argv.slice(1));
    if (!args.length) {
      if (ctx.stdin !== undefined) ctx.out(ctx.stdin);
      return 0;
    }
    let code = 0;
    const parts: string[] = [];
    for (const a of args) {
      const path = ctx.path(a);
      const virt = virtualRead(ctx, path);
      if (virt !== undefined) {
        parts.push(virt.replace(/\n$/, ""));
        continue;
      }
      const { node, err } = lookup(ctx, path);
      if (err) {
        deny(ctx, "cat", a, err);
        code = 1;
        continue;
      }
      if (node!.type === "dir") {
        deny(ctx, "cat", a, "Is a directory");
        code = 1;
        continue;
      }
      if (!can(ctx.host, ctx.user, node!, "r")) {
        deny(ctx, "cat", a, "Permission denied");
        code = 1;
        continue;
      }
      if (node!.padBytes && node!.padBytes > 50_000) {
        parts.push((node!.content || "").replace(/\n$/, ""));
        parts.push(`... (${humanBytes(nodeSize(node!))} of log lines. Try: tail -n 20 ${a})`);
        continue;
      }
      parts.push(node!.content.replace(/\n$/, ""));
    }
    if (parts.length) ctx.out(parts.join("\n"));
    return code;
  },
};

export const echo: Command = {
  name: "echo",
  summary: "print text (echo hi > file writes it)",
  run(ctx) {
    const args = ctx.argv.slice(1);
    const noNewline = args[0] === "-n";
    ctx.out((noNewline ? args.slice(1) : args).join(" "));
    return 0;
  },
};

export const mkdir: Command = {
  name: "mkdir",
  summary: "make a folder (mkdir -p a/b/c)",
  run(ctx) {
    const { flags, args } = flagSet(ctx.argv.slice(1));
    const modeIdx = ctx.argv.indexOf("-m");
    const mode = modeIdx > 0 ? parseInt(ctx.argv[modeIdx + 1], 8) : 0o755;
    const names = args.filter((a, i) => !(modeIdx > 0 && ctx.argv[modeIdx + 1] === a && i === 0));
    if (!names.length) {
      ctx.err("mkdir: missing operand");
      return 1;
    }
    let code = 0;
    for (const a of names) {
      const path = ctx.path(a);
      const existing = getNode(ctx.host, path);
      if (existing) {
        if (!flags.has("p")) {
          ctx.err(`mkdir: cannot create directory '${a}': File exists`);
          code = 1;
        }
        continue;
      }
      if (!flags.has("p") && !getDir(ctx.host, dirname(path))) {
        ctx.err(`mkdir: cannot create directory '${a}': No such file or directory`);
        code = 1;
        continue;
      }
      const err = mkdirp(ctx.host, ctx.user, path, mode);
      if (err) {
        ctx.err(`mkdir: cannot create directory '${a}': ${fsErrorText(err)}`);
        code = 1;
      }
    }
    return code;
  },
};

export const touch: Command = {
  name: "touch",
  summary: "create an empty file",
  run(ctx) {
    const args = ctx.argv.slice(1).filter((a) => !a.startsWith("-"));
    if (!args.length) {
      ctx.err("touch: missing file operand");
      return 1;
    }
    let code = 0;
    for (const a of args) {
      const path = ctx.path(a);
      if (getNode(ctx.host, path)) continue;
      const err = writeFile(ctx.host, ctx.user, path, "");
      if (err) {
        ctx.err(`touch: cannot touch '${a}': ${fsErrorText(err)}`);
        code = 1;
      }
    }
    return code;
  },
};

const PROTECTED = ["/", "/etc", "/usr", "/bin", "/var", "/home", "/root", "/boot", "/srv"];

export const rm: Command = {
  name: "rm",
  summary: "delete files (rm -r for folders). There is no trash.",
  run(ctx) {
    const { flags, args } = flagSet(ctx.argv.slice(1));
    const recursive = flags.has("r") || flags.has("R") || flags.has("recursive");
    const force = flags.has("f") || flags.has("force");
    if (!args.length) {
      ctx.err("rm: missing operand");
      return 1;
    }
    let code = 0;
    for (const a of args) {
      const path = ctx.path(a);
      if (PROTECTED.includes(path)) {
        ctx.err(`rm: refusing to remove '${a}'`);
        ctx.info("The game will not let you delete a system folder. On a real server this would wreck the box.");
        code = 1;
        continue;
      }
      const { node, err } = lookup(ctx, path);
      if (err) {
        if (!force) {
          ctx.err(`rm: cannot remove '${a}': ${err}`);
          code = 1;
        }
        continue;
      }
      if (node!.type === "dir" && !recursive) {
        ctx.err(`rm: cannot remove '${a}': Is a directory`);
        code = 1;
        continue;
      }
      const parent = getDir(ctx.host, dirname(path))!;
      if (!can(ctx.host, ctx.user, parent, "w")) {
        ctx.err(`rm: cannot remove '${a}': Permission denied`);
        code = 1;
        continue;
      }
      delete parent.children[basename(path)];
    }
    return code;
  },
};

function cloneNode(n: FsNode, owner: string): FsNode {
  if (n.type === "file") return file(n.content, n.mode, owner, owner === "root" ? "root" : owner, n.padBytes);
  const d = dir(n.mode, owner, owner === "root" ? "root" : owner);
  for (const [k, v] of Object.entries(n.children)) d.children[k] = cloneNode(v, owner);
  return d;
}

function copyOrMove(ctx: Ctx, move: boolean): number {
  const name = move ? "mv" : "cp";
  const { flags, args } = flagSet(ctx.argv.slice(1));
  if (args.length < 2) {
    ctx.err(`${name}: missing destination file operand after '${args[0] ?? ""}'`);
    return 1;
  }
  const dest = ctx.path(args[args.length - 1]);
  const sources = args.slice(0, -1);
  let code = 0;
  for (const s of sources) {
    const src = ctx.path(s);
    const { node, err } = lookup(ctx, src);
    if (err) {
      ctx.err(`${name}: cannot stat '${s}': ${err}`);
      code = 1;
      continue;
    }
    if (node!.type === "dir" && !move && !(flags.has("r") || flags.has("R") || flags.has("a"))) {
      ctx.err(`cp: -r not specified; omitting directory '${s}'`);
      code = 1;
      continue;
    }
    if (!can(ctx.host, ctx.user, node!, "r")) {
      ctx.err(`${name}: cannot open '${s}' for reading: Permission denied`);
      code = 1;
      continue;
    }
    const destNode = getNode(ctx.host, dest);
    const finalPath = destNode?.type === "dir" ? `${dest === "/" ? "" : dest}/${basename(src)}` : dest;
    const parent = getDir(ctx.host, dirname(finalPath));
    if (!parent) {
      ctx.err(`${name}: cannot create regular file '${args[args.length - 1]}': No such file or directory`);
      code = 1;
      continue;
    }
    if (!can(ctx.host, ctx.user, parent, "w")) {
      ctx.err(`${name}: cannot create regular file '${args[args.length - 1]}': Permission denied`);
      code = 1;
      continue;
    }
    const copy = move ? node! : cloneNode(node!, ctx.user);
    if (!move && flags.has("a") && node!.type === "file") {
      copy.owner = node!.owner;
      copy.group = node!.group;
    }
    parent.children[basename(finalPath)] = copy;
    if (move) {
      const srcParent = getDir(ctx.host, dirname(src))!;
      if (srcParent !== parent || basename(src) !== basename(finalPath)) delete srcParent.children[basename(src)];
    }
  }
  return code;
}

export const cp: Command = { name: "cp", summary: "copy files (cp -r for folders)", run: (ctx) => copyOrMove(ctx, false) };
export const mv: Command = { name: "mv", summary: "move or rename files", run: (ctx) => copyOrMove(ctx, true) };

function parseSymbolic(spec: string, mode: number): number | null {
  let m = mode;
  for (const part of spec.split(",")) {
    const r = /^([ugoa]*)([+\-=])([rwxXt]*)$/.exec(part);
    if (!r) return null;
    const who = r[1] || "a";
    let bits = 0;
    for (const p of r[3]) {
      if (p === "r") bits |= 4;
      if (p === "w") bits |= 2;
      if (p === "x" || p === "X") bits |= 1;
    }
    let mask = 0;
    if (who.includes("u") || who.includes("a")) mask |= bits << 6;
    if (who.includes("g") || who.includes("a")) mask |= bits << 3;
    if (who.includes("o") || who.includes("a")) mask |= bits;
    if (r[2] === "+") m |= mask;
    else if (r[2] === "-") m &= ~mask;
    else {
      let clear = 0;
      if (who.includes("u") || who.includes("a")) clear |= 0o700;
      if (who.includes("g") || who.includes("a")) clear |= 0o070;
      if (who.includes("o") || who.includes("a")) clear |= 0o007;
      m = (m & ~clear) | mask;
    }
  }
  return m;
}

function walk(n: FsNode, fn: (n: FsNode) => void) {
  fn(n);
  if (n.type === "dir") for (const c of Object.values(n.children)) walk(c, fn);
}

export const chmod: Command = {
  name: "chmod",
  summary: "change permissions (chmod 600 file, chmod +x script)",
  run(ctx) {
    const recursive = ctx.argv.includes("-R") || ctx.argv.includes("--recursive");
    const rawArgs = ctx.argv.slice(1).filter((a) => a !== "-R" && a !== "--recursive");
    const spec = rawArgs[0];
    const files = rawArgs.slice(1);
    if (!spec || !files.length) {
      ctx.err("chmod: missing operand");
      return 1;
    }
    let code = 0;
    for (const f of files) {
      const path = ctx.path(f);
      const { node, err } = lookup(ctx, path);
      if (err) {
        ctx.err(`chmod: cannot access '${f}': ${err}`);
        code = 1;
        continue;
      }
      if (ctx.user !== "root" && node!.owner !== ctx.user) {
        ctx.err(`chmod: changing permissions of '${f}': Operation not permitted`);
        code = 1;
        continue;
      }
      const apply = (n: FsNode) => {
        if (/^[0-7]{3,4}$/.test(spec)) n.mode = (n.mode & ~0o7777) | parseInt(spec, 8);
        else {
          const m = parseSymbolic(spec, n.mode);
          if (m !== null) n.mode = m;
        }
      };
      if (!/^[0-7]{3,4}$/.test(spec) && parseSymbolic(spec, 0) === null) {
        ctx.err(`chmod: invalid mode: '${spec}'`);
        return 1;
      }
      if (recursive) walk(node!, apply);
      else apply(node!);
      if (spec === "777" || spec === "0777") {
        ctx.info("777 means anyone on this machine can change it. Almost never what you want.");
      }
    }
    return code;
  },
};

export const chown: Command = {
  name: "chown",
  summary: "change owner (chown deploy:deploy file)",
  run(ctx) {
    const recursive = ctx.argv.includes("-R");
    const rest = ctx.argv.slice(1).filter((a) => a !== "-R");
    const spec = rest[0];
    const files = rest.slice(1);
    if (!spec || !files.length) {
      ctx.err("chown: missing operand");
      return 1;
    }
    const [owner, groupRaw] = spec.split(":");
    const group = groupRaw === "" ? owner : groupRaw;
    if (owner && !ctx.host.users[owner]) {
      ctx.err(`chown: invalid user: '${spec}'`);
      return 1;
    }
    if (group && !ctx.host.groups[group]) {
      ctx.err(`chown: invalid group: '${spec}'`);
      return 1;
    }
    let code = 0;
    for (const f of files) {
      const path = ctx.path(f);
      const { node, err } = lookup(ctx, path);
      if (err) {
        ctx.err(`chown: cannot access '${f}': ${err}`);
        code = 1;
        continue;
      }
      if (ctx.user !== "root") {
        ctx.err(`chown: changing ownership of '${f}': Operation not permitted`);
        code = 1;
        continue;
      }
      const apply = (n: FsNode) => {
        if (owner) n.owner = owner;
        if (group) n.group = group;
      };
      if (recursive) walk(node!, apply);
      else apply(node!);
    }
    return code;
  },
};

export const nano: Command = {
  name: "nano",
  summary: "edit a file (Ctrl+S saves, Esc closes)",
  run(ctx) {
    const target = ctx.argv.slice(1).find((a) => !a.startsWith("-"));
    if (!target) {
      ctx.err("nano: give it a file, like: nano /etc/ssh/sshd_config");
      return 1;
    }
    const path = ctx.path(target);
    const node = getNode(ctx.host, path);
    if (node?.type === "dir") {
      ctx.err(`nano: ${target} is a directory`);
      return 1;
    }
    const parent = getDir(ctx.host, dirname(path));
    if (!parent) {
      ctx.err(`nano: ${dirname(path)}: No such file or directory`);
      return 1;
    }
    let content = "";
    if (node) {
      if (!canTraverse(ctx.host, ctx.user, path) || !can(ctx.host, ctx.user, node, "r")) {
        ctx.err(`[ Error reading ${target}: Permission denied ]`);
        return 1;
      }
      content = node.content;
    }
    const canWrite = node ? can(ctx.host, ctx.user, node, "w") : can(ctx.host, ctx.user, parent, "w");
    ctx.emit.editor = { host: ctx.frame.host, path, content, canWrite, asUser: ctx.user, isNew: !node };
    return 0;
  },
};

export const tee: Command = {
  name: "tee",
  summary: "write what comes in to a file (works with sudo)",
  run(ctx) {
    const append = ctx.argv.includes("-a");
    const files = ctx.argv.slice(1).filter((a) => !a.startsWith("-"));
    const input = ctx.stdin ?? "";
    let code = 0;
    for (const f of files) {
      const err = writeFile(ctx.host, ctx.user, ctx.path(f), input + "\n", { append });
      if (err) {
        ctx.err(`tee: ${f}: ${fsErrorText(err)}`);
        code = 1;
      }
    }
    ctx.out(input);
    return code;
  },
};

export const FILE_COMMANDS = [pwd, cd, ls, cat, echo, mkdir, touch, rm, cp, mv, chmod, chown, nano, tee];
