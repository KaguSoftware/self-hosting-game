import { describe, expect, it } from "vitest";
import { LEVELS } from "./index";
import { JARGON } from "./jargon";
import type { Step } from "./schema";

// Rule: never ask something the game has not taught yet, and never show a word it has not explained.

const QUESTION_KINDS = new Set(["predict", "spot", "order", "match", "rapid", "budget"]);

function isQuestion(s: Step): boolean {
  const t = s.task;
  return QUESTION_KINDS.has(t.kind) || (t.kind === "map" && (t.mode === "route" || t.mode === "match"));
}

/** Text the player reads or taps before acting. */
function visible(s: Step): string[] {
  const t = s.task;
  const out = [s.mission];
  if ("prompt" in t && t.prompt) out.push(t.prompt as string);
  if (t.kind === "predict") out.push(t.question, ...t.options);
  if (t.kind === "spot") out.push(...t.lines);
  if (t.kind === "order") out.push(...t.items);
  if (t.kind === "match") out.push(...t.buckets, ...t.items.map((i) => i.text));
  if (t.kind === "rapid") for (const q of t.items) out.push(q.q, ...q.options);
  if (t.kind === "map" && t.mode === "match") out.push(...t.pairs.map((p) => p.chip));
  if (t.kind === "terminal") out.push(...t.goals.map((g) => g.describe));
  if (t.kind === "budget") out.push(...t.pieces.flatMap((p) => [p.name, p.note]), ...t.plans.map((p) => p.name));
  return out;
}

/** Text that explains things, available to this step (intel) or to later ones (after, why). */
function explainsNow(s: Step): string {
  return [...(s.intel?.lines ?? []), s.intel?.analogy ?? ""].join(" ");
}
function explainsLater(s: Step): string {
  const t = s.task;
  const why = "why" in t ? (t.why as string) : "";
  const quizWhy = t.kind === "rapid" ? t.items.map((q) => q.why).join(" ") : "";
  return [s.after ?? "", why, quizWhy].join(" ");
}

describe("question basis", () => {
  const order = LEVELS.flatMap((l) => l.steps.map((s) => s.id));
  for (const l of LEVELS)
    for (const s of l.steps) {
      if (!isQuestion(s)) continue;
      it(`${s.id} says where its answer comes from`, () => {
        expect(s.basis, `${s.id} (${s.task.kind}) needs basis: taught, guess or known`).toBeDefined();
        if (s.basis && "taught" in s.basis) {
          expect(s.basis.taught.length).toBeGreaterThan(0);
          for (const ref of s.basis.taught) {
            if (ref === "self") {
              expect(explainsNow(s).length, `${s.id} cites itself but has no intel`).toBeGreaterThan(0);
              continue;
            }
            const at = order.indexOf(ref);
            expect(at, `${s.id} cites unknown step ${ref}`).toBeGreaterThanOrEqual(0);
            expect(at, `${s.id} cites ${ref}, which comes later`).toBeLessThan(order.indexOf(s.id));
          }
        }
      });
    }
});

describe("no unexplained jargon", () => {
  it("explains every term before showing it", () => {
    const known = new Set<string>();
    const problems: string[] = [];
    for (const l of LEVELS)
      for (const s of l.steps) {
        const now = explainsNow(s);
        const here = new Set(known);
        for (const j of JARGON) if (j.re.test(now)) here.add(j.term);
        for (const t of s.teaches ?? []) here.add(t);
        for (const text of visible(s))
          for (const j of JARGON)
            if (j.re.test(text) && !here.has(j.term)) problems.push(`${s.id}: "${j.term}" in "${text}"`);
        for (const t of here) known.add(t);
        const later = explainsLater(s);
        for (const j of JARGON) if (j.re.test(later)) known.add(j.term);
        // Review cards come back later, so they may use anything known by the end of this step.
        if (s.review)
          for (const text of [s.review.q, ...s.review.options])
            for (const j of JARGON) if (j.re.test(text) && !known.has(j.term)) problems.push(`${s.id} review: "${j.term}" in "${text}"`);
      }
    expect([...new Set(problems)]).toEqual([]);
  });

  it("only claims to teach what the text really explains", () => {
    for (const l of LEVELS)
      for (const s of l.steps) {
        for (const term of s.teaches ?? []) {
          const j = JARGON.find((x) => x.term === term);
          expect(j, `${s.id} teaches unknown term ${term}`).toBeDefined();
          const guess = !!s.basis && "guess" in s.basis;
          // A guess teaches through its answer. Anything else teaches through its intel, or through map labels.
          const source = guess ? explainsLater(s) : explainsNow(s);
          const ok = j!.re.test(source) || (!guess && s.task.kind === "map");
          expect(ok, `${s.id} claims to teach "${term}" but never explains it`).toBe(true);
        }
      }
  });
});

describe("RAM budget puzzles", () => {
  for (const l of LEVELS)
    for (const s of l.steps) {
      const t = s.task;
      if (t.kind !== "budget") continue;
      it(`${s.id}: the answer is the cheapest plan that fits`, () => {
        const need = t.pieces.reduce((a, p) => a + p.mb, 0);
        const fits = t.plans.map((p, i) => ({ i, ok: p.ramMb >= need, price: parseFloat(p.price.replace(/[^0-9.]/g, "")) }));
        const cheapest = fits.filter((f) => f.ok).sort((a, b) => a.price - b.price)[0];
        expect(cheapest?.i).toBe(t.answer);
      });
    }
});
