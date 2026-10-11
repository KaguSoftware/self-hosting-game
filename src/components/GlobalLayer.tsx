"use client";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { TERMS } from "@/content/dictionary";
import { FLAGS } from "@/content/flags";
import { useUi } from "@/store/ui";
import { startCloudSync } from "@/store/cloud";
import { hydrateProgress } from "@/store/progress";
import { KeyLayer, plain, useEscapeKey, useHotkey, useRestoreFocus } from "@/components/play/common";

function Confetti() {
  const n = useUi((s) => s.confetti);
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!n || !ref.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const c = ref.current;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    c.width = window.innerWidth;
    c.height = window.innerHeight;
    const colors = ["#ffffff", "#d9d9d9", "#9a9a9a", "#5e5e5e"];
    const parts = Array.from({ length: 150 }, () => ({
      x: c.width / 2 + (Math.random() - 0.5) * 200,
      y: c.height * 0.35,
      vx: (Math.random() - 0.5) * 16,
      vy: -Math.random() * 14 - 4,
      s: 4 + Math.random() * 6,
      r: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      col: colors[Math.floor(Math.random() * colors.length)],
    }));
    let frame = 0;
    let raf = 0;
    const draw = () => {
      ctx.clearRect(0, 0, c.width, c.height);
      for (const p of parts) {
        p.vy += 0.35;
        p.vx *= 0.99;
        p.x += p.vx;
        p.y += p.vy;
        p.r += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.fillStyle = p.col;
        ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
        ctx.restore();
      }
      frame++;
      if (frame < 200) raf = requestAnimationFrame(draw);
      else ctx.clearRect(0, 0, c.width, c.height);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [n]);
  return <canvas ref={ref} className="pointer-events-none fixed inset-0 z-[90]" />;
}

function Toasts() {
  const toasts = useUi((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed right-3 top-16 z-[80] flex flex-col items-end gap-1.5">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, x: 30, scale: 0.9 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10 }}
            className={`rounded-lg border px-3 py-1.5 font-mono text-[13px] shadow-lg ${
              t.kind === "xp" ? "border-amber/50 bg-panel text-amber glow" : t.kind === "warn" ? "border-red/50 bg-panel text-red" : "border-line2 bg-panel text-ink"
            }`}
          >
            {t.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function Dictionary() {
  const { dictOpen, dictQuery, closeDict } = useUi();
  const [q, setQ] = useState(dictQuery);
  const [tab, setTab] = useState<"words" | "flags">("words");
  const flagGroups = useMemo(() => {
    const s = q.trim().toLowerCase();
    const groups = new Map<string, typeof FLAGS>();
    for (const f of FLAGS) {
      if (s && !`${f.cmd} ${f.flag} ${f.means}`.toLowerCase().includes(s)) continue;
      groups.set(f.cmd, [...(groups.get(f.cmd) ?? []), f]);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [q]);
  useEffect(() => setQ(dictQuery), [dictQuery, dictOpen]);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return TERMS.filter((t) => !s || t.term.toLowerCase().includes(s) || t.plain.toLowerCase().includes(s) || (t.replaces ?? "").toLowerCase().includes(s)).sort((a, b) =>
      a.term.localeCompare(b.term),
    );
  }, [q]);
  useEscapeKey(closeDict, dictOpen, { layer: true });
  // Ctrl+\ (Cmd+\ on a Mac) opens the dictionary from anywhere, even mid-command in the
  // terminal, and closes it again. Focus goes back to where it was.
  useHotkey(
    (e) => (e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "\\" || e.code === "Backslash"),
    () => (useUi.getState().dictOpen ? closeDict() : useUi.getState().openDict()),
    true,
    { inInput: "always", layer: true },
  );
  useRestoreFocus(dictOpen);
  return (
    <>
    {dictOpen && <KeyLayer />}
    <AnimatePresence>
      {dictOpen && (
        <>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={closeDict} className="fixed inset-0 z-[60] bg-bg/60" />
          <motion.aside
            data-kb-panel
            role="dialog"
            aria-modal="true"
            aria-label="Dictionary"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 320, damping: 32 }}
            className="fixed bottom-0 right-0 top-0 z-[61] flex w-full max-w-md flex-col border-l border-line bg-panel"
          >
            <div className="flex items-center gap-2 border-b border-line p-3">
              <span className="font-display text-2xl text-amber glow">Dictionary</span>
              <button type="button" onClick={closeDict} className="ml-auto rounded px-2 font-mono text-muted hover:text-amber">
                ✕
              </button>
            </div>
            <div className="flex gap-1 px-3 pt-3" role="tablist">
              {(["words", "flags"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={`rounded-md px-3 py-1.5 text-[13px] transition ${tab === t ? "bg-ink text-bg" : "text-muted hover:text-ink"}`}
                >
                  {t === "words" ? "Words" : "Flags (-h, -la...)"}
                </button>
              ))}
            </div>
            <div className="p-3">
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search: ufw, volume, 502..."
                className="w-full rounded-lg border border-line2 bg-bg px-3 py-2 font-mono text-[13px] outline-none focus:border-amber"
              />
            </div>
            {tab === "flags" && (
              <div className="flex-1 space-y-3 overflow-y-auto px-3 pb-6 scroll-thin">
                <p className="text-[13px] leading-snug text-muted">
                  Flags are the extra bits after a command that change how it works. They start with a dash. Several one-letter flags can be glued together: <code className="font-mono text-ink">ls -la</code> is <code className="font-mono text-ink">ls -l -a</code>.
                </p>
                {flagGroups.map(([cmd, fs]) => (
                  <div key={cmd} className="rounded-lg border border-line bg-bg2/60 p-3">
                    <div className="mb-1.5 font-mono text-[14px] font-semibold text-ink">{cmd}</div>
                    <ul className="space-y-1">
                      {fs.map((f) => (
                        <li key={f.flag} className="flex gap-2 text-[13px] leading-snug">
                          <code className="min-w-14 shrink-0 whitespace-nowrap font-mono text-ink">{f.flag}</code>
                          <span className="text-ink/80">{f.means}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                {!flagGroups.length && <p className="font-mono text-[13px] text-muted">Nothing found.</p>}
              </div>
            )}
            {tab === "words" && (
            <div className="flex-1 space-y-2 overflow-y-auto px-3 pb-6 scroll-thin">
              {list.map((t) => (
                <div key={t.id} className="rounded-lg border border-line bg-bg2/60 p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-mono text-[14px] font-semibold text-amber">{t.term}</span>
                    <span className="font-mono text-[10px] text-faint">world {t.world}</span>
                  </div>
                  <p className="mt-1 text-[13.5px] leading-snug text-ink/90">{t.plain}</p>
                  {t.replaces && (
                    <p className="mt-1 text-[12.5px] text-muted">
                      <span className="font-mono text-[10px] uppercase tracking-wider text-faint">replaces </span>
                      {t.replaces}
                    </p>
                  )}
                </div>
              ))}
              {!list.length && <p className="font-mono text-[13px] text-muted">Nothing found.</p>}
            </div>
            )}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
    </>
  );
}

const SHORTCUTS: { title: string; rows: [string[], string][] }[] = [
  {
    title: "Everywhere",
    rows: [
      [["?"], "Open or close this list"],
      [["Ctrl \\"], "Open or close the dictionary, even while typing in the terminal"],
      [["/"], "Open the dictionary (when you are not typing)"],
      [["Esc"], "Close a panel. In the terminal: step out of it so letter keys work"],
      [["Tab", "Shift Tab"], "Move between buttons"],
      [["Enter"], "Press the main button: Continue, Check, Next. On the path: play your next level"],
      [["J"], "On the path: scroll to your next level"],
      [["Ctrl Enter"], "The same, even while you are typing"],
    ],
  },
  {
    title: "Answering",
    rows: [
      [["1", "2", "3"], "Pick an answer, a line, a piece, a plan or a switch"],
      [["A", "B", "C"], "Pick a bucket, or a box on the server map"],
      [["↑", "↓"], "Move the picked line up or down"],
      [["H"], "Get a hint (Ctrl H in the terminal)"],
      [["S"], "Show me, after both hints (Ctrl S in the terminal)"],
      [["R"], "Quick review, on the level complete screen"],
    ],
  },
  {
    title: "Terminal",
    rows: [
      [["Enter"], "Run the command"],
      [["Tab"], "Finish a name for you. On an empty line: fill in the command to type"],
      [["Ctrl Space"], "Add the next suggested word to the line"],
      [["↑", "↓"], "Bring back an earlier command"],
      [["Alt 1", "Alt 2"], "Switch terminal window (Ctrl Shift 1 works too)"],
      [["Alt N"], "Open a new window"],
      [["Alt P"], "Open the provider console, when the button is there"],
      [["T"], "Jump back into the terminal"],
      [["Ctrl C"], "Stop what is running"],
      [["Ctrl L"], "Clear the screen"],
    ],
  },
];

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-line2 bg-bg px-1.5 font-mono text-[12px] font-semibold text-ink">
      {children}
    </kbd>
  );
}

/** "?" opens a list of every keyboard shortcut. */
function ShortcutsHelp() {
  const { helpOpen, openHelp, closeHelp } = useUi();
  const panel = useRef<HTMLDivElement>(null);
  useHotkey((e) => e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey, openHelp, !helpOpen);
  useHotkey((e) => e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey, closeHelp, helpOpen, { layer: true });
  useHotkey((e) => e.key === "/" && plain(e), () => useUi.getState().openDict(), !helpOpen);
  useEscapeKey(closeHelp, helpOpen, { layer: true });
  useRestoreFocus(helpOpen);
  useEffect(() => {
    if (helpOpen) panel.current?.focus({ preventScroll: true });
  }, [helpOpen]);
  return (
    <>
      {helpOpen && <KeyLayer />}
      <AnimatePresence>
        {helpOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={closeHelp}
            className="fixed inset-0 z-70 flex items-center justify-center bg-bg/80 p-4"
          >
            <motion.div
              ref={panel}
              data-kb-panel
              role="dialog"
              aria-modal="true"
              aria-labelledby="keys-title"
              tabIndex={-1}
              initial={{ scale: 0.96, y: 8 }}
              animate={{ scale: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 420, damping: 32 }}
              onClick={(e) => e.stopPropagation()}
              className="max-h-[88vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-line2 bg-panel p-5 outline-none scroll-thin"
            >
              <div className="flex items-center">
                <h2 id="keys-title" className="text-[18px] font-semibold text-ink">
                  Keyboard shortcuts
                </h2>
                <button type="button" onClick={closeHelp} className="ml-auto rounded px-2 font-mono text-muted hover:text-ink" aria-label="Close">
                  ✕
                </button>
              </div>
              <p className="mt-1 text-[13px] text-muted">You never need the mouse. Letter and number keys wait while you type in a box.</p>
              <div className="mt-4 grid gap-5 md:grid-cols-2">
                {SHORTCUTS.map((g) => (
                  <section key={g.title} className={g.title === "Terminal" ? "md:col-span-2" : ""}>
                    <h3 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-muted">{g.title}</h3>
                    <ul className={`space-y-1.5 ${g.title === "Terminal" ? "md:grid md:grid-cols-2 md:gap-x-5 md:space-y-0 md:gap-y-1.5" : ""}`}>
                      {g.rows.map(([keys, what]) => (
                        <li key={what} className="flex items-start gap-3 text-[13.5px] leading-snug">
                          <span className="flex min-w-30 shrink-0 flex-wrap gap-1">
                            {keys.map((k) => (
                              <Kbd key={k}>{k}</Kbd>
                            ))}
                          </span>
                          <span className="pt-0.5 text-ink/85">{what}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
              <p className="mt-4 text-[12px] text-faint">
                On a Mac, Cmd works wherever Ctrl is listed. Press <Kbd>Esc</Kbd> or <Kbd>?</Kbd> to close.
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

export function ShakeRoot({ children }: { children: React.ReactNode }) {
  const n = useUi((s) => s.shake);
  const [cls, setCls] = useState("");
  useEffect(() => {
    if (!n) return;
    setCls("shake");
    const t = setTimeout(() => setCls(""), 500);
    return () => clearTimeout(t);
  }, [n]);
  return <div className={cls}>{children}</div>;
}

export default function GlobalLayer() {
  useEffect(() => {
    void hydrateProgress().then(() => startCloudSync());
  }, []);
  return (
    <>
      <Confetti />
      <Toasts />
      <Dictionary />
      <ShortcutsHelp />
    </>
  );
}
