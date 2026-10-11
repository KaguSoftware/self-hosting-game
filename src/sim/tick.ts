// The sim clock. Everything that happens "over time" (crash-loop restarts, healthchecks,
// cron jobs, pipelines, growing logs) is a reconciler that runs when the clock moves.
import type { World } from "./types";

/** Called with an immer draft, the old time and the new time (seconds). */
export type Reconciler = (w: World, from: number, to: number) => void;

const RECONCILERS: { name: string; run: Reconciler }[] = [];

/** Register once per name (modules can be imported more than once in tests). */
export function registerReconciler(name: string, run: Reconciler): void {
  const i = RECONCILERS.findIndex((r) => r.name === name);
  if (i >= 0) RECONCILERS[i] = { name, run };
  else RECONCILERS.push({ name, run });
}

/** Move the clock forward to `to` and let every reconciler catch up. */
export function advance(w: World, to: number): void {
  const from = w.clock;
  if (to <= from) return;
  w.clock = to;
  for (const r of RECONCILERS) r.run(w, from, to);
}

/** Longest single jump `sleep` may make, so a typo cannot skip a week. */
export const MAX_SLEEP = 86400;
