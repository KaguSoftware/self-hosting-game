"use client";
import { useMemo, useState } from "react";
import type { Step, Task } from "@/content/schema";
import { goalCtx, goalsMet } from "@/engine/play";
import { applyMapAction, isActionActive } from "@/sim/map";
import { usePlay } from "@/store/play";
import { sfx } from "@/lib/sfx";
import Terminal from "../terminal/Terminal";
import { Btn, type TaskCallbacks } from "./common";

type T = Extract<Task, { kind: "mission" }>;

/**
 * One long task with no guides and no hints: build the whole thing, then finish.
 * Core areas must all pass; every other check that passes is a star.
 */
export default function MissionTask({ step, task, cb, done }: { step: Step; task: T; cb: TaskCallbacks; done: boolean }) {
  const { state, log, tick, busy } = usePlay();
  const [finished, setFinished] = useState(false);
  const met = useMemo(() => goalsMet(task.goals, goalCtx(state, log)), [task.goals, state, log, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const areas = useMemo(() => {
    const out: { name: string; core: boolean; items: { describe: string; ok: boolean }[] }[] = [];
    task.goals.forEach((g, i) => {
      let a = out.find((x) => x.name === g.area);
      if (!a) out.push((a = { name: g.area, core: !!g.core, items: [] }));
      a.core = a.core || !!g.core;
      a.items.push({ describe: g.describe, ok: met[i] });
    });
    return out;
  }, [task.goals, met]);

  const coreOk = task.goals.every((g, i) => !g.core || met[i]);
  const extras = task.goals.filter((g) => !g.core);
  const extrasOk = extras.filter((g) => met[task.goals.indexOf(g)]).length;

  function finish() {
    if (!coreOk || finished || done) return;
    setFinished(true);
    sfx.fanfare();
    cb.onDone({
      mistakes: extras.length - extrasOk,
      usedHints: false,
      usedShowMe: false,
      missed: [],
      bonusXp: extrasOk * 20,
      why: `Mission complete. ${extrasOk} of ${extras.length} extra checks passed${extrasOk === extras.length ? ": a perfect server." : ". Replay to get them all."}`,
    });
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-line2 bg-panel p-4">
        <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted">The brief</div>
        <ul className="space-y-1">
          {task.brief.map((b) => (
            <li key={b} className="text-[14px] text-ink/90">
              <span className="text-muted">›</span> {b}
            </li>
          ))}
        </ul>
        <p className="mt-2 font-mono text-[11.5px] text-muted">No guides, no hints, no show me. Everything you need, you have learned.</p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {areas.map((a) => {
          const ok = a.items.every((x) => x.ok);
          return (
            <div key={a.name} className={`rounded-xl border p-3 ${ok ? "border-teal/50 bg-teal/[0.04]" : "border-line bg-panel"}`}>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className={`text-[13.5px] font-semibold ${ok ? "text-teal" : "text-ink"}`}>{a.name}</span>
                {a.core && <span className="font-mono text-[10px] uppercase tracking-widest text-muted">must pass</span>}
              </div>
              <ul className="space-y-0.5">
                {a.items.map((x) => (
                  <li key={x.describe} className={`flex items-start gap-2 text-[12.5px] ${x.ok ? "text-teal" : "text-ink/75"}`}>
                    <span className="mt-px w-3 shrink-0">{x.ok ? "✓" : "·"}</span>
                    <span>{x.describe}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      {task.controls && (
        <div className="rounded-xl border border-line2 bg-panel p-3">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted">Provider dashboard</div>
          <div className="flex flex-wrap gap-1.5">
            {task.controls.map((c) => {
              const on = isActionActive(state.world, c.on);
              return (
                <button
                  key={`${c.node}-${c.label}`}
                  type="button"
                  disabled={done || busy}
                  aria-pressed={on}
                  onClick={() => {
                    sfx.tap();
                    usePlay.getState().setWorld(applyMapAction(state.world, on ? c.off : c.on));
                  }}
                  className={`rounded-md border px-2.5 py-1 font-mono text-[12px] transition disabled:opacity-50 ${
                    on ? "border-ink bg-ink text-bg" : "border-line2 bg-panel2 text-ink hover:border-ink"
                  }`}
                >
                  {c.label}: {on ? "on" : "off"}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <Terminal stepId={step.id} allowConsole={task.console} disabled={done || busy} />

      {!done && (
        <div className="flex flex-wrap items-center gap-3">
          <Btn kind={coreOk ? "teal" : "ghost"} onClick={finish} disabled={!coreOk}>
            Finish mission
          </Btn>
          <span className="font-mono text-[12px] text-muted">
            {coreOk ? `Ready. ${extrasOk} of ${extras.length} extra checks pass.` : "Every must-pass area needs to be green first."}
          </span>
        </div>
      )}
    </div>
  );
}
