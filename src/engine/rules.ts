// Pure game rules. No React, no storage.

export const STEP_XP = 10;
export const LEVEL_BONUS = 20;
export const CLEAN_BONUS = 10;
export const RAPID_XP_PER_HIT = 3;

export function comboMultiplier(combo: number): number {
  if (combo >= 10) return 3;
  if (combo >= 6) return 2;
  if (combo >= 3) return 1.5;
  return 1;
}

/** XP needed to reach player level n (level 1 starts at 0). */
export function xpForLevel(n: number): number {
  return Math.round(60 * (n - 1) ** 1.45);
}

export function levelFromXp(xp: number): { level: number; into: number; need: number } {
  let level = 1;
  while (xpForLevel(level + 1) <= xp) level++;
  const base = xpForLevel(level);
  return { level, into: xp - base, need: xpForLevel(level + 1) - base };
}

export const RANKS = [
  "Intern",
  "Junior Ops",
  "Server Wrangler",
  "Shell Pilot",
  "Port Keeper",
  "Container Captain",
  "Proxy Whisperer",
  "Data Guardian",
  "Pipeline Smith",
  "Head of Infra",
];

export function rankFor(level: number): string {
  return RANKS[Math.min(RANKS.length - 1, Math.floor((level - 1) / 2))];
}

export function stars(usedHints: boolean, usedShowMe: boolean): 1 | 2 | 3 {
  if (usedShowMe) return 1;
  if (usedHints) return 2;
  return 3;
}

// ---------- days and streaks ----------

export function dayKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function daysBetween(a: string, b: string): number {
  const da = new Date(a + "T12:00:00");
  const db = new Date(b + "T12:00:00");
  return Math.round((db.getTime() - da.getTime()) / 86_400_000);
}

export interface Streak {
  current: number;
  best: number;
  lastDay: string | null;
  freezes: number;
}

/** Call when the player finishes something today. Freezes cover missed days. */
export function bumpStreak(s: Streak, today: string): { streak: Streak; usedFreeze: number; earnedFreeze: boolean } {
  if (s.lastDay === today) return { streak: s, usedFreeze: 0, earnedFreeze: false };
  let current = s.current;
  let freezes = s.freezes;
  let usedFreeze = 0;
  if (s.lastDay === null) current = 1;
  else {
    const gap = daysBetween(s.lastDay, today);
    const missed = gap - 1;
    if (missed <= 0) current += 1;
    else if (missed <= freezes) {
      freezes -= missed;
      usedFreeze = missed;
      current += 1;
    } else current = 1;
  }
  let earnedFreeze = false;
  if (current > 0 && current % 7 === 0 && freezes < 2) {
    freezes += 1;
    earnedFreeze = true;
  }
  return { streak: { current, best: Math.max(s.best, current), lastDay: today, freezes }, usedFreeze, earnedFreeze };
}

/** Streak as shown today (it is broken if a day was missed and no freeze can cover it). */
export function liveStreak(s: Streak, today: string): number {
  if (!s.lastDay) return 0;
  const missed = daysBetween(s.lastDay, today) - 1;
  if (missed <= 0) return s.current;
  return missed <= s.freezes ? s.current : 0;
}

// ---------- spaced review (Leitner boxes) ----------

export interface ReviewCard {
  id: string;
  box: number; // 1..5
  due: string; // day key
  misses: number;
}

const BOX_DAYS = [0, 0, 1, 3, 7, 16];

export function addDays(day: string, n: number): string {
  const d = new Date(day + "T12:00:00");
  d.setDate(d.getDate() + n);
  return dayKey(d);
}

export function scheduleMiss(cards: ReviewCard[], id: string, today: string): ReviewCard[] {
  const existing = cards.find((c) => c.id === id);
  if (existing) return cards.map((c) => (c.id === id ? { ...c, box: 1, due: today, misses: c.misses + 1 } : c));
  return [...cards, { id, box: 1, due: today, misses: 1 }];
}

export function scheduleHit(cards: ReviewCard[], id: string, today: string): ReviewCard[] {
  return cards
    .map((c) => {
      if (c.id !== id) return c;
      const box = Math.min(6, c.box + 1);
      return { ...c, box, due: addDays(today, BOX_DAYS[Math.min(5, box)] || 1) };
    })
    .filter((c) => c.box <= 5);
}

export function dueCards(cards: ReviewCard[], today: string): ReviewCard[] {
  return cards.filter((c) => c.due <= today).sort((a, b) => a.box - b.box || b.misses - a.misses);
}

// ---------- incidents ----------

export function incidentScore(opts: { seconds: number; limit: number; commands: number; hints: number; showMe: boolean }): number {
  if (opts.showMe) return 50;
  const speed = Math.max(0, 1 - opts.seconds / opts.limit);
  const base = 200 + Math.round(400 * speed);
  const testPenalty = Math.max(0, opts.commands - 4) * 12;
  return Math.max(60, base - testPenalty - opts.hints * 60);
}
