"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { incidentById } from "@/content/incidents";
import { levelById, nextLevel, replay, worldLabel, worldOf, WORLDS } from "@/content";
import type { Level } from "@/content/schema";
import { goalCtx, goalsMet } from "@/engine/play";
import { comboMultiplier, dueCards, dayKey, LEVEL_BONUS, CLEAN_BONUS, levelFromXp, rankFor, stars as starsFor, STEP_XP } from "@/engine/rules";
import { buildContext } from "@/lib/context";
import { sfx } from "@/lib/sfx";
import { usePlay } from "@/store/play";
import { useProgress } from "@/store/progress";
import { useUi } from "@/store/ui";
import ServerMap from "../map/ServerMap";
import { Btn, KeyHint, MissionCard, plain, useEnterKey, useHotkey, type TaskCallbacks, type TaskResult } from "./common";
import BudgetTask from "./BudgetTask";
import { isGuess } from "@/content/schema";
import IncidentTask from "./IncidentTask";
import MissionTask from "./MissionTask";
import PipelinePanel from "./PipelinePanel";
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
        // A guess is how you learn something new. It is never punished.
        if (isGuess(step)) {
          sfx.tap();
          return;
        }
        usePlay.getState().breakCombo();
        sfx.error();
        if (quizId) useProgress.getState().miss(quizId);
      },
      onDone(r) {
        const prog = useProgress.getState();
        const combo = usePlay.getState().combo;
        const wrongGuess = !isGuess(step) && (step.task.kind === "predict" || step.task.kind === "rapid") && r.mistakes > 0 && !r.bonusXp;
        const base = r.usedShowMe ? Math.round(STEP_XP / 2) : wrongGuess ? 3 : STEP_XP;
        const xp = Math.round(base * comboMultiplier(combo)) + (r.bonusXp ?? 0);
        prog.addXp(xp);
        prog.attempt(level.world, r.mistakes === 0 && !r.usedShowMe, step.tags);
        if (!isGuess(step)) for (const id of r.missed) prog.miss(id);
        setLevelXp((x) => x + xp);
        setFlags((f) => ({ hints: f.hints || r.usedHints, showMe: f.showMe || r.usedShowMe }));
        setResult({ ...r, xp, why: [step.after, r.why].filter(Boolean).join(" ") || undefined });
        sfx.success();
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

  // Enter continues. Ctrl+Enter (Cmd+Enter on a Mac) works even from the terminal. On the
  // level summary Enter goes to the next level (or back to the path after the last one),
  // and R starts the quick review when it is offered.
  useEnterKey(next, !!result && !summary);
  useEnterKey(() => {
    const nl = nextLevel(level.id);
    router.push(nl ? `/play/${nl.id}` : "/");
  }, !!summary);
  const dueOnSummary = summary && hydrated ? dueCards(useProgress.getState().review, dayKey()).length : 0;
  useHotkey((e) => plain(e) && e.key.toLowerCase() === "r", () => router.push("/review"), dueOnSummary >= 3);

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
  const showSideMap = level.world >= 0 && !(t.kind === "map" || t.kind === "allocate" || t.kind === "rapid" || t.kind === "match" || t.kind === "order");
  const incident = t.kind === "incident" ? incidentById(t.incidentId) : undefined;
  const done = !!result;
  const pwKnown = level.base === "chain" && play.state.world.hosts.vps.users.deploy?.password;

  const taskEl = (() => {
    const key = `${level.id}-${stepIdx}`;
    switch (t.kind) {
      case "terminal":
        return <TerminalTask key={key} step={step} task={t} cb={cb} stepStart={stepStart} done={done} beginner={level.world <= 1} />;
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
      case "budget":
        return <BudgetTask key={key} step={step} task={t} cb={cb} done={done} />;
      case "allocate":
        return <AllocateTask key={key} step={step} task={t} cb={cb} done={done} />;
      case "incident":
        return incident ? <IncidentTask key={key} incident={incident} cb={cb} done={done} after={t.after} /> : null;
      case "mission":
        return <MissionTask key={key} step={step} task={t} cb={cb} done={done} />;
    }
  })();

  const due = dueCards(useProgress.getState().review, dayKey()).length;
  const nl = nextLevel(level.id);

  const verdict: "good" | "bad" | "help" | "done" | "learn" = !result
    ? "done"
    : isGuess(step) && result.mistakes > 0
      ? "learn"
      : result.usedShowMe
      ? "help"
      : (t.kind === "predict" || t.kind === "rapid") && result.mistakes > 0
        ? "bad"
        : result.mistakes === 0
          ? "good"
          : "done";
  const verdictTitle = { good: "Correct!", bad: "Not quite", help: "Solved, with help", done: "Done", learn: "Now you know" }[verdict];

  return (
    <div className="mx-auto flex min-h-dvh max-w-[1240px] flex-col px-4 pb-16 md:px-6">
      {/* header */}
      <header className="sticky top-0 z-30 -mx-4 mb-5 flex items-center gap-3 border-b border-line bg-bg/95 px-4 py-2.5 backdrop-blur md:-mx-6 md:px-6">
        <Link href="/" className="flex h-8 w-8 items-center justify-center rounded-md text-[16px] text-muted hover:bg-panel hover:text-ink" aria-label="Back to the path">
          ✕
        </Link>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] text-muted">{level.world < 0 ? world?.title : `${worldLabel(level.world)} · ${world?.title}`}</div>
          <div className="truncate text-[15px] font-semibold leading-tight text-ink">{level.title}</div>
        </div>
        <div className="hidden w-40 items-center gap-1 md:flex" aria-label={`Step ${stepIdx + 1} of ${level.steps.length}`}>
          {level.steps.map((s, i) => (
            <span key={s.id} className={`h-1.5 flex-1 rounded-full transition-colors ${i < stepIdx || (i === stepIdx && done) ? "bg-teal" : i === stepIdx ? "bg-ink" : "bg-line2"}`} />
          ))}
        </div>
        <div className="flex items-center gap-1.5 text-[12px]">
          {play.combo >= 2 && (
            <span className="rounded-md bg-panel2 px-2 py-1 font-mono text-ink" title="Right answers in a row multiply your XP">
              {play.combo} in a row{comboMultiplier(play.combo) > 1 ? ` · XP x${comboMultiplier(play.combo)}` : ""}
            </span>
          )}
          <span className="hidden px-1 font-mono text-muted sm:inline">+{levelXp} XP</span>
          <button
            type="button"
            onClick={() => useUi.getState().openHelp()}
            className="hidden h-8 rounded-md border border-line2 px-2.5 text-muted hover:border-ink hover:text-ink sm:block"
            title="Keyboard shortcuts (press ?)"
          >
            Keys
          </button>
          <button type="button" onClick={() => useUi.getState().openDict()} className="h-8 rounded-md border border-line2 px-2.5 text-muted hover:border-ink hover:text-ink" title="Dictionary (press /)">
            ?
          </button>
          <button type="button" onClick={copyContext} className="h-8 rounded-md border border-line2 px-2.5 text-muted hover:border-ink hover:text-ink" title="Copy context for Claude">
            {copied ? "Copied ✓" : "Ask Claude"}
          </button>
        </div>
      </header>

      <AnimatePresence>
        {comboPop && comboPop.n >= 3 && (
          <motion.div
            key={comboPop.key}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            onAnimationComplete={() => setTimeout(() => setComboPop(null), 700)}
            className="pointer-events-none fixed left-1/2 top-16 z-50 -translate-x-1/2 rounded-full bg-ink px-3 py-1 font-mono text-[13px] font-semibold text-bg"
          >
            {comboPop.n} in a row
          </motion.div>
        )}
      </AnimatePresence>

      <div className={`grid flex-1 items-start gap-6 ${showSideMap ? "lg:grid-cols-[minmax(0,1fr)_360px]" : ""}`}>
        <main className={`min-w-0 space-y-4 ${showSideMap ? "" : t.kind === "map" ? "mx-auto w-full max-w-6xl" : "mx-auto w-full max-w-3xl"}`}>
          <motion.div key={step.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}>
            <MissionCard step={step} index={stepIdx} total={level.steps.length} />
          </motion.div>
          {showSideMap && (
            <div className="lg:hidden">
              <button type="button" onClick={() => setMapOpen(!mapOpen)} className="mb-2 text-[13px] text-muted hover:text-ink">
                {mapOpen ? "▾ Hide server map" : "▸ Show server map"}
              </button>
              {mapOpen && <ServerMap world={play.preview ?? play.state.world} trace={play.trace} traceKey={play.traceKey} forceVertical />}
            </div>
          )}
          {play.state.world.gitlab && (
            <div className="lg:hidden">
              <PipelinePanel world={play.state.world} />
            </div>
          )}
          {isGuess(step) && !done && (
            <div className="flex items-start gap-2.5 rounded-xl border border-line2 bg-panel2/60 px-4 py-3 text-[14px] leading-snug text-ink/85">
              <span className="mt-px font-mono text-[12px] font-semibold text-muted">?</span>
              <span>
                <span className="font-semibold text-ink">This one is new. Take a guess.</span> Nothing is lost if you are wrong: the answer teaches you.
              </span>
            </div>
          )}
          {taskEl}
        </main>
        {showSideMap && (
          <aside className="hidden lg:block">
            <div className="sticky top-[72px] space-y-2">
              <ServerMap world={play.preview ?? play.state.world} trace={play.trace} traceKey={play.traceKey} forceVertical title={play.preview ? "What if... (preview)" : "Your servers, live"} />
              <PipelinePanel world={play.state.world} />
              {pwKnown && (
                <button type="button" onClick={() => setRevealPw(!revealPw)} className="text-[12px] text-faint hover:text-muted">
                  deploy&apos;s password: {revealPw ? play.state.world.hosts.vps.users.deploy?.password : "•••••• (tap to show)"}
                </button>
              )}
            </div>
          </aside>
        )}
      </div>

      {/* step result */}
      <AnimatePresence>
        {result && !summary && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-40 flex items-end justify-center bg-black/55 p-4 sm:items-center"
            role="dialog"
            aria-modal="true"
            aria-labelledby="result-title"
          >
            <motion.div
              initial={{ opacity: 0, y: 24, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12 }}
              transition={{ type: "spring", stiffness: 420, damping: 32 }}
              className={`w-full max-w-md rounded-2xl border bg-panel p-5 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.8)] ${
                verdict === "bad" ? "border-red/50" : verdict === "help" || verdict === "learn" ? "border-line2" : "border-teal/50"
              }`}
            >
              <div className="flex items-center gap-3">
                <motion.span
                  initial={{ scale: 0.4, rotate: -20 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ type: "spring", stiffness: 500, damping: 18, delay: 0.05 }}
                  className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${
                    verdict === "bad" ? "bg-red/15 text-red" : verdict === "help" || verdict === "learn" ? "bg-panel2 text-ink" : "bg-teal/15 text-teal"
                  }`}
                  aria-hidden
                >
                  {verdict === "bad" ? (
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                      <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
                    </svg>
                  ) : (
                    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
                      <path d="M5 11.5l4 4 8-9" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </motion.span>
                <div className="min-w-0 flex-1">
                  <div id="result-title" className={`text-[20px] font-semibold leading-tight ${verdict === "bad" ? "text-red" : verdict === "help" || verdict === "learn" ? "text-ink" : "text-teal"}`}>
                    {verdictTitle}
                  </div>
                  <div className="mt-0.5 font-mono text-[12px] text-muted">
                    +{result.xp} XP{play.combo >= 2 ? ` · ${play.combo} in a row` : ""}{comboMultiplier(play.combo) > 1 ? ` (XP x${comboMultiplier(play.combo)})` : ""}
                  </div>
                </div>
              </div>
              {result.why && <p className="mt-4 text-[15px] leading-relaxed text-ink/90">{result.why}</p>}
              {step.copy && (
                <Btn
                  kind="ghost"
                  className="mt-3 w-full"
                  onClick={() =>
                    navigator.clipboard?.writeText(step.copy!.text).then(
                      () => useUi.getState().toast("Copied. Paste it into a message or a note.", "info"),
                      () => useUi.getState().toast("Could not copy. Your browser blocked the clipboard.", "warn"),
                    )
                  }
                >
                  {step.copy.label}
                </Btn>
              )}
              <Btn kind={verdict === "bad" || verdict === "help" || verdict === "learn" ? "primary" : "teal"} onClick={next} className="mt-5 w-full" autoFocus>
                {stepIdx + 1 < level.steps.length ? "Continue" : "Finish level"}
                <KeyHint>↵</KeyHint>
              </Btn>
            </motion.div>
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
              <div className="font-mono text-[11px] uppercase tracking-[0.3em] text-muted">{summary.worldDone ? `${worldLabel(level.world)} complete` : "Level complete"}</div>
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
                {nl && (
                  <Btn onClick={() => router.push(`/play/${nl.id}`)} autoFocus>
                    Next: {nl.title}
                    <KeyHint>↵</KeyHint>
                  </Btn>
                )}
                {due >= 3 && (
                  <Btn kind="ghost" onClick={() => router.push("/review")}>
                    Quick review ({Math.min(due, 5)} cards)
                    <KeyHint>R</KeyHint>
                  </Btn>
                )}
                <Btn kind={nl ? "ghost" : "primary"} onClick={() => router.push("/")} autoFocus={!nl}>
                  Back to the path
                  {!nl && <KeyHint>↵</KeyHint>}
                </Btn>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
