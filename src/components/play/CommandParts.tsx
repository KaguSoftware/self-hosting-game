"use client";
import { useEffect, useMemo, useState } from "react";
import { explainLine } from "@/content/explain";
import { flagsIn } from "@/content/flags";
import { useProgress } from "@/store/progress";

/**
 * Every part of each command, explained: "sudo = run as root", "-R = recursive",
 * "deploy:deploy = owner:group". Shown under "Type this" so nothing is magic.
 */
export default function CommandParts({ lines, where, className = "" }: { lines: string[]; where: string; className?: string }) {
  const [open, setOpen] = useState(true);
  const hydrated = useProgress((s) => s.hydrated);
  const explained = useMemo(() => lines.map((l) => ({ line: l, parts: explainLine(l).filter((p) => p.means) })), [lines]);

  // These notes explain the flags too, so count them as seen (the terminal then stops repeating them).
  useEffect(() => {
    if (!hydrated) return;
    const keys = lines.flatMap(flagsIn).map((n) => n.key);
    if (keys.length) useProgress.getState().sawFlags(keys, where);
  }, [hydrated, lines, where]);

  if (!explained.some((e) => e.parts.length)) return null;
  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="font-mono text-[11px] uppercase tracking-widest text-muted hover:text-ink"
      >
        {open ? "▾" : "▸"} What each part means
      </button>
      {open && (
        <div className="mt-2 space-y-3">
          {explained.map(({ line, parts }) =>
            !parts.length ? null : (
              <div key={line}>
                {explained.length > 1 && <div className="mb-1 font-mono text-[12px] text-faint">{line}</div>}
                <ul className="space-y-1" aria-label={`What each part of ${line} means`}>
                  {parts.map((p, i) => (
                    <li key={`${i}:${p.text}`} className="flex gap-2.5 text-[13px] leading-snug text-ink/85">
                      <code className="shrink-0 whitespace-nowrap rounded bg-bg px-1.5 py-px font-mono text-[12px] text-ink">{p.text}</code>
                      <span>{p.means}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
