// On-call mode: an endless stream of incidents on the finished server, getting harder.
// 1-3: one break, hints on. 4-6: one break, less time. 7-9: two breaks from different
// layers at once, no hints. 10+: the same with a shrinking timer (90 seconds at least).
import type { Incident } from "@/content/schema";
import { seededShuffle } from "./shuffle";

export interface OnCallPage {
  /** 0-based position in the run. */
  index: number;
  incident: Incident;
  /** The incidents it was made from. */
  parts: string[];
  hints: boolean;
}

export function onCallPool(all: Incident[]): Incident[] {
  return all.filter((i) => i.oncall);
}

function timeFor(index: number, parts: Incident[]): number {
  const base = parts.reduce((s, p) => s + p.timeLimit, 0);
  if (index < 3) return base;
  if (index < 6) return Math.round(base * 0.85);
  if (index < 9) return Math.round(base * 0.7);
  return Math.max(90, Math.round(base * 0.7 * Math.pow(0.9, index - 8)));
}

/** Two incidents that can be broken and fixed together without one hiding the other. */
export function compatible(a: Incident, b: Incident): boolean {
  if (a.id === b.id || !a.oncall || !b.oncall) return false;
  if (a.oncall.layer === b.oncall.layer) return false;
  return !(a.oncall.conflicts ?? []).includes(b.id) && !(b.oncall.conflicts ?? []).includes(a.id);
}

/** Combine one or two incidents into one page. `after` is the level whose end state is the base. */
export function mergeIncidents(parts: Incident[], after: string, index: number, hints: boolean): Incident {
  const first = parts[0];
  const vps = parts.some((p) => p.start === "vps-deploy");
  return {
    id: `oncall-${index}-${parts.map((p) => p.id).join("+")}`,
    title: parts.map((p) => p.title).join(" + "),
    client: {
      name: "Pager",
      message: parts.length === 1 ? first.client.message : `Two alerts at once. ${parts.map((p) => p.client.message).join(" Also: ")}`,
    },
    after,
    start: vps ? "vps-deploy" : first.start,
    breakIt: (w) => {
      for (const p of parts) p.breakIt(w);
    },
    goals: parts.flatMap((p) => p.goals),
    hints: hints ? first.hints : ["No hints on this shift. Find the hop that says no.", "Outside in: dig, curl -v, then the logs."],
    fastestPath: parts.flatMap((p) => p.fastestPath),
    fix: parts.flatMap((p) => p.fix),
    fixMap: parts.flatMap((p) => p.fixMap ?? []),
    fixMapAfter: parts.flatMap((p) => p.fixMapAfter ?? []),
    controls: parts.flatMap((p) => p.controls ?? []),
    debrief: parts.flatMap((p) => p.debrief.slice(0, parts.length === 1 ? 3 : 2)),
    timeLimit: timeFor(index, parts),
    url: parts.find((p) => p.url)?.url,
    console: parts.some((p) => p.console),
    oncall: first.oncall,
  };
}

/**
 * The page at `index` for a run with this seed. The same seed gives the same run.
 * An incident never comes back within 3 pages.
 */
export function onCallPage(pool: Incident[], seed: string, index: number, after: string): OnCallPage {
  const recent: string[] = [];
  let page: OnCallPage | null = null;
  for (let i = 0; i <= index; i++) {
    const order = seededShuffle(pool, `${seed}:${i}`).filter((p) => !recent.slice(-3).includes(p.id));
    const fresh = order.length ? order : seededShuffle(pool, `${seed}:${i}`);
    const a = fresh[0];
    const parts = [a];
    if (i >= 6) {
      const b = fresh.slice(1).find((x) => compatible(a, x)) ?? pool.find((x) => compatible(a, x));
      if (b) parts.push(b);
    }
    recent.push(...parts.map((p) => p.id));
    const hints = i < 6;
    page = { index: i, parts: parts.map((p) => p.id), hints, incident: mergeIncidents(parts, after, i, hints) };
  }
  return page!;
}
