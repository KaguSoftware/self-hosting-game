import type { Check } from "@/sim/predicates";
import type { MapAction } from "@/sim/map";
import type { Frame, HostId, World } from "@/sim/types";

export interface Intel {
  /** 1 to 3 short lines. */
  lines: string[];
  analogy?: string;
  terms?: string[];
}

export interface QuizItem {
  id: string;
  q: string;
  options: string[];
  answer: number;
  /** One short line shown after answering. */
  why: string;
  tag: string;
}

export interface Goal {
  describe: string;
  check: Check;
}

export interface MapControl {
  node: string;
  label: string;
  on: MapAction;
  off: MapAction;
}

export interface ConfigBlank {
  options: string[];
  /** Index into options of the right answer. Validation is still by meaning via checks. */
  answer: number;
}

export interface ConfigCheck {
  describe: string;
  test: (text: string) => boolean;
}

export type Task =
  | {
      kind: "terminal";
      goals: Goal[];
      hints: [string, string];
      showMe: string[];
      /** Which window show me types into. */
      showMeShell?: number;
      chips?: string[];
      windows?: boolean;
      console?: boolean;
      /** URL to trace on the map when a goal is met. */
      url?: string;
      /** Beginner help: the exact command(s) to type, shown with a tap-to-type button. */
      guide?: string[];
    }
  | { kind: "map"; mode: "route"; prompt: string; path: string[]; hints: [string, string] }
  | { kind: "map"; mode: "match"; prompt: string; pairs: { chip: string; node: string }[]; hints: [string, string] }
  | {
      kind: "map";
      mode: "toggle";
      prompt: string;
      controls: MapControl[];
      goals: Goal[];
      hints: [string, string];
      showMe: MapAction[];
      url?: string;
    }
  | {
      kind: "allocate";
      prompt: string;
      host: { cpus: number; ramGb: number };
      vms: { name: string; cpus: number; ramGb: number }[];
      /** Indices of VMs that must be placed. */
      goal: "fit-ram" | "overcommit-cpu";
      hints: [string, string];
    }
  | {
      kind: "config";
      host: HostId;
      path: string;
      lang: "sshd" | "yaml" | "caddy" | "dockerfile" | "ini" | "text";
      mode: "blanks" | "fix" | "reorder";
      /** For blanks: text with {{id}} markers. For fix: editable text. For reorder: lines in shuffled order. */
      start: string;
      blanks?: Record<string, ConfigBlank>;
      checks: ConfigCheck[];
      solution: string;
      hints: [string, string];
      /** Write the result into the sim file system on success. */
      writeToSim?: boolean;
    }
  | {
      kind: "predict";
      question: string;
      options: string[];
      answer: number;
      why: string;
      /** Keep the written order (for options that are naturally ordered, like plan sizes). */
      fixedOrder?: boolean;
      /** Shown on the map after answering. Preview only unless persist. */
      playout?: { actions: MapAction[]; url?: string; ssh?: { user: string }; persist?: boolean };
    }
  | { kind: "spot"; prompt: string; lines: string[]; bugs: number[]; why: string; mono?: boolean }
  | { kind: "order"; prompt: string; items: string[]; why: string }
  | { kind: "rapid"; items: QuizItem[]; seconds: number }
  | { kind: "match"; prompt: string; buckets: string[]; items: { text: string; bucket: number }[]; why: string }
  | { kind: "incident"; incidentId: string };

export type TaskKind = Task["kind"];

export interface Step {
  id: string;
  mission: string;
  intel?: Intel;
  task: Task;
  /** Quick quiz used by spaced review when this step was missed. */
  review?: QuizItem;
  /** One plain line shown after success: what just happened. */
  after?: string;
  tags: string[];
}

export type StartPreset = "laptop" | "vps-root" | "vps-deploy";

export interface Level {
  id: string;
  world: number;
  title: string;
  /** World 0 plays on the finished demo stack. Everything else grows one server. */
  base: "demo" | "chain";
  start?: StartPreset;
  /** Extra state for this level, applied on top of the chain (immer draft). */
  setup?: (w: World) => void;
  steps: Step[];
}

export interface WorldDef {
  id: number;
  title: string;
  tagline: string;
  levels: Level[];
  cheatSheet: { cmd: string; what: string }[];
}

export interface Incident {
  id: string;
  title: string;
  client: { name: string; message: string };
  /** Start from the canonical end state of this level. */
  after: string;
  breakIt: (w: World) => void;
  start: StartPreset;
  goals: Goal[];
  hints: [string, string];
  fastestPath: string[];
  /** The fix, as commands, for show me and tests (run from the start shells). */
  fix: string[];
  /** Run fix in this window. */
  fixShell?: number;
  debrief: string[];
  timeLimit: number;
  /** Offer the provider's web console (root shell without SSH). */
  console?: boolean;
  /** Trace this on the map once fixed. */
  url?: string;
  /** Or trace an SSH login as this user once fixed. */
  sshUser?: string;
}

export interface Term {
  id: string;
  term: string;
  plain: string;
  /** What it replaces from Vercel or Supabase, if anything. */
  replaces?: string;
  world: number;
}

export const DEFAULT_FRAMES: Record<StartPreset, Frame[]> = {
  laptop: [{ host: "laptop", user: "you", cwd: "/home/you", via: "local" }],
  "vps-root": [
    { host: "laptop", user: "you", cwd: "/home/you", via: "local" },
    { host: "vps", user: "root", cwd: "/root", via: "ssh", remote: "203.0.113.10" },
  ],
  "vps-deploy": [
    { host: "laptop", user: "you", cwd: "/home/you", via: "local" },
    { host: "vps", user: "deploy", cwd: "/home/deploy", via: "ssh", remote: "203.0.113.10" },
  ],
};
