"use client";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { emptyProgress, migrateProgress, PROGRESS_VERSION, type Progress } from "@/engine/progress";
import { bumpStreak, dayKey, scheduleHit, scheduleMiss } from "@/engine/rules";

interface Actions {
  addXp(n: number): void;
  completeLevel(id: string, stars: number, xp: number): { earnedFreeze: boolean };
  attempt(world: number, correct: boolean, tags: string[]): void;
  miss(quizId: string | undefined): void;
  reviewResult(quizId: string, correct: boolean): void;
  incident(id: string, score: number, seconds: number, commands: number): void;
  setVar(k: string, v: string): void;
  setMuted(m: boolean): void;
  /** Record that a flag note was shown at `where` (a step id or terminal run id). */
  sawFlags(keys: string[], where: string): void;
  replaceAll(p: Progress): void;
  reset(): void;
}

export type ProgressStore = Progress & Actions & { hydrated: boolean };

const safeStorage = createJSONStorage(() => {
  try {
    const t = "__probe__";
    window.localStorage.setItem(t, t);
    window.localStorage.removeItem(t);
    return window.localStorage;
  } catch {
    const mem = new Map<string, string>();
    return {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    };
  }
});

function pick(s: ProgressStore): Progress {
  const { version, xp, completed, incidents, streak, review, stats, vars, settings, onCall, flagSeen } = s;
  return { version, xp, completed, incidents, streak, review, stats, vars, settings, onCall, flagSeen };
}

export const useProgress = create<ProgressStore>()(
  persist(
    (set, get) => ({
      ...emptyProgress(),
      hydrated: false,
      addXp: (n) => set((s) => ({ xp: s.xp + Math.max(0, Math.round(n)) })),
      completeLevel: (id, stars, xp) => {
        const s = get();
        const prev = s.completed[id];
        const { streak, earnedFreeze } = bumpStreak(s.streak, dayKey());
        set({
          completed: {
            ...s.completed,
            [id]: { stars: Math.max(stars, prev?.stars ?? 0), xp: Math.max(xp, prev?.xp ?? 0), at: new Date().toISOString() },
          },
          streak,
        });
        return { earnedFreeze };
      },
      attempt: (world, correct, tags) =>
        set((s) => {
          const w = s.stats.worlds[world] ?? { attempts: 0, correct: 0 };
          const t = { ...s.stats.tags };
          for (const tag of tags) {
            const cur = t[tag] ?? { miss: 0, hit: 0 };
            t[tag] = correct ? { ...cur, hit: cur.hit + 1 } : { ...cur, miss: cur.miss + 1 };
          }
          return {
            stats: {
              worlds: { ...s.stats.worlds, [world]: { attempts: w.attempts + 1, correct: w.correct + (correct ? 1 : 0) } },
              tags: t,
            },
          };
        }),
      miss: (quizId) => {
        if (!quizId) return;
        set((s) => ({ review: scheduleMiss(s.review, quizId, dayKey()) }));
      },
      reviewResult: (quizId, correct) =>
        set((s) => ({ review: correct ? scheduleHit(s.review, quizId, dayKey()) : scheduleMiss(s.review, quizId, dayKey()) })),
      incident: (id, score, seconds, commands) =>
        set((s) => {
          const prev = s.incidents[id];
          if (prev && prev.best >= score) return {};
          return { incidents: { ...s.incidents, [id]: { best: score, seconds, commands } } };
        }),
      setVar: (k, v) => set((s) => ({ vars: { ...s.vars, [k]: v } })),
      setMuted: (m) => set((s) => ({ settings: { ...s.settings, muted: m } })),
      sawFlags: (keys, where) =>
        set((s) => {
          let changed = false;
          const next = { ...s.flagSeen };
          for (const k of keys) {
            const list = next[k] ?? [];
            if (list.includes(where) || list.length >= 3) continue;
            next[k] = [...list, where];
            changed = true;
          }
          return changed ? { flagSeen: next } : {};
        }),
      replaceAll: (p) => set({ ...migrateProgress(p) }),
      reset: () => set({ ...emptyProgress() }),
    }),
    {
      name: "shg-progress",
      version: PROGRESS_VERSION,
      storage: safeStorage,
      partialize: (s) => pick(s as ProgressStore),
      migrate: (persisted) => migrateProgress(persisted) as unknown as ProgressStore,
      merge: (persisted, current) => ({ ...current, ...migrateProgress(persisted) }),
      skipHydration: true,
    },
  ),
);

export function snapshot(): Progress {
  return pick(useProgress.getState());
}

/** Load saved progress (call once on the client, after first render). */
export async function hydrateProgress() {
  if (useProgress.getState().hydrated) return;
  await useProgress.persist.rehydrate();
  useProgress.setState({ hydrated: true });
}
