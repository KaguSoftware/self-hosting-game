import { getDir, resolvePath } from "../fs";
import type { Shell, World } from "../types";
import { COMMANDS } from "./registry";
import { homeOf, topFrame } from "./run";

export interface Completion {
  /** New full line after completing (if a single match or common prefix). */
  line: string;
  /** All candidates, shown when there are several. */
  options: string[];
}

function commonPrefix(xs: string[]): string {
  if (!xs.length) return "";
  let p = xs[0];
  for (const x of xs) while (!x.startsWith(p)) p = p.slice(0, -1);
  return p;
}

export function completeLine(w: World, sh: Shell, line: string): Completion {
  const words = line.split(/\s+/);
  const last = words[words.length - 1] ?? "";
  const before = line.slice(0, line.length - last.length);
  const first = words[0] === "sudo" ? words[1] : words[0];
  const isCommandPos = words.length === 1 || (words[0] === "sudo" && words.length === 2);

  let candidates: string[] = [];
  if (isCommandPos) {
    candidates = Object.values(COMMANDS)
      .filter((c) => !c.hidden && c.name.startsWith(last))
      .map((c) => c.name + " ");
  } else {
    const f = topFrame(sh);
    const host = w.hosts[f.host];
    const home = homeOf(w, f);
    const slash = last.lastIndexOf("/");
    const dirPart = slash >= 0 ? last.slice(0, slash + 1) : "";
    const base = slash >= 0 ? last.slice(slash + 1) : last;
    const abs = resolvePath(f.cwd, dirPart || ".", home);
    const d = getDir(host, abs);
    if (d) {
      candidates = Object.keys(d.children)
        .filter((n) => n.startsWith(base) && (base.startsWith(".") || !n.startsWith(".")))
        .sort()
        .map((n) => dirPart + n + (d.children[n].type === "dir" ? "/" : " "));
    }
    const cmd = first ? COMMANDS[first] : undefined;
    if (cmd?.complete && words.length <= (words[0] === "sudo" ? 4 : 3)) {
      const extra = cmd.complete(words.slice(1), undefined as never).filter((x) => x.startsWith(last)).map((x) => x + " ");
      candidates = [...extra, ...candidates];
    }
    if (first === "systemctl" || first === "journalctl") {
      const svcs = Object.keys(host.services).filter((s) => s.startsWith(last)).map((s) => s + " ");
      candidates = [...candidates, ...svcs];
    }
  }
  candidates = [...new Set(candidates)];
  if (candidates.length === 1) return { line: before + candidates[0], options: [] };
  const prefix = commonPrefix(candidates);
  return {
    line: prefix.length > last.length ? before + prefix : line,
    options: candidates.map((c) => c.trim()),
  };
}
