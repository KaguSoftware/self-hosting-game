import { describe, expect, it } from "vitest";
import { produce } from "immer";
import { INCIDENTS, LEVELS, replay } from "@/content";
import { execScript, goalCtx, goalsMet } from "./play";
import { shellsFor } from "./replay";
import { applyMapActions } from "@/sim/map";
import { compatible, mergeIncidents, onCallPage, onCallPool } from "./oncall";
import type { Incident } from "@/content/schema";

const VARS = { deployPassword: "test-pass-1" };
/** On-call plays on the final mission's finished server (or the last chain level before it exists). */
const BASE = LEVELS.some((l) => l.id === "w12-01") ? "w12-01" : [...LEVELS].reverse().find((l) => l.base === "chain")!.id;

function breakAndFix(inc: Incident) {
  const world = produce(replay.levelEndWorld(replay.levelById(BASE)!, VARS), inc.breakIt);
  let state = { world, shells: shellsFor(inc.start) };
  const broken = goalsMet(inc.goals, goalCtx(state, [])).every(Boolean);
  if (inc.fixMap?.length) state = { ...state, world: applyMapActions(state.world, inc.fixMap) };
  const ran = execScript(state, 0, inc.fix, VARS);
  const fixed = inc.fixMapAfter?.length ? execScript({ ...ran.state, world: applyMapActions(ran.state.world, inc.fixMapAfter) }, 0, ["sleep 240"], VARS).state : ran.state;
  return { broken, fixed: goalsMet(inc.goals, goalCtx(fixed, ran.log)).every(Boolean), log: ran.log };
}

describe("on-call", () => {
  const pool = onCallPool(INCIDENTS);

  it("has a pool to draw from", () => {
    expect(pool.length).toBeGreaterThanOrEqual(5);
  });

  for (const inc of pool) {
    it(`${inc.id} breaks and can be fixed on the finished server`, () => {
      const r = breakAndFix(mergeIncidents([inc], BASE, 0, true));
      expect(r.broken, "starts already fixed").toBe(false);
      expect(r.fixed, r.log.map((e) => `$ ${e.line}\n${e.out}`).join("\n")).toBe(true);
    });
  }

  it("every compatible pair can be broken and fixed together", () => {
    const bad: string[] = [];
    for (const a of pool)
      for (const b of pool) {
        if (a.id >= b.id || !compatible(a, b)) continue;
        const r = breakAndFix(mergeIncidents([a, b], BASE, 7, false));
        if (r.broken || !r.fixed) bad.push(`${a.id} + ${b.id}`);
      }
    expect(bad).toEqual([]);
  });

  it("gets harder: two at once from page 7, no hints, less time", () => {
    const early = onCallPage(pool, "seed-1", 0, BASE);
    const late = onCallPage(pool, "seed-1", 9, BASE);
    expect(early.parts).toHaveLength(1);
    expect(early.hints).toBe(true);
    expect(late.parts).toHaveLength(2);
    expect(late.hints).toBe(false);
    expect(late.incident.timeLimit).toBeLessThan(pool.find((p) => p.id === late.parts[0])!.timeLimit + pool.find((p) => p.id === late.parts[1])!.timeLimit);
  });

  it("the same seed gives the same run, and no repeats within 3 pages", () => {
    expect(onCallPage(pool, "abc", 4, BASE).parts).toEqual(onCallPage(pool, "abc", 4, BASE).parts);
    const ids = [0, 1, 2, 3].map((i) => onCallPage(pool, "abc", i, BASE).parts[0]);
    expect(new Set(ids).size).toBe(4);
  });
});
