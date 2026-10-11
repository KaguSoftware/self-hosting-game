import { advance, MAX_SLEEP } from "../../tick";
import { can, canTraverse, dirname, getFile, getNode } from "../../fs";
import type { Command, Ctx } from "../ctx";

function readScript(ctx: Ctx, cmd: string, arg: string): string | null {
  const path = ctx.path(arg);
  const f = getFile(ctx.host, path);
  if (!f) {
    ctx.err(`${cmd}: 0: cannot open ${arg}: No such file`);
    return null;
  }
  if (!canTraverse(ctx.host, ctx.user, path) || !can(ctx.host, ctx.user, f, "r")) {
    ctx.err(`${cmd}: 0: cannot open ${arg}: Permission denied`);
    return null;
  }
  return f.content;
}

/** sh file / bash file: run a script without needing the x bit. */
function shell(name: string): Command {
  return {
    name,
    summary: `run a script file (${name} backup.sh)`,
    run(ctx) {
      const args = ctx.argv.slice(1).filter((a) => a !== "-e" && a !== "-x");
      if (args[0] === "-c") {
        if (!args[1]) {
          ctx.err(`${name}: -c: option requires an argument`);
          return 2;
        }
        return ctx.script(args[1], args.slice(2), name);
      }
      if (!args.length) {
        if (ctx.stdin !== undefined) return ctx.script(ctx.stdin, [], name);
        ctx.info(`An interactive ${name} is not in this game. Run a script: ${name} file.sh`);
        return 0;
      }
      const text = readScript(ctx, name, args[0]);
      if (text === null) return 2;
      return ctx.script(text, args.slice(1), args[0]);
    },
  };
}

export const sleep: Command = {
  name: "sleep",
  summary: "wait N seconds (sleep 60). Time moves on for everything",
  run(ctx) {
    const arg = ctx.argv[1];
    const m = /^(\d+)([smh]?)$/.exec(arg ?? "");
    if (!m) {
      ctx.err(arg ? `sleep: invalid time interval '${arg}'` : "sleep: missing operand");
      return 1;
    }
    const secs = Number(m[1]) * (m[2] === "m" ? 60 : m[2] === "h" ? 3600 : 1);
    advance(ctx.w, ctx.w.clock + Math.min(secs, MAX_SLEEP));
    if (secs > MAX_SLEEP) ctx.info(`Skipped ${MAX_SLEEP / 60} minutes (the most one sleep can skip here).`);
    return 0;
  },
};

export const exportCmd: Command = {
  name: "export",
  summary: "set a variable for the commands you run next (export TAG=abc123)",
  run(ctx) {
    const vars = { ...(ctx.sh.vars ?? {}) };
    for (const a of ctx.argv.slice(1)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(a);
      if (m) vars[m[1]] = m[2];
    }
    if (ctx.argv.length === 1) {
      ctx.out(
        Object.entries(vars)
          .map(([k, v]) => `declare -x ${k}="${v}"`)
          .join("\n"),
      );
      return 0;
    }
    ctx.sh.vars = vars;
    return 0;
  },
};

export const unset: Command = {
  name: "unset",
  summary: "remove a variable",
  hidden: true,
  run(ctx) {
    const vars = { ...(ctx.sh.vars ?? {}) };
    for (const a of ctx.argv.slice(1)) delete vars[a];
    ctx.sh.vars = vars;
    return 0;
  },
};

export const set: Command = {
  name: "set",
  summary: "shell options (used in scripts: set -e)",
  hidden: true,
  run: () => 0,
};

/** Turn a sed basic regex into a JS one: \( \) are groups, plain ( ) + ? { } | are literal. */
function breToJs(src: string): string {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length) {
      const n = src[++i];
      out += "()|{}+?".includes(n) ? n : "\\" + n;
    } else if ("()|{}+?".includes(c)) out += "\\" + c;
    else out += c;
  }
  return out;
}

interface SedExpr {
  re: RegExp;
  repl: string;
}

function parseExpr(expr: string, extended: boolean): SedExpr | string {
  if (expr[0] !== "s" || expr.length < 4) return `unknown command: \`${expr[0] ?? ""}'`;
  const d = expr[1];
  const parts: string[] = [];
  let cur = "";
  for (let i = 2; i < expr.length; i++) {
    if (expr[i] === "\\" && expr[i + 1] === d) {
      cur += d;
      i++;
    } else if (expr[i] === d) {
      parts.push(cur);
      cur = "";
    } else cur += expr[i];
  }
  if (parts.length < 2) return "unterminated `s' command";
  const flags = cur;
  if (/[^gI0-9]/.test(flags)) return `unknown option to \`s'`;
  try {
    const re = new RegExp(extended ? parts[0] : breToJs(parts[0]), (flags.includes("g") ? "g" : "") + (flags.includes("I") ? "i" : "") + "m");
    const repl = parts[1].replace(/\$/g, "$$$$").replace(/\\(\d)/g, "$$$1").replace(/(^|[^\\])&/g, "$1$$&").replace(/\\&/g, "&");
    return { re, repl };
  } catch {
    return "invalid regular expression";
  }
}

export const sed: Command = {
  name: "sed",
  summary: "find and replace in a file (sed -i 's/old/new/' file)",
  run(ctx) {
    const argv = ctx.argv.slice(1);
    let inPlace = false;
    let extended = false;
    const exprs: string[] = [];
    const files: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "-i" || a.startsWith("-i")) inPlace = true;
      else if (a === "-E" || a === "-r") extended = true;
      else if (a === "-e") exprs.push(argv[++i] ?? "");
      else if (a === "-n") continue;
      else if (!exprs.length && !a.startsWith("-")) exprs.push(a);
      else files.push(a);
    }
    if (!exprs.length) {
      ctx.err("Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...");
      return 1;
    }
    const parsed: SedExpr[] = [];
    for (const e of exprs) {
      const p = parseExpr(e, extended);
      if (typeof p === "string") {
        ctx.err(`sed: -e expression #1, char ${e.length}: ${p}`);
        return 1;
      }
      parsed.push(p);
    }
    const apply = (text: string) => parsed.reduce((t, p) => t.replace(p.re, p.repl), text);
    if (!files.length) {
      if (inPlace) {
        ctx.err("sed: no input files");
        return 1;
      }
      ctx.out(apply(ctx.stdin ?? "").replace(/\n$/, ""));
      return 0;
    }
    let code = 0;
    for (const a of files) {
      const path = ctx.path(a);
      const node = getNode(ctx.host, path);
      if (!node || !canTraverse(ctx.host, ctx.user, path)) {
        ctx.err(`sed: can't read ${a}: ${node ? "Permission denied" : "No such file or directory"}`);
        code = 2;
        continue;
      }
      if (node.type === "dir") {
        ctx.err(`sed: couldn't edit ${a}: not a regular file`);
        code = 4;
        continue;
      }
      if (!can(ctx.host, ctx.user, node, "r")) {
        ctx.err(`sed: can't read ${a}: Permission denied`);
        code = 2;
        continue;
      }
      const next = apply(node.content);
      if (!inPlace) {
        ctx.out(next.replace(/\n$/, ""));
        continue;
      }
      // sed -i writes a temp file next to the original, then renames it. It needs the folder writable.
      const parent = getNode(ctx.host, dirname(path));
      if (!parent || !can(ctx.host, ctx.user, parent, "w")) {
        ctx.err(`sed: couldn't open temporary file ${dirname(path)}/sedR4nd0m: Permission denied`);
        code = 4;
        continue;
      }
      node.content = next;
    }
    return code;
  },
};

export const SCRIPT_COMMANDS = [shell("sh"), shell("bash"), sleep, exportCmd, unset, set];
