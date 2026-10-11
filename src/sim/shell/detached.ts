// Running a line with no terminal attached (ssh host 'cmd', cron, CI jobs).
// run.ts registers the real runner, so commands can use it without importing run.ts
// (which would make an import cycle through the command registry).
import type { Frame, World } from "../types";

export type DetachedRunner = (w: World, frame: Frame, line: string, vars?: Record<string, string>) => { code: number; out: string };

let runner: DetachedRunner | undefined;

export function setDetachedRunner(r: DetachedRunner): void {
  runner = r;
}

export function runDetachedLine(w: World, frame: Frame, line: string, vars: Record<string, string> = {}): { code: number; out: string } {
  if (!runner) return { code: 127, out: "sh: 1: no shell available" };
  return runner(w, frame, line, vars);
}
