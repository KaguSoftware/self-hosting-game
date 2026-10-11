// Sim clock: seconds since 2026-10-11 09:00:00 UTC (a Sunday).
const BASE = Date.UTC(2026, 9, 11, 9, 0, 0);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function d(t: number) {
  return new Date(BASE + t * 1000);
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** "Oct 11 09:02:11" (journal / syslog style) */
export function syslogTime(t: number): string {
  const x = d(t);
  return `${MONTHS[x.getUTCMonth()]} ${p2(x.getUTCDate())} ${p2(x.getUTCHours())}:${p2(x.getUTCMinutes())}:${p2(x.getUTCSeconds())}`;
}

/** "Sun 2026-10-11 09:02:11 UTC" (systemctl style) */
export function systemdTime(t: number): string {
  const x = d(t);
  return `${DAYS[x.getUTCDay()]} ${x.getUTCFullYear()}-${p2(x.getUTCMonth() + 1)}-${p2(x.getUTCDate())} ${p2(x.getUTCHours())}:${p2(x.getUTCMinutes())}:${p2(x.getUTCSeconds())} UTC`;
}

/** "Sun Oct 11 09:02:11 UTC 2026" (date style) */
export function dateTime(t: number): string {
  const x = d(t);
  return `${DAYS[x.getUTCDay()]} ${MONTHS[x.getUTCMonth()]} ${p2(x.getUTCDate())} ${p2(x.getUTCHours())}:${p2(x.getUTCMinutes())}:${p2(x.getUTCSeconds())} UTC ${x.getUTCFullYear()}`;
}

/** "Oct 11 09:02" (ls -l style) */
export function lsTime(t: number): string {
  const x = d(t);
  return `${MONTHS[x.getUTCMonth()]} ${p2(x.getUTCDate())} ${p2(x.getUTCHours())}:${p2(x.getUTCMinutes())}`;
}

export function ago(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.floor(seconds))}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}min ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
}

export function hhmmss(t: number): string {
  const x = d(t);
  return `${p2(x.getUTCHours())}:${p2(x.getUTCMinutes())}:${p2(x.getUTCSeconds())}`;
}
