"use client";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { LEVELS, UPCOMING, WORLDS } from "@/content";
import type { WorldDef } from "@/content/schema";
import TopBar from "@/components/TopBar";
import { useProgress } from "@/store/progress";
import { sfx } from "@/lib/sfx";

export default function Home() {
  const completed = useProgress((s) => s.completed);
  const hydrated = useProgress((s) => s.hydrated);
  const [sheet, setSheet] = useState<WorldDef | null>(null);

  const firstOpen = LEVELS.findIndex((l) => !completed[l.id]);
  const unlocked = (i: number) => i === 0 || !!completed[LEVELS[i - 1].id];
  const doneCount = Object.keys(completed).length;

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-3xl px-4 pb-24">
        {hydrated && doneCount === 0 && (
          <motion.section initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mt-6 rounded-2xl border border-amber/30 bg-panel/70 p-5 box-glow">
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-teal">Incoming message</div>
            <p className="mt-2 font-display text-[22px] leading-tight text-ink">You are the new head of infrastructure.</p>
            <p className="mt-1 text-[15px] text-ink/85">
              No Vercel. No Supabase. One empty server, a client app called Crumb, and a pager. Build it, break it, fix it.
            </p>
            <Link
              href={`/play/${LEVELS[0].id}`}
              onClick={() => sfx.tap()}
              className="mt-4 inline-block rounded-lg bg-amber px-5 py-2 font-mono text-[14px] font-bold text-bg shadow-[0_3px_0_#4a4a4a] hover:bg-amber2"
            >
              Start the first mission
            </Link>
          </motion.section>
        )}

        {WORLDS.map((w) => {
          const levels = w.levels;
          const done = levels.filter((l) => completed[l.id]).length;
          const worldOpen = unlocked(LEVELS.indexOf(levels[0]));
          const worldDone = done === levels.length;
          return (
            <section key={w.id} className="mt-10">
              <div className={`sticky top-[52px] z-10 -mx-2 mb-4 flex items-center gap-3 rounded-xl border px-4 py-3 backdrop-blur ${worldOpen ? "border-line bg-panel/90" : "border-line/60 bg-bg2/80 opacity-60"}`}>
                <div className="font-display text-3xl leading-none text-muted">{String(w.id).padStart(2, "0")}</div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-display text-lg leading-tight text-ink">{w.title}</div>
                  <div className="truncate text-[12.5px] text-muted">{w.tagline}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-[11px] text-muted">
                    {done}/{levels.length}
                  </div>
                  {worldDone && (
                    <button type="button" onClick={() => setSheet(w)} className="mt-0.5 rounded border border-teal/50 px-1.5 font-mono text-[10px] text-teal hover:bg-teal/10">
                      cheat sheet
                    </button>
                  )}
                </div>
              </div>
              <div className="relative flex flex-col items-center gap-5 py-2">
                {levels.map((l, li) => {
                  const gi = LEVELS.indexOf(l);
                  const isDone = !!completed[l.id];
                  const isOpen = unlocked(gi);
                  const isCurrent = gi === firstOpen;
                  const isIncident = l.steps.some((s) => s.task.kind === "incident");
                  const offset = Math.sin(li * 1.15) * 90;
                  const st = completed[l.id]?.stars ?? 0;
                  const node = (
                    <motion.div
                      whileHover={isOpen ? { scale: 1.06 } : {}}
                      whileTap={isOpen ? { scale: 0.95 } : {}}
                      className={`relative flex h-[72px] w-[72px] items-center justify-center rounded-full border-2 font-display text-3xl ${
                        isIncident
                          ? isDone
                            ? "border-teal bg-teal/15 text-teal"
                            : isOpen
                              ? "alarm border-red bg-reddim/40 text-red"
                              : "border-line bg-bg2 text-faint"
                          : isDone
                            ? "border-teal bg-teal/15 text-teal"
                            : isOpen
                              ? "border-amber bg-amber/15 text-amber glow"
                              : "border-line bg-bg2 text-faint"
                      } ${isCurrent ? "pulse-ring" : ""}`}
                    >
                      {isIncident ? "!" : isDone ? "✓" : isOpen ? li + 1 : "▪"}
                      {isDone && (
                        <span className="absolute -bottom-2.5 flex gap-px text-[13px]">
                          {[1, 2, 3].map((i) => (
                            <span key={i} className={i <= st ? "text-amber" : "text-line2"}>
                              ★
                            </span>
                          ))}
                        </span>
                      )}
                    </motion.div>
                  );
                  return (
                    <div key={l.id} className="flex flex-col items-center" style={{ transform: `translateX(${offset}px)` }}>
                      {isCurrent && (
                        <motion.div animate={{ y: [0, -4, 0] }} transition={{ repeat: Infinity, duration: 1.6 }} className="mb-1 rounded-md bg-amber px-2 py-0.5 font-mono text-[11px] font-bold text-bg">
                          {doneCount === 0 ? "START" : "NEXT"}
                        </motion.div>
                      )}
                      {isOpen ? (
                        <Link href={`/play/${l.id}`} onClick={() => sfx.tap()} aria-label={l.title}>
                          {node}
                        </Link>
                      ) : (
                        <div aria-label={`${l.title} (locked)`}>{node}</div>
                      )}
                      <div className={`mt-3 max-w-40 text-center font-mono text-[11.5px] leading-tight ${isOpen ? "text-ink/85" : "text-faint"}`}>{l.title}</div>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}

        {UPCOMING.map((u) => (
          <section key={u.id} className="mt-8">
            <div className="flex items-center gap-3 rounded-xl border border-dashed border-line px-4 py-3 opacity-55">
              <div className="font-display text-4xl leading-none text-faint">{String(u.id).padStart(2, "0")}</div>
              <div className="min-w-0 flex-1">
                <div className="truncate font-display text-2xl leading-none text-muted">{u.title}</div>
                <div className="truncate text-[12.5px] text-faint">{u.tagline}</div>
              </div>
              <span className="font-mono text-[10px] uppercase tracking-widest text-faint">being built</span>
            </div>
          </section>
        ))}
      </main>

      <AnimatePresence>
        {sheet && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center bg-bg/80 p-4" onClick={() => setSheet(null)}>
            <motion.div initial={{ scale: 0.9 }} animate={{ scale: 1 }} onClick={(e) => e.stopPropagation()} className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-teal/40 bg-panel p-5 scroll-thin">
              <div className="flex items-center">
                <div className="font-display text-3xl text-teal glow-teal">Cheat sheet · {sheet.title}</div>
                <button type="button" onClick={() => setSheet(null)} className="ml-auto font-mono text-muted hover:text-amber">
                  ✕
                </button>
              </div>
              <ul className="mt-3 space-y-2">
                {sheet.cheatSheet.map((c) => (
                  <li key={c.cmd} className="rounded-lg border border-line bg-bg2/60 p-2">
                    <code className="block font-mono text-[12.5px] text-amber">{c.cmd}</code>
                    <span className="text-[13px] text-ink/85">{c.what}</span>
                  </li>
                ))}
              </ul>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
