// cron: runs each user's scheduled jobs as the sim clock passes their time.
// Real gotchas kept: cron's shell is /bin/sh with no terminal, an unescaped % ends the
// command, and output goes nowhere ("No MTA installed, discarding output").
import { dir, file, getDir, getFile, put } from "./fs";
import { runDetached } from "./shell/run";
import { registerReconciler } from "./tick";
import { calendar } from "./time";
import type { Host, World } from "./types";

export const SPOOL = "/var/spool/cron/crontabs";

export const CRONTAB_TEMPLATE = `# Edit this file to introduce tasks to be run by cron.
#
# Each task to run has to be defined through a single line
# indicating with different fields when the task will be run
# and what command to run for the task
#
# To define the time you can provide concrete values for
# minute (m), hour (h), day of month (dom), month (mon),
# and day of week (dow) or use '*' in these fields (for 'any').
#
# Notice that tasks will be started based on the cron's system
# daemon's notion of time and timezones.
#
# Output of the crontab jobs (including errors) is sent through
# email to the user the crontab file belongs to (unless redirected).
#
# For example, you can run a backup of all your user accounts
# at 5 a.m every week with:
# 0 5 * * 1 tar -zcf /var/backups/home.tgz /home/
#
# For more information see the manual pages of crontab(5) and cron(8)
#
# m h  dom mon dow   command
`;

export interface CronJob {
  user: string;
  min: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  mon: Set<number>;
  dow: Set<number>;
  /** Day of month and day of week both restricted: real cron runs when EITHER matches. */
  domOrDow: boolean;
  command: string;
  line: string;
}

const MACROS: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

function field(text: string, lo: number, hi: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    let [a, b] = [lo, hi];
    if (m[1] !== "*") {
      const r = m[1].split("-").map(Number);
      a = r[0];
      b = r[1] ?? (m[2] ? hi : r[0]);
    }
    const step = m[2] ? Number(m[2]) : 1;
    if (a < lo || b > hi || a > b || step < 1) return null;
    for (let v = a; v <= b; v += step) out.add(v === 7 && hi === 7 ? 0 : v);
  }
  return out;
}

/** Parse a crontab. Returns jobs, and errors in crontab's own wording. */
export function parseCrontab(text: string, user: string): { jobs: CronJob[]; errors: string[] } {
  const jobs: CronJob[] = [];
  const errors: string[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) return; // PATH=..., MAILTO=...
    let rest = line;
    let spec: string[];
    const macro = Object.keys(MACROS).find((k) => line.startsWith(k + " ") || line.startsWith(k + "\t"));
    if (macro) {
      spec = MACROS[macro].split(" ");
      rest = line.slice(macro.length).trim();
    } else if (line.startsWith("@reboot")) {
      return;
    } else {
      const parts = line.split(/\s+/);
      spec = parts.slice(0, 5);
      rest = parts.slice(5).join(" ");
    }
    const [mi, ho, dm, mo, dw] = [field(spec[0] ?? "", 0, 59), field(spec[1] ?? "", 0, 23), field(spec[2] ?? "", 1, 31), field(spec[3] ?? "", 1, 12), field(spec[4] ?? "", 0, 7)];
    const names = ["minute", "hour", "day-of-month", "month", "day-of-week"];
    const bad = [mi, ho, dm, mo, dw].findIndex((x) => !x);
    if (bad >= 0 || !rest) {
      errors.push(`"-":${i + 1}: bad ${bad >= 0 ? names[bad] : "command"}`);
      return;
    }
    jobs.push({ user, min: mi!, hour: ho!, dom: dm!, mon: mo!, dow: dw!, domOrDow: spec[2] !== "*" && spec[4] !== "*", command: rest, line });
  });
  return { jobs, errors };
}

export function matches(job: CronJob, t: number): boolean {
  const c = calendar(t);
  if (!job.min.has(c.minute) || !job.hour.has(c.hour) || !job.mon.has(c.month)) return false;
  return job.domOrDow ? job.dom.has(c.day) || job.dow.has(c.weekday) : job.dom.has(c.day) && job.dow.has(c.weekday);
}

/** What cron actually runs: everything after an unescaped % becomes input, not command. */
export function cronCommand(command: string): string {
  let out = "";
  for (let i = 0; i < command.length; i++) {
    if (command[i] === "\\" && command[i + 1] === "%") {
      out += "%";
      i++;
    } else if (command[i] === "%") break;
    else out += command[i];
  }
  return out;
}

export function userCrontab(host: Host, user: string): string | undefined {
  return getFile(host, `${SPOOL}/${user}`)?.content;
}

export function installCrontab(host: Host, user: string, text: string): string[] {
  const { errors } = parseCrontab(text, user);
  if (errors.length) return errors;
  if (!getDir(host, "/var/spool/cron")) put(host, "/var/spool/cron", dir(0o755));
  if (!getDir(host, SPOOL)) put(host, SPOOL, dir(0o1730, "root", "crontab"));
  put(host, `${SPOOL}/${user}`, file(text.endsWith("\n") ? text : text + "\n", 0o600, user, "crontab"));
  return [];
}

function allJobs(host: Host): CronJob[] {
  const out: CronJob[] = [];
  const spool = getDir(host, SPOOL);
  for (const [user, node] of Object.entries(spool?.children ?? {})) if (node.type === "file") out.push(...parseCrontab(node.content, user).jobs);
  const d = getDir(host, "/etc/cron.d");
  for (const node of Object.values(d?.children ?? {})) {
    if (node.type !== "file") continue;
    // /etc/cron.d lines have a user field after the schedule.
    for (const raw of node.content.split("\n")) {
      const parts = raw.trim().split(/\s+/);
      if (parts.length < 7 || raw.trim().startsWith("#")) continue;
      const user = parts[5];
      out.push(...parseCrontab(`${parts.slice(0, 5).join(" ")} ${parts.slice(6).join(" ")}`, user).jobs);
    }
  }
  return out;
}

let cronPid = 30000;

/** Run every job whose minute passed between `from` and `to`. */
export function reconcileCron(w: World, from: number, to: number): void {
  const host = w.hosts.vps;
  if (!w.provider.rented || host.services.cron?.state !== "active") return;
  const jobs = allJobs(host);
  if (!jobs.length) return;
  const first = Math.floor(from / 60) + 1;
  const last = Math.floor(to / 60);
  // A very long jump runs each job at most for its last few due times, like a machine that slept.
  for (let m = Math.max(first, last - 2 * 24 * 60); m <= last; m++) {
    const t = m * 60;
    for (const job of jobs) {
      if (!matches(job, t)) continue;
      const user = host.users[job.user];
      if (!user) continue;
      const pid = ++cronPid;
      host.journal.push({ t, unit: "cron", proc: `CRON[${pid}]`, msg: `(${job.user}) CMD (${job.command})` });
      const saved = w.clock;
      w.clock = t;
      const r = runDetached(w, { host: "vps", user: job.user, cwd: user.home, via: "local", noTty: true }, cronCommand(job.command), { HOME: user.home, PATH: "/usr/bin:/bin" });
      w.clock = Math.max(w.clock, saved);
      if (r.out.trim()) host.journal.push({ t, unit: "cron", proc: `CRON[${pid}]`, msg: "(CRON) info (No MTA installed, discarding output)" });
      if (host.journal.length > 600) host.journal.splice(0, host.journal.length - 600);
    }
  }
}

registerReconciler("cron", reconcileCron);
