"use client";
import Link from "next/link";
import { motion } from "motion/react";
import { dayKey, dueCards, levelFromXp, liveStreak, rankFor } from "@/engine/rules";
import { useProgress } from "@/store/progress";
import { useUi } from "@/store/ui";
import { useCloud } from "@/store/cloud";

export default function TopBar() {
  const p = useProgress();
  const cloud = useCloud();
  const { level, into, need } = levelFromXp(p.xp);
  const streak = liveStreak(p.streak, dayKey());
  const due = dueCards(p.review, dayKey()).length;
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2">
        <Link href="/" className="font-display text-[17px] leading-none text-ink">
          self-hosting<span className="text-muted">_</span>
        </Link>
        <div className="ml-auto flex items-center gap-1.5 font-mono text-[12px]">
          {due > 0 && (
            <Link href="/review" className="rounded-md border border-yellow/40 px-2 py-1 text-yellow hover:bg-yellow/10" title="Cards due for review">
              review {due}
            </Link>
          )}
          <span
            title={p.streak.freezes ? `${p.streak.freezes} streak freeze ready` : "Daily streak"}
            className={`rounded-md px-2 py-1 ${streak ? "text-amber" : "text-faint"}`}
          >
            streak {streak}
            {p.streak.freezes ? <span className="ml-1 text-muted">+{p.streak.freezes} freeze</span> : null}
          </span>
          <Link href="/profile" className="group flex items-center gap-2 rounded-md px-2 py-1 hover:bg-panel" title={rankFor(level)}>
            <span className="font-display text-xl leading-none text-teal">L{level}</span>
            <span className="hidden w-24 sm:block">
              <span className="block h-1.5 overflow-hidden rounded-full bg-line">
                <motion.span className="block h-full bg-teal" animate={{ width: `${(into / need) * 100}%` }} />
              </span>
              <span className="block text-[10px] text-muted">{p.xp} XP</span>
            </span>
          </Link>
          <button type="button" onClick={() => useUi.getState().openDict()} className="rounded-md border border-line2 px-2 py-1 text-muted hover:text-amber" title="Dictionary">
            ?
          </button>
          <button
            type="button"
            onClick={() => p.setMuted(!p.settings.muted)}
            className="rounded-md border border-line2 px-2 py-1 text-muted hover:text-amber"
            title={p.settings.muted ? "Sound off" : "Sound on"}
            aria-label={p.settings.muted ? "Turn sound on" : "Turn sound off"}
          >
            {p.settings.muted ? "♪̸" : "♪"}
          </button>
          {cloud.player && (
            <span
              className={`hidden h-2 w-2 rounded-full sm:block ${cloud.status === "ok" ? "bg-teal" : cloud.status === "syncing" ? "animate-pulse bg-amber" : cloud.status === "off" ? "bg-line2" : "bg-red"}`}
              title={`Cloud save: ${cloud.status}${cloud.message ? `. ${cloud.message}` : ""}`}
            />
          )}
        </div>
      </div>
    </header>
  );
}
