"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Step, Task } from "@/content/schema";
import { goalCtx, goalsMet } from "@/engine/play";
import { defaultVars, type PlayState } from "@/engine/replay";
import { traceHttp } from "@/sim/net";
import { usePlay } from "@/store/play";
import Terminal from "../terminal/Terminal";
import FlagNotes from "./FlagNotes";
import { flagsIn, flagsInProse } from "@/content/flags";
import { GoalList, HintBar, type TaskCallbacks } from "./common";

type T = Extract<Task, { kind: "terminal" }>;

export default function TerminalTask({
  step,
  task,
  cb,
  stepStart,
  done,
  allowConsole,
  beginner,
}: {
  step: Step;
  task: T;
  cb: TaskCallbacks;
  stepStart: () => PlayState;
  done: boolean;
  allowConsole?: boolean;
  beginner?: boolean;
}) {
  const { state, log, tick, busy } = usePlay();
  const [failures, setFailures] = useState(0);
  const [usedHints, setUsedHints] = useState(false);
  const [usedShowMe, setUsedShowMe] = useState(false);
  const idle = useRef(0);
  const fired = useRef(false);
  const lastCount = useRef(0);

  // Flags the intel card already explains are not repeated under "Type this".
  const intelFlags = useMemo(() => new Set((step.intel?.lines ?? []).flatMap(flagsInProse).map((n) => n.key)), [step.intel]);
  const met = useMemo(() => goalsMet(task.goals, goalCtx(state, log)), [task.goals, state, log, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const count = met.filter(Boolean).length;

  useEffect(() => {
    if (count > lastCount.current) {
      idle.current = 0;
      if (count < task.goals.length) cb.onCorrect();
    }
    lastCount.current = count;
    if (count === task.goals.length && !fired.current && !done) {
      fired.current = true;
      if (task.url) usePlay.getState().showTrace(traceHttp(usePlay.getState().state.world, task.url));
      setTimeout(() => {
        cb.onDone({
          mistakes: failures,
          usedHints,
          usedShowMe,
          missed: failures > 1 && step.review ? [step.review.id] : [],
        });
      }, 650);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count]);

  async function showMe() {
    setUsedShowMe(true);
    const play = usePlay.getState();
    play.setBusy(true);
    play.setState(stepStart(), "Rewinding to the start of this step. Watch:");
    play.resetLog();
    const idx = task.showMeShell ?? 0;
    while (usePlay.getState().state.shells.length <= idx) usePlay.getState().addWindow(undefined, "New window on your laptop.");
    usePlay.getState().setActive(idx);
    const vars = defaultVars(play.vars);
    for (const raw of task.showMe) {
      await new Promise((r) => setTimeout(r, 700));
      const line = raw.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
      usePlay.getState().run(line);
    }
    usePlay.getState().setBusy(false);
  }

  return (
    <div className="space-y-3">
      <div className={`grid gap-3 ${task.guide && !done ? "sm:grid-cols-2" : ""}`}>
        <div className="rounded-xl border border-line bg-panel px-4 py-3">
          <div className="mb-2 text-[12px] text-muted">Goal</div>
          <GoalList goals={task.goals} met={met} />
        </div>
        {task.guide && !done && (
          <div className="rounded-xl border border-line2 bg-panel2/60 px-4 py-3">
            <div className="mb-2 text-[12px] text-muted">Type this and press Enter, or tap it</div>
            <div className="flex flex-wrap gap-2">
              {task.guide.map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => usePlay.getState().typeIn(g)}
                  className="rounded-md border border-ink/40 bg-bg px-2.5 py-1 font-mono text-[14px] text-ink hover:border-ink"
                  title="Tap to type it in"
                >
                  {g}
                </button>
              ))}
            </div>
            <FlagNotes notes={task.guide.flatMap(flagsIn).filter((n) => !intelFlags.has(n.key))} where={step.id} className="mt-2.5" />
          </div>
        )}
      </div>
      <Terminal
        stepId={step.id}
        chips={task.chips}
        allowConsole={allowConsole || task.console}
        disabled={done || busy}
        onCommand={(r) => {
          if (done) return;
          // Some steps WANT an error (see the timeout, see Permission denied). If the command
          // moved a goal forward, it is progress, not a mistake.
          const now = usePlay.getState();
          const progressed = goalsMet(task.goals, goalCtx(now.state, now.log)).filter(Boolean).length > lastCount.current;
          if (r.isErrorish && !progressed) {
            setFailures((f) => f + 1);
            cb.onMistake();
          } else {
            idle.current += 1;
            if (idle.current >= 4) {
              idle.current = 0;
              setFailures((f) => f + 1);
            }
          }
        }}
      />
      {!done && (
        <HintBar
          hints={task.hints}
          threshold={beginner ? 1 : 2}
          failures={failures}
          onHint={() => setUsedHints(true)}
          onShowMe={() => void showMe()}
        />
      )}
    </div>
  );
}
