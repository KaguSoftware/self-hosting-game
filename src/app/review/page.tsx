"use client";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import TopBar from "@/components/TopBar";
import { Btn } from "@/components/play/common";
import { QUIZ } from "@/content";
import { dayKey, dueCards } from "@/engine/rules";
import { useProgress } from "@/store/progress";
import { useUi } from "@/store/ui";
import { sfx } from "@/lib/sfx";

export default function ReviewPage() {
  const hydrated = useProgress((s) => s.hydrated);
  const review = useProgress((s) => s.review);
  // Freeze the deck when the page opens so answering does not reshuffle it.
  const deck = useMemo(
    () =>
      dueCards(review, dayKey())
        .filter((c) => QUIZ[c.id])
        .slice(0, 5)
        .map((c) => QUIZ[c.id]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hydrated],
  );
  const [i, setI] = useState(0);
  const [pick, setPick] = useState<number | null>(null);
  const [hits, setHits] = useState(0);

  const q = deck[i];

  function answer(n: number) {
    if (pick !== null || !q) return;
    setPick(n);
    const ok = n === q.answer;
    useProgress.getState().reviewResult(q.id, ok);
    if (ok) {
      setHits((h) => h + 1);
      sfx.success();
    } else sfx.error();
  }

  function next() {
    setPick(null);
    if (i + 1 >= deck.length) {
      useProgress.getState().addXp(hits * 5);
      useUi.getState().toast(`+${hits * 5} XP`, "xp");
      if (hits === deck.length) useUi.getState().fireConfetti();
    }
    setI(i + 1);
  }

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-xl px-4 py-8">
        <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-yellow">Spaced review</div>
        <h1 className="font-display text-4xl text-amber glow">Weak spots</h1>
        <p className="text-[14px] text-muted">Things you missed come back until they stick.</p>
        {!hydrated ? null : !deck.length ? (
          <div className="mt-6 rounded-xl border border-line bg-panel p-5">
            <p className="text-[15px]">Nothing due right now. Nice.</p>
            <Link href="/" className="mt-3 inline-block font-mono text-[13px] text-amber hover:underline">
              ← back to the path
            </Link>
          </div>
        ) : i >= deck.length ? (
          <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="mt-6 rounded-xl border border-teal/40 bg-panel p-6 text-center">
            <div className="font-display text-5xl text-teal glow-teal">
              {hits}/{deck.length}
            </div>
            <p className="mt-1 text-[14px] text-ink/80">Right answers move to longer gaps. Misses come back tomorrow.</p>
            <Link href="/" className="mt-4 inline-block rounded-lg bg-amber px-4 py-2 font-mono text-[13px] font-bold text-bg">
              Back to the path
            </Link>
          </motion.div>
        ) : (
          <AnimatePresence mode="wait">
            <motion.div key={q.id} initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -30 }} className="mt-6 space-y-3">
              <div className="font-mono text-[11px] text-muted">
                {i + 1}/{deck.length} · {q.tag}
              </div>
              <p className="text-[17px] font-medium">{q.q}</p>
              <div className="grid gap-2">
                {q.options.map((o, n) => (
                  <button
                    key={o}
                    type="button"
                    onClick={() => answer(n)}
                    className={`rounded-lg border px-3 py-2.5 text-left text-[14px] transition ${
                      pick === null
                        ? "border-line2 bg-panel hover:border-amber"
                        : n === q.answer
                          ? "border-teal bg-teal/10 text-teal"
                          : n === pick
                            ? "border-red bg-red/10 text-red"
                            : "border-line opacity-50"
                    }`}
                  >
                    {o}
                  </button>
                ))}
              </div>
              {pick !== null && (
                <>
                  <p className="text-[14px] text-ink/85">{q.why}</p>
                  <Btn kind="teal" onClick={next}>
                    Next
                  </Btn>
                </>
              )}
            </motion.div>
          </AnimatePresence>
        )}
      </main>
    </>
  );
}
