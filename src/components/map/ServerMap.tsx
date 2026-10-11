"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { deriveMap, type MapNode } from "@/sim/map";
import type { TraceResult, World } from "@/sim/types";
import { sfx } from "@/lib/sfx";

type Pt = { x: number; y: number };

const H_SLOTS: Record<string, Pt> = {
  client: { x: 7, y: 24 },
  laptop: { x: 7, y: 74 },
  dns: { x: 22, y: 24 },
  pfw: { x: 37, y: 50 },
  ufw: { x: 53, y: 50 },
  caddy: { x: 66, y: 24 },
  app: { x: 79, y: 24 },
  db: { x: 92, y: 24 },
  sshd: { x: 66, y: 74 },
};
const H_EXTRA: Pt[] = [
  { x: 79, y: 74 },
  { x: 92, y: 74 },
  { x: 92, y: 50 },
  { x: 79, y: 50 },
  { x: 66, y: 50 },
];
const V_SLOTS: Record<string, Pt> = {
  client: { x: 26, y: 5 },
  laptop: { x: 74, y: 5 },
  dns: { x: 26, y: 17 },
  pfw: { x: 50, y: 29 },
  ufw: { x: 50, y: 44 },
  caddy: { x: 27, y: 57 },
  sshd: { x: 73, y: 57 },
  app: { x: 27, y: 70 },
  db: { x: 27, y: 84 },
};
const V_EXTRA: Pt[] = [
  { x: 73, y: 70 },
  { x: 73, y: 84 },
  { x: 50, y: 94 },
  { x: 27, y: 94 },
  { x: 73, y: 94 },
];

const GLYPH: Record<MapNode["kind"], string> = {
  client: "WWW",
  laptop: "~$",
  dns: "DNS",
  pfw: "FW",
  vps: "VPS",
  ufw: "ufw",
  sshd: "SSH",
  caddy: "443",
  app: "APP",
  db: "PG",
  svc: "SVC",
  volume: "VOL",
  gitlab: "GIT",
};

export interface MapToggle {
  node: string;
  label: string;
  on: boolean;
}

export interface ServerMapProps {
  world: World;
  trace?: TraceResult;
  traceKey?: number;
  interactive?: boolean;
  onNodeTap?: (id: string) => void;
  flash?: { id: string; kind: "good" | "bad"; key: number } | null;
  tags?: Record<string, string[]>;
  toggles?: MapToggle[];
  onToggle?: (node: string, label: string) => void;
  /** Node ids to dim (e.g. already-used in a route). */
  done?: string[];
  forceVertical?: boolean;
  className?: string;
  title?: string;
}

function layout(nodes: MapNode[], vertical: boolean): Record<string, Pt> {
  const slots = vertical ? V_SLOTS : H_SLOTS;
  const extra = (vertical ? V_EXTRA : H_EXTRA).slice();
  const out: Record<string, Pt> = {};
  for (const n of nodes) {
    if (n.id === "vps") continue;
    if (slots[n.id]) out[n.id] = slots[n.id];
  }
  const taken = new Set(Object.values(out).map((p) => `${p.x},${p.y}`));
  for (const n of nodes) {
    if (n.id === "vps" || out[n.id]) continue;
    let p = extra.shift();
    while (p && taken.has(`${p.x},${p.y}`)) p = extra.shift();
    if (p) {
      out[n.id] = p;
      taken.add(`${p.x},${p.y}`);
    }
  }
  return out;
}

const statusClass: Record<MapNode["status"], string> = {
  ok: "border-amber/70 bg-panel2 text-ink",
  off: "border-dashed border-line2 bg-panel/70 text-muted",
  warn: "border-yellow/80 bg-panel2 text-ink",
  down: "border-red bg-reddim/40 text-ink",
  ghost: "border-dashed border-line bg-transparent text-faint",
};

export default function ServerMap(props: ServerMapProps) {
  const { world, trace, traceKey = 0, interactive, onNodeTap, flash, tags, toggles, onToggle, done, forceVertical, className, title } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((e) => setWidth(e[0].contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const vertical = forceVertical || width < 620;
  const model = useMemo(() => deriveMap(world), [world]);
  const pos = useMemo(() => layout(model.nodes, vertical), [model, vertical]);
  const vpsNode = model.nodes.find((n) => n.id === "vps");
  const rented = world.provider.rented;

  // ----- packet animation -----
  const [packet, setPacket] = useState<{ pts: Pt[]; failed: boolean; key: number; note: string; at: string; status?: number } | null>(null);
  const [bubble, setBubble] = useState<{ at: string; text: string; ok: boolean } | null>(null);

  useEffect(() => {
    if (!trace || !traceKey) return;
    const pts: Pt[] = [];
    let lastNode = "";
    for (const h of trace.hops) {
      const node = h.node === "vps" ? null : h.node;
      const p = node ? pos[node] : undefined;
      if (!p && h.node === "vps") {
        pts.push(vertical ? { x: 50, y: 70 } : { x: 74, y: 50 });
        lastNode = "vps";
      } else if (p) {
        pts.push(p);
        lastNode = h.node;
      }
      if (!h.ok) break;
    }
    if (!pts.length) return;
    const failedHop = trace.hops.find((h) => !h.ok);
    setBubble(null);
    setPacket({ pts, failed: !trace.ok, key: traceKey, note: failedHop?.note ?? "", at: lastNode, status: trace.status });
    const per = reduced ? 0 : 260;
    pts.forEach((_, i) => {
      setTimeout(() => sfx.hop(i < pts.length - 1 || trace.ok), i * per);
    });
    const t = setTimeout(
      () => {
        setBubble({
          at: lastNode,
          ok: trace.ok,
          text: trace.ok
            ? trace.kind === "ssh"
              ? "✓ logged in"
              : `✓ ${trace.status ?? 200}`
            : `✕ ${failedHop?.note ?? "failed"}${trace.status ? ` (${trace.status})` : ""}`,
        });
        if (!trace.ok) sfx.fail();
      },
      pts.length * per + 80,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceKey]);

  const aspect = vertical ? "aspect-[4/7.4]" : "aspect-[1000/520]";
  const vpsBox = vertical ? { left: 4, top: 37, width: 92, height: 62 } : { left: 46.5, top: 8, width: 52, height: 84 };

  return (
    <div ref={ref} className={`relative w-full ${className ?? ""}`}>
      {title && <div className="mb-1 font-mono text-[11px] uppercase tracking-[0.2em] text-muted">{title}</div>}
      <div className={`relative w-full ${aspect} max-h-[78vh] overflow-hidden rounded-xl border border-line bg-bg2/80`}>
        <div className="pointer-events-none absolute inset-0 opacity-[0.07] [background-image:linear-gradient(var(--color-line2)_1px,transparent_1px),linear-gradient(90deg,var(--color-line2)_1px,transparent_1px)] [background-size:24px_24px]" />
        {/* VPS box */}
        <div
          className={`absolute rounded-xl border ${rented ? "border-amber/40 bg-amber/[0.03]" : "border-dashed border-line"} `}
          style={{ left: `${vpsBox.left}%`, top: `${vpsBox.top}%`, width: `${vpsBox.width}%`, height: `${vpsBox.height}%` }}
        >
          <div className="absolute -top-2.5 left-3 bg-bg2 px-1.5 font-mono text-[10px] uppercase tracking-widest text-amber/80">
            {vpsNode?.label ?? "server"} {rented && <span className="text-muted normal-case">· {vpsNode?.sub}</span>}
          </div>
          {!rented && (
            <div className="flex h-full items-center justify-center p-4 text-center font-mono text-xs text-faint">
              No server yet.
              <br />
              You rent one in World 1.
            </div>
          )}
        </div>

        {/* edges */}
        <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
          {model.edges.map((e) => {
            const a = pos[e.from];
            const b = pos[e.to];
            if (!a || !b) return null;
            const color = e.kind === "ssh" ? "var(--color-teal)" : e.kind === "data" ? "var(--color-faint)" : "var(--color-amber)";
            return (
              <line
                key={`${e.from}-${e.to}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={color}
                strokeOpacity={0.35}
                strokeWidth={1.5}
                strokeDasharray={e.kind === "data" ? "3 3" : e.kind === "ssh" ? "1 3" : undefined}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </svg>

        {/* nodes */}
        <AnimatePresence>
          {model.nodes
            .filter((n) => n.id !== "vps" && pos[n.id])
            .map((n) => {
              const p = pos[n.id];
              const f = flash && flash.id === n.id ? flash : null;
              const t = toggles?.filter((x) => x.node === n.id) ?? [];
              const isDone = done?.includes(n.id);
              return (
                <motion.div
                  key={n.id}
                  layout={!reduced}
                  initial={{ opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.6 }}
                  transition={{ type: "spring", stiffness: 380, damping: 26 }}
                  className="absolute z-10 -translate-x-1/2 -translate-y-1/2"
                  style={{ left: `${p.x}%`, top: `${p.y}%`, width: vertical ? "40%" : "11.5%", minWidth: 84 }}
                >
                  <button
                    type="button"
                    disabled={!interactive}
                    onClick={() => onNodeTap?.(n.id)}
                    className={`group relative block w-full rounded-lg border px-2 py-1.5 text-left transition ${statusClass[n.status]} ${
                      interactive ? "hover:border-teal hover:shadow-[0_0_0_3px_rgba(255,255,255,0.15)] active:scale-[0.97]" : "cursor-default"
                    } ${f?.kind === "good" ? "!border-teal shadow-[0_0_18px_rgba(255,255,255,0.45)]" : ""} ${f?.kind === "bad" ? "shake !border-red" : ""} ${
                      isDone ? "opacity-60" : ""
                    } ${n.status === "down" ? "animate-pulse" : ""}`}
                    aria-label={`${n.label}: ${n.sub}`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`font-display text-[15px] leading-none ${n.status === "ok" ? "text-amber glow" : n.status === "down" ? "text-red" : n.status === "warn" ? "text-yellow" : "text-faint"}`}
                      >
                        {GLYPH[n.kind]}
                      </span>
                      <span className="truncate font-mono text-[11px] font-semibold">{n.label}</span>
                    </div>
                    <div className="mt-0.5 line-clamp-2 whitespace-pre-line font-mono text-[9.5px] leading-tight text-muted">{n.sub}</div>
                    {tags?.[n.id]?.length ? (
                      <div className="mt-1 flex flex-wrap gap-0.5">
                        {tags[n.id].map((tg) => (
                          <span key={tg} className="rounded bg-teal/15 px-1 font-mono text-[9px] leading-4 text-teal">
                            {tg}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </button>
                  {t.map((x) => (
                    <button
                      key={x.label}
                      type="button"
                      onClick={() => onToggle?.(x.node, x.label)}
                      className={`mt-1 flex w-full items-center justify-between gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px] transition ${
                        x.on ? "border-teal/60 bg-teal/10 text-teal" : "border-red/60 bg-red/10 text-red"
                      }`}
                    >
                      <span className="truncate">{x.label}</span>
                      <span className={`relative inline-block h-3 w-6 rounded-full ${x.on ? "bg-teal/70" : "bg-line2"}`}>
                        <span className={`absolute top-0.5 h-2 w-2 rounded-full bg-bg transition-all ${x.on ? "left-3.5" : "left-0.5"}`} />
                      </span>
                    </button>
                  ))}
                </motion.div>
              );
            })}
        </AnimatePresence>

        {/* packet */}
        {packet && (
          <motion.div
            key={packet.key}
            className={`pointer-events-none absolute z-20 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full ${
              packet.failed ? "bg-red shadow-[0_0_14px_4px_rgba(255,93,79,0.7)]" : "bg-teal shadow-[0_0_14px_4px_rgba(255,255,255,0.7)]"
            }`}
            initial={{ left: `${packet.pts[0].x}%`, top: `${packet.pts[0].y}%`, opacity: 1, scale: 1 }}
            animate={{
              left: packet.pts.map((p) => `${p.x}%`),
              top: packet.pts.map((p) => `${p.y}%`),
            }}
            transition={{ duration: reduced ? 0 : Math.max(0.3, (packet.pts.length - 1) * 0.26), ease: "linear" }}
          />
        )}
        {bubble && pos[bubble.at] && (
          <motion.div
            key={`b-${traceKey}`}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className={`absolute bottom-2 left-2 right-2 z-30 rounded-md border px-2 py-1.5 font-mono text-[11px] leading-snug shadow-lg ${
              bubble.ok ? "border-line2 bg-bg text-ink" : "border-red/70 bg-bg text-red"
            }`}
          >
            {bubble.text}
          </motion.div>
        )}
      </div>
    </div>
  );
}
