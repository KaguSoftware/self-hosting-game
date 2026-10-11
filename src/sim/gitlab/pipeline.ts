// Pipelines over sim time: a push creates one, jobs go created -> pending -> running ->
// success/failed as runners pick them up, stage after stage. A tick reconciler moves them.
import { registerReconciler } from "../tick";
import type { World } from "../types";
import { parseCi, planPipeline } from "./ci";
import { estimateSeconds, executeJob, jobHeader, predefinedVars, visibleVars, BUILDS_DIR } from "./jobs";
import { isProtected } from "./state";
import type { CiJob, GitLabState, JobStatus, Pipeline, PipelineStatus, Runner } from "./types";

export interface NewPipeline {
  ref: string;
  sha: string;
  source?: Pipeline["source"];
  mergeRequest?: number;
}

const FINAL: JobStatus[] = ["success", "failed", "canceled", "skipped"];

/**
 * What GitLab does on a push: read .gitlab-ci.yml at that commit and create a pipeline.
 * Returns undefined when no pipeline is created (no CI file, or rules left no jobs).
 */
export function createPipeline(w: World, np: NewPipeline): Pipeline | undefined {
  const gl = w.gitlab;
  if (!gl) return undefined;
  const commit = gl.commits[np.sha];
  const text = commit?.files[".gitlab-ci.yml"];
  if (text === undefined) return undefined;
  const source = np.source ?? "push";
  const protectedRef = source !== "merge_request_event" && isProtected(gl, np.ref);
  const base: Pipeline = {
    id: gl.nextPipelineId,
    iid: gl.pipelines.length + 1,
    sha: np.sha,
    ref: np.ref,
    source,
    status: "created",
    jobs: [],
    createdAt: w.clock,
    protectedRef,
    ...(np.mergeRequest !== undefined ? { mergeRequest: np.mergeRequest } : {}),
  };
  const parsed = parseCi(text);
  const failWith = (errors: string[]): Pipeline => {
    gl.nextPipelineId++;
    const p: Pipeline = { ...base, status: "failed", errors, finishedAt: w.clock };
    gl.pipelines.push(p);
    return p;
  };
  if (!parsed.ok || !parsed.config) return failWith(parsed.errors);
  const cfg = parsed.config;
  const predefined = predefinedVars(gl, base);
  const project: Record<string, string> = {};
  for (const v of visibleVars(gl, protectedRef)) project[v.key] = v.type === "file" ? `${BUILDS_DIR}.tmp/${v.key}` : v.value;
  const plan = planPipeline(cfg, predefined, project, np.ref, source);
  if (plan.none) return undefined;
  if (plan.errors) return failWith(plan.errors);
  gl.nextPipelineId++;
  const stageIdx = (s: string) => cfg.stages.indexOf(s);
  const planned = [...plan.jobs].sort((a, b) => stageIdx(a.spec.stage) - stageIdx(b.spec.stage));
  const p: Pipeline = {
    ...base,
    jobs: planned.map((j) => ({
      id: gl.nextJobId++,
      name: j.spec.name,
      stage: j.spec.stage,
      status: "created",
      log: [],
      when: j.when,
      allowFailure: j.allowFailure,
      spec: { ...j.spec, variables: { ...cfg.variables, ...j.spec.variables } },
    })),
  };
  p.stages = cfg.stages;
  gl.pipelines.push(p);
  settleNow(w, gl);
  return p;
}

function stagesOf(p: Pipeline): string[] {
  return p.stages ?? [...new Set(p.jobs.map((j) => j.stage))];
}

/** Jobs this one waits for: its needs, or every job in an earlier stage. */
export function depsOf(p: Pipeline, job: CiJob): CiJob[] {
  if (job.spec.needs !== undefined) return p.jobs.filter((j) => job.spec.needs!.includes(j.name));
  const st = stagesOf(p);
  const mine = st.indexOf(job.stage);
  return p.jobs.filter((j) => st.indexOf(j.stage) < mine);
}

function tagsMatch(r: Runner, job: CiJob): boolean {
  if (!job.spec.tags.length) return r.runUntagged !== false;
  return job.spec.tags.every((t) => r.tags.includes(t));
}

/** GitLab's message on a job that stays pending. */
export function stuckMessage(gl: GitLabState, p: Pipeline, job: CiJob): string {
  const online = gl.runners.filter((r) => r.online && (!r.protected || p.protectedRef));
  if (job.spec.tags.length && !online.some((r) => tagsMatch(r, job))) {
    return `This job is stuck because you don't have any active runners online or available with any of these tags assigned to them: ${job.spec.tags.join(" ")}`;
  }
  if (!online.length) return "This job is stuck because the project doesn't have any runners online assigned to it.";
  return "This job is stuck because you don't have any active runners that can run this job.";
}

function pickRunner(gl: GitLabState, p: Pipeline, job: CiJob): Runner | undefined | "busy" {
  const fits = gl.runners.filter((r) => r.online && tagsMatch(r, job) && (!r.protected || p.protectedRef));
  if (!fits.length) return undefined;
  const busy = new Set(gl.pipelines.flatMap((x) => x.jobs.filter((j) => j.status === "running").map((j) => j.runnerId)));
  return fits.find((r) => !busy.has(r.id)) ?? "busy";
}

function failedHard(j: CiJob): boolean {
  return (j.status === "failed" && !j.allowFailure) || j.status === "canceled";
}

/** Move one pipeline as far as it can go at time `now`. Returns true if anything changed. */
function step(w: World, gl: GitLabState, p: Pipeline, now: number): boolean {
  if (p.errors) return false;
  let changed = false;
  for (const job of p.jobs) {
    if (job.status === "created") {
      const deps = depsOf(p, job);
      const waiting = deps.some((d) => !FINAL.includes(d.status) && !(d.status === "manual" && d.allowFailure));
      if (waiting) continue;
      const failed = deps.some(failedHard) || deps.some((d) => d.status === "skipped" && job.spec.needs?.includes(d.name));
      const when = job.when ?? "on_success";
      let next: JobStatus;
      if (when === "always") next = "pending";
      else if (when === "on_failure") next = failed ? "pending" : "skipped";
      else if (failed) next = "skipped";
      else next = when === "manual" ? "manual" : "pending";
      job.status = next;
      if (next === "skipped") job.finishedAt = now;
      changed = true;
    }
    if (job.status === "pending") {
      const r = pickRunner(gl, p, job);
      if (r === undefined) {
        const msg = stuckMessage(gl, p, job);
        if (job.stuck !== msg) {
          job.stuck = msg;
          changed = true;
        }
      } else if (r !== "busy") {
        job.status = "running";
        job.stuck = undefined;
        job.runnerId = r.id;
        job.startedAt = now;
        job.finishAt = now + estimateSeconds(job);
        job.log = jobHeader(job, r);
        changed = true;
      } else if (job.stuck) {
        job.stuck = undefined;
        changed = true;
      }
    }
    if (job.status === "running" && job.finishAt !== undefined && job.finishAt <= now) {
      const runner = gl.runners.find((x) => x.id === job.runnerId) ?? gl.runners[0];
      const deps = depsOf(p, job);
      const res = executeJob(w, p, job, runner, deps);
      job.status = res.status;
      job.log = res.log;
      job.finishedAt = job.finishAt;
      job.finishAt = undefined;
      if (res.artifacts) job.artifacts = res.artifacts;
      if (res.failureReason) job.failureReason = res.failureReason;
      changed = true;
    }
  }
  const before = p.status;
  p.status = pipelineStatus(p);
  if (FINAL.includes(p.status) && p.finishedAt === undefined) p.finishedAt = now;
  if (!FINAL.includes(p.status)) p.finishedAt = undefined;
  return changed || before !== p.status;
}

/** The pipeline's badge, from its jobs. */
export function pipelineStatus(p: Pipeline): PipelineStatus {
  if (p.errors) return "failed";
  const js = p.jobs;
  if (!js.length) return "skipped";
  if (js.some((j) => j.status === "running")) return "running";
  const started = js.some((j) => j.status !== "created" && j.status !== "pending");
  if (js.some((j) => j.status === "pending")) return started ? "running" : "pending";
  if (js.some((j) => j.status === "created")) {
    const blocked = js.some((j) => j.status === "manual" && !j.allowFailure);
    return blocked ? "manual" : started ? "running" : "created";
  }
  if (js.some((j) => j.status === "manual" && !j.allowFailure)) return "manual";
  if (js.some(failedHard)) return js.some((j) => j.status === "failed") ? "failed" : "canceled";
  if (js.every((j) => j.status === "skipped")) return "skipped";
  return "success";
}

/** Settle from outside the reconciler (a push, a button), with the same re-entry guard. */
function settleNow(w: World, gl: GitLabState): void {
  if (busy) return;
  busy = true;
  try {
    settle(w, gl, w.clock);
  } finally {
    busy = false;
  }
}

function settle(w: World, gl: GitLabState, now: number): void {
  for (let guard = 0; guard < 50; guard++) {
    let any = false;
    for (const p of gl.pipelines) if (!FINAL.includes(p.status) || p.jobs.some((j) => !FINAL.includes(j.status))) any = step(w, gl, p, now) || any;
    if (!any) break;
  }
}

let busy = false;

/** The tick reconciler: walk from `from` to `to`, finishing jobs at the moment they end. */
export function reconcilePipelines(w: World, from: number, to: number): void {
  const gl = w.gitlab;
  if (!gl || busy) return;
  busy = true;
  try {
    let t = from;
    for (let guard = 0; guard < 200; guard++) {
      settle(w, gl, t);
      const ends = gl.pipelines.flatMap((p) => p.jobs.filter((j) => j.status === "running" && j.finishAt !== undefined).map((j) => j.finishAt!));
      const next = ends.length ? Math.min(...ends) : undefined;
      if (next === undefined || next > to) break;
      t = Math.max(t, next);
    }
    settle(w, gl, to);
  } finally {
    busy = false;
  }
}

registerReconciler("gitlab", reconcilePipelines);

// ---------- buttons in the GitLab UI ----------

function findPipeline(gl: GitLabState, pipelineId?: number): Pipeline | undefined {
  return pipelineId !== undefined ? gl.pipelines.find((p) => p.id === pipelineId) : gl.pipelines[gl.pipelines.length - 1];
}

/** Press play on a manual job. */
export function playJob(w: World, name: string, pipelineId?: number): boolean {
  const gl = w.gitlab;
  const p = gl && findPipeline(gl, pipelineId);
  const job = p?.jobs.find((j) => j.name === name && j.status === "manual");
  if (!gl || !p || !job) return false;
  job.status = "pending";
  settleNow(w, gl);
  return true;
}

/** Retry a finished job (a fresh job id, a fresh container). Later jobs that were skipped get another chance. */
export function retryJob(w: World, name: string, pipelineId?: number): boolean {
  const gl = w.gitlab;
  const p = gl && findPipeline(gl, pipelineId);
  const job = p?.jobs.find((j) => j.name === name && (j.status === "failed" || j.status === "success" || j.status === "canceled"));
  if (!gl || !p || !job) return false;
  Object.assign(job, { id: gl.nextJobId++, status: "pending", log: [], startedAt: undefined, finishedAt: undefined, finishAt: undefined, artifacts: undefined, failureReason: undefined, runnerId: undefined });
  for (const j of p.jobs) if (j.status === "skipped") Object.assign(j, { status: "created", finishedAt: undefined });
  p.finishedAt = undefined;
  settleNow(w, gl);
  return true;
}

/** "Run pipeline" on a branch (CI_PIPELINE_SOURCE is "web"). */
export function runPipeline(w: World, ref: string): Pipeline | undefined {
  const sha = w.gitlab?.branches[ref];
  return sha ? createPipeline(w, { ref, sha, source: "web" }) : undefined;
}

/** Let pending jobs re-check runners right away (after a runner comes online in the settings). */
export function nudgePipelines(w: World): void {
  if (w.gitlab) settleNow(w, w.gitlab);
}
