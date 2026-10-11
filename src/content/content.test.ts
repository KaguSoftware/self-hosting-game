import { describe, expect, it } from "vitest";
import { produce } from "immer";
import { CONSOLE_FRAME, execScript, goalCtx, goalsMet, newWindow } from "@/engine/play";
import { applyStep, shellsFor } from "@/engine/replay";
import { applyMapActions } from "@/sim/map";
import { traceHttp } from "@/sim/net";
import { sshCheck } from "@/sim/sshAuth";
import { INCIDENTS, LEVELS, QUIZ, WORLDS, replay } from "./index";
import { TERMS } from "./dictionary";
import { worldStart } from "./worlds/start";
import { world0 } from "./worlds/w0";
import { world1 } from "./worlds/w1";
import { world2 } from "./worlds/w2";
import { world3 } from "./worlds/w3";
import { world4 } from "./worlds/w4";
import { world5 } from "./worlds/w5";

const AUTHORED_FOR_TEST = [worldStart, world0, world1, world2, world3, world4, world5];
import type { Step } from "./schema";

const VARS = { deployPassword: "test-pass-1" };

function words(s: string | undefined): number {
  return s ? s.split(/\s+/).filter(Boolean).length : 0;
}

function readingBeforeAction(step: Step): number {
  const t = step.task;
  let n = words(step.mission) + (step.intel?.lines.reduce((a, l) => a + words(l), 0) ?? 0) + words(step.intel?.analogy);
  if ("prompt" in t) n += words(t.prompt as string);
  if (t.kind === "predict") n += words(t.question);
  return n;
}

function allStrings(x: unknown, out: string[] = []): string[] {
  if (typeof x === "string") out.push(x);
  else if (Array.isArray(x)) x.forEach((v) => allStrings(v, out));
  else if (x && typeof x === "object") Object.values(x).forEach((v) => allStrings(v, out));
  return out;
}

describe("content lint", () => {
  it("has unique ids", () => {
    const ids = LEVELS.flatMap((l) => [l.id, ...l.steps.map((s) => s.id)]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps intel short and reading under ~60 words", () => {
    for (const l of LEVELS)
      for (const s of l.steps) {
        expect(s.intel?.lines.length ?? 0, s.id).toBeLessThanOrEqual(3);
        expect(readingBeforeAction(s), s.id).toBeLessThanOrEqual(60);
      }
  });

  it("never puts three steps of the same kind in a row", () => {
    for (const w of WORLDS) {
      const kinds = w.levels.flatMap((l) => l.steps.map((s) => s.task.kind));
      for (let i = 2; i < kinds.length; i++) {
        const run = kinds[i] === kinds[i - 1] && kinds[i] === kinds[i - 2];
        expect(run, `world ${w.id} around step ${i}: ${kinds[i]}`).toBe(false);
      }
    }
  });

  it("uses no em or en dashes in copy", () => {
    const strings = [...allStrings(WORLDS), ...allStrings(INCIDENTS), ...allStrings(TERMS)];
    for (const s of strings) expect(s.includes("—") || s.includes("–"), s).toBe(false);
  });

  it("has valid answers", () => {
    for (const l of LEVELS)
      for (const s of l.steps) {
        const t = s.task;
        if (t.kind === "predict") expect(t.answer).toBeLessThan(t.options.length);
        if (t.kind === "spot") t.bugs.forEach((b) => expect(b).toBeLessThan(t.lines.length));
        if (t.kind === "rapid") t.items.forEach((q) => expect(q.answer).toBeLessThan(q.options.length));
        if (t.kind === "match") t.items.forEach((it) => expect(it.bucket).toBeLessThan(t.buckets.length));
        if (t.kind === "config" && t.blanks)
          for (const [k, b] of Object.entries(t.blanks)) {
            expect(t.start.includes(`{{${k}}}`), `${s.id} blank ${k}`).toBe(true);
            expect(b.answer).toBeLessThan(b.options.length);
          }
      }
    for (const q of Object.values(QUIZ)) expect(q.answer).toBeLessThan(q.options.length);
  });
});

describe("answer positions", () => {
  it("does not bunch right answers into one spot", () => {
    const positions: number[] = [];
    for (const l of LEVELS)
      for (const s of l.steps) {
        const t = s.task;
        if (t.kind === "predict" && !t.fixedOrder && t.options.length > 2) positions.push(t.answer);
        if (t.kind === "rapid") for (const q of t.items) if (q.options.length > 2) positions.push(q.answer);
      }
    const counts = [0, 1, 2].map((p) => positions.filter((x) => x === p).length);
    for (const c of counts) expect(c / positions.length, `answer positions ${counts.join("/")}`).toBeLessThan(0.5);
    for (const c of counts) expect(c, `answer positions ${counts.join("/")}`).toBeGreaterThan(0);
  });

  it("keeps answers pointing at the same text after mixing", () => {
    const original = new Map<string, string>();
    for (const w of AUTHORED_FOR_TEST)
      for (const l of w.levels)
        for (const s of l.steps) {
          if (s.task.kind === "predict") original.set(s.id, s.task.options[s.task.answer]);
          if (s.task.kind === "rapid") for (const q of s.task.items) original.set(q.id, q.options[q.answer]);
        }
    for (const l of LEVELS)
      for (const s of l.steps) {
        if (s.task.kind === "predict") expect(s.task.options[s.task.answer]).toBe(original.get(s.id));
        if (s.task.kind === "rapid") for (const q of s.task.items) expect(q.options[q.answer]).toBe(original.get(q.id));
      }
  });
});

describe("every level goal is reachable and not pre-met", () => {
  for (const level of LEVELS) {
    it(level.id, () => {
      let state = replay.levelStart(level, VARS);
      for (const step of level.steps) {
        const t = step.task;
        if (t.kind === "terminal") {
          const g0 = goalCtx(state, []);
          expect(goalsMet(t.goals, g0).every(Boolean), `${step.id} goals already met`).toBe(false);
          const { state: after, log } = execScript(state, t.showMeShell ?? 0, t.showMe, VARS);
          const met = goalsMet(t.goals, goalCtx(after, log));
          expect(met, `${step.id}: ${log.map((e) => `$ ${e.line}\n${e.out}`).join("\n")}`).toEqual(t.goals.map(() => true));
        } else if (t.kind === "config") {
          for (const c of t.checks) expect(c.test(t.solution), `${step.id}: ${c.describe}`).toBe(true);
          if (t.blanks) {
            const filled = t.start.replace(/\{\{(\w+)\}\}/g, (_, k) => t.blanks![k].options[t.blanks![k].answer]);
            for (const c of t.checks) expect(c.test(filled), `${step.id} blanks: ${c.describe}`).toBe(true);
          }
        } else if (t.kind === "map" && t.mode === "toggle") {
          expect(goalsMet(t.goals, goalCtx(state, [])).every(Boolean), `${step.id} pre-met`).toBe(false);
          const w = applyMapActions(state.world, t.showMe);
          expect(goalsMet(t.goals, goalCtx({ ...state, world: w }, [])).every(Boolean), step.id).toBe(true);
        }
        state = applyStep(state, step, VARS);
      }
    });
  }
});

describe("incidents", () => {
  for (const inc of INCIDENTS) {
    it(inc.id, () => {
      const base = replay.levelEndWorld(replay.levelById(inc.after)!, VARS);
      const world = produce(base, inc.breakIt);
      let state = { world, shells: shellsFor(inc.start) };
      expect(goalsMet(inc.goals, goalCtx(state, [])).every(Boolean), "already fixed").toBe(false);
      if (inc.console) state = { ...state, shells: newWindow(state.shells, CONSOLE_FRAME) };
      const ran = execScript(state, inc.fixShell ?? 0, inc.fix, VARS);
      const log = ran.log;
      const fixed = inc.fixMap ? { ...ran.state, world: applyMapActions(ran.state.world, inc.fixMap) } : ran.state;
      expect(goalsMet(inc.goals, goalCtx(fixed, log)).every(Boolean), log.map((e) => e.out).join("\n")).toBe(true);
      if (inc.url) expect(traceHttp(fixed.world, inc.url).ok).toBe(true);
    });
  }
  it("publickey incident fails at the auth hop", () => {
    const inc = INCIDENTS.find((i) => i.id === "publickey")!;
    const world = produce(replay.levelEndWorld(replay.levelById(inc.after)!, VARS), inc.breakIt);
    const c = sshCheck(world, "you", "deploy", "203.0.113.10");
    expect(c.trace.failedAt).toBe("auth");
    expect(c.passwordPrompt).toBe(false);
  });
});
