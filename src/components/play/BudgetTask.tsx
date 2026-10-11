"use client";
import { AnimatePresence, motion } from "motion/react";
import { useRef, useState } from "react";
import type { Step, Task } from "@/content/schema";
import { applyMapActions } from "@/sim/map";
import { usePlay } from "@/store/play";
import { sfx } from "@/lib/sfx";
import { HintBar, OptionKey, useNumberKeys, type TaskCallbacks } from "./common";

type T = Extract<Task, { kind: "budget" }>;

function gb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1).replace(/\.0$/, "")} GB` : `${mb} MB`;
}

/** Load each program onto the server, then pick the cheapest plan that holds it all. */
export default function BudgetTask({ step, task, cb, done }: { step: Step; task: T; cb: TaskCallbacks; done: boolean }) {
  const [loaded, setLoaded] = useState<number[]>([]);
  const [picked, setPicked] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ text: string; kind: "bad" | "meh" } | null>(null);
  const [failures, setFailures] = useState(0);
  const [usedHints, setUsedHints] = useState(false);
  const total = loaded.reduce((s, i) => s + task.pieces[i].mb, 0);
  const allLoaded = loaded.length === task.pieces.length;
  const fullTotal = task.pieces.reduce((s, p) => s + p.mb, 0);

  function load(i: number) {
    if (done || loaded.includes(i)) return;
    sfx.tap();
    cb.onCorrect();
    setLoaded([...loaded, i]);
  }

  const fired = useRef(false);
  function finish(showMe: boolean) {
    if (fired.current) return;
    fired.current = true;
    if (task.apply) usePlay.getState().setWorld(applyMapActions(usePlay.getState().state.world, task.apply));
    setTimeout(
      () =>
        cb.onDone({
          mistakes: failures,
          usedHints,
          usedShowMe: showMe,
          missed: failures && step.review ? [step.review.id] : [],
          why: task.why,
        }),
      500,
    );
  }

  function pick(i: number) {
    if (done || !allLoaded || fired.current) return;
    setPicked(i);
    const plan = task.plans[i];
    if (plan.ramMb < fullTotal) {
      setFailures((f) => f + 1);
      cb.onMistake();
      setMsg({ text: `${plan.name} has ${gb(plan.ramMb)}. Everything needs ${gb(fullTotal)}. Programs would crash.`, kind: "bad" });
      return;
    }
    if (i !== task.answer) {
      setFailures((f) => f + 1);
      cb.onMistake();
      setMsg({ text: `It fits, but you would pay for ${gb(plan.ramMb - fullTotal)} you never use. Is there a cheaper plan that still fits?`, kind: "meh" });
      return;
    }
    setMsg(null);
    cb.onCorrect();
    finish(false);
  }

  // Keyboard: first 1, 2, 3 load the pieces, then (once all are loaded) 1, 2, 3 pick a plan.
  useNumberKeys(task.pieces.length, load, !done && !allLoaded);
  useNumberKeys(task.plans.length, pick, !done && allLoaded);

  return (
    <div className="space-y-4">
      <p className="text-[14px] text-muted">{task.prompt}</p>

      {/* 1. what has to fit */}
      <div className="rounded-xl border border-line bg-panel p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <span className="text-[13px] font-semibold text-ink">1. Tap each thing to load it onto the server</span>
          <span className="font-mono text-[13px] text-ink">{gb(total)}</span>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {task.pieces.map((p, i) => {
            const on = loaded.includes(i);
            return (
              <button
                key={p.name}
                type="button"
                onClick={() => load(i)}
                disabled={on || done}
                className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition ${
                  on ? "border-teal/50 bg-teal/[0.07]" : "border-line2 bg-panel2 hover:border-ink"
                }`}
              >
                <span className="flex min-w-0 items-start gap-2.5">
                  {!allLoaded && i < 9 && <OptionKey n={i + 1} className={on ? "invisible" : ""} />}
                  <span className="min-w-0">
                    <span className={`block text-[14px] font-medium ${on ? "text-teal" : "text-ink"}`}>
                      {on ? "✓ " : ""}
                      {p.name}
                    </span>
                    <span className="block text-[12.5px] text-muted">{p.note}</span>
                  </span>
                </span>
                <span className="shrink-0 font-mono text-[13px] text-ink/80">{gb(p.mb)}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 2. pick a plan */}
      <div className={`rounded-xl border border-line bg-panel p-4 transition ${allLoaded ? "" : "opacity-50"}`}>
        <div className="mb-3 text-[13px] font-semibold text-ink">{allLoaded ? "2. Pick the cheapest plan that fits it all" : "2. Load everything first, then pick a plan"}</div>
        <div className="grid gap-2 sm:grid-cols-2">
          {task.plans.map((p, i) => {
            const fits = p.ramMb >= fullTotal;
            const fill = Math.min(100, (fullTotal / p.ramMb) * 100);
            const chosen = picked === i;
            return (
              <button
                key={p.name}
                type="button"
                onClick={() => pick(i)}
                disabled={!allLoaded || done}
                className={`rounded-lg border px-3 py-2.5 text-left transition ${
                  chosen && done ? "border-teal bg-teal/10" : chosen && msg?.kind === "bad" ? "border-red bg-red/[0.07]" : "border-line2 bg-panel2 hover:border-ink"
                } disabled:cursor-not-allowed`}
              >
                <div className="flex items-baseline justify-between">
                  <span className="flex items-center gap-2 text-[14px] font-semibold text-ink">
                    {allLoaded && !done && i < 9 && <OptionKey n={i + 1} inline />}
                    {p.name}
                  </span>
                  <span className="font-mono text-[13px] text-ink">{p.price}</span>
                </div>
                <div className="mt-0.5 text-[12.5px] text-muted">
                  {gb(p.ramMb)} RAM · {p.cpus} vCPU
                </div>
                {allLoaded && (
                  <>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-line">
                      <motion.div
                        className={`h-full ${fits ? "bg-teal" : "bg-red"}`}
                        initial={{ width: 0 }}
                        animate={{ width: `${fill}%` }}
                        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                      />
                    </div>
                    <div className={`mt-1 font-mono text-[11.5px] ${fits ? "text-teal" : "text-red"}`}>
                      {fits ? `fits, ${gb(p.ramMb - fullTotal)} spare` : `short by ${gb(fullTotal - p.ramMb)}`}
                    </div>
                  </>
                )}
              </button>
            );
          })}
        </div>
        <AnimatePresence>
          {msg && (
            <motion.p
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className={`mt-3 text-[14px] ${msg.kind === "bad" ? "text-red" : "text-ink/85"}`}
            >
              {msg.text}
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      {!done && (
        <HintBar
          hints={task.hints}
          failures={failures}
          onHint={() => setUsedHints(true)}
          onShowMe={() => {
            setLoaded(task.pieces.map((_, i) => i));
            setPicked(task.answer);
            finish(true);
          }}
        />
      )}
    </div>
  );
}
