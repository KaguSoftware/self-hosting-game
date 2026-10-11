"use client";
import { AnimatePresence, motion, Reorder } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Step, Task } from "@/content/schema";
import { applyMapActions } from "@/sim/map";
import { traceHttp } from "@/sim/net";
import { sshCheck } from "@/sim/sshAuth";
import { usePlay } from "@/store/play";
import { sfx } from "@/lib/sfx";
import { hashHex } from "@/sim/util";
import { writeConfig } from "@/engine/replay";
import { Btn, HintBar, type TaskCallbacks } from "./common";

type Of<K extends Task["kind"]> = Extract<Task, { kind: K }>;

const letters = "ABCDEFGH";

// ---------------- predict ----------------

export function PredictTask({ step, task, cb, done }: { step: Step; task: Of<"predict">; cb: TaskCallbacks; done: boolean }) {
  const [pick, setPick] = useState<number | null>(null);

  function choose(i: number) {
    if (pick !== null || done) return;
    setPick(i);
    const right = i === task.answer;
    if (right) cb.onCorrect();
    else cb.onMistake(step.id);
    const play = usePlay.getState();
    const po = task.playout;
    if (po) {
      const next = applyMapActions(play.state.world, po.actions);
      if (po.persist) play.setWorld(next);
      else play.setPreview(next);
      if (po.url) play.showTrace(traceHttp(next, po.url));
      if (po.ssh) play.showTrace(sshCheck(next, "you", po.ssh.user, next.hosts.vps.publicIp ?? "").trace);
    }
    setTimeout(
      () => cb.onDone({ mistakes: right ? 0 : 1, usedHints: false, usedShowMe: false, missed: right ? [] : [step.id], why: task.why }),
      po?.url || po?.ssh ? 1500 : 500,
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-[15px] font-medium text-ink">{task.question}</p>
      <div className="grid gap-2">
        {task.options.map((o, i) => {
          const state = pick === null ? "idle" : i === task.answer ? "right" : i === pick ? "wrong" : "dim";
          return (
            <motion.button
              key={o}
              type="button"
              whileTap={{ scale: 0.98 }}
              animate={state === "wrong" ? { x: [0, -6, 6, -4, 4, 0] } : {}}
              onClick={() => choose(i)}
              className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left text-[14px] transition ${
                state === "idle"
                  ? "border-line2 bg-panel hover:border-amber hover:bg-panel2"
                  : state === "right"
                    ? "border-teal bg-teal/10 text-teal"
                    : state === "wrong"
                      ? "border-red bg-red/10 text-red"
                      : "border-line opacity-50"
              }`}
            >
              <span className="mt-px font-display text-[18px] leading-none text-amber/80">{letters[i]}</span>
              <span>{o}</span>
            </motion.button>
          );
        })}
      </div>
      {pick === null && <p className="font-mono text-[11px] text-faint">Commit to a guess. Then watch it play out.</p>}
    </div>
  );
}

// ---------------- spot the bug ----------------

export function SpotTask({ step, task, cb, done }: { step: Step; task: Of<"spot">; cb: TaskCallbacks; done: boolean }) {
  const [found, setFound] = useState<number[]>([]);
  const [wrong, setWrong] = useState<number[]>([]);
  const fired = useRef(false);

  function tap(i: number) {
    if (done || found.includes(i)) return;
    if (task.bugs.includes(i)) {
      sfx.tap();
      cb.onCorrect();
      const f = [...found, i];
      setFound(f);
      if (f.length === task.bugs.length && !fired.current) {
        fired.current = true;
        setTimeout(
          () =>
            cb.onDone({
              mistakes: wrong.length,
              usedHints: false,
              usedShowMe: false,
              missed: wrong.length && step.review ? [step.review.id] : [],
              why: task.why,
            }),
          450,
        );
      }
    } else if (!wrong.includes(i)) {
      setWrong([...wrong, i]);
      cb.onMistake();
    }
  }

  return (
    <div className="space-y-2">
      <p className="font-mono text-[12px] text-muted">
        {task.prompt}
        {task.bugs.length > 1 ? ` (${task.bugs.length - found.length} left)` : ""}
      </p>
      <div className={`overflow-x-auto rounded-lg border border-line bg-[#070707] p-1.5 scroll-thin ${task.mono ? "font-mono text-[12px]" : "text-[14px]"}`}>
        {task.lines.map((l, i) => {
          const isFound = found.includes(i);
          const isWrong = wrong.includes(i);
          return (
            <motion.button
              key={i}
              type="button"
              onClick={() => tap(i)}
              animate={isWrong ? { x: [0, -5, 5, -3, 3, 0] } : {}}
              className={`block w-full whitespace-pre rounded px-2 py-1 text-left transition ${
                isFound ? "bg-teal/15 text-teal ring-1 ring-teal/60" : isWrong ? "bg-red/10 text-red/80 line-through" : "text-ink/90 hover:bg-amber/10"
              }`}
            >
              {l || " "}
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------- order the steps ----------------

function shuffled(items: string[], seed: string): string[] {
  const out = items.slice();
  let h = parseInt(hashHex(seed, 8), 16);
  for (let i = out.length - 1; i > 0; i--) {
    h = (h * 1103515245 + 12345) >>> 0;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  if (out.every((x, i) => x === items[i])) out.reverse();
  return out;
}

export function OrderTask({ step, task, cb, done }: { step: Step; task: Of<"order">; cb: TaskCallbacks; done: boolean }) {
  const [order, setOrder] = useState(() => shuffled(task.items, step.id));
  const [checked, setChecked] = useState<boolean[] | null>(null);
  const [failures, setFailures] = useState(0);
  const [usedHints, setUsedHints] = useState(false);

  function move(i: number, d: number) {
    const j = i + d;
    if (j < 0 || j >= order.length) return;
    const next = order.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setOrder(next);
    setChecked(null);
    sfx.tap();
  }

  function check(final = order, showMe = false) {
    const res = final.map((x, i) => x === task.items[i]);
    setChecked(res);
    if (res.every(Boolean)) {
      if (!showMe) cb.onCorrect();
      setTimeout(
        () =>
          cb.onDone({
            mistakes: failures,
            usedHints,
            usedShowMe: showMe,
            missed: failures && step.review ? [step.review.id] : [],
            why: task.why,
          }),
        500,
      );
    } else {
      setFailures((f) => f + 1);
      cb.onMistake();
    }
  }

  return (
    <div className="space-y-3">
      <p className="font-mono text-[12px] text-muted">{task.prompt}</p>
      <Reorder.Group axis="y" values={order} onReorder={(v) => { setOrder(v); setChecked(null); }} className="space-y-1.5">
        {order.map((item, i) => (
          <Reorder.Item
            key={item}
            value={item}
            dragListener={!done}
            className={`flex cursor-grab items-center gap-2 rounded-lg border bg-panel px-2 py-2 text-[13.5px] active:cursor-grabbing ${
              checked ? (checked[i] ? "border-teal/70 text-teal" : "border-red/70 text-red") : "border-line2 text-ink"
            }`}
          >
            <span className="w-5 text-center font-display text-[18px] text-amber/80">{i + 1}</span>
            <span className="flex-1">{item}</span>
            <span className="flex flex-col">
              <button type="button" aria-label="Move up" onClick={() => move(i, -1)} className="px-1.5 text-[11px] leading-3 text-muted hover:text-amber">
                ▲
              </button>
              <button type="button" aria-label="Move down" onClick={() => move(i, 1)} className="px-1.5 text-[11px] leading-3 text-muted hover:text-amber">
                ▼
              </button>
            </span>
          </Reorder.Item>
        ))}
      </Reorder.Group>
      {!done && (
        <>
          <Btn onClick={() => check()}>Check order</Btn>
          <HintBar
            hints={[`The first step is: ${task.items[0]}`, `The last step is: ${task.items[task.items.length - 1]}`]}
            failures={failures}
            onHint={() => setUsedHints(true)}
            onShowMe={() => {
              setOrder(task.items);
              check(task.items, true);
            }}
            showMeLabel="Sort it for me"
          />
        </>
      )}
    </div>
  );
}

// ---------------- sort into buckets ----------------

export function MatchTask({ step, task, cb, done }: { step: Step; task: Of<"match">; cb: TaskCallbacks; done: boolean }) {
  const [sel, setSel] = useState<number | null>(null);
  const [placed, setPlaced] = useState<Record<number, number>>({});
  const [bad, setBad] = useState<number | null>(null);
  const mistakes = useRef(0);

  function drop(bucket: number) {
    if (sel === null || done) return;
    if (task.items[sel].bucket === bucket) {
      sfx.tap();
      cb.onCorrect();
      const next = { ...placed, [sel]: bucket };
      setPlaced(next);
      setSel(null);
      if (Object.keys(next).length === task.items.length) {
        setTimeout(
          () =>
            cb.onDone({
              mistakes: mistakes.current,
              usedHints: false,
              usedShowMe: false,
              missed: mistakes.current && step.review ? [step.review.id] : [],
              why: task.why,
            }),
          450,
        );
      }
    } else {
      mistakes.current += 1;
      setBad(bucket);
      setTimeout(() => setBad(null), 450);
      cb.onMistake();
    }
  }

  return (
    <div className="space-y-3">
      <p className="font-mono text-[12px] text-muted">{task.prompt}</p>
      <div className="flex min-h-10 flex-wrap gap-1.5">
        {task.items.map((it, i) =>
          placed[i] !== undefined ? null : (
            <motion.button
              layout
              key={it.text}
              type="button"
              onClick={() => {
                sfx.tap();
                setSel(sel === i ? null : i);
              }}
              className={`rounded-md border px-2.5 py-1.5 text-[13px] transition ${
                sel === i ? "border-teal bg-teal/15 text-teal shadow-[0_0_12px_rgba(255,255,255,0.3)]" : "border-line2 bg-panel2 hover:border-amber"
              }`}
            >
              {it.text}
            </motion.button>
          ),
        )}
      </div>
      <div className={`grid gap-2 ${task.buckets.length > 2 ? "grid-cols-2" : "grid-cols-2"}`}>
        {task.buckets.map((b, bi) => (
          <motion.button
            key={b}
            type="button"
            onClick={() => drop(bi)}
            animate={bad === bi ? { x: [0, -6, 6, -4, 4, 0] } : {}}
            className={`min-h-24 rounded-xl border-2 border-dashed p-2 text-left transition ${
              bad === bi ? "border-red bg-red/5" : sel !== null ? "border-amber/60 bg-amber/[0.04] hover:bg-amber/10" : "border-line2"
            }`}
          >
            <div className="mb-1 font-mono text-[12px] font-semibold text-amber">{b}</div>
            <div className="flex flex-wrap gap-1">
              {task.items.map((it, i) =>
                placed[i] === bi ? (
                  <motion.span layout key={it.text} className="rounded bg-teal/15 px-1.5 py-0.5 text-[11.5px] text-teal">
                    {it.text}
                  </motion.span>
                ) : null,
              )}
            </div>
          </motion.button>
        ))}
      </div>
    </div>
  );
}

// ---------------- rapid fire ----------------

export function RapidTask({ task, cb, done }: { step: Step; task: Of<"rapid">; cb: TaskCallbacks; done: boolean }) {
  const [started, setStarted] = useState(false);
  const [idx, setIdx] = useState(0);
  const [left, setLeft] = useState(task.seconds);
  const [hits, setHits] = useState(0);
  const [missed, setMissed] = useState<string[]>([]);
  const [fb, setFb] = useState<{ i: number; ok: boolean } | null>(null);
  const [over, setOver] = useState(false);
  const fired = useRef(false);

  useEffect(() => {
    if (!started || over) return;
    const t = setInterval(() => setLeft((l) => l - 1), 1000);
    return () => clearInterval(t);
  }, [started, over]);

  useEffect(() => {
    if (left <= 0 && !over) setOver(true);
  }, [left, over]);

  useEffect(() => {
    if (!over || fired.current) return;
    fired.current = true;
    cb.onDone({
      mistakes: missed.length,
      usedHints: false,
      usedShowMe: false,
      missed,
      bonusXp: hits * 3,
      why: `${hits} of ${task.items.length} right${missed.length ? ". Misses go to your review queue." : ". Clean sweep!"}`,
    });
  }, [over]); // eslint-disable-line react-hooks/exhaustive-deps

  const q = task.items[idx];

  function answer(i: number) {
    if (fb || over || done) return;
    const ok = i === q.answer;
    setFb({ i, ok });
    if (ok) {
      setHits((h) => h + 1);
      cb.onCorrect();
    } else {
      setMissed((m) => [...m, q.id]);
      cb.onMistake(q.id);
    }
    setTimeout(() => {
      setFb(null);
      if (idx + 1 >= task.items.length) setOver(true);
      else setIdx(idx + 1);
    }, ok ? 380 : 900);
  }

  if (!started) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-line bg-panel/60 p-6 text-center">
        <div className="font-display text-5xl text-amber glow">{task.seconds}s</div>
        <p className="text-[14px] text-muted">{task.items.length} quick questions. Speed builds your combo.</p>
        <Btn
          onClick={() => {
            sfx.tap();
            setStarted(true);
          }}
        >
          Start
        </Btn>
      </div>
    );
  }

  if (over) {
    return (
      <div className="rounded-xl border border-line bg-panel/60 p-5 text-center">
        <div className="font-display text-5xl text-amber glow">
          {hits}/{task.items.length}
        </div>
        <p className="mt-1 text-[13px] text-muted">{left <= 0 ? "Time!" : "Done!"}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between font-mono text-[12px]">
        <span className="text-muted">
          {idx + 1}/{task.items.length}
        </span>
        <div className="mx-3 h-1.5 flex-1 overflow-hidden rounded-full bg-line">
          <motion.div className={`h-full ${left <= 8 ? "bg-red" : "bg-amber"}`} animate={{ width: `${(left / task.seconds) * 100}%` }} transition={{ ease: "linear", duration: 1 }} />
        </div>
        <span className={`font-display text-xl ${left <= 8 ? "text-red" : "text-amber"}`}>{left}s</span>
      </div>
      <AnimatePresence mode="wait">
        <motion.div key={q.id} initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -30 }} transition={{ duration: 0.15 }}>
          <p className="mb-2 text-[16px] font-medium">{q.q}</p>
          <div className="grid gap-2">
            {q.options.map((o, i) => (
              <button
                key={o}
                type="button"
                onClick={() => answer(i)}
                className={`rounded-lg border px-3 py-2.5 text-left text-[14px] transition ${
                  fb && i === q.answer ? "border-teal bg-teal/10 text-teal" : fb && fb.i === i ? "border-red bg-red/10 text-red" : "border-line2 bg-panel hover:border-amber"
                }`}
              >
                {o}
              </button>
            ))}
          </div>
          {fb && !fb.ok && <p className="mt-2 font-mono text-[12px] text-red/90">{q.why}</p>}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

// ---------------- config editor ----------------

export function ConfigTask({ step, task, cb, done }: { step: Step; task: Of<"config">; cb: TaskCallbacks; done: boolean }) {
  const blankIds = useMemo(() => [...task.start.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]), [task.start]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [text, setText] = useState(task.mode === "fix" ? task.start : "");
  const [lines, setLines] = useState(() => (task.mode === "reorder" ? task.start.split("\n") : []));
  const [results, setResults] = useState<boolean[] | null>(null);
  const [failures, setFailures] = useState(0);
  const [usedHints, setUsedHints] = useState(false);

  const current = () =>
    task.mode === "blanks"
      ? task.start.replace(/\{\{(\w+)\}\}/g, (_, k) => values[k] ?? "")
      : task.mode === "fix"
        ? text
        : lines.join("\n");

  function check(showMe = false) {
    const t = showMe ? task.solution : current();
    const res = task.checks.map((c) => {
      try {
        return c.test(t);
      } catch {
        return false;
      }
    });
    setResults(res);
    if (res.every(Boolean)) {
      if (!showMe) cb.onCorrect();
      if (task.writeToSim) {
        const play = usePlay.getState();
        play.setWorld(writeConfig(play.state.world, task.host, task.path, t));
      }
      setTimeout(
        () =>
          cb.onDone({
            mistakes: failures,
            usedHints,
            usedShowMe: showMe,
            missed: failures && step.review ? [step.review.id] : [],
            why: `Saved ${task.path}.`,
          }),
        450,
      );
    } else {
      setFailures((f) => f + 1);
      cb.onMistake();
    }
  }

  const filledAll = task.mode !== "blanks" || blankIds.every((id) => values[id]);

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-xl border border-line bg-[#070707]">
        <div className="flex items-center justify-between border-b border-line bg-panel/80 px-3 py-1 font-mono text-[11px] text-muted">
          <span>{task.path}</span>
          <span className="text-amber/70">{task.mode === "blanks" ? "fill the blanks" : task.mode === "fix" ? "fix the bug" : "reorder the lines"}</span>
        </div>
        {task.mode === "blanks" && (
          <pre className="max-h-[52vh] overflow-auto p-3 font-mono text-[12px] leading-[1.55] text-ink/80 scroll-thin">
            {task.start.split(/(\{\{\w+\}\})/g).map((part, i) => {
              const m = /^\{\{(\w+)\}\}$/.exec(part);
              if (!m) return <span key={i}>{part}</span>;
              const id = m[1];
              const b = task.blanks?.[id];
              return (
                <span key={i} className="inline-flex gap-1 align-middle">
                  {b?.options.map((o) => (
                    <button
                      key={o}
                      type="button"
                      disabled={done}
                      onClick={() => {
                        sfx.tap();
                        setValues({ ...values, [id]: o });
                        setResults(null);
                      }}
                      className={`rounded border px-1.5 font-mono text-[12px] leading-5 transition ${
                        values[id] === o ? "border-amber bg-amber/20 text-amber" : "border-dashed border-line2 text-muted hover:border-amber hover:text-amber"
                      }`}
                    >
                      {o}
                    </button>
                  ))}
                </span>
              );
            })}
          </pre>
        )}
        {task.mode === "fix" && (
          <textarea
            value={text}
            disabled={done}
            onChange={(e) => {
              setText(e.target.value);
              setResults(null);
            }}
            spellCheck={false}
            rows={Math.min(22, text.split("\n").length + 1)}
            className="w-full resize-y bg-transparent p-3 font-mono text-[12.5px] leading-[1.55] text-ink outline-none scroll-thin"
          />
        )}
        {task.mode === "reorder" && (
          <Reorder.Group axis="y" values={lines} onReorder={setLines} className="p-2">
            {lines.map((l) => (
              <Reorder.Item key={l} value={l} className="cursor-grab whitespace-pre rounded px-2 py-1 font-mono text-[12.5px] hover:bg-amber/10">
                {l}
              </Reorder.Item>
            ))}
          </Reorder.Group>
        )}
      </div>
      {results && (
        <ul className="space-y-1">
          {task.checks.map((c, i) => (
            <li key={c.describe} className={`font-mono text-[12.5px] ${results[i] ? "text-teal" : "text-red"}`}>
              {results[i] ? "✓" : "✕"} {c.describe}
            </li>
          ))}
        </ul>
      )}
      {!done && (
        <>
          <Btn onClick={() => check()} disabled={!filledAll}>
            Save and check
          </Btn>
          <HintBar
            hints={task.hints}
            failures={failures}
            onHint={() => setUsedHints(true)}
            onShowMe={() => {
              if (task.mode === "blanks" && task.blanks) {
                const v: Record<string, string> = {};
                for (const [k, b] of Object.entries(task.blanks)) v[k] = b.options[b.answer];
                setValues(v);
              } else if (task.mode === "fix") setText(task.solution);
              else setLines(task.solution.split("\n"));
              check(true);
            }}
          />
        </>
      )}
    </div>
  );
}

// ---------------- hypervisor allocator ----------------

export function AllocateTask({ step, task, cb, done }: { step: Step; task: Of<"allocate">; cb: TaskCallbacks; done: boolean }) {
  const [placed, setPlaced] = useState<number[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [failures, setFailures] = useState(0);
  const [usedHints, setUsedHints] = useState(false);
  const fired = useRef(false);
  const cpu = placed.reduce((s, i) => s + task.vms[i].cpus, 0);
  const ram = placed.reduce((s, i) => s + task.vms[i].ramGb, 0);

  function finishIfFull(nextRam: number, showMe = false) {
    if (nextRam === task.host.ramGb && !fired.current) {
      fired.current = true;
      setTimeout(
        () =>
          cb.onDone({
            mistakes: failures,
            usedHints,
            usedShowMe: showMe,
            missed: failures && step.review ? [step.review.id] : [],
            why: "RAM is 100% and cannot go higher. CPU above 100% is fine: VMs rarely all need it at once.",
          }),
        700,
      );
    }
  }

  function toggle(i: number) {
    if (done) return;
    if (placed.includes(i)) {
      setPlaced(placed.filter((x) => x !== i));
      setMsg(null);
      sfx.tap();
      return;
    }
    const vm = task.vms[i];
    if (ram + vm.ramGb > task.host.ramGb) {
      sfx.error();
      setFailures((f) => f + 1);
      cb.onMistake();
      setMsg(`Refused: ${vm.name} needs ${vm.ramGb} GB RAM, only ${task.host.ramGb - ram} GB left. RAM can't be shared.`);
      return;
    }
    const next = [...placed, i];
    setPlaced(next);
    sfx.tap();
    cb.onCorrect();
    const nextCpu = cpu + vm.cpus;
    setMsg(nextCpu > task.host.cpus ? `CPU at ${Math.round((nextCpu / task.host.cpus) * 100)}%. Overcommitted, and that is OK.` : null);
    finishIfFull(ram + vm.ramGb);
  }

  const bar = (val: number, max: number, color: string, label: string) => (
    <div>
      <div className="mb-1 flex justify-between font-mono text-[11px]">
        <span className="text-muted">{label}</span>
        <span className={val > max ? "text-yellow" : "text-ink"}>
          {val}/{max} ({Math.round((val / max) * 100)}%)
        </span>
      </div>
      <div className="relative h-3 overflow-hidden rounded-full bg-line">
        <motion.div className={`h-full ${color}`} animate={{ width: `${Math.min(100, (val / max) * 100)}%` }} />
        {val > max && <div className="absolute inset-0 animate-pulse bg-yellow/30" />}
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <p className="font-mono text-[12px] text-muted">{task.prompt}</p>
      <div className="rounded-xl border border-amber/40 bg-amber/[0.03] p-3">
        <div className="mb-2 font-display text-xl text-amber glow">PHYSICAL HOST · {task.host.cpus} cores · {task.host.ramGb} GB</div>
        <div className="space-y-2">
          {bar(cpu, task.host.cpus, "bg-amber", "CPU (shared)")}
          {bar(ram, task.host.ramGb, "bg-teal", "RAM (reserved)")}
        </div>
        <div className="mt-3 flex min-h-12 flex-wrap gap-1.5">
          <AnimatePresence>
            {placed.map((i) => (
              <motion.button
                key={task.vms[i].name}
                layout
                initial={{ scale: 0.5, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.5, opacity: 0 }}
                type="button"
                onClick={() => toggle(i)}
                className="rounded-md border border-teal/60 bg-teal/10 px-2 py-1 font-mono text-[11.5px] text-teal"
              >
                VM {task.vms[i].name} · {task.vms[i].cpus}c · {task.vms[i].ramGb}G ✕
              </motion.button>
            ))}
          </AnimatePresence>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {task.vms.map((vm, i) =>
          placed.includes(i) ? null : (
            <motion.button
              key={vm.name}
              layout
              type="button"
              onClick={() => toggle(i)}
              className="rounded-lg border border-line2 bg-panel2 px-2.5 py-1.5 text-left font-mono text-[12px] hover:border-amber"
            >
              <div className="text-ink">VM {vm.name}</div>
              <div className="text-muted">
                {vm.cpus} vCPU · {vm.ramGb} GB
              </div>
            </motion.button>
          ),
        )}
      </div>
      {msg && <p className={`font-mono text-[12.5px] ${msg.startsWith("Refused") ? "text-red" : "text-yellow"}`}>{msg}</p>}
      {!done && (
        <HintBar
          hints={task.hints}
          failures={failures}
          onHint={() => setUsedHints(true)}
          onShowMe={() => {
            const pick = task.vms.map((v, i) => ({ v, i })).filter((x) => x.v.ramGb === 8).map((x) => x.i).slice(0, 4);
            setPlaced(pick);
            finishIfFull(pick.reduce((s, i) => s + task.vms[i].ramGb, 0), true);
          }}
        />
      )}
    </div>
  );
}
