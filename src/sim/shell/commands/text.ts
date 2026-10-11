import { can, canTraverse, getFile } from "../../fs";
import type { Command, Ctx } from "../ctx";
import { virtualRead } from "../virtual";

/** Read input from stdin or the first file argument. */
function input(ctx: Ctx, fileArg: string | undefined, cmd: string): string | null {
  if (!fileArg) return ctx.stdin ?? "";
  const path = ctx.path(fileArg);
  const virt = virtualRead(ctx, path);
  if (virt !== undefined) return virt;
  const f = getFile(ctx.host, path);
  if (!f) {
    ctx.err(`${cmd}: ${fileArg}: No such file or directory`);
    return null;
  }
  if (!canTraverse(ctx.host, ctx.user, path) || !can(ctx.host, ctx.user, f, "r")) {
    ctx.err(`${cmd}: ${fileArg}: Permission denied`);
    return null;
  }
  return f.content;
}

function lines(text: string): string[] {
  const l = text.split("\n");
  if (l.length && l[l.length - 1] === "") l.pop();
  return l;
}

function numArg(argv: string[], def: number): { n: number; rest: string[] } {
  let n = def;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-n") {
      n = Number(argv[++i]);
    } else if (/^-n\d+$/.test(a)) {
      n = Number(a.slice(2));
    } else if (/^-\d+$/.test(a)) {
      n = Number(a.slice(1));
    } else if (a === "-f" || a === "-F") {
      // follow is not a thing in a turn-based terminal
    } else rest.push(a);
  }
  return { n, rest };
}

export const grep: Command = {
  name: "grep",
  summary: "find lines that match (grep -i word file)",
  run(ctx) {
    const flags = new Set<string>();
    const args: string[] = [];
    for (const a of ctx.argv.slice(1)) {
      if (a.startsWith("-") && a.length > 1 && !args.length) for (const c of a.slice(1)) flags.add(c);
      else args.push(a);
    }
    const pattern = args[0];
    if (pattern === undefined) {
      ctx.err("Usage: grep [OPTION]... PATTERNS [FILE]...");
      return 2;
    }
    const files = args.slice(1);
    const sources = files.length ? files : [undefined];
    let re: RegExp;
    try {
      re = new RegExp(flags.has("F") ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern.replace(/\\\|/g, "|"), flags.has("i") ? "i" : "");
    } catch {
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags.has("i") ? "i" : "");
    }
    const out: string[] = [];
    let found = false;
    let code = 0;
    for (const f of sources) {
      const text = input(ctx, f, "grep");
      if (text === null) {
        code = 2;
        continue;
      }
      lines(text).forEach((l, i) => {
        const m = re.test(l) !== flags.has("v");
        if (m) {
          found = true;
          const prefix = (files.length > 1 ? `${f}:` : "") + (flags.has("n") ? `${i + 1}:` : "");
          out.push(prefix + l);
        }
      });
    }
    if (flags.has("c")) ctx.out(String(out.length));
    else if (out.length) ctx.out(out.join("\n"));
    return code || (found ? 0 : 1);
  },
};

export const head: Command = {
  name: "head",
  summary: "first lines of a file (head -n 20 file)",
  run(ctx) {
    const { n, rest } = numArg(ctx.argv.slice(1), 10);
    const text = input(ctx, rest[0], "head");
    if (text === null) return 1;
    const l = lines(text).slice(0, n);
    if (l.length) ctx.out(l.join("\n"));
    return 0;
  },
};

export const tail: Command = {
  name: "tail",
  summary: "last lines of a file (tail -n 20 /var/log/syslog)",
  run(ctx) {
    const { n, rest } = numArg(ctx.argv.slice(1), 10);
    const text = input(ctx, rest[0], "tail");
    if (text === null) return 1;
    const l = lines(text).slice(-n);
    if (l.length) ctx.out(l.join("\n"));
    return 0;
  },
};

export const wc: Command = {
  name: "wc",
  summary: "count lines (wc -l)",
  run(ctx) {
    const rest = ctx.argv.slice(1).filter((a) => !a.startsWith("-"));
    const text = input(ctx, rest[0], "wc");
    if (text === null) return 1;
    const n = lines(text).length;
    ctx.out(ctx.argv.includes("-l") ? `${n}${rest[0] ? " " + rest[0] : ""}` : `${n} ${text.split(/\s+/).filter(Boolean).length} ${text.length}`);
    return 0;
  },
};

export const sort: Command = {
  name: "sort",
  summary: "sort lines",
  run(ctx) {
    const rest = ctx.argv.slice(1).filter((a) => !a.startsWith("-"));
    const text = input(ctx, rest[0], "sort");
    if (text === null) return 1;
    const l = lines(text).sort();
    if (ctx.argv.includes("-r")) l.reverse();
    if (l.length) ctx.out(l.join("\n"));
    return 0;
  },
};

export const less: Command = {
  name: "less",
  summary: "read a long file (here it just prints it)",
  run(ctx) {
    const rest = ctx.argv.slice(1).filter((a) => !a.startsWith("-"));
    const text = input(ctx, rest[0], "less");
    if (text === null) return 1;
    if (text) ctx.out(text.replace(/\n$/, ""));
    return 0;
  },
};

export const more: Command = { ...less, name: "more", hidden: true };

export const TEXT_COMMANDS = [grep, head, tail, wc, sort, less, more];
