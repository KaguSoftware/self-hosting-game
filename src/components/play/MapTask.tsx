"use client";
import { motion } from "motion/react";
import { useMemo, useRef, useState } from "react";
import type { Step, Task } from "@/content/schema";
import { goalCtx, goalsMet } from "@/engine/play";
import { applyMapAction, applyMapActions, isActionActive } from "@/sim/map";
import { traceHttp } from "@/sim/net";
import type { Hop, TraceResult } from "@/sim/types";
import { usePlay } from "@/store/play";
import { sfx } from "@/lib/sfx";
import ServerMap from "../map/ServerMap";
import { GoalList, HintBar, type TaskCallbacks } from "./common";

type T = Extract<Task, { kind: "map" }>;

const URL = "https://crumb.shop";

export default function MapTask({ step, task, cb, done }: { step: Step; task: T; cb: TaskCallbacks; done: boolean }) {
  const world = usePlay((s) => s.state.world);
  const trace = usePlay((s) => s.trace);
  const traceKey = usePlay((s) => s.traceKey);
  const [failures, setFailures] = useState(0);
  const [usedHints, setUsedHints] = useState(false);
  const [flash, setFlash] = useState<{ id: string; kind: "good" | "bad"; key: number } | null>(null);
  const flashKey = useRef(0);

  // route
  const [routeIdx, setRouteIdx] = useState(0);
  // match
  const [chip, setChip] = useState<number | null>(null);
  const [placed, setPlaced] = useState<Record<number, boolean>>({});
  const [usedShowMe, setUsedShowMe] = useState(false);

  const fire = (id: string, kind: "good" | "bad") => {
    flashKey.current += 1;
    setFlash({ id, kind, key: flashKey.current });
  };

  const fail = (id: string) => {
    fire(id, "bad");
    setFailures((f) => f + 1);
    cb.onMistake();
  };

  const finish = (extra: { usedShowMe?: boolean } = {}) =>
    setTimeout(
      () =>
        cb.onDone({
          mistakes: failures,
          usedHints,
          usedShowMe: extra.usedShowMe ?? usedShowMe,
          missed: failures > 1 && step.review ? [step.review.id] : [],
        }),
      task.mode === "route" ? 1200 : 700,
    );

  function partialTrace(nodes: string[]): TraceResult {
    const hops: Hop[] = nodes.map((n) => ({ id: "browser", label: n, ok: true, note: "", node: n }));
    return { kind: "http", target: URL, hops, ok: true, status: 200 };
  }

  function tapNode(id: string) {
    if (done) return;
    if (task.mode === "route") {
      const want = task.path[routeIdx];
      if (id === want) {
        sfx.tap();
        fire(id, "good");
        cb.onCorrect();
        const next = routeIdx + 1;
        setRouteIdx(next);
        if (next === task.path.length) {
          usePlay.getState().showTrace(traceHttp(world, URL));
          finish();
        } else if (next > 1) {
          usePlay.getState().showTrace(partialTrace(task.path.slice(next - 2, next)));
        }
      } else if (!task.path.slice(0, routeIdx).includes(id)) fail(id);
      return;
    }
    if (task.mode === "match") {
      if (chip === null) {
        sfx.tap();
        return;
      }
      if (task.pairs[chip].node === id) {
        sfx.tap();
        fire(id, "good");
        cb.onCorrect();
        const next = { ...placed, [chip]: true };
        setPlaced(next);
        setChip(null);
        if (Object.keys(next).length === task.pairs.length) finish();
      } else fail(id);
    }
  }

  // toggle
  const goalsOk = useMemo(() => (task.mode === "toggle" ? goalsMet(task.goals, goalCtx({ world, shells: [] }, [])) : []), [task, world]);
  const toggles =
    task.mode === "toggle"
      ? task.controls.map((c) => ({ node: c.node, label: c.label, on: isActionActive(world, c.on) }))
      : undefined;

  function toggle(node: string, label: string) {
    if (task.mode !== "toggle" || done) return;
    const c = task.controls.find((x) => x.node === node && x.label === label);
    if (!c) return;
    sfx.tap();
    const next = applyMapAction(world, isActionActive(world, c.on) ? c.off : c.on);
    usePlay.getState().setWorld(next);
    usePlay.getState().showTrace(traceHttp(next, task.url ?? URL));
    const ok = goalsMet(task.goals, goalCtx({ world: next, shells: [] }, []));
    if (ok.every(Boolean)) {
      cb.onCorrect();
      finish();
    } else {
      setFailures((f) => f + 1);
    }
  }

  function showMe() {
    setUsedShowMe(true);
    if (task.mode === "toggle") {
      const next = applyMapActions(world, task.showMe);
      usePlay.getState().setWorld(next);
      usePlay.getState().showTrace(traceHttp(next, task.url ?? URL));
      finish({ usedShowMe: true });
    } else if (task.mode === "route") {
      setRouteIdx(task.path.length);
      usePlay.getState().showTrace(traceHttp(world, URL));
      finish({ usedShowMe: true });
    } else {
      const all: Record<number, boolean> = {};
      task.pairs.forEach((_, i) => (all[i] = true));
      setPlaced(all);
      finish({ usedShowMe: true });
    }
  }

  const tags: Record<string, string[]> = {};
  if (task.mode === "match") {
    task.pairs.forEach((p, i) => {
      if (placed[i]) (tags[p.node] ??= []).push(p.chip);
    });
  }
  if (task.mode === "route") {
    task.path.slice(0, routeIdx).forEach((n, i) => (tags[n] = [`${i + 1}`]));
  }

  return (
    <div className="space-y-3">
      <p className="text-[14px] text-muted">{task.prompt}</p>
      {task.mode === "match" && (
        <div className="flex flex-wrap gap-1.5">
          {task.pairs.map((p, i) =>
            placed[i] ? null : (
              <motion.button
                key={p.chip}
                layout
                type="button"
                onClick={() => {
                  sfx.tap();
                  setChip(chip === i ? null : i);
                }}
                className={`rounded-md border px-3 py-1.5 text-[13.5px] transition ${
                  chip === i ? "border-ink bg-ink text-bg" : "border-line2 bg-panel2 text-ink hover:border-ink"
                }`}
              >
                {p.chip}
              </motion.button>
            ),
          )}
        </div>
      )}
      {task.mode === "toggle" && <GoalList goals={task.goals} met={goalsOk} />}
      <ServerMap
        world={world}
        trace={trace}
        traceKey={traceKey}
        interactive={task.mode !== "toggle" && !done}
        onNodeTap={tapNode}
        flash={flash}
        tags={tags}
        toggles={toggles}
        onToggle={toggle}
      />
      {!done && <HintBar hints={task.hints} failures={failures} onHint={() => setUsedHints(true)} onShowMe={showMe} />}
    </div>
  );
}
