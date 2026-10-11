import type { Level, Step, WorldDef } from "@/content/schema";
import type { LogEntry } from "@/sim/predicates";
import type { TermLine } from "@/store/play";

/** Text to paste into Claude chat when stuck. */
export function buildContext(opts: {
  world?: WorldDef;
  level: Level;
  step: Step;
  stepIdx: number;
  goals?: { describe: string; met: boolean }[];
  log: LogEntry[];
  lines: TermLine[];
  hintsSeen?: string[];
}): string {
  const { world, level, step, stepIdx, goals, log, lines } = opts;
  const out: string[] = [];
  out.push("I'm playing a hands-on game that teaches self-hosting (Ubuntu 24.04, Docker Compose v2, Caddy 2, Postgres 17, GitLab CI). It has a simulated terminal.");
  out.push("I'm a Next.js developer who has only used Vercel and Supabase. Please explain simply.");
  out.push("");
  if (world) out.push(`World ${world.id}: ${world.title}`);
  out.push(`Level: ${level.title} (step ${stepIdx + 1} of ${level.steps.length})`);
  out.push(`Mission: ${step.mission}`);
  if (step.intel) out.push(`Intel shown: ${step.intel.lines.join(" ")}`);
  const t = step.task;
  if (t.kind === "predict") out.push(`Question: ${t.question}\nOptions: ${t.options.join(" | ")}`);
  if ("prompt" in t && t.prompt) out.push(`Task: ${t.prompt}`);
  if (goals?.length) out.push(`Goals:\n${goals.map((g) => `  [${g.met ? "x" : " "}] ${g.describe}`).join("\n")}`);
  if (log.length) {
    out.push("");
    out.push("What I tried (last commands and output):");
    for (const e of log.slice(-15)) {
      if (e.line === "(answer)") continue;
      out.push(`${e.user}@${e.host === "vps" ? "web-1" : "laptop"}$ ${e.line}`);
      if (e.out) out.push(e.out.split("\n").slice(0, 14).join("\n"));
    }
  } else if (lines.length) {
    out.push("");
    out.push("Terminal so far:");
    out.push(
      lines
        .slice(-30)
        .map((l) => l.text)
        .join("\n"),
    );
  }
  if (opts.hintsSeen?.length) out.push(`Hints I saw: ${opts.hintsSeen.join(" / ")}`);
  out.push("");
  out.push("My question: ");
  return out.join("\n");
}
