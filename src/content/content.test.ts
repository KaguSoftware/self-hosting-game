import { describe, expect, it } from "vitest";
import { produce } from "immer";
import { CONSOLE_FRAME, execScript, goalCtx, goalsMet, newWindow } from "@/engine/play";
import { applyStep, shellsFor } from "@/engine/replay";
import { applyMapActions } from "@/sim/map";
import { traceHttp } from "@/sim/net";
import { sshCheck } from "@/sim/sshAuth";
import { INCIDENTS, LEVELS, QUIZ, WORLDS, replay } from "./index";
import { TERMS } from "./dictionary";
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
      const { state: fixed, log } = execScript(state, inc.fixShell ?? 0, inc.fix, VARS);
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
