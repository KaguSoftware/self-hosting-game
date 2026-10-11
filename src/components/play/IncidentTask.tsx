"use client";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { produce } from "immer";
import type { Incident } from "@/content/schema";
import { replay } from "@/content";
import { CONSOLE_FRAME, goalCtx, goalsMet } from "@/engine/play";
import { defaultVars, shellsFor } from "@/engine/replay";
import { incidentScore } from "@/engine/rules";
import { traceHttp } from "@/sim/net";
import { sshCheck } from "@/sim/sshAuth";
import { usePlay } from "@/store/play";
import { useProgress } from "@/store/progress";
import { useUi } from "@/store/ui";
import { sfx } from "@/lib/sfx";
import Terminal from "../terminal/Terminal";
import { Btn, GoalList, HintBar, type TaskCallbacks } from "./common";

export function incidentStartState(inc: Incident, vars: Record<string, string>) {
  const lvl = replay.levelById(inc.after)!;
  const world = produce(replay.levelEndWorld(lvl, vars), inc.breakIt);
  return { world, shells: shellsFor(inc.start) };
}

export default function IncidentTask({ incident, cb, done }: { incident: Incident; cb: TaskCallbacks; done: boolean }) {
  const vars = useProgress((s) => s.vars);
  const { state, log, tick } = usePlay();
  const busy = usePlay((s) => s.busy);
  const [phase, setPhase] = useState<"call" | "live" | "fixed">("call");
  const [elapsed, setElapsed] = useState(0);
  const [failures, setFailures] = useState(0);
  const [hintsUsed, setHintsUsed] = useState(0);
  const [usedShowMe, setUsedShowMe] = useState(false);
  const [result, setResult] = useState<{ score: number; seconds: number; commands: number } | null>(null);
  const started = useRef(0);

  useEffect(() => {
    usePlay.getState().load(incidentStartState(incident, vars), vars, "Pager went off. You are on your laptop.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incident.id]);

  useEffect(() => {
    if (phase !== "live") return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started.current) / 1000)), 500);
    const a = setInterval(() => sfx.alarm(), 12000);
    return () => {
      clearInterval(t);
      clearInterval(a);
    };
  }, [phase]);

  const met = useMemo(() => goalsMet(incident.goals, goalCtx(state, log)), [incident.goals, state, log, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const allMet = met.every(Boolean);

  useEffect(() => {
    if (phase !== "live" || !allMet) return;
    const seconds = Math.max(1, Math.floor((Date.now() - started.current) / 1000));
    const commands = log.filter((l) => l.line !== "(answer)").length;
    const score = incidentScore({ seconds, limit: incident.timeLimit, commands, hints: hintsUsed, showMe: usedShowMe });
    setResult({ score, seconds, commands });
    setPhase("fixed");
    useProgress.getState().incident(incident.id, score, seconds, commands);
    if (incident.url) usePlay.getState().showTrace(traceHttp(state.world, incident.url));
    else if (incident.sshUser) usePlay.getState().showTrace(sshCheck(state.world, "you", incident.sshUser, state.world.hosts.vps.publicIp ?? "").trace);
    sfx.fanfare();
    useUi.getState().fireConfetti();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allMet, phase]);

  const uptime = Math.max(0, 100 - (elapsed / incident.timeLimit) * 100);

  async function showMe() {
    setUsedShowMe(true);
    const play = usePlay.getState();
    play.setBusy(true);
    const idx = incident.fixShell ?? 0;
    if (incident.console && !play.state.shells.some((s) => s.frames[0].via === "console")) {
      play.addWindow(CONSOLE_FRAME, "Provider web console. You are root on web-1, connected through the provider, not SSH.");
    }
    const target = incident.console ? usePlay.getState().state.shells.findIndex((s) => s.frames[0].via === "console") : idx;
    usePlay.getState().setActive(target);
    const v = defaultVars(vars);
    for (const raw of incident.fix) {
      await new Promise((r) => setTimeout(r, 700));
      usePlay.getState().run(raw.replace(/\{\{(\w+)\}\}/g, (_, k) => v[k] ?? ""));
    }
    usePlay.getState().setBusy(false);
  }

  if (phase === "call") {
    return (
      <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} className="alarm space-y-4 rounded-xl border border-red/60 bg-reddim/20 p-5">
        <div className="flex items-center gap-3">
          <span className="relative flex h-3 w-3">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red opacity-75" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-red" />
          </span>
          <span className="font-display text-3xl tracking-wide text-red">INCIDENT</span>
          <span className="font-mono text-[12px] text-red/80">{incident.title}</span>
        </div>
        <div className="rounded-lg border border-line bg-bg/70 p-3">
          <div className="mb-1 font-mono text-[11px] text-muted">{incident.client.name}</div>
          <p className="text-[15px] leading-snug">{incident.client.message}</p>
        </div>
        <p className="font-mono text-[12px] text-muted">
          Uptime drains while you work. Fewer test commands and a faster fix score higher. You have about {Math.round(incident.timeLimit / 60)} minutes.
        </p>
        <Btn
          kind="danger"
          onClick={() => {
            sfx.alarm();
            useUi.getState().doShake();
            started.current = Date.now();
            setPhase("live");
          }}
        >
          Take the call
        </Btn>
      </motion.div>
    );
  }

  return (
    <div className="space-y-3">
      <div className={`rounded-xl border p-3 ${phase === "fixed" ? "border-teal/60 bg-teal/[0.05]" : "alarm border-red/60 bg-reddim/10"}`}>
        <div className="flex flex-wrap items-center gap-3">
          <span className={`font-display text-2xl ${phase === "fixed" ? "text-teal glow-teal" : "text-red"}`}>{phase === "fixed" ? "RESOLVED" : "OUTAGE"}</span>
          <div className="min-w-40 flex-1">
            <div className="mb-0.5 flex justify-between font-mono text-[10px] uppercase tracking-widest text-muted">
              <span>uptime</span>
              <span>{uptime.toFixed(1)}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-line">
              <motion.div className={`h-full ${uptime > 50 ? "bg-amber" : uptime > 20 ? "bg-yellow" : "bg-red"}`} animate={{ width: `${uptime}%` }} />
            </div>
          </div>
          <span className="font-display text-2xl text-ink">
            {String(Math.floor(elapsed / 60)).padStart(2, "0")}:{String(elapsed % 60).padStart(2, "0")}
          </span>
        </div>
        <p className="mt-2 text-[13px] text-ink/80">
          <span className="font-mono text-[11px] text-muted">{incident.client.name}: </span>
          {incident.client.message}
        </p>
        <div className="mt-2">
          <GoalList goals={incident.goals} met={met} />
        </div>
      </div>

      <Terminal
        stepId={`incident:${incident.id}`}
        allowConsole={incident.console}
        disabled={phase === "fixed" || busy}
        onCommand={(r) => {
          if (r.isErrorish) setFailures((f) => f + 1);
        }}
      />

      {phase === "live" && (
        <HintBar hints={incident.hints} failures={failures} onHint={() => setHintsUsed((h) => h + 1)} onShowMe={() => void showMe()} showMeLabel="Fix it for me" />
      )}

      <AnimatePresence>
        {phase === "fixed" && result && (
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="space-y-3 rounded-xl border border-line2 bg-panel p-4">
            <div className="flex flex-wrap items-end gap-6">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-widest text-muted">score</div>
                <div className="font-display text-5xl text-amber glow">{result.score}</div>
              </div>
              <div className="font-mono text-[12px] text-muted">
                <div>
                  time <span className="text-ink">{result.seconds}s</span>
                </div>
                <div>
                  commands <span className="text-ink">{result.commands}</span>
                </div>
              </div>
            </div>
            <div>
              <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-muted">Fastest diagnostic path</div>
              <ol className="space-y-0.5">
                {incident.fastestPath.map((p, i) => (
                  <li key={p} className="font-mono text-[12px] text-ink/90">
                    <span className="text-amber">{i + 1}.</span> {p}
                  </li>
                ))}
              </ol>
            </div>
            <ul className="space-y-1">
              {incident.debrief.map((d) => (
                <li key={d} className="text-[13.5px] text-ink/90">
                  <span className="text-muted">›</span> {d}
                </li>
              ))}
            </ul>
            {!done && (
              <Btn
                kind="teal"
                onClick={() =>
                  cb.onDone({
                    mistakes: failures,
                    usedHints: hintsUsed > 0,
                    usedShowMe,
                    missed: [],
                    bonusXp: Math.round(result.score / 10),
                    why: `Incident closed. Score ${result.score}.`,
                  })
                }
              >
                Close the incident
              </Btn>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
