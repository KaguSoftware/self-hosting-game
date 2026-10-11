import { describe, expect, it } from "vitest";
import { produce } from "immer";
import { replay } from "@/content";
import { cronCommand, parseCrontab } from "./cron";
import { file, getDir, getFile, put } from "./fs";
import { createShell, runScript } from "./shell/run";
import { strftime } from "./time";
import type { Shell, World } from "./types";

const VARS = { deployPassword: "test-pass-1" };

function server(): { w: World; sh: Shell } {
  const w = replay.levelEndWorld(replay.levelById("w5-08")!, VARS);
  return { w, sh: createShell("t", { host: "vps", user: "deploy", cwd: "/home/deploy", via: "ssh", remote: "203.0.113.10" }) };
}

function run(s: { w: World; sh: Shell }, lines: string[]) {
  const r = runScript(s.w, s.sh, lines, VARS);
  return { w: r.world, sh: r.shell, text: r.out.map((o) => o.text).join("\n") };
}

describe("cron", () => {
  it("parses schedules and refuses bad ones", () => {
    expect(parseCrontab("15 3 * * * /srv/crumb/backup.sh", "deploy").jobs).toHaveLength(1);
    expect(parseCrontab("@daily /x.sh", "deploy").jobs[0].hour.has(0)).toBe(true);
    expect(parseCrontab("61 3 * * * /x.sh", "deploy").errors[0]).toMatch(/bad minute/);
  });

  it("an unescaped % ends the command", () => {
    expect(cronCommand("echo $(date +%F)")).toBe("echo $(date +");
    expect(cronCommand("echo $(date +\\%F)")).toBe("echo $(date +%F)");
  });

  it("runs a job when its time comes", () => {
    const s = server();
    let r = run(s, ["mkdir -p /home/deploy/out", "echo '15 3 * * * echo ran-at-$(date +\\%H\\%M) >> /home/deploy/out/log' | crontab -", "crontab -l"]);
    expect(r.text).toContain("15 3 * * *");
    expect(getFile(r.w.hosts.vps, "/home/deploy/out/log")).toBeUndefined();
    r = run(r, ["sleep 20h"]);
    expect(getFile(r.w.hosts.vps, "/home/deploy/out/log")?.content).toContain("ran-at-0315");
    expect(r.w.hosts.vps.journal.some((j) => j.unit === "cron" && /\(deploy\) CMD/.test(j.msg))).toBe(true);
  });

  it("with an unescaped %, the job breaks quietly", () => {
    const s = server();
    const r = run(s, ["mkdir -p /home/deploy/out", "echo '15 3 * * * echo ran-$(date +%F) >> /home/deploy/out/log' | crontab -", "sleep 20h"]);
    expect(getFile(r.w.hosts.vps, "/home/deploy/out/log")).toBeUndefined();
  });

  it("cron has no terminal: compose exec needs -T", () => {
    const s = server();
    const bad = run(s, ["echo '0 4 * * * cd /srv/crumb && docker compose exec db pg_isready > /home/deploy/no-tty.txt 2>&1' | crontab -", "sleep 20h"]);
    expect(getFile(bad.w.hosts.vps, "/home/deploy/no-tty.txt")?.content ?? "").not.toMatch(/accepting/);
    const tty = run(s, ["cd /srv/crumb", "docker compose exec db echo hi"]);
    expect(tty.text).not.toContain("not a TTY");
  });

  it("crontab -l without a crontab", () => {
    expect(run(server(), ["crontab -l"]).text).toContain("no crontab for deploy");
  });
});

describe("date", () => {
  it("formats like the real date", () => {
    expect(strftime(0, "%F")).toBe("2026-10-11");
    expect(run(server(), ["date +%F"]).text).toMatch(/^2026-10-11$/m);
  });
});

describe("rclone", () => {
  it("needs a configured remote, then copies up and down", () => {
    const s = server();
    let w = produce(s.w, (d) => {
      d.hosts.vps.packages.rclone = { version: "1.60.1" };
      put(d.hosts.vps, "/home/deploy/backups", { type: "dir", children: {}, mode: 0o755, owner: "deploy", group: "deploy" });
      put(d.hosts.vps, "/home/deploy/backups/crumb-2026-10-12.dump", file("PGDMP...", 0o600, "deploy", "deploy"));
    });
    const missing = run({ ...s, w }, ["rclone copy /home/deploy/backups offsite:crumb-backups"]);
    expect(missing.text).toContain("didn't find section in config file");
    w = produce(w, (d) => {
      for (const p of ["/home/deploy/.config", "/home/deploy/.config/rclone"]) put(d.hosts.vps, p, { type: "dir", children: {}, mode: 0o700, owner: "deploy", group: "deploy" });
      put(d.hosts.vps, "/home/deploy/.config/rclone/rclone.conf", file("[offsite]\ntype = s3\nprovider = Other\n", 0o600, "deploy", "deploy"));
    });
    const up = run({ ...s, w }, ["rclone copy /home/deploy/backups offsite:crumb-backups", "rclone ls offsite:crumb-backups"]);
    expect(up.text).toContain("crumb-2026-10-12.dump");
    const down = run({ ...up }, ["mkdir /home/deploy/restore", "rclone copy offsite:crumb-backups /home/deploy/restore"]);
    expect(getDir(down.w.hosts.vps, "/home/deploy/restore")?.children["crumb-2026-10-12.dump"]).toBeDefined();
  });
});

describe("reboot", () => {
  it("brings back services and containers by restart policy, and drops ssh", () => {
    const s = server();
    const sh = createShell("t", { host: "laptop", user: "you", cwd: "/home/you", via: "local" });
    sh.frames.push({ host: "vps", user: "deploy", cwd: "/home/deploy", via: "ssh", remote: "203.0.113.10" });
    const r = run({ w: s.w, sh }, ["sudo reboot", VARS.deployPassword]);
    expect(r.sh.frames).toHaveLength(1);
    expect(r.text).toContain("closed by remote host");
    const cs = Object.values(r.w.hosts.vps.docker.containers).filter((c) => c.project === "crumb");
    expect(cs.length).toBeGreaterThan(0);
    expect(cs.every((c) => c.status === "running")).toBe(true);
  });
});
