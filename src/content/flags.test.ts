import { describe, expect, it } from "vitest";
import { INCIDENTS, LEVELS, WORLDS } from "./index";
import { flagsIn, flagsInProse } from "./flags";
import type { Step } from "./schema";

function commandLines(s: Step): string[] {
  const t = s.task;
  const out: string[] = [];
  if (t.kind === "terminal") out.push(...t.showMe, ...(t.guide ?? []), ...(t.chips ?? []));
  return out;
}

function proseLines(s: Step): string[] {
  const t = s.task;
  const out = [...(s.intel?.lines ?? []), s.after ?? ""];
  if ("hints" in t && Array.isArray(t.hints)) out.push(...(t.hints as string[]));
  if ("why" in t && typeof t.why === "string") out.push(t.why);
  return out;
}

/** Question text the player must understand before answering. */
function questionText(s: Step): string[] {
  const t = s.task;
  const out: string[] = [s.mission];
  if (t.kind === "predict") out.push(t.question, ...t.options);
  if (t.kind === "rapid") for (const q of t.items) out.push(q.q, ...q.options);
  if (t.kind === "spot") out.push(...t.lines);
  if (t.kind === "order") out.push(...t.items);
  return out;
}

describe("flags", () => {
  it("every flag used anywhere has a plain explanation", () => {
    const unknown: string[] = [];
    const check = (notes: ReturnType<typeof flagsIn>, where: string) => {
      for (const n of notes) if (!n.parts.length) unknown.push(`${where}: ${n.cmd} ${n.flag}`);
    };
    for (const l of LEVELS)
      for (const s of l.steps) {
        for (const line of commandLines(s)) check(flagsIn(line), s.id);
        for (const line of [...proseLines(s), ...questionText(s), ...(s.review ? [s.review.q, ...s.review.options] : [])]) check(flagsInProse(line), s.id);
      }
    for (const w of WORLDS) for (const c of w.cheatSheet) check(flagsInProse(c.cmd), `cheat sheet ${w.id}`);
    for (const inc of INCIDENTS) {
      for (const line of inc.fix) check(flagsIn(line), inc.id);
      for (const line of [...inc.fastestPath, ...inc.hints]) check(flagsInProse(line), inc.id);
    }
    expect(unknown).toEqual([]);
  });

  it("questions only use flags that were explained earlier", () => {
    // Keys are per single flag: "usermod -aG" explains "usermod -a" and "usermod -G".
    const keysOf = (n: ReturnType<typeof flagsIn>[number]) => n.parts.map((p) => `${n.cmd} ${p.flag}`);
    const explained = new Set<string>();
    const problems: string[] = [];
    for (const l of LEVELS) {
      const reviews: { id: string; lines: string[] }[] = [];
      for (const s of l.steps) {
        const t = s.task;
        const shownHere = new Set<string>();
        // Explained on screen: "Type this" buttons and intel cards show flag notes.
        if (t.kind === "terminal") for (const g of t.guide ?? []) for (const n of flagsIn(g)) keysOf(n).forEach((k) => shownHere.add(k));
        for (const line of s.intel?.lines ?? []) for (const n of flagsInProse(line)) keysOf(n).forEach((k) => shownHere.add(k));
        for (const line of questionText(s))
          for (const n of flagsInProse(line))
            for (const k of keysOf(n)) if (!explained.has(k) && !shownHere.has(k)) problems.push(`${s.id}: ${k} in "${line}"`);
        for (const k of shownHere) explained.add(k);
        if (s.review) reviews.push({ id: s.id, lines: [s.review.q, ...s.review.options] });
      }
      // Review cards come back later, so they only need the flag explained by the end of the level.
      for (const r of reviews)
        for (const line of r.lines)
          for (const n of flagsInProse(line)) for (const k of keysOf(n)) if (!explained.has(k)) problems.push(`${r.id} review: ${k} in "${line}"`);
    }
    expect(problems).toEqual([]);
  });
});
