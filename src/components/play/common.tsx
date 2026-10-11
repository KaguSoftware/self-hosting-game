"use client";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import type { Intel, Step } from "@/content/schema";
import { termById } from "@/content/dictionary";
import { useUi } from "@/store/ui";
import { flagsInProse } from "@/content/flags";
import FlagNotes from "./FlagNotes";
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
    <div className="space-y-3">
      <div>
        <div className="mb-1 font-mono text-[11px] text-muted">
          Step {index + 1} of {total}
        </div>
        <h2 className="text-balance text-[19px] font-semibold leading-snug text-ink md:text-[20px]">{step.mission}</h2>
      </div>
      {step.intel && <IntelCard intel={step.intel} stepId={step.id} />}
    </div>
  );
}

export function IntelCard({ intel, stepId }: { intel: Intel; stepId: string }) {
  const openDict = useUi((s) => s.openDict);
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1], delay: 0.05 }}
      className="rounded-xl border border-line bg-panel px-4 py-3"
    >
      <div className="space-y-1">
        {intel.lines.map((l) => (
          <p key={l} className="max-w-[68ch] text-[15px] leading-relaxed text-ink/90">
            {l}
          </p>
        ))}
      </div>
      {intel.analogy && <p className="mt-2 max-w-[68ch] text-[14px] italic leading-relaxed text-muted">{intel.analogy}</p>}
      <FlagNotes notes={intel.lines.flatMap(flagsInProse)} where={stepId} className="mt-2.5 border-t border-line pt-2.5" />
      {intel.terms?.length ? (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {intel.terms.map((t) => {
            const term = termById(t);
            if (!term) return null;
            return (
              <button
                key={t}
                type="button"
                onClick={() => openDict(term.term)}
                className="rounded-md border border-line2 px-2 py-0.5 text-[12px] text-muted transition hover:border-ink hover:text-ink"
              >
                What is {term.term}?
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
  threshold = 2,
}: {
  hints: [string, string];
  failures: number;
  threshold?: number;
  onHint: () => void;
  onShowMe?: () => void;
  showMeLabel?: string;
}) {
  const [level, setLevel] = useState(0);
  const visible = failures >= threshold || level > 0;
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
          className={`flex items-center gap-2.5 text-[14px] ${met[i] ? "text-teal" : "text-ink/80"}`}
        >
          <span
            className={`inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border text-[11px] font-bold ${
              met[i] ? "border-teal bg-teal text-bg" : "border-line2"
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
      ? "bg-ink text-bg hover:bg-white active:translate-y-px"
      : kind === "teal"
        ? "bg-teal text-bg hover:brightness-110 active:translate-y-px"
        : kind === "danger"
          ? "bg-red text-bg hover:brightness-110"
          : "border border-line2 text-ink hover:border-ink";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-lg px-4 py-2.5 text-[14px] font-semibold transition disabled:opacity-40 ${k} ${className}`}
    >
      {children}
    </button>
  );
}

/** Press 1, 2, 3... to pick option 1, 2, 3... (ignored while typing in a field). */
export function useNumberKeys(count: number, onPick: (index: number) => void, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const h = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= count) {
        e.preventDefault();
        onPick(n - 1);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });
}

/** The number shown on an answer, matching the key that picks it. */
export function OptionKey({ n }: { n: number }) {
  return (
    <span
      aria-hidden
      className="mt-px inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-line2 font-mono text-[11.5px] font-semibold leading-none text-muted"
    >
      {n}
    </span>
  );
}
