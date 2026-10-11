// How the docker CLI prints things: durations, tables, the PORTS and STATUS columns.
import type { Container, Host, World } from "../types";
import { hashHex } from "../util";
import { localImage } from "./images";

/** Go's units.HumanDuration, used all over docker ps. */
export function humanDuration(seconds: number): string {
  const s = Math.floor(seconds);
  if (s < 1) return "Less than a second";
  if (s === 1) return "1 second";
  if (s < 60) return `${s} seconds`;
  const m = Math.floor(s / 60);
  if (m === 1) return "About a minute";
  if (m < 60) return `${m} minutes`;
  const h = Math.round(s / 3600);
  if (h === 1) return "About an hour";
  if (h < 48) return `${h} hours`;
  if (h < 24 * 7 * 2) return `${Math.floor(h / 24)} days`;
  if (h < 24 * 30 * 2) return `${Math.floor(h / 24 / 7)} weeks`;
  if (h < 24 * 365 * 2) return `${Math.floor(h / 24 / 30)} months`;
  return `${Math.floor(h / 24 / 365)} years`;
}

/** Docker's tabwriter: every column but the last padded to its widest cell plus 3 spaces. */
export function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, [...c].length)));
  return rows
    .map((r) => r.map((c, i) => (i === r.length - 1 ? c : c + " ".repeat(widths[i] - [...c].length + 3))).join("").trimEnd())
    .join("\n");
}

export function shortId(c: Container): string {
  return c.id.slice(0, 12);
}

/** 64 hex characters. Old hand-built containers have 12, so the rest is derived from them. */
export function fullId(id: string): string {
  return id.length >= 64 ? id.slice(0, 64) : id + hashHex("id:" + id, 64 - id.length);
}

export function startedAt(c: Container): number {
  return c.startedAt ?? c.createdAt;
}

/** The STATUS column. */
export function statusText(w: World, c: Container): string {
  const since = (t: number | undefined) => humanDuration(w.clock - (t ?? c.createdAt));
  switch (c.status) {
    case "running": {
      const h = c.health === "starting" ? " (health: starting)" : c.health ? ` (${c.health})` : "";
      return `Up ${since(startedAt(c))}${h}`;
    }
    case "restarting":
      return `Restarting (${c.exitCode ?? 1}) ${since(c.finishedAt)} ago`;
    case "exited":
      return `Exited (${c.exitCode ?? 0}) ${since(c.finishedAt)} ago`;
    case "created":
      return "Created";
  }
}

/** The PORTS column: published ports, then exposed ones nobody published. */
export function portsText(host: Host, c: Container): string {
  if (c.status !== "running") return "";
  const parts: string[] = [];
  for (const p of c.ports) {
    if (p.hostIp === "0.0.0.0") parts.push(`0.0.0.0:${p.hostPort}->${p.containerPort}/tcp`, `[::]:${p.hostPort}->${p.containerPort}/tcp`);
    else parts.push(`${p.hostIp}:${p.hostPort}->${p.containerPort}/tcp`);
  }
  const exposed = localImage(host, c.image)?.meta?.exposed ?? defaultExposed(c);
  for (const e of exposed) if (!c.ports.some((p) => p.containerPort === e)) parts.push(`${e}/tcp`);
  return parts.join(", ");
}

function defaultExposed(c: Container): number[] {
  if (c.kind === "postgres") return [5432];
  if (c.kind === "caddy") return [80, 443, 2019];
  return c.listenPort ? [c.listenPort] : [];
}

/** The full command a container runs (entrypoint + cmd). */
export function commandOf(host: Host, c: Container): string[] {
  const meta = localImage(host, c.image)?.meta;
  const cmd = c.command?.length ? c.command : (meta?.cmd ?? defaultCmd(c));
  return [...(meta?.entrypoint ?? []), ...cmd];
}

function defaultCmd(c: Container): string[] {
  if (c.kind === "postgres") return ["docker-entrypoint.sh", "postgres"];
  if (c.kind === "caddy") return ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"];
  if (c.kind === "nextjs") return ["docker-entrypoint.sh", "node", "server.js"];
  return ["/bin/sh"];
}

/** The COMMAND column: quoted and cut at 20 characters with an ellipsis. */
export function commandText(host: Host, c: Container): string {
  const s = commandOf(host, c).join(" ");
  return `"${s.length > 20 ? s.slice(0, 19) + "…" : s}"`;
}
