// Canonical states. Every chain level starts from the end of the previous one,
// built by replaying each earlier step's "show me" through the real simulator.
import { produce } from "immer";
import { DEFAULT_DEPLOY_PASSWORD } from "@/sim/constants";
import { basename, dirname, file, getDir, getFile, put } from "@/sim/fs";
import { applyMapActions } from "@/sim/map";
import { createShell, runScript } from "@/sim/shell/run";
import type { Shell, World } from "@/sim/types";
import { createDemoWorld, createWorld } from "@/sim/worlds";
import type { Level, Step, StartPreset } from "@/content/schema";
import { DEFAULT_FRAMES } from "@/content/schema";

export interface PlayState {
  world: World;
  shells: Shell[];
}

export type Vars = Record<string, string>;

export function defaultVars(v: Vars = {}): Vars {
  return { deployPassword: DEFAULT_DEPLOY_PASSWORD, ...v };
}

export function shellsFor(preset: StartPreset = "laptop"): Shell[] {
  const frames = DEFAULT_FRAMES[preset];
  const sh = createShell("w1", frames[0]);
  return [{ ...sh, frames: frames.map((f) => ({ ...f })) }];
}

/** Write a config file the way a careful admin would: keep mode and owner. */
export function writeConfig(w: World, host: "laptop" | "vps", path: string, content: string): World {
  return produce(w, (d) => {
    const h = d.hosts[host];
    const existing = getFile(h, path);
    if (existing) existing.content = content;
    else {
      if (!getDir(h, dirname(path))) put(h, dirname(path), { type: "dir", children: {}, mode: 0o755, owner: "root", group: "root" });
      put(h, path, file(content, 0o644));
    }
    void basename;
  });
}

export function applyStep(state: PlayState, step: Step, vars: Vars): PlayState {
  const t = step.task;
  switch (t.kind) {
    case "terminal": {
      const i = t.showMeShell ?? 0;
      const shells = state.shells.slice();
      while (shells.length <= i) shells.push(createShell(`w${shells.length + 1}`, { host: "laptop", user: "you", cwd: "/home/you", via: "local" }));
      const r = runScript(state.world, shells[i], t.showMe, defaultVars(vars));
      shells[i] = r.shell;
      return { world: r.world, shells };
    }
    case "config":
      if (t.writeToSim === false) return state;
      return { ...state, world: writeConfig(state.world, t.host, t.path, t.solution) };
    case "map":
      if (t.mode === "toggle") return { ...state, world: applyMapActions(state.world, t.showMe) };
      return state;
    case "predict":
      if (t.playout?.persist) return { ...state, world: applyMapActions(state.world, t.playout.actions) };
      return state;
    default:
      return state;
  }
}

export interface LevelIndex {
  levels: Level[];
}

const endCache = new Map<string, World>();
const startCache = new Map<string, World>();

function key(levelId: string, vars: Vars) {
  return `${levelId}|${JSON.stringify(defaultVars(vars))}`;
}

export function makeReplay(index: LevelIndex) {
  const chain = index.levels.filter((l) => l.base === "chain");

  function levelStartWorld(level: Level, vars: Vars): World {
    const k = key(level.id, vars);
    const hit = startCache.get(k);
    if (hit) return hit;
    let w: World;
    if (level.base === "demo") w = createDemoWorld();
    else {
      const i = chain.findIndex((l) => l.id === level.id);
      w = i <= 0 ? createWorld() : levelEndWorld(chain[i - 1], vars);
    }
    if (level.setup) w = produce(w, level.setup);
    startCache.set(k, w);
    return w;
  }

  function levelEndWorld(level: Level, vars: Vars): World {
    const k = key(level.id, vars);
    const hit = endCache.get(k);
    if (hit) return hit;
    let s: PlayState = { world: levelStartWorld(level, vars), shells: shellsFor(level.start) };
    for (const step of level.steps) s = applyStep(s, step, vars);
    endCache.set(k, s.world);
    return s.world;
  }

  function levelStart(level: Level, vars: Vars): PlayState {
    return { world: levelStartWorld(level, vars), shells: shellsFor(level.start) };
  }

  /** Canonical state right before step `idx` (for "show me" resets). */
  function stepStart(level: Level, idx: number, vars: Vars): PlayState {
    let s = levelStart(level, vars);
    for (let i = 0; i < idx; i++) s = applyStep(s, level.steps[i], vars);
    return s;
  }

  function levelById(id: string): Level | undefined {
    return index.levels.find((l) => l.id === id);
  }

  return { levelStart, stepStart, levelEndWorld, levelStartWorld, levelById };
}
