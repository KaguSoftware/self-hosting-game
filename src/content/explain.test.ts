import { describe, expect, it } from "vitest";
import { INCIDENTS, LEVELS, WORLDS } from "./index";
import { explainLine, looksLikeCommand } from "./explain";

/** Cheat sheet lines use " / " and "; " between commands. */
function cheatCommands(cmd: string): string[] {
  return cmd
    .split(/ \/ |; /)
    .map((s) => s.trim())
    .filter(looksLikeCommand);
}

describe("every part of every command is explained", () => {
  it("guides, chips, show me, incident fixes and cheat sheets", () => {
    const missing = new Set<string>();
    const check = (line: string, where: string) => {
      for (const p of explainLine(line)) if (!p.means) missing.add(`${where}: "${p.text}" in "${line}"`);
    };
    for (const l of LEVELS)
      for (const s of l.steps) {
        const t = s.task;
        if (t.kind !== "terminal") continue;
        for (const line of [...(t.guide ?? []), ...(t.chips ?? []), ...t.showMe]) if (looksLikeCommand(line)) check(line, s.id);
      }
    for (const inc of INCIDENTS) for (const line of inc.fix) if (looksLikeCommand(line)) check(line, inc.id);
    for (const w of WORLDS) for (const c of w.cheatSheet) for (const line of cheatCommands(c.cmd)) check(line, `cheat sheet ${w.id}`);
    expect([...missing]).toEqual([]);
  });

  it("explains the example the player asked about", () => {
    const parts = explainLine("sudo chown -R deploy:deploy /srv/crumb");
    expect(parts.map((p) => p.text)).toEqual(["sudo", "chown", "-R", "deploy:deploy", "/srv/crumb"]);
    expect(parts.every((p) => p.means.length > 10)).toBe(true);
    expect(parts[3].means).toMatch(/owner.*group/);
  });

  it("knows a flag's value from the flag (-aG sudo, -u ssh, -n 30)", () => {
    const parts = explainLine("sudo journalctl -u ssh -n 30");
    expect(parts.find((p) => p.text === "ssh")?.means).toMatch(/service/);
    expect(parts.find((p) => p.text === "30")?.means).toMatch(/lines/);
    expect(explainLine("usermod -aG sudo deploy").find((p) => p.text === "sudo")?.means).toMatch(/group/);
  });

  it("explains docker by sub-command, with values and the command inside", () => {
    const run = explainLine("docker run -d --name db -e POSTGRES_PASSWORD=dev -v pgdata:/var/lib/postgresql/data -p 127.0.0.1:5432:5432 postgres:17");
    expect(run.every((p) => p.means), JSON.stringify(run.filter((p) => !p.means))).toBe(true);
    expect(run.find((p) => p.text === "postgres:17")?.means).toMatch(/version/);
    expect(run.find((p) => p.text.startsWith("127.0.0.1:"))?.means).toMatch(/this machine only/);
    const down = explainLine("docker compose down -v");
    expect(down.find((p) => p.text === "-v")?.means).toMatch(/delete the volumes/);
    const exec = explainLine("docker compose exec db psql -U crumb");
    expect(exec.find((p) => p.text === "db")?.means).toMatch(/service/);
    expect(exec.find((p) => p.text === "psql")?.means).toMatch(/inside the container/);
  });

  it("explains pipes and redirects", () => {
    const parts = explainLine("sudo sshd -T | grep -i password");
    expect(parts.find((p) => p.text === "|")?.means).toMatch(/pipe/);
  });
});
