"use client";
import { useEffect, useMemo } from "react";
import type { FlagNote } from "@/content/flags";
import { useProgress } from "@/store/progress";

/** How many times a flag gets explained in place before the game trusts you know it. */
export const FLAG_SHOWINGS = 3;

/**
 * Explains the flags in some commands ("-h = human-friendly sizes") the first
 * few times the player sees them. `where` identifies this showing (a step id),
 * so re-renders of the same step do not use up a showing.
 */
export default function FlagNotes({ notes, where, className = "" }: { notes: FlagNote[]; where: string; className?: string }) {
  const seen = useProgress((s) => s.flagSeen);
  const hydrated = useProgress((s) => s.hydrated);

  const show = useMemo(() => {
    const out: FlagNote[] = [];
    const keys = new Set<string>();
    for (const n of notes) {
      if (!n.parts.length || keys.has(n.key)) continue;
      const list = seen[n.key] ?? [];
      if (list.length < FLAG_SHOWINGS || list.includes(where)) {
        out.push(n);
        keys.add(n.key);
      }
    }
    return out;
    // Decide once per showing: do not hide a note the moment it gets recorded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes.map((n) => n.key).join(), where, hydrated]);

  useEffect(() => {
    if (hydrated && show.length) useProgress.getState().sawFlags(show.map((n) => n.key), where);
  }, [hydrated, show, where]);

  if (!show.length) return null;
  return (
    <ul className={`space-y-1 ${className}`} aria-label="What the flags mean">
      {show.flatMap((n) =>
        // "ls -la" is shown as two rows: ls -l, ls -a
        n.parts.map((p) => (
          <li key={`${n.key}:${p.flag}`} className="flex gap-2.5 text-[13px] leading-snug text-ink/80">
            <code className="shrink-0 whitespace-nowrap rounded bg-bg px-1.5 py-px font-mono text-[12px] text-ink">
              {n.cmd} {p.flag}
            </code>
            <span>{p.means}</span>
          </li>
        )),
      )}
    </ul>
  );
}
