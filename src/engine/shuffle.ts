import { hashHex } from "@/sim/util";

/** Same seed, same order. Used so a question looks the same after a reload. */
export function seededShuffle<T>(items: T[], seed: string): T[] {
  const out = items.slice();
  // mulberry32: well mixed in every bit (a plain LCG's low bits repeat, which bunched answers).
  let a = parseInt(hashHex(seed, 8), 16) >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
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
