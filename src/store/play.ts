"use client";
import { create } from "zustand";
import { produce } from "immer";
import type { LogEntry } from "@/sim/predicates";
import type { EditorRequest, Frame, OutLine, TraceResult, World } from "@/sim/types";
import { cancelPending, promptText } from "@/sim/shell/run";
import { writeFile, fsErrorText } from "@/sim/fs";
import { completeLine } from "@/sim/shell/complete";
import { execLine, LAPTOP_FRAME, newWindow } from "@/engine/play";
import type { PlayState, Vars } from "@/engine/replay";
import { sfx } from "@/lib/sfx";

export interface TermLine {
  id: number;
  text: string;
  kind: OutLine["kind"] | "cmd" | "sys";
}

let lid = 1;
const line = (text: string, kind: TermLine["kind"]): TermLine => ({ id: lid++, text, kind });

export interface PlayStore {
  state: PlayState;
  vars: Vars;
  active: number;
  lines: TermLine[][];
  log: LogEntry[];
  trace?: TraceResult;
  traceKey: number;
  preview: World | null;
  editor: { shell: number; req: EditorRequest; error?: string } | null;
  combo: number;
  bestCombo: number;
  /** Bumped whenever the world changes so goal checks re-run. */
  tick: number;
  busy: boolean;
  /** Text the terminal should put in its input (from guide buttons). */
  insert: { text: string; key: number } | null;

  load(state: PlayState, vars: Vars, intro?: string): void;
  setState(state: PlayState, note?: string): void;
  resetLog(): void;
  run(text: string, opts?: { echo?: boolean }): { code: number; isErrorish: boolean } | null;
  cancel(): void;
  complete(text: string): { line: string; options: string[] };
  addWindow(frame?: Frame, label?: string): number;
  setActive(i: number): void;
  saveEditor(content: string): boolean;
  closeEditor(): void;
  setWorld(w: World): void;
  showTrace(t: TraceResult | undefined): void;
  setPreview(w: World | null): void;
  sys(text: string, shell?: number): void;
  clear(shell?: number): void;
  bumpCombo(): number;
  breakCombo(): void;
  setBusy(b: boolean): void;
  typeIn(text: string): void;
}

export const usePlay = create<PlayStore>((set, get) => ({
  state: { world: undefined as unknown as World, shells: [] },
  vars: {},
  active: 0,
  lines: [[]],
  log: [],
  trace: undefined,
  traceKey: 0,
  preview: null,
  editor: null,
  combo: 0,
  bestCombo: 0,
  tick: 0,
  busy: false,
  insert: null,

  load(state, vars, intro) {
    set({
      state,
      vars,
      active: 0,
      lines: state.shells.map((_, i) => (i === 0 && intro ? [line(intro, "sys")] : [])),
      log: [],
      trace: undefined,
      preview: null,
      editor: null,
      combo: 0,
      bestCombo: 0,
      tick: get().tick + 1,
      busy: false,
    });
  },

  setState(state, note) {
    const lines = state.shells.map((_, i) => get().lines[i] ?? []);
    if (note) lines[0] = [...lines[0], line(note, "sys")];
    set({ state, lines, active: Math.min(get().active, state.shells.length - 1), tick: get().tick + 1, editor: null });
  },

  resetLog() {
    set({ log: [] });
  },

  run(text, opts = {}) {
    const { state, active, vars } = get();
    const sh = state.shells[active];
    if (!sh) return null;
    const pending = sh.pending;
    const prompt = promptText(state.world, sh);
    const echo = pending ? prompt + (pending.secret ? "" : text) : prompt + text;
    const r = execLine(state, active, text, vars);
    const all = get().lines.slice();
    let mine = all[active] ?? [];
    if (opts.echo !== false) mine = [...mine, line(echo, "cmd")];
    if (r.result.clear) mine = [];
    for (const o of r.result.out) mine = [...mine, line(o.text, o.kind)];
    if (mine.length > 600) mine = mine.slice(-600);
    all[active] = mine;
    const editor = r.result.editor ? { shell: active, req: r.result.editor } : get().editor;
    const isErrorish =
      (r.result.code !== 0 && r.result.code !== 130) ||
      r.result.out.some((o) => o.kind === "info" && /not in this game yet/.test(o.text));
    set({
      state: r.state,
      lines: all,
      log: text.trim() || pending ? [...get().log, r.entry] : get().log,
      editor,
      tick: get().tick + 1,
      ...(r.result.trace ? { trace: r.result.trace, traceKey: get().traceKey + 1 } : {}),
    });
    return { code: r.result.code, isErrorish };
  },

  cancel() {
    const { state, active } = get();
    const sh = state.shells[active];
    if (!sh) return;
    const r = cancelPending(state.world, sh);
    const shells = state.shells.slice();
    shells[active] = r.shell;
    const all = get().lines.slice();
    all[active] = [...(all[active] ?? []), line(promptText(state.world, sh) + "^C", "cmd")];
    set({ state: { world: r.world, shells }, lines: all });
  },

  complete(text) {
    const { state, active } = get();
    const sh = state.shells[active];
    if (!sh || sh.pending) return { line: text, options: [] };
    return completeLine(state.world, sh, text);
  },

  addWindow(frame = LAPTOP_FRAME, label) {
    const shells = newWindow(get().state.shells, frame);
    const lines = [...get().lines, label ? [line(label, "sys")] : []];
    set({ state: { ...get().state, shells }, lines, active: shells.length - 1, tick: get().tick + 1 });
    return shells.length - 1;
  },

  setActive(i) {
    set({ active: i });
  },

  saveEditor(content) {
    const ed = get().editor;
    if (!ed) return false;
    if (!ed.req.canWrite) {
      set({ editor: { ...ed, error: `[ Error writing ${ed.req.path}: Permission denied ]` } });
      sfx.error();
      return false;
    }
    let err: string | null = null;
    const world = produce(get().state.world, (d) => {
      const host = d.hosts[ed.req.host];
      const e = writeFile(host, ed.req.asUser, ed.req.path, content);
      if (e) err = fsErrorText(e);
    });
    if (err) {
      set({ editor: { ...ed, error: `[ Error writing ${ed.req.path}: ${err} ]` } });
      return false;
    }
    const lines = get().lines.slice();
    const n = content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
    lines[ed.shell] = [...(lines[ed.shell] ?? []), line(`[ Wrote ${n} lines to ${ed.req.path} ]`, "info")];
    set({
      state: { ...get().state, world },
      editor: { ...ed, req: { ...ed.req, content, isNew: false }, error: undefined },
      lines,
      tick: get().tick + 1,
    });
    return true;
  },

  closeEditor() {
    set({ editor: null });
  },

  setWorld(w) {
    set({ state: { ...get().state, world: w }, tick: get().tick + 1 });
  },

  showTrace(t) {
    set({ trace: t, traceKey: get().traceKey + 1 });
  },

  setPreview(w) {
    set({ preview: w });
  },

  sys(text, shell) {
    const i = shell ?? get().active;
    const lines = get().lines.slice();
    lines[i] = [...(lines[i] ?? []), line(text, "sys")];
    set({ lines });
  },

  clear(shell) {
    const i = shell ?? get().active;
    const lines = get().lines.slice();
    lines[i] = [];
    set({ lines });
  },

  bumpCombo() {
    const combo = get().combo + 1;
    set({ combo, bestCombo: Math.max(get().bestCombo, combo) });
    return combo;
  },

  breakCombo() {
    set({ combo: 0 });
  },

  setBusy(b) {
    set({ busy: b });
  },

  typeIn(text) {
    set({ insert: { text, key: Date.now() } });
  },
}));
