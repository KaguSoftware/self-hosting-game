"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { deriveMap, type MapNode } from "@/sim/map";
import type { TraceResult, World } from "@/sim/types";
import { sfx } from "@/lib/sfx";
import { LETTERS, OptionKey, useLetterKeys, useNumberKeys } from "../play/common";

type Pt = { x: number; y: number };

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
  /** Keyboard: letters tap the boxes (when interactive), numbers flip the switches. Badges show the keys. */
  keys?: boolean;
  className?: string;
  title?: string;
}

/** Plain-English job of each box, for people new to all this. */
const ROLE: Record<MapNode["kind"], string> = {
  client: "someone's browser",
  laptop: "where you type",
  dns: "address book",
  pfw: "front gate",
  vps: "the server",
  ufw: "door lock",
  sshd: "how you log in",
  caddy: "front desk",
  app: "your Next.js code",
  db: "your data",
  svc: "a program",
  volume: "saved files",
  gitlab: "your code repo",
};

const statusClass: Record<MapNode["status"], string> = {
  ok: "border-line2 bg-panel2 text-ink",
  off: "border-dashed border-line2 bg-panel text-muted",
  warn: "border-line2 bg-panel2 text-ink",
  down: "border-red/80 bg-reddim/40 text-ink",
  ghost: "border-dashed border-line bg-bg2 text-faint",
};

// ---------- pixel layout ----------
// Everything is measured in px from the real width, so padding never depends on the screen.

const NODE_H = 64;
const TOGGLE_H = 30;
const TAG_H = 20;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Layout {
  /** Top-left corner of each node box, px. */
  at: Record<string, Pt>;
  /** Node width, px (per node, since outside and inside columns differ). */
  w: Record<string, number>;
  height: number;
  vps: Box;
}

type Slot = { id: string; col: "L" | "R" | "M" } | null;

function extraIds(nodes: MapNode[]): string[] {
  const fixed = new Set(["client", "laptop", "dns", "pfw", "gitlab", "vps", "ufw", "sshd", "caddy", "app", "db"]);
  return nodes.filter((n) => !fixed.has(n.id)).map((n) => n.id);
}

function verticalLayout(nodes: MapNode[], W: number, rented: boolean, extraH: (id: string) => number): Layout {
  const pad = 12;
  const gap = 10;
  const rowGap = 18;
  const boxPad = 12;
  const boxLabel = 14;
  const has = new Set(nodes.map((n) => n.id));
  const at: Record<string, Pt> = {};
  const w: Record<string, number> = {};
  const outW = (W - 2 * pad - gap) / 2;
  const inW = (W - 2 * pad - 2 * boxPad - gap) / 2;
  const colX = (col: "L" | "R" | "M", inside: boolean) => {
    const cw = inside ? inW : outW;
    const left = pad + (inside ? boxPad : 0);
    if (col === "L") return left;
    if (col === "R") return W - left - cw;
    return (W - cw) / 2;
  };
  let y = pad;
  const placeRow = (slots: Slot[], inside: boolean) => {
    const real = slots.filter((s): s is NonNullable<Slot> => !!s && has.has(s.id));
    if (!real.length) return;
    const h = NODE_H + Math.max(...real.map((s) => extraH(s.id)));
    for (const s of real) {
      at[s.id] = { x: colX(s.col, inside), y };
      w[s.id] = inside ? inW : outW;
    }
    y += h + rowGap;
  };
  placeRow([{ id: "client", col: "L" }, { id: "laptop", col: "R" }], false);
  // GitLab lives on the internet, outside your server.
  placeRow([{ id: "dns", col: "L" }, { id: "gitlab", col: "R" }], false);
  placeRow([{ id: "pfw", col: "M" }], false);
  const boxTop = y;
  y += boxPad + boxLabel;
  if (rented) {
    const extras = extraIds(nodes);
    placeRow([{ id: "ufw", col: "M" }], true);
    placeRow([{ id: "caddy", col: "L" }, { id: "sshd", col: "R" }], true);
    const nextExtra = (): Slot => {
      const id = extras.shift();
      return id ? { id, col: "R" } : null;
    };
    placeRow([{ id: "app", col: "L" }, nextExtra()], true);
    placeRow([{ id: "db", col: "L" }, nextExtra()], true);
    while (extras.length) {
      const a = extras.shift()!;
      const b = extras.shift();
      placeRow([{ id: a, col: "L" }, b ? { id: b, col: "R" } : null], true);
    }
    y = y - rowGap + boxPad;
  } else {
    y += 56;
  }
  const vps = { left: pad, top: boxTop, width: W - 2 * pad, height: y - boxTop };
  return { at, w, height: y + pad, vps };
}

function horizontalLayout(nodes: MapNode[], W: number, rented: boolean, extraH: (id: string) => number): Layout {
  const pad = 16;
  const gap = 14;
  const boxPad = 14;
  const boxLabel = 14;
  const rowGap = 26;
  const colW = (W - 2 * pad - 6 * gap - 2 * boxPad) / 7;
  const colX = (i: number) => pad + i * (colW + gap) + (i >= 3 ? boxPad : 0);
  const has = new Set(nodes.map((n) => n.id));
  const at: Record<string, Pt> = {};
  const w: Record<string, number> = {};
  const extras = extraIds(nodes);

  // Rows: 0 = top, 1 = middle, 2 = bottom, 3+ = overflow. Cells are [column, id].
  const rows: [number, string][][] = [
    [
      [0, "client"],
      [1, "dns"],
      [4, "caddy"],
      [5, "app"],
      [6, "db"],
    ],
    [
      [2, "pfw"],
      [3, "ufw"],
    ],
    [
      [0, "laptop"],
      [1, "gitlab"],
      [4, "sshd"],
    ],
  ];
  if (rented) {
    for (const col of [5, 6, 3]) {
      const id = extras.shift();
      if (id) rows[2].push([col, id]);
    }
    while (extras.length) {
      const row: [number, string][] = [];
      for (const col of [3, 4, 5, 6]) {
        const id = extras.shift();
        if (id) row.push([col, id]);
      }
      rows.push(row);
    }
  }
  const boxTop = pad;
  let y = boxTop + boxPad + boxLabel;
  for (const row of rows) {
    const real = row.filter(([, id]) => has.has(id) && (rented || ["client", "dns", "laptop"].includes(id)));
    const h = NODE_H + Math.max(0, ...real.map(([, id]) => extraH(id)));
    for (const [col, id] of real) {
      at[id] = { x: colX(col), y };
      w[id] = colW;
    }
    y += h + rowGap;
  }
  y = y - rowGap + boxPad;
  const vps = { left: colX(3) - boxPad, top: boxTop, width: W - pad - (colX(3) - boxPad), height: y - boxTop };
  return { at, w, height: y + pad, vps };
}

export default function ServerMap(props: ServerMapProps) {
  const { world, trace, traceKey = 0, interactive, onNodeTap, flash, tags, toggles, onToggle, done, forceVertical, className, title, keys } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (!ref.current) return;
    setWidth(ref.current.clientWidth);
    const ro = new ResizeObserver((e) => setWidth(e[0].contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const W = width || 360;
  const vertical = forceVertical || W < 760;
  const model = useMemo(() => deriveMap(world), [world]);
  const rented = world.provider.rented;
  const vpsNode = model.nodes.find((n) => n.id === "vps");

  const extraH = (id: string) =>
    (toggles?.filter((t) => t.node === id).length ?? 0) * TOGGLE_H + (tags !== undefined && (tags[id]?.length || interactive) ? TAG_H : 0);

  const L = useMemo(
    () => (vertical ? verticalLayout(model.nodes, W, rented, extraH) : horizontalLayout(model.nodes, W, rented, extraH)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, W, vertical, rented, toggles?.length, tags ? Object.keys(tags).join() : "", interactive],
  );

  /** Centre of a node box in % of the map, for edges and the packet. */
  const center = (id: string): Pt | undefined => {
    const p = L.at[id];
    if (!p) return undefined;
    return { x: ((p.x + L.w[id] / 2) / W) * 100, y: ((p.y + NODE_H / 2) / L.height) * 100 };
  };
  const vpsCenter: Pt = { x: ((L.vps.left + L.vps.width / 2) / W) * 100, y: ((L.vps.top + L.vps.height / 2) / L.height) * 100 };

  // ----- keyboard -----
  // Boxes get letters (A, B, C... reading order: top to bottom, left to right), switches get numbers.
  const order = model.nodes
    .filter((n) => n.id !== "vps" && L.at[n.id])
    .map((n) => n.id)
    .sort((a, b) => L.at[a].y - L.at[b].y || L.at[a].x - L.at[b].x);
  const nodeKey: Record<string, string> = {};
  if (keys && interactive) order.slice(0, LETTERS.length).forEach((id, i) => (nodeKey[id] = LETTERS[i]));
  const toggleOrder = keys && toggles ? order.flatMap((id) => toggles.filter((x) => x.node === id)) : [];
  const toggleKey = (x: MapToggle) => {
    const i = toggleOrder.findIndex((y) => y.node === x.node && y.label === x.label);
    return i >= 0 && i < 9 ? i + 1 : undefined;
  };
  useLetterKeys(Math.min(order.length, LETTERS.length), (i) => onNodeTap?.(order[i]), !!keys && !!interactive);
  useNumberKeys(toggleOrder.length, (i) => onToggle?.(toggleOrder[i].node, toggleOrder[i].label), !!keys && toggleOrder.length > 0);

  // ----- packet animation -----
  const [packet, setPacket] = useState<{ pts: Pt[]; failed: boolean; key: number } | null>(null);
  const [result, setResult] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    if (!trace || !traceKey) return;
    const pts: Pt[] = [];
    for (const h of trace.hops) {
      const p = h.node === "vps" ? vpsCenter : center(h.node);
      if (p) pts.push(p);
      if (!h.ok) break;
    }
    if (!pts.length) return;
    const failedHop = trace.hops.find((h) => !h.ok);
    setResult(null);
    setPacket({ pts, failed: !trace.ok, key: traceKey });
    const per = reduced ? 0 : 260;
    pts.forEach((_, i) => {
      setTimeout(() => sfx.hop(i < pts.length - 1 || trace.ok), i * per);
    });
    const t = setTimeout(
      () => {
        setResult({
          ok: trace.ok,
          text: trace.ok
            ? trace.kind === "ssh"
              ? "✓ Logged in"
              : `✓ ${trace.status ?? 200}: the request made it`
            : `✕ ${failedHop?.note ?? "failed"}${trace.status ? ` (${trace.status})` : ""}`,
        });
        if (!trace.ok) sfx.fail();
      },
      pts.length * per + 80,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceKey]);

  const pct = (v: number, of: number) => `${(v / of) * 100}%`;

  return (
    <div ref={ref} data-map className={`relative w-full ${className ?? ""}`}>
      {title && <div className="mb-2 text-[12px] text-muted">{title}</div>}
      <div className="relative w-full overflow-hidden rounded-xl border border-line bg-bg2/80" style={{ height: L.height }}>
        <div className="pointer-events-none absolute inset-0 opacity-[0.07] [background-image:linear-gradient(var(--color-line2)_1px,transparent_1px),linear-gradient(90deg,var(--color-line2)_1px,transparent_1px)] [background-size:24px_24px]" />

        {/* the server outline */}
        <div
          className={`absolute rounded-xl border ${rented ? "border-line2 bg-white/[0.015]" : "border-dashed border-line"}`}
          style={{ left: L.vps.left, top: L.vps.top, width: L.vps.width, height: L.vps.height }}
        >
          <div className="absolute -top-2.5 left-3 max-w-[calc(100%-24px)] truncate bg-bg2 px-1.5 font-mono text-[11px] text-ink/80">
            {rented ? vpsNode?.label : "No server yet"}
            {rented && <span className="text-muted"> · {vpsNode?.sub}</span>}
          </div>
          {!rented && <div className="flex h-full items-center justify-center px-4 pt-2 text-center text-[13px] text-faint">You rent one in World 1.</div>}
        </div>

        {/* edges */}
        <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
          {model.edges.map((e) => {
            const a = center(e.from);
            const b = center(e.to);
            if (!a || !b) return null;
            return (
              <line
                key={`${e.from}-${e.to}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={e.kind === "data" ? "var(--color-faint)" : "var(--color-muted)"}
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
            .filter((n) => n.id !== "vps" && L.at[n.id])
            .map((n) => {
              const p = L.at[n.id];
              const f = flash && flash.id === n.id ? flash : null;
              const t = toggles?.filter((x) => x.node === n.id) ?? [];
              const isDone = done?.includes(n.id);
              return (
                <motion.div
                  key={n.id}
                  initial={{ opacity: 0, scale: 0.85 }}
                  animate={{ opacity: 1, scale: 1, left: pct(p.x, W), top: p.y }}
                  exit={{ opacity: 0, scale: 0.85 }}
                  transition={{ type: "spring", stiffness: 380, damping: 30 }}
                  className="absolute z-10"
                  style={{ width: L.w[n.id] }}
                >
                  <button
                    type="button"
                    disabled={!interactive}
                    onClick={() => onNodeTap?.(n.id)}
                    style={{ height: NODE_H }}
                    className={`group relative flex w-full flex-col justify-center rounded-lg border px-2.5 text-left transition ${statusClass[n.status]} ${
                      interactive ? "hover:border-ink hover:bg-panel2 active:scale-[0.97]" : "cursor-default"
                    } ${f?.kind === "good" ? "!border-teal !bg-teal/10" : ""} ${f?.kind === "bad" ? "shake !border-red" : ""} ${
                      isDone ? "opacity-60" : ""
                    } ${n.status === "down" ? "animate-pulse" : ""}`}
                    aria-label={`${n.label}: ${ROLE[n.kind]}. ${n.sub}`}
                    title={`${n.label}: ${n.sub}`}
                  >
                    {nodeKey[n.id] && <OptionKey n={nodeKey[n.id]} small className="absolute right-1.5 top-1.5 bg-bg/60" />}
                    <span className={`truncate text-[12.5px] font-semibold leading-tight ${nodeKey[n.id] ? "pr-5" : ""}`}>{n.label}</span>
                    <span className="mt-0.5 truncate text-[11.5px] leading-tight text-ink/70">{ROLE[n.kind]}</span>
                    <span className="mt-0.5 truncate font-mono text-[10px] leading-tight text-faint">{n.sub.split("\n")[0]}</span>
                  </button>
                  {tags?.[n.id]?.length ? (
                    <div className="mt-1 flex h-4 flex-wrap gap-1 overflow-hidden">
                      {tags[n.id].map((tg) => (
                        <span key={tg} className="truncate rounded bg-teal/15 px-1.5 font-mono text-[10.5px] leading-4 text-teal">
                          {tg}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {t.map((x) => (
                    <button
                      key={x.label}
                      type="button"
                      onClick={() => onToggle?.(x.node, x.label)}
                      title={x.label}
                      className={`mt-1.5 flex h-6 w-full items-center justify-between gap-1 rounded-md border px-2 text-[11.5px] transition ${
                        x.on ? "border-teal/60 bg-teal/10 text-teal" : "border-red/60 bg-red/10 text-red"
                      }`}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        {toggleKey(x) && <OptionKey n={toggleKey(x)!} small tone="border-current text-current" className="opacity-80" />}
                        <span className="truncate">{x.label}</span>
                      </span>
                      <span className={`relative inline-block h-3 w-6 shrink-0 rounded-full ${x.on ? "bg-teal/70" : "bg-line2"}`}>
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
              packet.failed ? "bg-red shadow-[0_0_12px_3px_rgba(248,86,78,0.6)]" : "bg-teal shadow-[0_0_12px_3px_rgba(62,207,116,0.6)]"
            }`}
            initial={{ left: `${packet.pts[0].x}%`, top: `${packet.pts[0].y}%` }}
            animate={{ left: packet.pts.map((p) => `${p.x}%`), top: packet.pts.map((p) => `${p.y}%`) }}
            transition={{ duration: reduced ? 0 : Math.max(0.3, (packet.pts.length - 1) * 0.26), ease: "linear" }}
          />
        )}
      </div>

      {/* what happened to the last request, under the map so it never covers a box */}
      <AnimatePresence mode="wait">
        {result && (
          <motion.div
            key={`r-${traceKey}`}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className={`mt-2 rounded-lg border px-3 py-2 font-mono text-[12px] leading-snug ${
              result.ok ? "border-teal/50 bg-teal/[0.06] text-teal" : "border-red/60 bg-red/[0.06] text-red"
            }`}
            role="status"
          >
            {result.text}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
