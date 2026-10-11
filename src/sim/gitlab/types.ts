// The GitLab side of the world: one project (crumb/web), its CI/CD settings, runners,
// pipelines and the laptop's local clone. Pure data, like the rest of World.

export type JobStatus = "created" | "pending" | "running" | "success" | "failed" | "canceled" | "skipped" | "manual";

/** A pipeline's status. "manual" means blocked on a manual job nobody has played yet. */
export type PipelineStatus = JobStatus;

export type JobWhen = "on_success" | "on_failure" | "always" | "manual" | "never" | "delayed";

export interface GitCommit {
  /** 40 hex characters. */
  sha: string;
  message: string;
  author: string;
  parent?: string;
  /** Every tracked file in the repo at this commit (path relative to the repo root). */
  files: Record<string, string>;
  /** Sim clock time of the commit. */
  at: number;
}

export interface CiVariable {
  key: string;
  value: string;
  /** "file": the runner writes the value to a temp file and the variable holds the file's path. */
  type: "env_var" | "file";
  /** Only given to pipelines on protected branches. */
  protected: boolean;
  /** Printed as [MASKED] in job logs. GitLab only masks single-line values of 8 characters or more. */
  masked: boolean;
}

export interface Runner {
  id: number;
  description: string;
  online: boolean;
  tags: string[];
  executor: "docker";
  /** Needed for docker:dind. */
  privileged: boolean;
  /** Picks up jobs that have no tags (GitLab's "Run untagged jobs"). Default true. */
  runUntagged?: boolean;
  /** Only runs jobs on protected branches. */
  protected?: boolean;
  /** Image for jobs that do not say `image:`. */
  defaultImage?: string;
  /** Short token shown in logs ("on web-1-runner t3xQaB9c"). */
  shortToken?: string;
}

export interface CiService {
  name: string;
  alias?: string;
}

export interface CiRule {
  if?: string;
  when?: JobWhen;
  allowFailure?: boolean;
  variables?: Record<string, string>;
  /** rules:changes and rules:exists are accepted and treated as matching. */
  changes?: boolean;
  exists?: boolean;
}

/** One job of .gitlab-ci.yml after extends, default: and parsing. */
export interface CiJobSpec {
  name: string;
  stage: string;
  image?: string;
  services: CiService[];
  variables: Record<string, string>;
  beforeScript: string[];
  script: string[];
  afterScript: string[];
  rules?: CiRule[];
  only?: string[];
  except?: string[];
  when: JobWhen;
  /** undefined: no needs (stage order). [] : start right away. */
  needs?: string[];
  artifacts?: { paths: string[]; when?: "on_success" | "on_failure" | "always" };
  tags: string[];
  allowFailure: boolean;
  environment?: string;
}

export interface CiJob {
  id: number;
  name: string;
  stage: string;
  status: JobStatus;
  log: string[];
  startedAt?: number;
  finishedAt?: number;
  allowFailure?: boolean;
  when?: JobWhen;
  /** The job as it was parsed when the pipeline was created. */
  spec: CiJobSpec;
  runnerId?: number;
  /** When a running job finishes (sim clock). */
  finishAt?: number;
  /** The pending message GitLab shows when no runner can take the job. */
  stuck?: string;
  /** Files this job uploaded as artifacts (relative path to content). */
  artifacts?: Record<string, string>;
  failureReason?: string;
}

export interface Pipeline {
  id: number;
  iid: number;
  sha: string;
  ref: string;
  source: "push" | "web" | "merge_request_event";
  status: PipelineStatus;
  jobs: CiJob[];
  createdAt: number;
  finishedAt?: number;
  /** Was the ref protected when the pipeline was created (protected variables, protected runners). */
  protectedRef: boolean;
  /** "Found errors in your .gitlab-ci.yml:" lines. The pipeline failed with no jobs. */
  errors?: string[];
  mergeRequest?: number;
  /** Stage order from the CI file, .pre and .post included. */
  stages?: string[];
}

export interface DeployToken {
  id: number;
  name: string;
  /** gitlab+deploy-token-1 */
  username: string;
  token: string;
  scopes: ("read_repository" | "read_registry" | "write_registry")[];
  revoked?: boolean;
}

export interface DeployKey {
  id: number;
  title: string;
  key: string;
  canPush: boolean;
}

export interface MergeRequest {
  iid: number;
  source: string;
  target: string;
  title: string;
  state: "opened" | "merged" | "closed";
}

/** The laptop's clone of crumb/web. The working tree is the real laptop filesystem. */
export interface LocalRepo {
  /** Repo root on the laptop. */
  path: string;
  /** Checked out branch. */
  branch: string;
  branches: Record<string, string>;
  /** Local branch to remote branch it tracks. */
  upstream: Record<string, string>;
  /** Last known origin/* refs. */
  remoteRefs: Record<string, string>;
  /** The staging area: what the next commit will contain. */
  index: Record<string, string>;
}

export interface GitLabState {
  project: {
    path: string;
    name: string;
    visibility: "private" | "internal" | "public";
    defaultBranch: string;
    sshUrl: string;
    webUrl: string;
  };
  /** Branch names or wildcards ("release/*"). */
  protectedBranches: string[];
  branches: Record<string, string>;
  /** Every commit object, local and pushed (git objects are shared, refs decide who has what). */
  commits: Record<string, GitCommit>;
  variables: CiVariable[];
  runners: Runner[];
  pipelines: Pipeline[];
  nextPipelineId: number;
  nextJobId: number;
  deployTokens: DeployToken[];
  deployKeys: DeployKey[];
  /** Public SSH keys on the player's GitLab profile (git push uses these). */
  userKeys: string[];
  mergeRequests: MergeRequest[];
  local?: LocalRepo;
}
