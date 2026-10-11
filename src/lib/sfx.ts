"use client";
// Every sound is synthesized with the Web Audio API. No audio files.
import { useProgress } from "@/store/progress";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

function ac(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (useProgress.getState().settings.muted) return null;
  try {
    if (!ctx) {
      const C = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new C();
      master = ctx.createGain();
      master.gain.value = 0.35;
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(freq: number, start: number, dur: number, opts: { type?: OscillatorType; vol?: number; slideTo?: number; attack?: number } = {}) {
  const c = ac();
  if (!c || !master) return;
  const t0 = c.currentTime + start;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = opts.type ?? "square";
  osc.frequency.setValueAtTime(freq, t0);
  if (opts.slideTo) osc.frequency.exponentialRampToValueAtTime(opts.slideTo, t0 + dur);
  const vol = opts.vol ?? 0.2;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + (opts.attack ?? 0.008));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g);
  g.connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise(start: number, dur: number, vol = 0.05, hp = 2000) {
  const c = ac();
  if (!c || !master) return;
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = "highpass";
  f.frequency.value = hp;
  const g = c.createGain();
  g.gain.value = vol;
  src.connect(f);
  f.connect(g);
  g.connect(master);
  src.start(c.currentTime + start);
}

let lastKey = 0;

export const sfx = {
  key() {
    const now = performance.now();
    if (now - lastKey < 35) return;
    lastKey = now;
    noise(0, 0.025, 0.04, 3500 + Math.random() * 1500);
  },
  enter() {
    noise(0, 0.05, 0.06, 1500);
    tone(180, 0, 0.05, { type: "triangle", vol: 0.08 });
  },
  success() {
    tone(660, 0, 0.12, { type: "triangle", vol: 0.18 });
    tone(990, 0.08, 0.18, { type: "triangle", vol: 0.16 });
    tone(1320, 0.16, 0.26, { type: "sine", vol: 0.12 });
  },
  error() {
    tone(150, 0, 0.18, { type: "sawtooth", vol: 0.12, slideTo: 90 });
    tone(110, 0.02, 0.2, { type: "square", vol: 0.06 });
  },
  tap() {
    tone(520, 0, 0.05, { type: "triangle", vol: 0.08 });
  },
  combo(n: number) {
    const base = 440 * Math.pow(2, Math.min(n, 12) / 12);
    tone(base, 0, 0.09, { type: "square", vol: 0.1 });
    tone(base * 1.5, 0.06, 0.12, { type: "triangle", vol: 0.1 });
  },
  hop(ok: boolean) {
    tone(ok ? 880 : 220, 0, 0.04, { type: "sine", vol: 0.05 });
  },
  fail() {
    tone(330, 0, 0.12, { type: "square", vol: 0.1, slideTo: 160 });
    noise(0.05, 0.15, 0.05, 600);
  },
  levelUp() {
    const notes = [523, 659, 784, 1047, 784, 1047, 1319];
    notes.forEach((f, i) => tone(f, i * 0.09, 0.22, { type: i % 2 ? "triangle" : "square", vol: 0.14 }));
  },
  fanfare() {
    const notes = [392, 523, 659, 784, 659, 784, 1047];
    notes.forEach((f, i) => tone(f, i * 0.12, 0.3, { type: "square", vol: 0.12 }));
    tone(1047, 0.85, 0.7, { type: "triangle", vol: 0.15 });
  },
  alarm() {
    for (let i = 0; i < 3; i++) {
      tone(880, i * 0.5, 0.22, { type: "sawtooth", vol: 0.1 });
      tone(660, i * 0.5 + 0.25, 0.22, { type: "sawtooth", vol: 0.1 });
    }
  },
  whoosh() {
    noise(0, 0.25, 0.05, 800);
  },
};
