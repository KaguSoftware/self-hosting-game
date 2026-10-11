"use client";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { TERMS } from "@/content/dictionary";
import { useUi } from "@/store/ui";
import { startCloudSync } from "@/store/cloud";
import { hydrateProgress } from "@/store/progress";

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
  useEffect(() => setQ(dictQuery), [dictQuery, dictOpen]);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return TERMS.filter((t) => !s || t.term.toLowerCase().includes(s) || t.plain.toLowerCase().includes(s) || (t.replaces ?? "").toLowerCase().includes(s)).sort((a, b) =>
      a.term.localeCompare(b.term),
    );
  }, [q]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && closeDict();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [closeDict]);
  return (
    <AnimatePresence>
      {dictOpen && (
        <>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={closeDict} className="fixed inset-0 z-[60] bg-bg/60" />
          <motion.aside
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
            <div className="p-3">
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search: ufw, volume, 502..."
                className="w-full rounded-lg border border-line2 bg-bg px-3 py-2 font-mono text-[13px] outline-none focus:border-amber"
              />
            </div>
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
          </motion.aside>
        </>
      )}
    </AnimatePresence>
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
    </>
  );
}
