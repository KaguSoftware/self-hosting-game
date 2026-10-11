"use client";
import { useEffect, useRef, useState } from "react";
import { promptText, topFrame } from "@/sim/shell/run";
import { usePlay } from "@/store/play";
import { sfx } from "@/lib/sfx";
import { CONSOLE_FRAME } from "@/engine/play";
import NanoEditor from "./NanoEditor";

export interface TerminalProps {
  chips?: string[];
  allowConsole?: boolean;
  onCommand?: (r: { code: number; isErrorish: boolean; line: string }) => void;
  disabled?: boolean;
  height?: string;
}

const kindClass: Record<string, string> = {
  out: "text-ink/90",
  err: "text-red/90",
  info: "text-teal",
  cmd: "text-amber",
  sys: "text-teal/80 italic",
};

export default function Terminal({ chips = [], allowConsole, onCommand, disabled, height = "h-[46vh] md:h-[52vh]" }: TerminalProps) {
  const { state, active, lines, editor } = usePlay();
  const run = usePlay((s) => s.run);
  const [input, setInput] = useState("");
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

  if (!sh) return null;

  function submit(text: string) {
    if (disabled) return;
    sfx.enter();
    setOptions([]);
    setHistIdx(null);
    const r = run(text);
    setInput("");
    if (r) onCommand?.({ ...r, line: text });
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      submit(input);
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      if (pending) return;
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
          <span className="h-2.5 w-2.5 rounded-full bg-red/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-yellow/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-teal/70" />
        </span>
        {state.shells.map((_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => usePlay.getState().setActive(i)}
            className={`shrink-0 rounded-md px-2 py-0.5 font-mono text-[11px] transition ${
              i === active ? "bg-amber/15 text-amber" : "text-muted hover:text-ink"
            }`}
          >
            {label(i)}
          </button>
        ))}
        <button
          type="button"
          title="New window (your laptop)"
          onClick={() => {
            sfx.tap();
            usePlay.getState().addWindow(undefined, "New window on your laptop.");
          }}
          className="shrink-0 rounded-md px-2 py-0.5 font-mono text-[12px] text-muted hover:bg-panel2 hover:text-amber"
        >
          + window
        </button>
        {allowConsole && !hasConsole && (
          <button
            type="button"
            title="Your provider's web console: a root shell that works without SSH"
            onClick={() => {
              sfx.whoosh();
              usePlay
                .getState()
                .addWindow(CONSOLE_FRAME, "Provider web console. You are root on web-1, connected through the provider, not SSH.");
            }}
            className="ml-auto shrink-0 rounded-md border border-teal/50 px-2 py-0.5 font-mono text-[11px] text-teal hover:bg-teal/10"
          >
            open provider console
          </button>
        )}
      </div>

      {/* output */}
      <div
        ref={scrollRef}
        onClick={() => {
          if (!window.getSelection()?.toString()) inputRef.current?.focus();
        }}
        className={`${height} overflow-y-auto px-3 py-2 font-mono text-[12.5px] leading-[1.45] scroll-thin md:text-[13px]`}
      >
        {myLines.map((l) => (
          <pre key={l.id} className={`whitespace-pre-wrap break-words ${kindClass[l.kind] ?? ""}`}>
            {l.kind === "info" ? "» " : ""}
            {l.text}
          </pre>
        ))}
        <div className="flex items-start">
          <pre className="whitespace-pre-wrap break-all text-amber">{prompt}</pre>
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
              type={pending?.secret ? "password" : "text"}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Terminal input"
              className={`w-full bg-transparent font-mono focus-visible:outline-none text-[12.5px] text-ink caret-amber outline-none md:text-[13px] ${pending?.secret ? "text-transparent" : ""}`}
            />
            {pending?.secret && <span className="pointer-events-none absolute left-0 top-0 text-faint">{input ? "(hidden)" : ""}</span>}
          </div>
        </div>
        {options.length > 0 && <pre className="mt-1 whitespace-pre-wrap text-muted">{options.join("   ")}</pre>}
      </div>

      {/* chips + run (mobile friendly) */}
      <div className="flex items-center gap-1.5 overflow-x-auto border-t border-line bg-panel/60 px-2 py-1.5 scroll-thin">
        {chips.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => tapChip(c)}
            className="shrink-0 rounded-md border border-line2 bg-panel2 px-2 py-1 font-mono text-[11px] text-ink/90 hover:border-amber hover:text-amber"
          >
            {c}
          </button>
        ))}
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
          className="shrink-0 rounded-md bg-amber px-3 py-1 font-mono text-[11px] font-bold text-bg md:hidden"
        >
          Run ↵
        </button>
      </div>

      {editor && <NanoEditor />}
    </div>
  );
}
