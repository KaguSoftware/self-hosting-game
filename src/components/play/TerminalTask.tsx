"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Step, Task } from "@/content/schema";
import { goalCtx, goalsMet } from "@/engine/play";
import { defaultVars, type PlayState } from "@/engine/replay";
import { traceHttp } from "@/sim/net";
import { usePlay } from "@/store/play";
import Terminal from "../terminal/Terminal";
import { GoalList, HintBar, type TaskCallbacks } from "./common";

type T = Extract<Task, { kind: "terminal" }>;

export default function TerminalTask({
  step,
  task,
  cb,
  stepStart,
  done,
  allowConsole,
}: {
  step: Step;
  task: T;
  cb: TaskCallbacks;
  stepStart: () => PlayState;
  done: boolean;
  allowConsole?: boolean;
}) {
  const { state, log, tick, busy } = usePlay();
  const [failures, setFailures] = useState(0);
  const [usedHints, setUsedHints] = useState(false);
  const [usedShowMe, setUsedShowMe] = useState(false);
  const idle = useRef(0);
  const fired = useRef(false);
  const lastCount = useRef(0);

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
      <div className="rounded-lg border border-line bg-panel/60 px-3 py-2">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.25em] text-muted">Goal</div>
        <GoalList goals={task.goals} met={met} />
      </div>
      <Terminal
        chips={task.chips}
        allowConsole={allowConsole || task.console}
        disabled={done || busy}
        onCommand={(r) => {
          if (done) return;
          if (r.isErrorish) {
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
          failures={failures}
          onHint={() => setUsedHints(true)}
          onShowMe={() => void showMe()}
        />
      )}
    </div>
  );
}
