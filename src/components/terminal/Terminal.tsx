"use client";
import { useEffect, useRef, useState } from "react";
import { promptText, topFrame } from "@/sim/shell/run";
import { usePlay } from "@/store/play";
import { sfx } from "@/lib/sfx";
import { CONSOLE_FRAME } from "@/engine/play";
import NanoEditor from "./NanoEditor";
import { describeFlag, flagsIn } from "@/content/flags";
import { useProgress } from "@/store/progress";
import { FLAG_SHOWINGS } from "../play/FlagNotes";
import { plain, useHotkey } from "../play/common";

export interface TerminalProps {
  /** Current step or incident id, so flag notes are not repeated within it. */
  stepId?: string;
  chips?: string[];
  /** "Type this" commands. Tab on an empty line fills in the next one. */
  guide?: string[];
  allowConsole?: boolean;
  onCommand?: (r: { code: number; isErrorish: boolean; line: string }) => void;
  disabled?: boolean;
  height?: string;
}

const kindClass: Record<string, string> = {
  out: "text-ink/90",
  err: "text-red/90",
  info: "text-ink/70",
  cmd: "text-ink",
  sys: "text-muted italic",
};

export default function Terminal({ stepId = "terminal", chips = [], guide, allowConsole, onCommand, disabled, height = "h-[34vh] md:h-[min(36vh,340px)]" }: TerminalProps) {
  const { state, active, lines, editor } = usePlay();
  const run = usePlay((s) => s.run);
  const [input, setInput] = useState("");
  const chipIdx = useRef(0);
  const [focused, setFocused] = useState(false);
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const [options, setOptions] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const sh = state.shells[active];
  const myLines = lines[active] ?? [];
  const pending = sh?.pending;
  const prompt = sh && state.world ? promptText(state.world, sh) : "";
  const hasConsole = state.shells.some((s) => s.frames[0]?.via === "console");

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [myLines.length, active, input]);

  useEffect(() => {
    if (!editor && !disabled) inputRef.current?.focus({ preventScroll: true });
  }, [active, editor, disabled]);

  const insert = usePlay((s) => s.insert);
  useEffect(() => {
    if (!insert) return;
    setInput(insert.text);
    inputRef.current?.focus();
  }, [insert]);

  // ---- keyboard: windows ----
  // Alt+1..9 (or Ctrl+Shift+1..9) switches window, Alt+N opens one, Alt+P opens the
  // provider console when it is offered, T jumps back into the command line.
  const digit = (e: KeyboardEvent) => (/^Digit[1-9]$/.test(e.code) ? Number(e.code.slice(5)) : 0);
  useHotkey(
    (e) => digit(e) > 0 && !e.metaKey && ((e.altKey && !e.ctrlKey && !e.shiftKey) || (e.ctrlKey && e.shiftKey && !e.altKey)),
    (e) => {
      const i = digit(e) - 1;
      if (i < usePlay.getState().state.shells.length) usePlay.getState().setActive(i);
      inputRef.current?.focus({ preventScroll: true });
    },
    !editor,
    { inInput: "always" },
  );
  useHotkey(
    (e) => e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyN",
    () => newWindow(),
    !editor && !disabled,
    { inInput: "always" },
  );
  useHotkey(
    (e) => e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyP",
    () => openConsole(),
    !!allowConsole && !hasConsole && !editor && !disabled,
    { inInput: "always" },
  );
  useHotkey((e) => plain(e) && e.key.toLowerCase() === "t", () => inputRef.current?.focus(), !editor && !disabled);

  if (!sh) return null;

  function newWindow() {
    sfx.tap();
    usePlay.getState().addWindow(undefined, "New window on your laptop.");
  }

  function openConsole() {
    sfx.whoosh();
    usePlay.getState().addWindow(CONSOLE_FRAME, "Provider web console. You are root on web-1, connected through the provider, not SSH.");
  }

  /**
   * The next "Type this" command: the one after the line you have now if it is one of
   * them, else the first one not run yet in this step.
   */
  function nextGuide(cur: string): string | undefined {
    if (!guide?.length) return undefined;
    const at = guide.indexOf(cur.trim());
    if (at >= 0) return guide[(at + 1) % guide.length];
    const ran = new Set(usePlay.getState().log.map((l) => l.line.trim()));
    return guide.find((g) => !ran.has(g)) ?? guide[0];
  }

  function nextChip() {
    if (!chips.length) {
      const g = nextGuide(input);
      if (g) setInput(g);
      return;
    }
    tapChip(chips[chipIdx.current % chips.length]);
    chipIdx.current += 1;
  }

  function submit(text: string) {
    if (disabled) return;
    sfx.enter();
    setOptions([]);
    setHistIdx(null);
    const r = run(text);
    setInput("");
    if (!pending) explainFlags(text);
    if (r) onCommand?.({ ...r, line: text });
  }

  /** The first few times you run a flag, say what it means right in the terminal. */
  function explainFlags(text: string) {
    const prog = useProgress.getState();
    const fresh = flagsIn(text).filter((n) => {
      const list = prog.flagSeen[n.key] ?? [];
      return n.parts.length && list.length < FLAG_SHOWINGS && !list.includes(stepId);
    });
    const unique = fresh.filter((n, i) => fresh.findIndex((x) => x.key === n.key) === i);
    if (!unique.length) return;
    for (const n of unique) usePlay.getState().sys(`${n.cmd} ${n.flag}: ${n.parts.length > 1 ? describeFlag(n) : n.parts[0].means}`);
    prog.sawFlags(
      unique.map((n) => n.key),
      `run:${stepId}:${Date.now()}`,
    );
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      // Ctrl+Enter means "next", handled by the level player. Do not run a command.
      if (e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      submit(input);
      return;
    }
    if (e.key === "Escape") {
      // Step out of the terminal so letter keys (H, S, T, ?) work as shortcuts.
      e.currentTarget.blur();
      return;
    }
    if (e.ctrlKey && !e.altKey && (e.key === " " || e.code === "Space")) {
      e.preventDefault();
      nextChip();
      return;
    }
    if (e.key === "Tab") {
      // Shift+Tab leaves the terminal, so every other button stays reachable.
      if (e.shiftKey) return;
      e.preventDefault();
      if (pending) return;
      // On an empty line (or on a "Type this" command), Tab fills in the next one.
      const g = (!input.trim() || guide?.includes(input.trim())) && nextGuide(input);
      if (g) {
        setInput(g);
        setOptions([]);
        return;
      }
      const c = usePlay.getState().complete(input);
      setInput(c.line);
      setOptions(c.options.length > 1 ? c.options.slice(0, 30) : []);
      return;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      if (pending) return;
      e.preventDefault();
      const h = sh.history;
      if (!h.length) return;
      let i = histIdx ?? h.length;
      i = e.key === "ArrowUp" ? Math.max(0, i - 1) : Math.min(h.length, i + 1);
      setHistIdx(i);
      setInput(i >= h.length ? "" : h[i]);
      return;
    }
    if (e.ctrlKey && (e.key === "l" || e.key === "L")) {
      e.preventDefault();
      usePlay.getState().clear();
      return;
    }
    if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
      if (window.getSelection()?.toString()) return;
      e.preventDefault();
      if (pending) usePlay.getState().cancel();
      else {
        usePlay.getState().sys("^C");
        setInput("");
      }
      return;
    }
    if (e.key.length === 1) sfx.key();
  }

  function tapChip(c: string) {
    sfx.tap();
    if (pending) {
      setInput(c);
      inputRef.current?.focus();
      return;
    }
    setInput((cur) => {
      if (!cur.trim()) return c;
      return cur.endsWith(" ") ? cur + c : cur + " " + c;
    });
    inputRef.current?.focus();
  }

  const label = (i: number) => {
    const s = state.shells[i];
    const f = topFrame(s);
    const first = s.frames[0];
    if (first.via === "console") return "provider console";
    return `${i + 1}: ${f.user}@${state.world.hosts[f.host].hostname}`;
  };

  return (
    <div className="relative flex flex-col overflow-hidden rounded-xl border border-line bg-[#070707] shadow-[inset_0_0_60px_rgba(0,0,0,0.6)]">
      {/* tabs */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-line bg-panel/80 px-2 py-1.5 scroll-thin">
        <span className="mr-1 flex gap-1">
          <span className="h-2.5 w-2.5 rounded-full bg-line2" />
          <span className="h-2.5 w-2.5 rounded-full bg-line2" />
          <span className="h-2.5 w-2.5 rounded-full bg-line2" />
        </span>
        {state.shells.map((_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => usePlay.getState().setActive(i)}
            title={i < 9 ? `Alt+${i + 1}` : undefined}
            aria-pressed={i === active}
            className={`shrink-0 rounded-md px-2 py-0.5 font-mono text-[12px] transition ${
              i === active ? "bg-panel2 text-ink" : "text-muted hover:text-ink"
            }`}
          >
            {label(i)}
          </button>
        ))}
        <button
          type="button"
          title="New window on your laptop (Alt+N)"
          onClick={newWindow}
          className="shrink-0 rounded-md px-2 py-0.5 font-mono text-[12px] text-muted hover:bg-panel2 hover:text-ink"
        >
          + window
          <span aria-hidden className="ml-1.5 hidden text-[11px] opacity-60 md:inline">
            Alt N
          </span>
        </button>
        {allowConsole && !hasConsole && (
          <button
            type="button"
            title="Your provider's web console: a root shell that works without SSH (Alt+P)"
            onClick={openConsole}
            className="ml-auto shrink-0 rounded-md border border-line2 px-2 py-0.5 font-mono text-[11px] text-ink hover:border-ink"
          >
            open provider console
            <span aria-hidden className="ml-1.5 hidden opacity-60 md:inline">
              Alt P
            </span>
          </button>
        )}
      </div>

      {/* output */}
      <div
        ref={scrollRef}
        onClick={() => {
          if (!window.getSelection()?.toString()) inputRef.current?.focus();
        }}
        className={`${height} overflow-y-auto px-4 py-3 font-mono text-[13px] leading-[1.5] scroll-thin`}
      >
        {myLines.map((l) => (
          <pre key={l.id} className={`whitespace-pre-wrap break-words ${kindClass[l.kind] ?? ""}`}>
            {l.kind === "info" ? "» " : ""}
            {l.text}
          </pre>
        ))}
        <div className="flex items-start">
          <pre className="whitespace-pre-wrap break-all text-muted">{prompt}</pre>
          <div className="relative min-w-[2ch] flex-1">
            <input
              ref={inputRef}
              value={input}
              disabled={disabled}
              onChange={(e) => {
                setInput(e.target.value);
                setOptions([]);
              }}
              onKeyDown={onKey}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              data-terminal-input
              type={pending?.secret ? "password" : "text"}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Terminal input"
              className={`w-full bg-transparent font-mono text-[13px] text-ink caret-ink outline-none focus-visible:outline-none ${pending?.secret ? "text-transparent" : ""}`}
            />
            {pending?.secret && <span className="pointer-events-none absolute left-0 top-0 text-faint">{input ? "(hidden)" : ""}</span>}
          </div>
        </div>
        {options.length > 0 && <pre className="mt-1 whitespace-pre-wrap text-muted">{options.join("   ")}</pre>}
      </div>

      {/* chips + run (mobile friendly) */}
      <div className="flex items-center gap-1.5 overflow-x-auto border-t border-line bg-panel/60 px-2 py-1.5 scroll-thin">
        {chips.map((c, i) => (
          <button
            key={c}
            type="button"
            onClick={() => tapChip(c)}
            className={`shrink-0 rounded-md border bg-panel2 px-2.5 py-1 font-mono text-[12px] text-ink/90 hover:border-ink ${
              i === chipIdx.current % chips.length ? "border-ink/60" : "border-line2"
            }`}
          >
            {c}
          </button>
        ))}
        <span aria-hidden className="ml-auto hidden shrink-0 pl-2 font-mono text-[11px] text-faint md:inline">
          {disabled || editor ? "" : !focused ? "Press T to type here" : chips.length ? "Ctrl Space adds the next one" : guide?.length && !input ? "Tab fills in the command" : ""}
        </span>
        <button
          type="button"
          onClick={() => {
            const c = usePlay.getState().complete(input);
            setInput(c.line);
            setOptions(c.options.length > 1 ? c.options.slice(0, 30) : []);
            inputRef.current?.focus();
          }}
          className="ml-auto shrink-0 rounded-md border border-line2 px-2 py-1 font-mono text-[11px] text-muted md:hidden"
        >
          Tab
        </button>
        <button
          type="button"
          onClick={() => submit(input)}
          className="shrink-0 rounded-md bg-ink px-3 py-1 font-mono text-[12px] font-bold text-bg md:hidden"
        >
          Run ↵
        </button>
      </div>

      {editor && <NanoEditor />}
    </div>
  );
}
