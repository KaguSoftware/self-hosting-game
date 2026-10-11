import { z } from "zod";

export const PROGRESS_VERSION = 1;

const ReviewCardZ = z.object({ id: z.string(), box: z.number(), due: z.string(), misses: z.number() });

export const ProgressZ = z.object({
  version: z.literal(PROGRESS_VERSION),
  xp: z.number().min(0),
  completed: z.record(z.string(), z.object({ stars: z.number(), xp: z.number(), at: z.string() })),
  incidents: z.record(z.string(), z.object({ best: z.number(), seconds: z.number(), commands: z.number() })),
  streak: z.object({ current: z.number(), best: z.number(), lastDay: z.string().nullable(), freezes: z.number() }),
  review: z.array(ReviewCardZ),
  stats: z.object({
    worlds: z.record(z.string(), z.object({ attempts: z.number(), correct: z.number() })),
    tags: z.record(z.string(), z.object({ miss: z.number(), hit: z.number() })),
  }),
  vars: z.record(z.string(), z.string()),
  settings: z.object({ muted: z.boolean() }),
  onCall: z.object({ best: z.number(), runs: z.number() }),
});

export type Progress = z.infer<typeof ProgressZ>;

export function emptyProgress(): Progress {
  return {
    version: PROGRESS_VERSION,
    xp: 0,
    completed: {},
    incidents: {},
    streak: { current: 0, best: 0, lastDay: null, freezes: 0 },
    review: [],
    stats: { worlds: {}, tags: {} },
    vars: {},
    settings: { muted: false },
    onCall: { best: 0, runs: 0 },
  };
}

/**
 * Bring any older or partial save up to the current schema.
 * Unknown or broken fields fall back to defaults instead of crashing.
 */
export function migrateProgress(raw: unknown): Progress {
  const base = emptyProgress();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  // v0 (never shipped) stored xp and completed only. Future versions add cases here.
  const merged = {
    ...base,
    ...r,
    version: PROGRESS_VERSION,
    streak: { ...base.streak, ...(r.streak as object) },
    stats: { ...base.stats, ...(r.stats as object) },
    settings: { ...base.settings, ...(r.settings as object) },
    onCall: { ...base.onCall, ...(r.onCall as object) },
  };
  const parsed = ProgressZ.safeParse(merged);
  if (parsed.success) return parsed.data;
  // Keep whatever top-level fields are valid on their own.
  const out = { ...base };
  for (const k of Object.keys(base) as (keyof Progress)[]) {
    const field = ProgressZ.shape[k].safeParse(merged[k]);
    if (field.success) (out as Record<string, unknown>)[k] = field.data;
  }
  return out;
}

export function exportProgress(p: Progress): string {
  return JSON.stringify({ app: "self-hosting-game", exportedAt: new Date().toISOString(), progress: p }, null, 2);
}

export function importProgress(text: string): { ok: true; progress: Progress } | { ok: false; error: string } {
  try {
    const data = JSON.parse(text);
    const raw = data?.progress ?? data;
    if (!raw || typeof raw !== "object" || typeof raw.xp !== "number") return { ok: false, error: "That file does not look like a progress export." };
    return { ok: true, progress: migrateProgress(raw) };
  } catch {
    return { ok: false, error: "Could not read that file. Is it the JSON you exported?" };
  }
}

/** Combine two saves (local and cloud) without losing anything earned. */
export function mergeProgress(a: Progress, b: Progress): Progress {
  const completed = { ...a.completed };
  for (const [id, v] of Object.entries(b.completed)) {
    const cur = completed[id];
    completed[id] = cur ? { stars: Math.max(cur.stars, v.stars), xp: Math.max(cur.xp, v.xp), at: cur.at > v.at ? cur.at : v.at } : v;
  }
  const incidents = { ...a.incidents };
  for (const [id, v] of Object.entries(b.incidents)) {
    if (!incidents[id] || incidents[id].best < v.best) incidents[id] = v;
  }
  const newer = (a.streak.lastDay ?? "") >= (b.streak.lastDay ?? "") ? a : b;
  const reviewIds = new Map(a.review.map((c) => [c.id, c]));
  for (const c of b.review) if (!reviewIds.has(c.id)) reviewIds.set(c.id, c);
  const richer = a.xp >= b.xp ? a : b;
  return {
    ...richer,
    xp: Math.max(a.xp, b.xp),
    completed,
    incidents,
    streak: { ...newer.streak, best: Math.max(a.streak.best, b.streak.best) },
    review: [...reviewIds.values()],
    vars: { ...b.vars, ...a.vars },
    onCall: { best: Math.max(a.onCall.best, b.onCall.best), runs: Math.max(a.onCall.runs, b.onCall.runs) },
  };
}
