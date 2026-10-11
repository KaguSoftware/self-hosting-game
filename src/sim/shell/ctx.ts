import type { EditorRequest, Frame, Host, OutLine, Pending, Shell, TraceResult, World } from "../types";

export interface Ctx {
  w: World;
  sh: Shell;
  frame: Frame;
  host: Host;
  /** Effective user (root under sudo). */
  user: string;
  /** Logged-in user of this frame. */
  realUser: string;
  sudo: boolean;
  argv: string[];
  /** Raw words, with quoted flags, for commands that care. */
  stdin?: string;
  home: string;
  vars: Record<string, string>;
  /** Environment the command sees: shell variables plus VAR=x prefixes. */
  env: Record<string, string>;
  /** Run text as a shell script in this window (sh file, bash file). Returns the exit code. */
  script(text: string, args: string[], name: string): number;
  out(s: string): void;
  err(s: string): void;
  /** Game voice, shown in teal. Use sparingly. */
  info(s: string): void;
  prompt(p: Omit<Pending, "cmd"> & { cmd?: string }): void;
  emit: { trace?: TraceResult; editor?: EditorRequest; clear?: boolean };
  /** Resolve a path argument against cwd and home. */
  path(p: string): string;
  journal(unit: string, msg: string, proc?: string): void;
}

export interface Command {
  name: string;
  summary: string;
  run(ctx: Ctx): number;
  /** Called with the user's answer to a pending prompt. */
  resume?(ctx: Ctx, pending: Pending, input: string): number;
  /** Extra completions for the first argument(s). */
  complete?(args: string[], ctx: Ctx): string[];
  /** Hidden from help. */
  hidden?: boolean;
}

export interface RunResult {
  world: World;
  shell: Shell;
  out: OutLine[];
  code: number;
  trace?: TraceResult;
  editor?: EditorRequest;
  clear?: boolean;
}

export function flagSet(argv: string[]): { flags: Set<string>; args: string[] } {
  const flags = new Set<string>();
  const args: string[] = [];
  let endOfFlags = false;
  for (const a of argv) {
    if (endOfFlags || !a.startsWith("-") || a === "-") {
      args.push(a);
    } else if (a === "--") {
      endOfFlags = true;
    } else if (a.startsWith("--")) {
      flags.add(a.slice(2));
    } else {
      for (const ch of a.slice(1)) flags.add(ch);
    }
  }
  return { flags, args };
}
