"use client";
import { useState } from "react";
import type { World } from "@/sim/types";
import type { CiJob, JobStatus, Pipeline } from "@/sim/gitlab/types";

/** What GitLab writes on a status badge. */
const WORD: Record<JobStatus, string> = {
  success: "passed",
  failed: "failed",
  running: "running",
  pending: "pending",
  created: "created",
  manual: "manual",
  canceled: "canceled",
  skipped: "skipped",
};

const MARK: Record<JobStatus, string> = {
  success: "✓",
  failed: "✕",
  running: "●",
  pending: "○",
  created: "○",
  manual: "▶",
  canceled: "⊘",
  skipped: "»",
};

/** Green is right, red is wrong, everything else stays black and white. */
function pillClass(s: JobStatus): string {
  if (s === "success") return "border-teal text-teal bg-teal/10";
  if (s === "failed") return "border-red text-red bg-red/10";
  if (s === "skipped" || s === "canceled") return "border-dashed border-line2 text-faint";
  return "border-line2 text-ink";
}

function wordClass(s: JobStatus): string {
  return s === "success" ? "text-teal" : s === "failed" ? "text-red" : "text-muted";
}

function stagesOf(p: Pipeline): string[] {
  const used = new Set(p.jobs.map((j) => j.stage));
  return (p.stages ?? [...used]).filter((s) => used.has(s));
}

export interface PipelinePanelProps {
  world: World;
  /** How many of the newest pipelines to show. */
  limit?: number;
  className?: string;
}

/** A read-only view of the latest GitLab pipelines: stages as columns, a pill per job, its log on click. */
export default function PipelinePanel({ world, limit = 3, className = "" }: PipelinePanelProps) {
  const gl = world.gitlab;
  const [open, setOpen] = useState<number | null>(null);
  if (!gl) return null;
  const pipelines = gl.pipelines.slice(-limit).reverse();
  const allJobs = pipelines.flatMap((p) => p.jobs);
  const shown: CiJob | undefined = allJobs.find((j) => j.id === open);

  return (
    <section className={`rounded-xl border border-line bg-panel p-3 md:p-4 ${className}`} aria-label="Pipelines">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="font-mono text-[13px] text-ink">{gl.project.path} · pipelines</h3>
        <span className="font-mono text-[11px] text-muted">{gl.runners.some((r) => r.online) ? "runner online" : "no runner online"}</span>
      </div>

      {!pipelines.length && <p className="text-[14px] text-muted">No pipelines yet. A push with a .gitlab-ci.yml starts one.</p>}

      <ol className="space-y-3">
        {pipelines.map((p) => (
          <li key={p.id} className="rounded-lg border border-line2 bg-panel2 p-3">
            <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-[12px]">
              <span className={wordClass(p.status)}>
                {MARK[p.status]} {WORD[p.status]}
              </span>
              <span className="text-ink">#{p.id}</span>
              <span className="text-muted">{p.ref}</span>
              <span className="text-muted">{p.sha.slice(0, 8)}</span>
              <span className="min-w-0 truncate text-ink/80">{gl.commits[p.sha]?.message.split("\n")[0]}</span>
            </div>

            {p.errors ? (
              <div className="rounded border border-red/60 bg-red/10 px-3 py-2 font-mono text-[12px] text-red">
                <div>Found errors in your .gitlab-ci.yml:</div>
                <ul className="mt-1 list-disc pl-5">
                  {p.errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="flex gap-3 overflow-x-auto pb-1">
                {stagesOf(p).map((stage) => (
                  <div key={stage} className="min-w-[8.5rem] shrink-0">
                    <div className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-muted">{stage}</div>
                    <div className="flex flex-col gap-1.5">
                      {p.jobs
                        .filter((j) => j.stage === stage)
                        .map((j) => (
                          <button
                            key={j.id}
                            type="button"
                            onClick={() => setOpen(open === j.id ? null : j.id)}
                            aria-pressed={open === j.id}
                            aria-label={`${j.name}: ${WORD[j.status]}${j.allowFailure && j.status === "failed" ? " (allowed to fail)" : ""}`}
                            className={`flex items-center gap-2 rounded-full border px-3 py-1 text-left font-mono text-[12px] transition-colors hover:border-ink ${pillClass(j.status)} ${
                              open === j.id ? "ring-1 ring-ink" : ""
                            }`}
                          >
                            <span aria-hidden>{MARK[j.status]}</span>
                            <span className="truncate">{j.name}</span>
                          </button>
                        ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>

      {shown && (
        <div className="mt-3">
          <div className="mb-1 flex items-baseline justify-between gap-3 font-mono text-[12px]">
            <span className="text-ink">
              {shown.name} <span className={wordClass(shown.status)}>{WORD[shown.status]}</span>
            </span>
            <button type="button" onClick={() => setOpen(null)} className="text-muted hover:text-ink">
              close
            </button>
          </div>
          <pre className="max-h-[22rem] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-bg p-3 font-mono text-[12px] leading-relaxed text-ink/90">
            {shown.stuck
              ? shown.stuck
              : shown.log.length
                ? shown.log.join("\n")
                : shown.status === "manual"
                  ? "This job needs someone to press play."
                  : shown.status === "skipped"
                    ? "This job was skipped because an earlier job failed."
                    : "This job has not started yet."}
          </pre>
        </div>
      )}
    </section>
  );
}
