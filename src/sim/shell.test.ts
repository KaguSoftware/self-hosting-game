import { describe, expect, it } from "vitest";
import { produce } from "immer";
import { parse } from "./shell/parse";
import { createShell, runDetached, runScript } from "./shell/run";
import { createWorld, rentVps } from "./worlds";
import { getFile } from "./fs";
import { advance, registerReconciler } from "./tick";
import type { Shell, World } from "./types";

const laptop = (): Shell => createShell("t", { host: "laptop", user: "you", cwd: "/home/you", via: "local" });

function run(lines: string[], w: World = produce(createWorld(), (d) => rentVps(d)), sh: Shell = laptop()) {
  const r = runScript(w, sh, lines);
  return { ...r, text: r.out.map((o) => o.text).join("\n") };
}

describe("parser extras", () => {
  it("splits VAR=x prefixes from the command", () => {
    const seq = parse("TAG=abc123 docker compose up -d", {});
    const cmd = seq.items[0].pipeline.cmds[0];
    expect(cmd.env).toEqual({ TAG: "abc123" });
    expect(cmd.argv.map((w) => w.text)).toEqual(["docker", "compose", "up", "-d"]);
  });
  it("reads < file", () => {
    expect(parse("pg_restore -d crumb < dump.sql", {}).items[0].pipeline.cmds[0].stdinFrom).toBe("dump.sql");
  });
  it("runs $(...) through a callback", () => {
    const seq = parse(`echo backup-$(date +%F).dump "in $(pwd)"`, {}, (inner) => (inner.startsWith("date") ? "2026-10-11\n" : "/srv"));
    expect(seq.items[0].pipeline.cmds[0].argv.map((w) => w.text)).toEqual(["echo", "backup-2026-10-11.dump", "in /srv"]);
  });
});

describe("runner extras", () => {
  it("sets shell variables and passes them on", () => {
    const r = run(["NAME=crumb", "echo hello $NAME"]);
    expect(r.text).toContain("hello crumb");
    expect(r.shell.vars).toEqual({ NAME: "crumb" });
  });
  it("substitutes command output", () => {
    const r = run(["echo now: $(pwd)"]);
    expect(r.text).toContain("now: /home/you");
  });
  it("needs the x bit to run ./script.sh", () => {
    const r1 = run(["echo 'echo it ran' > hi.sh", "./hi.sh"]);
    expect(r1.text).toContain("-bash: ./hi.sh: Permission denied");
    const r2 = run(["chmod +x hi.sh", "./hi.sh"], r1.world, r1.shell);
    expect(r2.text).toContain("it ran");
    const r3 = run(["sh hi.sh"], r1.world, r1.shell);
    expect(r3.text).toContain("it ran");
  });
  it("runs scripts in their own copy of the shell, with set -e", () => {
    const r1 = run(["printf x > /dev/null", "echo 'set -e' > s.sh", "echo 'cd /tmp' >> s.sh", "echo 'false-command' >> s.sh", "echo 'echo never' >> s.sh", "chmod +x s.sh", "./s.sh", "pwd"]);
    expect(r1.text).not.toContain("never");
    expect(r1.text.trim().endsWith("/home/you")).toBe(true);
  });
  it("reads stdin from a file", () => {
    const r = run(["echo 'one two' > f.txt", "wc -w < f.txt"]);
    expect(r.text).toMatch(/\b2\b/);
  });
  it("sed -i replaces in place and keeps the file mode", () => {
    const r = run(["echo 'DATABASE_URL=postgres://u:p@localhost:5432/crumb' > .env", "chmod 600 .env", "sed -i 's/@localhost:/@db:/' .env", "cat .env"]);
    expect(r.text).toContain("@db:5432");
    expect(getFile(r.world.hosts.laptop, "/home/you/.env")?.mode).toBe(0o600);
  });
  it("sleep moves the clock and runs reconcilers", () => {
    let seen = 0;
    registerReconciler("test-counter", (_w, from, to) => (seen += to - from));
    const before = seen;
    const r = run(["sleep 60"]);
    expect(r.world.clock).toBeGreaterThanOrEqual(60);
    expect(seen - before).toBeGreaterThanOrEqual(60);
    registerReconciler("test-counter", () => {});
  });
  it("runDetached runs on a draft with no terminal", () => {
    const w = produce(produce(createWorld(), (d) => rentVps(d)), (d: World) => {
      const r = runDetached(d, { host: "vps", user: "root", cwd: "/root", via: "local" }, "echo hi > /root/from-cron.txt");
      expect(r.code).toBe(0);
    });
    expect(getFile(w.hosts.vps, "/root/from-cron.txt")?.content).toContain("hi");
  });
  it("advance never goes backwards", () => {
    const w = produce(createWorld(), (d) => {
      d.clock = 100;
      advance(d, 50);
    });
    expect(w.clock).toBe(100);
  });
});
