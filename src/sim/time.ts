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

/** "2026-10-11T09:02:11.000000000Z" (docker inspect style) */
export function isoTime(t: number): string {
  return d(t).toISOString().replace(/\.(\d{3})Z$/, ".$1000000Z");
}

/** "2026-10-11 09:02:11.000 UTC" (Postgres log style) */
export function pgTime(t: number): string {
  return d(t).toISOString().replace("T", " ").replace("Z", " UTC");
}

/** Calendar fields for cron. Months are 1-12, weekday 0 = Sunday. */
export function calendar(t: number): { minute: number; hour: number; day: number; month: number; weekday: number; year: number } {
  const x = d(t);
  return { minute: x.getUTCMinutes(), hour: x.getUTCHours(), day: x.getUTCDate(), month: x.getUTCMonth() + 1, weekday: x.getUTCDay(), year: x.getUTCFullYear() };
}

/** date +FORMAT: %F %Y %m %d %H %M %S %s %T %a %b %%. */
export function strftime(t: number, fmt: string): string {
  const x = d(t);
  const map: Record<string, string> = {
    F: `${x.getUTCFullYear()}-${p2(x.getUTCMonth() + 1)}-${p2(x.getUTCDate())}`,
    Y: String(x.getUTCFullYear()),
    m: p2(x.getUTCMonth() + 1),
    d: p2(x.getUTCDate()),
    H: p2(x.getUTCHours()),
    M: p2(x.getUTCMinutes()),
    S: p2(x.getUTCSeconds()),
    T: `${p2(x.getUTCHours())}:${p2(x.getUTCMinutes())}:${p2(x.getUTCSeconds())}`,
    s: String(Math.floor((BASE + t * 1000) / 1000)),
    a: DAYS[x.getUTCDay()],
    b: MONTHS[x.getUTCMonth()],
    "%": "%",
  };
  return fmt.replace(/%(.)/g, (m, c) => map[c] ?? m);
}

/** Unix seconds, for JSON log lines ("ts":1760173331). */
export function unixTime(t: number): number {
  return Math.floor((BASE + t * 1000) / 1000);
}
