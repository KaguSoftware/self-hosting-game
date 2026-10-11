import { makeReplay } from "@/engine/replay";
import { mixOptions } from "@/engine/shuffle";
import { INCIDENTS } from "./incidents";
import type { Level, QuizItem, Step, WorldDef } from "./schema";
import { worldStart } from "./worlds/start";
import { world0 } from "./worlds/w0";
import { world1 } from "./worlds/w1";
import { world2 } from "./worlds/w2";
import { world3 } from "./worlds/w3";
import { world4 } from "./worlds/w4";
import { world5 } from "./worlds/w5";
import { world6 } from "./worlds/w6";
import { world7 } from "./worlds/w7";
import { world8 } from "./worlds/w8";
import { world9 } from "./worlds/w9";
import { world10 } from "./worlds/w10";
import { world11 } from "./worlds/w11";
import { world12 } from "./worlds/w12";

const AUTHORED: WorldDef[] = [worldStart, world0, world1, world2, world3, world4, world5, world6, world7, world8, world9, world10, world11, world12];

function mixQuiz(q: QuizItem): QuizItem {
  return { ...q, ...mixOptions(q.id, q.options, q.answer) };
}

/**
 * Content is written with the right answer wherever was handy (often first).
 * Mix every multiple-choice question once, with a stable seed, so the right
 * answer lands in a different spot from question to question.
 */
function mixStep(s: Step): Step {
  const t = s.task;
  const review = s.review ? mixQuiz(s.review) : undefined;
  if (t.kind === "predict" && !t.fixedOrder) return { ...s, review, task: { ...t, ...mixOptions(s.id, t.options, t.answer) } };
  if (t.kind === "rapid") return { ...s, review, task: { ...t, items: t.items.map(mixQuiz) } };
  return review ? { ...s, review } : s;
}

export const WORLDS: WorldDef[] = AUTHORED.map((w) => ({ ...w, levels: w.levels.map((l) => ({ ...l, steps: l.steps.map(mixStep) })) }));

/** Worlds still being built. Shown locked on the path. */
export const UPCOMING: { id: number; title: string; tagline: string }[] = [
];

export const LEVELS: Level[] = WORLDS.flatMap((w) => w.levels);

export const replay = makeReplay({ levels: LEVELS });

/** "Start" for the intro world, "World N" otherwise. */
export function worldLabel(id: number): string {
  return id < 0 ? "Start" : `World ${id}`;
}

export function levelById(id: string): Level | undefined {
  return LEVELS.find((l) => l.id === id);
}

export function worldOf(levelId: string): WorldDef | undefined {
  return WORLDS.find((w) => w.levels.some((l) => l.id === levelId));
}

export function nextLevel(id: string): Level | undefined {
  const i = LEVELS.findIndex((l) => l.id === id);
  return i >= 0 ? LEVELS[i + 1] : undefined;
}

/** A quick quiz version of any step, for spaced review. */
export function stepQuiz(step: Step): QuizItem | undefined {
  if (step.review) return step.review;
  if (step.task.kind === "predict") {
    return {
      id: step.id,
      q: `${step.mission} ${step.task.question}`,
      options: step.task.options,
      answer: step.task.answer,
      why: step.task.why,
      tag: step.tags[0] ?? "general",
    };
  }
  return undefined;
}

export const QUIZ: Record<string, QuizItem> = {};
for (const l of LEVELS) {
  for (const s of l.steps) {
    const q = stepQuiz(s);
    if (q) QUIZ[q.id] = q;
    if (s.task.kind === "rapid") for (const it of s.task.items) QUIZ[it.id] = it;
  }
}

export { INCIDENTS };
