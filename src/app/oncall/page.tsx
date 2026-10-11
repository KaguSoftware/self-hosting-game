"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import TopBar from "@/components/TopBar";
import IncidentTask from "@/components/play/IncidentTask";
import { Btn, useEnterKey } from "@/components/play/common";
import { INCIDENTS, LEVELS, levelById } from "@/content";
import { onCallPage, onCallPool } from "@/engine/oncall";
import { useProgress } from "@/store/progress";
import { useUi } from "@/store/ui";

/** On-call unlocks after the final mission and plays on its finished server. */
const FINAL = "w12-01";

function baseLevel(): string {
  if (levelById(FINAL)) return FINAL;
  return [...LEVELS].reverse().find((l) => l.base === "chain")!.id;
}

export default function OnCallPage() {
  const hydrated = useProgress((s) => s.hydrated);
  const unlocked = useProgress((s) => !!s.completed[FINAL]);
  const onCall = useProgress((s) => s.onCall);
  const [seed, setSeed] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [score, setScore] = useState(0);
  const [over, setOver] = useState<{ pages: number; score: number } | null>(null);
  const pool = useMemo(() => onCallPool(INCIDENTS), []);
  const page = useMemo(() => (seed ? onCallPage(pool, seed, index, baseLevel()) : null), [pool, seed, index]);

  const start = () => {
    setSeed(String(Date.now()));
    setIndex(0);
    setScore(0);
    setOver(null);
  };
  const end = (pages: number, total: number) => {
    useProgress.getState().onCallShift(pages, total);
    setOver({ pages, score: total });
    setSeed(null);
  };
  useEnterKey(start, hydrated && unlocked && !seed);

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-[1100px] px-4 py-8">
        <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted">After the final mission</div>
        <h1 className="font-display text-4xl text-amber glow">On-call</h1>
        <p className="text-[14px] text-muted">Pages keep coming, and they get harder: less time, then two breaks at once, then no hints.</p>

        {!hydrated ? null : !unlocked ? (
          <div className="mt-6 rounded-xl border border-line bg-panel p-5">
            <p className="text-[15px]">Finish the final mission to unlock On-call.</p>
            <Link href="/" className="mt-3 inline-block font-mono text-[13px] text-amber hover:underline">
              ← back to the path
            </Link>
          </div>
        ) : !seed || !page ? (
          <div className="mt-6 space-y-4 rounded-xl border border-line bg-panel p-5">
            {over && (
              <p className="text-[15px]">
                Shift over. You fixed <span className="text-teal">{over.pages}</span> {over.pages === 1 ? "incident" : "incidents"}, score {over.score}.
              </p>
            )}
            <div className="font-mono text-[12px] text-muted">
              Best shift: {onCall.best} incidents · best score {onCall.bestScore ?? 0} · shifts played {onCall.runs}
            </div>
            <Btn kind="danger" onClick={start} autoFocus>
              {over ? "Start another shift" : "Start a shift"}
            </Btn>
          </div>
        ) : (
          <div className="mt-6 space-y-3">
            <div className="flex flex-wrap items-center gap-3 font-mono text-[12px] text-muted">
              <span>
                Page <span className="text-ink">{index + 1}</span>
              </span>
              <span>score {score}</span>
              <span>{page.parts.length > 1 ? "two breaks at once" : "one break"}</span>
              <span>{page.hints ? "hints on" : "no hints"}</span>
              <button type="button" className="ml-auto text-muted underline hover:text-ink" onClick={() => end(index, score)}>
                End shift
              </button>
            </div>
            <IncidentTask
              key={page.incident.id}
              incident={page.incident}
              done={false}
              record={false}
              onTimeout={() => {
                useUi.getState().toast("Uptime hit zero. Shift over.", "warn");
                end(index, score);
              }}
              cb={{
                onCorrect: () => {},
                onMistake: () => {},
                onDone: (r) => {
                  setScore((s) => s + (r.bonusXp ?? 0) * 10);
                  setIndex((i) => i + 1);
                },
              }}
            />
          </div>
        )}
      </main>
    </>
  );
}
