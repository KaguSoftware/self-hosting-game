"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { incidentById } from "@/content/incidents";
import { levelById, nextLevel, replay, worldOf, WORLDS } from "@/content";
import type { Level } from "@/content/schema";
import { goalCtx, goalsMet } from "@/engine/play";
import { comboMultiplier, dueCards, dayKey, LEVEL_BONUS, CLEAN_BONUS, levelFromXp, rankFor, stars as starsFor, STEP_XP } from "@/engine/rules";
import { buildContext } from "@/lib/context";
import { sfx } from "@/lib/sfx";
import { usePlay } from "@/store/play";
import { useProgress } from "@/store/progress";
import { useUi } from "@/store/ui";
import ServerMap from "../map/ServerMap";
import { Btn, MissionCard, type TaskCallbacks, type TaskResult } from "./common";
import IncidentTask from "./IncidentTask";
import MapTask from "./MapTask";
import { AllocateTask, ConfigTask, MatchTask, OrderTask, PredictTask, RapidTask, SpotTask } from "./QuizTasks";
import TerminalTask from "./TerminalTask";

interface Summary {
  xp: number;
  stars: 1 | 2 | 3;
  levelUp: number | null;
  worldDone: boolean;
  earnedFreeze: boolean;
}

export default function LevelPlayer({ levelId }: { levelId: string }) {
  const level = levelById(levelId) as Level;
  const world = worldOf(levelId);
  const router = useRouter();
  const hydrated = useProgress((s) => s.hydrated);
  const vars = useProgress((s) => s.vars);
  const [stepIdx, setStepIdx] = useState(0);
  const [result, setResult] = useState<(TaskResult & { xp: number }) | null>(null);
  const [levelXp, setLevelXp] = useState(0);
  const [flags, setFlags] = useState({ hints: false, showMe: false });
  const [summary, setSummary] = useState<Summary | null>(null);
  const [copied, setCopied] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [comboPop, setComboPop] = useState<{ n: number; key: number } | null>(null);
  const [revealPw, setRevealPw] = useState(false);
  const play = usePlay();
  const step = level.steps[stepIdx];

  // Load the canonical start of this level once progress is ready.
  useEffect(() => {
    if (!hydrated) return;
    const start = replay.levelStart(level, vars);
    const intro = level.start === "vps-root" || level.start === "vps-deploy" ? "You are already logged in to web-1." : "Your laptop. Fresh terminal.";
    usePlay.getState().load(start, vars, intro);
    setStepIdx(0);
    setResult(null);
    setSummary(null);
    setLevelXp(0);
    setFlags({ hints: false, showMe: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levelId, hydrated]);

  const stepStart = useCallback(() => replay.stepStart(level, stepIdx, vars), [level, stepIdx, vars]);

  const cb: TaskCallbacks = useMemo(
    () => ({
      onCorrect() {
        const n = usePlay.getState().bumpCombo();
        if (n >= 2) {
          sfx.combo(n);
          setComboPop({ n, key: Date.now() });
        } else sfx.tap();
      },
      onMistake(quizId) {
        usePlay.getState().breakCombo();
        sfx.error();
        if (quizId) useProgress.getState().miss(quizId);
      },
      onDone(r) {
        const prog = useProgress.getState();
        const combo = usePlay.getState().combo;
        const base = r.usedShowMe ? Math.round(STEP_XP / 2) : STEP_XP;
        const xp = Math.round(base * comboMultiplier(combo)) + (r.bonusXp ?? 0);
        prog.addXp(xp);
        prog.attempt(level.world, r.mistakes === 0 && !r.usedShowMe, step.tags);
        for (const id of r.missed) prog.miss(id);
        setLevelXp((x) => x + xp);
        setFlags((f) => ({ hints: f.hints || r.usedHints, showMe: f.showMe || r.usedShowMe }));
        setResult({ ...r, xp });
        sfx.success();
        useUi.getState().toast(`+${xp} XP`, "xp");
        // Remember the deploy password the player chose, so later levels use it.
        const deploy = usePlay.getState().state.world?.hosts.vps.users.deploy;
        if (deploy?.password && deploy.password !== prog.vars.deployPassword) prog.setVar("deployPassword", deploy.password);
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [levelId, stepIdx],
  );

  function next() {
    sfx.whoosh();
    usePlay.getState().setPreview(null);
    usePlay.getState().resetLog();
    if (stepIdx + 1 < level.steps.length) {
      setResult(null);
      setStepIdx(stepIdx + 1);
      return;
    }
    finishLevel();
  }

  function finishLevel() {
    const prog = useProgress.getState();
    const before = levelFromXp(prog.xp).level;
    const st = starsFor(flags.hints, flags.showMe);
    const bonus = LEVEL_BONUS + (st === 3 ? CLEAN_BONUS : 0);
    prog.addXp(bonus);
    const total = levelXp + bonus;
    const { earnedFreeze } = prog.completeLevel(level.id, st, total);
    const after = levelFromXp(useProgress.getState().xp).level;
    const w = WORLDS.find((x) => x.id === level.world)!;
    const completed = useProgress.getState().completed;
    const worldDone = w.levels.every((l) => completed[l.id]);
    setSummary({ xp: total, stars: st, levelUp: after > before ? after : null, worldDone, earnedFreeze });
    useUi.getState().fireConfetti();
    if (after > before || worldDone) sfx.levelUp();
    else sfx.fanfare();
  }

  // Enter continues
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (result && !summary) {
        e.preventDefault();
        next();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  function copyContext() {
    const t = step.task;
    const goals =
      t.kind === "terminal"
        ? t.goals.map((g, i) => ({ describe: g.describe, met: goalsMet(t.goals, goalCtx(play.state, play.log))[i] }))
        : undefined;
    const text = buildContext({ world, level, step, stepIdx, goals, log: play.log, lines: play.lines[play.active] ?? [] });
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      },
      () => useUi.getState().toast("Could not copy. Your browser blocked the clipboard.", "warn"),
    );
  }

  if (!hydrated || !play.state.world) {
    return <div className="p-10 text-center font-mono text-muted">Booting the simulator...</div>;
  }

  const t = step.task;
  const showSideMap = !(t.kind === "map" || t.kind === "allocate" || t.kind === "rapid" || t.kind === "match" || t.kind === "order");
  const incident = t.kind === "incident" ? incidentById(t.incidentId) : undefined;
  const done = !!result;
  const pwKnown = level.base === "chain" && play.state.world.hosts.vps.users.deploy?.password;

  const taskEl = (() => {
    const key = `${level.id}-${stepIdx}`;
    switch (t.kind) {
      case "terminal":
        return <TerminalTask key={key} step={step} task={t} cb={cb} stepStart={stepStart} done={done} />;
      case "map":
        return <MapTask key={key} step={step} task={t} cb={cb} done={done} />;
      case "predict":
        return <PredictTask key={key} step={step} task={t} cb={cb} done={done} />;
      case "spot":
        return <SpotTask key={key} step={step} task={t} cb={cb} done={done} />;
      case "order":
        return <OrderTask key={key} step={step} task={t} cb={cb} done={done} />;
      case "rapid":
        return <RapidTask key={key} step={step} task={t} cb={cb} done={done} />;
      case "match":
        return <MatchTask key={key} step={step} task={t} cb={cb} done={done} />;
      case "config":
        return <ConfigTask key={key} step={step} task={t} cb={cb} done={done} />;
      case "allocate":
        return <AllocateTask key={key} step={step} task={t} cb={cb} done={done} />;
      case "incident":
        return incident ? <IncidentTask key={key} incident={incident} cb={cb} done={done} /> : null;
    }
  })();

  const due = dueCards(useProgress.getState().review, dayKey()).length;
  const nl = nextLevel(level.id);

  return (
    <div className="mx-auto flex min-h-dvh max-w-[1400px] flex-col px-3 pb-28 pt-2 md:px-6">
      {/* header */}
      <header className="sticky top-0 z-30 -mx-3 mb-3 flex items-center gap-2 border-b border-line bg-bg/90 px-3 py-2 backdrop-blur md:-mx-6 md:px-6">
        <Link href="/" className="rounded-md px-2 py-1 font-mono text-[18px] text-muted hover:text-amber" aria-label="Back to the path">
          ✕
        </Link>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[10px] uppercase tracking-[0.2em] text-muted">
            World {level.world} · {world?.title}
          </div>
          <div className="truncate font-display text-[16px] leading-tight text-ink">{level.title}</div>
        </div>
        <div className="hidden items-center gap-1 sm:flex">
          {level.steps.map((s, i) => (
            <span key={s.id} className={`h-1.5 w-6 rounded-full ${i < stepIdx || (i === stepIdx && done) ? "bg-teal" : i === stepIdx ? "bg-amber" : "bg-line2"}`} />
          ))}
        </div>
        <div className="flex items-center gap-1.5 font-mono text-[11px]">
          <span className={`rounded-md px-2 py-1 ${play.combo >= 3 ? "bg-amber/15 text-amber" : "text-muted"}`} title="Combo">
            x{comboMultiplier(play.combo)} · {play.combo}
          </span>
          <span className="hidden rounded-md px-2 py-1 text-teal sm:inline">+{levelXp} XP</span>
          <button type="button" onClick={() => useUi.getState().openDict()} className="rounded-md border border-line2 px-2 py-1 text-muted hover:text-amber" title="Dictionary">
            ?
          </button>
          <button type="button" onClick={copyContext} className="rounded-md border border-line2 px-2 py-1 text-muted hover:text-teal" title="Copy context for Claude">
            {copied ? "copied ✓" : "ask Claude"}
          </button>
        </div>
      </header>

      <AnimatePresence>
        {comboPop && comboPop.n >= 2 && (
          <motion.div
            key={comboPop.key}
            initial={{ opacity: 0, y: 10, scale: 0.8 }}
            animate={{ opacity: 1, y: -10, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4 }}
            onAnimationComplete={() => setTimeout(() => setComboPop(null), 500)}
            className="pointer-events-none fixed left-1/2 top-16 z-50 -translate-x-1/2 font-display text-3xl text-amber glow"
          >
            COMBO x{comboPop.n}
          </motion.div>
        )}
      </AnimatePresence>

      <div className={`grid flex-1 gap-4 ${showSideMap ? "lg:grid-cols-[minmax(0,1fr)_400px]" : ""}`}>
        <main className="min-w-0 space-y-4">
          <motion.div key={step.id} initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.25 }}>
            <MissionCard step={step} index={stepIdx} total={level.steps.length} />
          </motion.div>
          {showSideMap && (
            <div className="lg:hidden">
              <button type="button" onClick={() => setMapOpen(!mapOpen)} className="mb-2 font-mono text-[11px] text-muted hover:text-amber">
                {mapOpen ? "▾ hide server map" : "▸ show server map"}
              </button>
              {mapOpen && <ServerMap world={play.preview ?? play.state.world} trace={play.trace} traceKey={play.traceKey} forceVertical />}
            </div>
          )}
          {taskEl}
        </main>
        {showSideMap && (
          <aside className="hidden lg:block">
            <div className="sticky top-20 space-y-2">
              <ServerMap world={play.preview ?? play.state.world} trace={play.trace} traceKey={play.traceKey} forceVertical title={play.preview ? "what if... (preview)" : "your infrastructure, live"} />
              {pwKnown && (
                <button type="button" onClick={() => setRevealPw(!revealPw)} className="font-mono text-[11px] text-faint hover:text-muted">
                  deploy's password: {revealPw ? play.state.world.hosts.vps.users.deploy?.password : "•••••• (tap to show)"}
                </button>
              )}
            </div>
          </aside>
        )}
      </div>

      {/* success banner */}
      <AnimatePresence>
        {result && !summary && (
          <motion.div
            initial={{ y: 120 }}
            animate={{ y: 0 }}
            exit={{ y: 120 }}
            transition={{ type: "spring", stiffness: 300, damping: 28 }}
            className="fixed inset-x-0 bottom-0 z-40 border-t border-teal/40 bg-[#111111]/95 backdrop-blur"
          >
            <div className="mx-auto flex max-w-[1400px] flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center md:px-6">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-display text-2xl text-teal glow-teal">{result.mistakes === 0 && !result.usedShowMe ? "Nailed it" : "Done"}</span>
                  <span className="rounded bg-amber/15 px-1.5 font-mono text-[12px] text-amber">+{result.xp} XP</span>
                </div>
                {result.why && <p className="text-[14px] leading-snug text-ink/90">{result.why}</p>}
              </div>
              <Btn kind="teal" onClick={next} className="sm:min-w-40">
                Continue ↵
              </Btn>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* level complete */}
      <AnimatePresence>
        {summary && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 z-50 flex items-center justify-center bg-bg/85 p-4 backdrop-blur-sm">
            <motion.div
              initial={{ scale: 0.85, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 260, damping: 20 }}
              className="w-full max-w-md space-y-4 rounded-2xl border border-amber/40 bg-panel p-6 text-center box-glow"
            >
              <div className="font-mono text-[11px] uppercase tracking-[0.3em] text-muted">{summary.worldDone ? `World ${level.world} complete` : "Level complete"}</div>
              <div className="font-display text-4xl text-amber glow">{level.title}</div>
              <div className="flex justify-center gap-2">
                {[1, 2, 3].map((i) => (
                  <motion.span
                    key={i}
                    initial={{ scale: 0, rotate: -40 }}
                    animate={{ scale: 1, rotate: 0 }}
                    transition={{ delay: 0.2 + i * 0.15, type: "spring" }}
                    className={`text-4xl ${i <= summary.stars ? "text-amber glow" : "text-line2"}`}
                  >
                    ★
                  </motion.span>
                ))}
              </div>
              <div className="font-display text-3xl text-teal">+{summary.xp} XP</div>
              {summary.levelUp && (
                <motion.div initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.8 }} className="rounded-lg border border-teal/50 bg-teal/10 p-2">
                  <div className="font-display text-2xl text-teal">LEVEL UP: {summary.levelUp}</div>
                  <div className="font-mono text-[12px] text-ink/80">New rank: {rankFor(summary.levelUp)}</div>
                </motion.div>
              )}
              {summary.worldDone && <p className="text-[13px] text-ink/80">Cheat sheet unlocked on the path.</p>}
              {summary.earnedFreeze && <p className="text-[13px] text-teal">7 day streak! You earned a streak freeze.</p>}
              {summary.stars < 3 && <p className="font-mono text-[11px] text-muted">Replay without hints for 3 stars.</p>}
              <div className="flex flex-col gap-2">
                {due >= 3 && (
                  <Btn kind="ghost" onClick={() => router.push("/review")}>
                    Quick review ({Math.min(due, 5)} cards)
                  </Btn>
                )}
                {nl && (
                  <Btn onClick={() => router.push(`/play/${nl.id}`)}>Next: {nl.title}</Btn>
                )}
                <Btn kind="ghost" onClick={() => router.push("/")}>
                  Back to the path
                </Btn>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
