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

/**
 * Tiered hints: shows up after 2 failures. nudge → hint → show me.
 * Keys: H for the next hint, S for show me. In the terminal hold Ctrl (Ctrl+H, Ctrl+S),
 * so typing an h or s in a command never sets them off.
 */
export function HintBar({
  hints,
  failures,
  onHint,
  onShowMe,
  showMeLabel = "Show me",
  threshold = 2,
  terminal = false,
}: {
  hints: [string, string];
  failures: number;
  threshold?: number;
  onHint: () => void;
  onShowMe?: () => void;
  showMeLabel?: string;
  /** The task has a terminal, so the badges say Ctrl H and Ctrl S. */
  terminal?: boolean;
}) {
  const [level, setLevel] = useState(0);
  const visible = failures >= threshold || level > 0;

  function nextHint() {
    if (level >= 2) return;
    sfx.tap();
    setLevel(level + 1);
    onHint();
  }
  function showMe() {
    if (level < 2 || !onShowMe) return;
    sfx.whoosh();
    setLevel(3);
    onShowMe();
  }

  const hintKey = (key: string) => (e: KeyboardEvent) =>
    e.key.toLowerCase() === key && !e.altKey && !e.shiftKey && (!(e.ctrlKey || e.metaKey) || isTerminalInput(e.target));
  useHotkey(hintKey("h"), nextHint, visible && level < 2, { inInput: "terminal-ctrl" });
  useHotkey(hintKey("s"), showMe, visible && level === 2 && !!onShowMe, { inInput: "terminal-ctrl" });
  const badge = (k: string) => <KeyHint>{terminal ? `Ctrl ${k}` : k}</KeyHint>;
  const tip = (k: string) => (terminal ? `Press Ctrl+${k}, or ${k} when you are not typing` : `Press ${k}`);

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
                onClick={nextHint}
                title={tip("H")}
                className="rounded-md border border-yellow/50 px-2 py-0.5 font-mono text-[11px] text-yellow hover:bg-yellow/10"
              >
                Give me a nudge{badge("H")}
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
              onClick={nextHint}
              title={tip("H")}
              className="mt-1.5 rounded-md border border-yellow/50 px-2 py-0.5 font-mono text-[11px] text-yellow hover:bg-yellow/10"
            >
              Stronger hint{badge("H")}
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
              title={tip("S")}
              className="mt-1.5 rounded-md bg-yellow/90 px-2 py-0.5 font-mono text-[11px] font-semibold text-bg hover:bg-yellow"
            >
              {showMeLabel} (costs the bonus XP){level === 2 && badge("S")}
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
  autoFocus,
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  kind?: "primary" | "ghost" | "teal" | "danger";
  disabled?: boolean;
  className?: string;
  /** Put keyboard focus here when the button appears, so Enter presses it. */
  autoFocus?: boolean;
  title?: string;
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
      autoFocus={autoFocus}
      title={title}
      className={`rounded-lg px-4 py-2.5 text-[14px] font-semibold transition disabled:opacity-40 ${k} ${className}`}
    >
      {children}
    </button>
  );
}

// ---------------- keyboard ----------------
// The whole game can be played without a mouse. These helpers keep every shortcut
// polite: they never fire while you are typing, never twice for one key press, and
// never behind an open dictionary or help panel.

/** True when the key press happens inside a text field. */
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  if (el.tagName === "INPUT") {
    const type = (el as HTMLInputElement).type;
    return !["button", "checkbox", "radio", "submit", "reset", "range", "file"].includes(type);
  }
  return !!el.isContentEditable;
}

/** The terminal's command line. Some shortcuts work there while Ctrl is held. */
export function isTerminalInput(t: EventTarget | null): boolean {
  return !!(t as HTMLElement | null)?.closest?.("[data-terminal-input]");
}

/** A focused button or link already does its own thing on Enter, so leave it alone. */
function activatesOnEnter(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if ((el as HTMLButtonElement).disabled) return false;
  return el.tagName === "BUTTON" || (el.tagName === "A" && el.hasAttribute("href")) || el.getAttribute("role") === "button" || el.tagName === "SUMMARY";
}

/**
 * A dictionary or help panel is open on top: keys belong to it, not the page behind.
 * An open panel renders a hidden `<KeyLayer />` marker; its content carries `data-kb-panel`.
 */
function blockedByLayer(t: EventTarget | null): boolean {
  if (typeof document === "undefined" || !document.querySelector("[data-kb-layer]")) return false;
  return !(t as HTMLElement | null)?.closest?.("[data-kb-panel]");
}

/**
 * Render while a panel is open, so page shortcuts wait until it closes. It also keeps
 * Tab inside the panel, so focus never wanders off to the page behind it.
 */
export function KeyLayer() {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.defaultPrevented) return;
      const panels = document.querySelectorAll<HTMLElement>("[data-kb-panel]");
      const panel = panels[panels.length - 1];
      if (!panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>("button, [href], input, textarea, select, [tabindex]:not([tabindex='-1'])")].filter(
        (el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null,
      );
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = !!active && panel.contains(active);
      if (e.shiftKey && (!inside || active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  return <span data-kb-layer hidden />;
}

// The last thing that had focus outside any panel, so closing a panel can put focus back
// (for example into the terminal input). Tracked all the time because a panel's search box
// grabs focus before any effect could look.
let lastOutside: HTMLElement | null = null;
let tracking = false;
function trackFocus() {
  if (tracking || typeof document === "undefined") return;
  tracking = true;
  document.addEventListener("focusin", (e) => {
    const el = e.target as HTMLElement | null;
    if (el && el !== document.body && !el.closest?.("[data-kb-panel]")) lastOutside = el;
  });
  // Focus dropped to nothing (Esc out of the terminal, a click on empty space): nothing to go back to.
  document.addEventListener("focusout", (e) => {
    if (!e.relatedTarget && !(e.target as HTMLElement | null)?.closest?.("[data-kb-panel]")) lastOutside = null;
  });
}

/** Put focus back where it was before a panel opened, once it closes. */
export function useRestoreFocus(open: boolean) {
  useEffect(() => {
    trackFocus();
  }, []);
  useEffect(() => {
    if (!open) return;
    const before = lastOutside;
    return () => {
      if (before && before.isConnected && !(before as HTMLInputElement).disabled) before.focus({ preventScroll: true });
    };
  }, [open]);
}

export interface HotkeyOptions {
  /**
   * Inside a text field: never (default), only with Ctrl/Cmd held, only in the
   * terminal with Ctrl/Cmd held, or always.
   */
  inInput?: "never" | "ctrl" | "terminal-ctrl" | "always";
  /** This shortcut belongs to an open panel (dictionary, help), so that panel does not block it. */
  layer?: boolean;
}

/**
 * Low level: call `onKey` for key presses that `match`. Skips presses another handler
 * already took (preventDefault), held-down repeats, typing in fields, and anything
 * behind an open panel.
 */
export function useHotkey(match: (e: KeyboardEvent) => boolean, onKey: (e: KeyboardEvent) => void, enabled: boolean, opts: HotkeyOptions = {}) {
  useEffect(() => {
    if (!enabled) return;
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.repeat) return;
      if (!opts.layer && blockedByLayer(e.target)) return;
      if (!match(e)) return;
      if (isTypingTarget(e.target)) {
        const ctrl = e.ctrlKey || e.metaKey;
        const mode = opts.inInput ?? "never";
        if (mode === "never") return;
        if (mode === "ctrl" && !ctrl) return;
        if (mode === "terminal-ctrl" && !(ctrl && isTerminalInput(e.target))) return;
      }
      e.preventDefault();
      onKey(e);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });
}

/** A plain key press: no Ctrl, Cmd or Alt. Shift only when asked for. */
export function plain(e: KeyboardEvent, shift = false): boolean {
  return !e.ctrlKey && !e.metaKey && !e.altKey && (shift || !e.shiftKey);
}

/**
 * Enter presses the main "continue" button. Ctrl+Enter (Cmd+Enter on a Mac) works
 * everywhere, even from the terminal or a text box. Plain Enter is ignored while
 * typing, and when a button or link has focus (that button gets the Enter instead).
 * Alt or Shift held: ignored.
 */
export function useEnterKey(onEnter: () => void, enabled: boolean) {
  useHotkey(
    (e) => {
      if (e.key !== "Enter" || e.altKey || e.shiftKey) return false;
      if (!(e.ctrlKey || e.metaKey) && activatesOnEnter(e.target)) return false;
      return true;
    },
    () => onEnter(),
    enabled,
    { inInput: "ctrl" },
  );
}

/** Press 1, 2, 3... to pick option 1, 2, 3... (ignored while typing in a field). */
export function useNumberKeys(count: number, onPick: (index: number) => void, enabled: boolean) {
  useHotkey(
    (e) => {
      if (!plain(e) || e.key.length !== 1) return false;
      const n = Number(e.key);
      return Number.isInteger(n) && n >= 1 && n <= Math.min(count, 9);
    },
    (e) => onPick(Number(e.key) - 1),
    enabled && count > 0,
  );
}

/** Letters for buckets and map boxes. No H, S or T: those are the hint, show me and terminal keys. */
export const LETTERS = "ABCDEFGIJKLMNOPQRUVWXYZ";

/** Letter keys A, B, C... pick item 1, 2, 3... */
export function useLetterKeys(count: number, onPick: (index: number) => void, enabled: boolean) {
  useHotkey(
    (e) => plain(e, true) && e.key.length === 1 && LETTERS.slice(0, count).includes(e.key.toUpperCase()),
    (e) => onPick(LETTERS.indexOf(e.key.toUpperCase())),
    enabled && count > 0,
  );
}

/** Escape key. Works inside text fields too unless told otherwise. */
export function useEscapeKey(onEscape: () => void, enabled: boolean, opts: HotkeyOptions = {}) {
  useHotkey((e) => e.key === "Escape" && plain(e, true), () => onEscape(), enabled, { inInput: "always", ...opts });
}

/**
 * Keyboard for putting a list in order: 1 to 9 picks a line, arrow Up and Down
 * move it, Escape lets go.
 */
export function useReorderKeys({
  count,
  sel,
  setSel,
  move,
  enabled,
}: {
  count: number;
  sel: number | null;
  setSel: (i: number | null) => void;
  move: (from: number, dir: -1 | 1) => void;
  enabled: boolean;
}) {
  useNumberKeys(count, (i) => setSel(sel === i ? null : i), enabled);
  useHotkey(
    (e) => sel !== null && plain(e) && (e.key === "ArrowUp" || e.key === "ArrowDown"),
    (e) => {
      if (sel === null) return;
      const d = e.key === "ArrowUp" ? -1 : 1;
      const j = sel + d;
      if (j < 0 || j >= count) return;
      move(sel, d);
      setSel(j);
    },
    enabled,
  );
  useEscapeKey(() => setSel(null), enabled && sel !== null, { inInput: "never" });
}

/** The key shown on an answer or a choice, matching the key that picks it. */
export function OptionKey({
  n,
  small = false,
  inline = false,
  tone = "border-line2 text-muted",
  className = "",
}: {
  n: number | string;
  /** Smaller badge for chips and switches. */
  small?: boolean;
  /** Sits in a row with items-center, so no nudge down for text alignment. */
  inline?: boolean;
  /** Border and text color classes. */
  tone?: string;
  className?: string;
}) {
  const size = small ? "h-4 min-w-4 text-[10px]" : "h-5 min-w-5 text-[11.5px]";
  return (
    <span
      aria-hidden
      className={`${inline || small ? "" : "mt-px"} inline-flex shrink-0 items-center justify-center rounded border px-1 font-mono font-semibold leading-none ${size} ${tone} ${className}`}
    >
      {n}
    </span>
  );
}

/** A faded shortcut label inside a button, like the result modal's "↵". */
export function KeyHint({ children }: { children: React.ReactNode }) {
  return (
    <span aria-hidden className="ml-1.5 font-mono text-[12px] font-normal opacity-60">
      {children}
    </span>
  );
}
