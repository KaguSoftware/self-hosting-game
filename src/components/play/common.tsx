"use client";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import type { Intel, Step } from "@/content/schema";
import { termById } from "@/content/dictionary";
import { useUi } from "@/store/ui";
import { sfx } from "@/lib/sfx";

export interface TaskResult {
  mistakes: number;
  usedHints: boolean;
  usedShowMe: boolean;
  /** Quiz ids to put in the review queue. */
  missed: string[];
  /** Line shown in the success banner. */
  why?: string;
  /** Extra XP on top of the step XP (rapid fire hits). */
  bonusXp?: number;
}

export interface TaskCallbacks {
  onDone(r: TaskResult): void;
  /** A wrong action. quizId goes to the review queue. */
  onMistake(quizId?: string): void;
  /** A right action (feeds the combo). */
  onCorrect(): void;
}

export function MissionCard({ step, index, total }: { step: Step; index: number; total: number }) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-amber/80">
          Mission {index + 1}/{total}
        </span>
      </div>
      <h2 className="font-sans text-[17px] font-semibold leading-snug text-ink md:text-lg">{step.mission}</h2>
      {step.intel && <IntelCard intel={step.intel} />}
    </div>
  );
}

export function IntelCard({ intel }: { intel: Intel }) {
  const openDict = useUi((s) => s.openDict);
  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 300, damping: 24, delay: 0.1 }}
      className="relative overflow-hidden rounded-lg border border-teal/30 bg-teal/[0.06] px-3 py-2"
    >
      <div className="absolute left-0 top-0 h-full w-0.5 bg-teal/70" />
      <div className="mb-0.5 font-mono text-[10px] uppercase tracking-[0.25em] text-teal">Intel</div>
      {intel.lines.map((l) => (
        <p key={l} className="font-mono text-[12.5px] leading-snug text-ink/90">
          {l}
        </p>
      ))}
      {intel.analogy && <p className="mt-1 text-[12.5px] italic leading-snug text-teal/90">{intel.analogy}</p>}
      {intel.terms?.length ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {intel.terms.map((t) => {
            const term = termById(t);
            if (!term) return null;
            return (
              <button
                key={t}
                type="button"
                onClick={() => openDict(term.term)}
                className="rounded border border-teal/30 px-1.5 font-mono text-[10px] text-teal/90 hover:bg-teal/10"
              >
                ? {term.term}
              </button>
            );
          })}
        </div>
      ) : null}
    </motion.div>
  );
}

/** Tiered hints: shows up after 2 failures. nudge → hint → show me. */
export function HintBar({
  hints,
  failures,
  onHint,
  onShowMe,
  showMeLabel = "Show me",
}: {
  hints: [string, string];
  failures: number;
  onHint: () => void;
  onShowMe?: () => void;
  showMeLabel?: string;
}) {
  const [level, setLevel] = useState(0);
  const visible = failures >= 2 || level > 0;
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          className="overflow-hidden rounded-lg border border-yellow/30 bg-yellow/[0.05] px-3 py-2"
        >
          {level === 0 && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] text-yellow/90">Stuck? No shame in it.</span>
              <button
                type="button"
                onClick={() => {
                  sfx.tap();
                  setLevel(1);
                  onHint();
                }}
                className="rounded-md border border-yellow/50 px-2 py-0.5 font-mono text-[11px] text-yellow hover:bg-yellow/10"
              >
                Give me a nudge
              </button>
            </div>
          )}
          {level >= 1 && (
            <p className="font-mono text-[12.5px] text-yellow/90">
              <span className="text-yellow">nudge:</span> {hints[0]}
            </p>
          )}
          {level === 1 && (
            <button
              type="button"
              onClick={() => {
                sfx.tap();
                setLevel(2);
                onHint();
              }}
              className="mt-1.5 rounded-md border border-yellow/50 px-2 py-0.5 font-mono text-[11px] text-yellow hover:bg-yellow/10"
            >
              Stronger hint
            </button>
          )}
          {level >= 2 && (
            <p className="mt-1 font-mono text-[12.5px] text-yellow/90">
              <span className="text-yellow">hint:</span> {hints[1]}
            </p>
          )}
          {level >= 2 && onShowMe && (
            <button
              type="button"
              onClick={() => {
                sfx.whoosh();
                setLevel(3);
                onShowMe();
              }}
              className="mt-1.5 rounded-md bg-yellow/90 px-2 py-0.5 font-mono text-[11px] font-semibold text-bg hover:bg-yellow"
            >
              {showMeLabel} (costs the bonus XP)
            </button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function GoalList({ goals, met }: { goals: { describe: string }[]; met: boolean[] }) {
  return (
    <ul className="space-y-1">
      {goals.map((g, i) => (
        <motion.li
          key={g.describe}
          animate={met[i] ? { x: [0, 4, 0] } : {}}
          className={`flex items-center gap-2 font-mono text-[12.5px] ${met[i] ? "text-teal" : "text-muted"}`}
        >
          <span
            className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${
              met[i] ? "border-teal bg-teal/20 text-teal" : "border-line2"
            }`}
          >
            {met[i] ? "✓" : ""}
          </span>
          {g.describe}
        </motion.li>
      ))}
    </ul>
  );
}

export function Btn({
  children,
  onClick,
  kind = "primary",
  disabled,
  className = "",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  kind?: "primary" | "ghost" | "teal" | "danger";
  disabled?: boolean;
  className?: string;
}) {
  const k =
    kind === "primary"
      ? "bg-amber text-bg hover:bg-amber2 shadow-[0_3px_0_#4a4a4a] active:translate-y-[2px] active:shadow-none"
      : kind === "teal"
        ? "bg-teal text-bg hover:brightness-110 shadow-[0_3px_0_#4a4a4a] active:translate-y-[2px] active:shadow-none"
        : kind === "danger"
          ? "bg-red text-bg hover:brightness-110"
          : "border border-line2 text-ink hover:border-amber hover:text-amber";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-lg px-4 py-2 font-mono text-[13px] font-semibold tracking-wide transition disabled:opacity-40 ${k} ${className}`}
    >
      {children}
    </button>
  );
}
