"use client";
import { useRef, useState } from "react";
import TopBar from "@/components/TopBar";
import { Btn } from "@/components/play/common";
import { LEVELS, WORLDS } from "@/content";
import { exportProgress, importProgress } from "@/engine/progress";
import { dayKey, levelFromXp, liveStreak, rankFor } from "@/engine/rules";
import { snapshot, useProgress } from "@/store/progress";
import { useCloud } from "@/store/cloud";
import { useUi } from "@/store/ui";

export default function ProfilePage() {
  const p = useProgress();
  const cloud = useCloud();
  const [name, setName] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { level, into, need } = levelFromXp(p.xp);

  const weakest = Object.entries(p.stats.tags)
    .filter(([, v]) => v.miss > 0)
    .sort((a, b) => b[1].miss / (b[1].miss + b[1].hit) - a[1].miss / (a[1].miss + a[1].hit) || b[1].miss - a[1].miss)
    .slice(0, 5);

  function doExport() {
    const blob = new Blob([exportProgress(snapshot())], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `self-hosting-progress-${dayKey()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function doImport(f: File) {
    const r = importProgress(await f.text());
    if (!r.ok) {
      useUi.getState().toast(r.error, "warn");
      return;
    }
    p.replaceAll(r.progress);
    useUi.getState().toast("Progress imported", "info");
  }

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-3xl space-y-6 px-4 py-8">
        <section className="flex flex-wrap items-end gap-6">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted">rank</div>
            <div className="font-display text-5xl leading-none text-amber glow">{rankFor(level)}</div>
          </div>
          <div className="min-w-48 flex-1">
            <div className="flex justify-between font-mono text-[12px] text-muted">
              <span>Level {level}</span>
              <span>
                {into}/{need} XP
              </span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-line">
              <div className="h-full bg-ink" style={{ width: `${(into / need) * 100}%` }} />
            </div>
          </div>
        </section>

        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["Total XP", p.xp],
            ["Streak", `${liveStreak(p.streak, dayKey())} days`],
            ["Best streak", `${p.streak.best} days`],
            ["Levels", `${Object.keys(p.completed).length}/${LEVELS.length}`],
          ].map(([k, v]) => (
            <div key={String(k)} className="rounded-xl border border-line bg-panel p-3">
              <div className="font-mono text-[10px] uppercase tracking-widest text-muted">{k}</div>
              <div className="font-display text-3xl text-ink">{v}</div>
            </div>
          ))}
        </section>

        <section className="rounded-xl border border-line bg-panel p-4">
          <h2 className="mb-3 font-display text-2xl text-amber">Accuracy per world</h2>
          <div className="space-y-2">
            {WORLDS.map((w) => {
              const s = p.stats.worlds[w.id];
              const pct = s && s.attempts ? Math.round((s.correct / s.attempts) * 100) : null;
              return (
                <div key={w.id} className="grid grid-cols-[1fr_2fr_3rem] items-center gap-3 font-mono text-[12px]">
                  <span className="truncate text-ink/85">
                    {w.title}
                  </span>
                  <div className="h-2 overflow-hidden rounded-full bg-line">
                    <div className={`h-full ${pct === null ? "" : pct >= 80 ? "bg-teal" : pct >= 50 ? "bg-amber" : "bg-red"}`} style={{ width: `${pct ?? 0}%` }} />
                  </div>
                  <span className="text-right text-muted">{pct === null ? "n/a" : `${pct}%`}</span>
                </div>
              );
            })}
          </div>
        </section>

        <section className="rounded-xl border border-line bg-panel p-4">
          <h2 className="mb-2 font-display text-2xl text-amber">Weakest topics</h2>
          {weakest.length ? (
            <ul className="space-y-1">
              {weakest.map(([tag, v]) => (
                <li key={tag} className="flex justify-between font-mono text-[12.5px]">
                  <span className="text-ink/90">{tag}</span>
                  <span className="text-red/90">
                    {v.miss} missed · {v.hit} right
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">No misses yet. Suspicious.</p>
          )}
          <p className="mt-2 text-[12px] text-faint">{p.review.length} cards in your review queue.</p>
        </section>

        <section className="space-y-3 rounded-xl border border-line bg-panel p-4">
          <h2 className="font-display text-2xl text-amber">Cloud save</h2>
          <p className="text-[13px] text-muted">Pick a player name to save progress online and continue on another device. No password: anyone with the name can load it.</p>
          {cloud.player ? (
            <div className="flex flex-wrap items-center gap-3 font-mono text-[13px]">
              <span>
                player <span className="text-ink">{cloud.player}</span> · {cloud.status}
              </span>
              <Btn kind="ghost" onClick={() => void cloud.push()}>
                Save now
              </Btn>
              <Btn kind="ghost" onClick={() => cloud.disconnect()}>
                Disconnect
              </Btn>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="player name"
                className="rounded-lg border border-line2 bg-bg px-3 py-2 font-mono text-[13px] outline-none focus:border-amber"
              />
              <Btn onClick={() => void cloud.connect(name)}>Connect</Btn>
            </div>
          )}
          {cloud.message && <p className="font-mono text-[12px] text-yellow">{cloud.message}</p>}
        </section>

        <section className="space-y-3 rounded-xl border border-line bg-panel p-4">
          <h2 className="font-display text-2xl text-amber">Backup your progress</h2>
          <p className="text-[13px] text-muted">Practice what you preach: 3-2-1.</p>
          <div className="flex flex-wrap gap-2">
            <Btn onClick={doExport}>Export JSON</Btn>
            <Btn kind="ghost" onClick={() => fileRef.current?.click()}>
              Import JSON
            </Btn>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void doImport(f);
                e.target.value = "";
              }}
            />
            {!confirmReset ? (
              <Btn kind="ghost" onClick={() => setConfirmReset(true)} className="ml-auto">
                Reset
              </Btn>
            ) : (
              <Btn
                kind="danger"
                className="ml-auto"
                onClick={() => {
                  p.reset();
                  setConfirmReset(false);
                }}
              >
                Really wipe everything?
              </Btn>
            )}
          </div>
        </section>
      </main>
    </>
  );
}
