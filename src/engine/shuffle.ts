import { hashHex } from "@/sim/util";

/** Same seed, same order. Used so a question looks the same after a reload. */
export function seededShuffle<T>(items: T[], seed: string): T[] {
  const out = items.slice();
  let h = parseInt(hashHex(seed, 8), 16);
  for (let i = out.length - 1; i > 0; i--) {
    h = (Math.imul(h, 1103515245) + 12345) >>> 0;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Show the options of a multiple-choice question in a stable, mixed order,
 * so the right answer is not always in the same spot.
 */
export function mixOptions(id: string, options: string[], answer: number): { options: string[]; answer: number } {
  const order = seededShuffle(
    options.map((_, i) => i),
    `opts:${id}`,
  );
  return { options: order.map((i) => options[i]), answer: order.indexOf(answer) };
}
