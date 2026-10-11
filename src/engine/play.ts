// Running commands for the game: wraps the sim and records a log for goal checks.
import type { GoalCtx, LogEntry } from "@/sim/predicates";
import { createShell, runLine, topFrame } from "@/sim/shell/run";
import type { RunResult } from "@/sim/shell/ctx";
import type { Frame, Shell, World } from "@/sim/types";
import type { Goal } from "@/content/schema";
import { defaultVars, type PlayState, type Vars } from "./replay";

export const LAPTOP_FRAME: Frame = { host: "laptop", user: "you", cwd: "/home/you", via: "local" };
export const CONSOLE_FRAME: Frame = { host: "vps", user: "root", cwd: "/root", via: "console" };

export function newWindow(shells: Shell[], frame: Frame = LAPTOP_FRAME): Shell[] {
  return [...shells, createShell(`w${shells.length + 1}`, { ...frame })];
}

export interface Exec {
  state: PlayState;
  entry: LogEntry;
  result: RunResult;
}

export function execLine(state: PlayState, shellIdx: number, line: string, vars: Vars): Exec {
  const sh = state.shells[shellIdx];
  const before = topFrame(sh);
  const result = runLine(state.world, sh, line, defaultVars(vars));
  const shells = state.shells.slice();
  shells[shellIdx] = result.shell;
  const entry: LogEntry = {
    line: sh.pending ? "(answer)" : line,
    out: result.out.map((o) => o.text).join("\n"),
    host: before.host,
    user: before.user,
    code: result.code,
  };
  return { state: { world: result.world, shells }, entry, result };
}

/** Run a list of lines in one window, logging each. */
export function execScript(state: PlayState, shellIdx: number, lines: string[], vars: Vars): { state: PlayState; log: LogEntry[] } {
  let s = state;
  const log: LogEntry[] = [];
  const v = defaultVars(vars);
  for (const raw of lines) {
    const line = raw.replace(/\{\{(\w+)\}\}/g, (_, k) => v[k] ?? "");
    while (s.shells.length <= shellIdx) s = { ...s, shells: newWindow(s.shells) };
    const r = execLine(s, shellIdx, line, v);
    s = r.state;
    log.push(r.entry);
  }
  return { state: s, log };
}

export function goalCtx(state: PlayState, log: LogEntry[]): GoalCtx {
  return { world: state.world, shells: state.shells, log };
}

export function goalsMet(goals: Goal[], g: GoalCtx): boolean[] {
  return goals.map((x) => {
    try {
      return x.check(g);
    } catch {
      return false;
    }
  });
}

export type { World };
