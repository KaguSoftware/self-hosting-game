import { getDir, getFile, userGroups } from "../../fs";
import { effectiveSshd, parseSshd } from "../../sshd";
import { ago, syslogTime, systemdTime } from "../../time";
import type { Host, JournalLine, Service } from "../../types";
import type { Command, Ctx } from "../ctx";

const ALIAS: Record<string, string> = { sshd: "ssh", "ssh.socket": "ssh" };

export function unitName(raw: string): string {
  const n = raw.replace(/\.service$/, "");
  return ALIAS[n] ?? n;
}

function findService(host: Host, raw: string): Service | undefined {
  return host.services[unitName(raw)];
}

function procLabel(s: Service | undefined, unit: string): string {
  if (unit === "ssh") return `sshd[${s?.pid ?? 1012}]`;
  if (unit === "docker") return `dockerd[${s?.pid ?? 901}]`;
  return `${unit}[${s?.pid ?? 1}]`;
}

export function formatJournal(host: Host, lines: JournalLine[]): string {
  return lines
    .map((l) => `${syslogTime(l.t)} ${host.hostname} ${l.proc ?? procLabel(host.services[l.unit], l.unit)}: ${l.msg}`)
    .join("\n");
}

function denied(ctx: Ctx, verb: string, unit: string): number {
  ctx.err(`Failed to ${verb} ${unit}.service: Interactive authentication required.\nSee system logs and 'systemctl status ${unit}.service' for details.`);
  return 1;
}

/** Start or restart a service. Returns false if it failed. */
export function startService(ctx: Ctx, s: Service): boolean {
  const host = ctx.host;
  if (s.name === "ssh") {
    const parse = parseSshd(host);
    if (parse.errors.length) {
      s.state = "failed";
      for (const e of parse.errors) ctx.journal("ssh", e);
      ctx.journal("ssh", "ssh.service: Control process exited, code=exited, status=255/EXCEPTION", "systemd[1]");
      ctx.journal("ssh", "Failed to start ssh.service - OpenBSD Secure Shell server.", "systemd[1]");
      return false;
    }
    s.loaded = effectiveSshd(host);
  }
  if (s.name === "hello" && !getFile(host, "/srv/hello/server.py")) {
    s.state = "failed";
    ctx.journal("hello", "hello.service: Failed to locate executable /srv/hello/server.py: No such file or directory", "(server.py)[2101]");
    ctx.journal("hello", "hello.service: Main process exited, code=exited, status=203/EXEC", "systemd[1]");
    return false;
  }
  s.state = "active";
  s.since = ctx.w.clock;
  s.pid = s.pid + 17;
  ctx.journal(s.name, `Started ${s.name}.service - ${s.description}.`, "systemd[1]");
  if (s.name === "ssh") ctx.journal("ssh", "Server listening on 0.0.0.0 port 22.");
  if (s.name === "hello") ctx.journal("hello", "Serving HTTP on 0.0.0.0 port 8080 (http://0.0.0.0:8080/) ...");
  return true;
}

function statusText(ctx: Ctx, s: Service): string {
  const host = ctx.host;
  const vendor = s.unitPath.startsWith("/usr/lib") ? "; preset: enabled" : "; preset: enabled";
  const active =
    s.state === "active"
      ? `active (running) since ${systemdTime(s.since)}; ${ago(ctx.w.clock - s.since)}`
      : s.state === "failed"
        ? `failed (Result: exit-code) since ${systemdTime(ctx.w.clock)}; 2s ago`
        : "inactive (dead)";
  const dot = s.state === "active" ? "●" : s.state === "failed" ? "×" : "○";
  const lines = [
    `${dot} ${s.name}.service - ${s.description}`,
    `     Loaded: loaded (${s.unitPath}; ${s.enabled ? "enabled" : "disabled"}${vendor})`,
    `     Active: ${active}`,
  ];
  if (s.triggeredBy) lines.push(`TriggeredBy: ● ${s.triggeredBy}`);
  if (s.state === "active") {
    lines.push(`   Main PID: ${s.pid} (${s.name === "ssh" ? "sshd" : s.name})`, `      Tasks: 1 (limit: 4553)`, `     Memory: 2.3M (peak: 2.9M)`, `        CPU: 38ms`, `     CGroup: /system.slice/${s.name}.service`);
  }
  const canSee = ctx.user === "root" || userGroups(host, ctx.user).some((g) => g === "adm" || g === "systemd-journal");
  const recent = host.journal.filter((l) => l.unit === s.name).slice(-4);
  if (recent.length && canSee) lines.push("", formatJournal(host, recent));
  return lines.join("\n");
}

export const systemctl: Command = {
  name: "systemctl",
  summary: "manage services (systemctl status ssh)",
  run(ctx) {
    const args = ctx.argv.slice(1).filter((a) => !a.startsWith("--") || a === "--now");
    const now = args.includes("--now");
    const rest = args.filter((a) => a !== "--now" && a !== "--no-pager");
    const verb = rest[0];
    const units = rest.slice(1);
    const host = ctx.host;

    if (!verb || verb === "list-units") {
      const rows = Object.values(host.services)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((s) => `  ${(s.name + ".service").padEnd(34)} loaded ${s.state.padEnd(8)} ${s.state === "active" ? "running" : "dead   "} ${s.description}`);
      ctx.out(`  UNIT                               LOAD   ACTIVE   SUB     DESCRIPTION\n${rows.join("\n")}\n\n${rows.length} loaded units listed.`);
      return 0;
    }
    if (verb === "daemon-reload") {
      if (ctx.user !== "root") return denied(ctx, "reload", "daemon");
      const d = getDir(host, "/etc/systemd/system");
      for (const name of Object.keys(d?.children ?? {})) {
        if (!name.endsWith(".service")) continue;
        const n = name.replace(/\.service$/, "");
        if (!host.services[n]) {
          host.services[n] = {
            name: n,
            description: n,
            unitPath: `/etc/systemd/system/${name}`,
            enabled: false,
            state: "inactive",
            since: ctx.w.clock,
            pid: 1700 + n.length,
          };
        }
      }
      return 0;
    }
    if (!units.length) {
      ctx.err(`Too few arguments.`);
      return 1;
    }
    let code = 0;
    const outs: string[] = [];
    for (const raw of units) {
      const s = findService(host, raw);
      const shown = raw.replace(/\.service$/, "");
      if (!s) {
        if (verb === "status") ctx.err(`Unit ${shown}.service could not be found.`);
        else ctx.err(`Failed to ${verb} ${shown}.service: Unit ${shown}.service not found.`);
        code = verb === "status" ? 4 : 5;
        continue;
      }
      switch (verb) {
        case "status":
          outs.push(statusText(ctx, s));
          if (s.state !== "active") code = 3;
          break;
        case "is-active":
          outs.push(s.state === "active" ? "active" : s.state);
          if (s.state !== "active") code = 3;
          break;
        case "is-enabled":
          outs.push(s.enabled ? "enabled" : "disabled");
          if (!s.enabled) code = 1;
          break;
        case "start":
        case "restart":
        case "reload": {
          if (ctx.user !== "root") return denied(ctx, verb, s.name);
          if (verb === "reload" && s.state !== "active") {
            ctx.err(`Job for ${s.name}.service invalid.`);
            return 1;
          }
          if (verb === "start" && s.state === "active") break;
          if (verb === "reload" && s.name === "ssh") {
            const parse = parseSshd(host);
            if (parse.errors.length) {
              ctx.err(`Job for ssh.service failed because the control process exited with error code.\nSee "systemctl status ssh.service" and "journalctl -xeu ssh.service" for details.`);
              for (const e of parse.errors) ctx.journal("ssh", e);
              return 1;
            }
            s.loaded = effectiveSshd(host);
            ctx.journal("ssh", "Received SIGHUP; restarting.");
            break;
          }
          if (!startService(ctx, s)) {
            ctx.err(`Job for ${s.name}.service failed because the control process exited with error code.\nSee "systemctl status ${s.name}.service" and "journalctl -xeu ${s.name}.service" for details.`);
            code = 1;
          }
          break;
        }
        case "stop": {
          if (ctx.user !== "root") return denied(ctx, verb, s.name);
          if (s.state === "active") {
            s.state = "inactive";
            ctx.journal(s.name, `Stopped ${s.name}.service - ${s.description}.`, "systemd[1]");
          }
          if (s.name === "ssh") {
            ctx.info("Your current SSH session keeps running. New logins will fail until ssh starts again.");
          }
          break;
        }
        case "enable":
        case "disable": {
          if (ctx.user !== "root") return denied(ctx, verb, s.name);
          const on = verb === "enable";
          if (s.enabled !== on) {
            s.enabled = on;
            if (on) outs.push(`Created symlink /etc/systemd/system/multi-user.target.wants/${s.name}.service → ${s.unitPath}.`);
            else outs.push(`Removed "/etc/systemd/system/multi-user.target.wants/${s.name}.service".`);
          }
          if (now) {
            if (on && s.state !== "active") startService(ctx, s);
            if (!on && s.state === "active") s.state = "inactive";
          }
          break;
        }
        default:
          ctx.err(`Unknown command verb '${verb}'.`);
          return 1;
      }
    }
    if (outs.length) ctx.out(outs.join("\n\n"));
    return code;
  },
  complete: () => ["status", "start", "stop", "restart", "reload", "enable", "disable", "is-active", "daemon-reload", "list-units"],
};

export const service: Command = {
  name: "service",
  summary: "old style: service ssh restart",
  hidden: true,
  run(ctx) {
    const [name, verb] = ctx.argv.slice(1);
    return systemctl.run({ ...ctx, argv: ["systemctl", verb ?? "status", name ?? ""] });
  },
};

export const journalctl: Command = {
  name: "journalctl",
  summary: "read service logs (journalctl -u ssh -n 20)",
  run(ctx) {
    const host = ctx.host;
    const args = ctx.argv.slice(1);
    let unit: string | undefined;
    let n = Infinity;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-u" || a === "--unit") unit = unitName(args[++i] ?? "");
      else if (a.startsWith("-u") && a.length > 2) unit = unitName(a.slice(2));
      else if (a.startsWith("--unit=")) unit = unitName(a.slice(7));
      else if (a === "-n" || a === "--lines") n = Number(args[++i]);
      else if (/^-n\d+$/.test(a)) n = Number(a.slice(2));
      else if (a === "-xe" || a === "-e") n = Math.min(n, 30);
      else if (a === "-xeu" || a === "-eu") {
        unit = unitName(args[++i] ?? "");
        n = Math.min(n, 30);
      }
    }
    const canSee = ctx.user === "root" || userGroups(host, ctx.user).some((g) => g === "adm" || g === "systemd-journal");
    if (!canSee) {
      ctx.out(
        "Hint: You are currently not seeing messages from other users and the system.\n      Users in groups 'adm', 'systemd-journal' can see all messages.\n      Pass -q to turn off this notice.\n-- No entries --",
      );
      return 0;
    }
    let lines = host.journal;
    if (unit) lines = lines.filter((l) => l.unit === unit);
    if (Number.isFinite(n)) lines = lines.slice(-n);
    if (!lines.length) {
      ctx.out("-- No entries --");
      return 0;
    }
    ctx.out(formatJournal(host, lines));
    return 0;
  },
};

export const SYSTEMD_COMMANDS = [systemctl, service, journalctl];
