import type { FsDir, FsFile, FsNode, Host } from "./types";

export function dir(mode = 0o755, owner = "root", group = owner, children: Record<string, FsNode> = {}): FsDir {
  return { type: "dir", mode, owner, group, children };
}

export function file(content: string, mode = 0o644, owner = "root", group = owner, padBytes?: number): FsFile {
  const f: FsFile = { type: "file", content, mode, owner, group };
  if (padBytes) f.padBytes = padBytes;
  return f;
}

/** Resolve "..", ".", "~" and relative paths into an absolute normalized path. */
export function resolvePath(cwd: string, p: string, home: string): string {
  if (p === "~") p = home;
  else if (p.startsWith("~/")) p = home + p.slice(1);
  const abs = p.startsWith("/") ? p : (cwd === "/" ? "" : cwd) + "/" + p;
  const out: string[] = [];
  for (const part of abs.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

export function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

export function dirname(path: string): string {
  const parts = splitPath(path);
  parts.pop();
  return "/" + parts.join("/");
}

export function basename(path: string): string {
  const parts = splitPath(path);
  return parts[parts.length - 1] ?? "/";
}

export function getNode(host: Host, path: string): FsNode | undefined {
  let node: FsNode = host.fs;
  for (const part of splitPath(path)) {
    if (node.type !== "dir") return undefined;
    const next: FsNode | undefined = node.children[part];
    if (!next) return undefined;
    node = next;
  }
  return node;
}

export function getDir(host: Host, path: string): FsDir | undefined {
  const n = getNode(host, path);
  return n && n.type === "dir" ? n : undefined;
}

export function getFile(host: Host, path: string): FsFile | undefined {
  const n = getNode(host, path);
  return n && n.type === "file" ? n : undefined;
}

export function readText(host: Host, path: string): string | undefined {
  return getFile(host, path)?.content;
}

export function userGroups(host: Host, user: string): string[] {
  const out: string[] = [];
  for (const g of Object.values(host.groups)) {
    if (g.name === user || g.members.includes(user)) out.push(g.name);
  }
  return out;
}

export function isSudoer(host: Host, user: string): boolean {
  return user === "root" || userGroups(host, user).some((g) => g === "sudo" || g === "admin");
}

export type Access = "r" | "w" | "x";

export function can(host: Host, user: string, node: FsNode, access: Access): boolean {
  if (user === "root") {
    if (access === "x" && node.type === "file") return (node.mode & 0o111) !== 0;
    return true;
  }
  const bit = access === "r" ? 4 : access === "w" ? 2 : 1;
  let shift: number;
  if (node.owner === user) shift = 6;
  else if (userGroups(host, user).includes(node.group)) shift = 3;
  else shift = 0;
  return ((node.mode >> shift) & bit) !== 0;
}

/** Every directory on the way must be searchable (x). */
export function canTraverse(host: Host, user: string, path: string): boolean {
  let node: FsNode = host.fs;
  const parts = splitPath(path);
  for (let i = 0; i < parts.length; i++) {
    if (node.type !== "dir") return false;
    if (!can(host, user, node, "x")) return false;
    const next: FsNode | undefined = node.children[parts[i]];
    if (!next) return true; // missing is reported elsewhere
    node = next;
  }
  return true;
}

export type FsError = "ENOENT" | "EACCES" | "ENOTDIR" | "EISDIR" | "EEXIST";

export function writeFile(
  host: Host,
  user: string,
  path: string,
  content: string,
  opts: { append?: boolean; mode?: number } = {},
): FsError | null {
  const parent = getNode(host, dirname(path));
  if (!parent) return "ENOENT";
  if (parent.type !== "dir") return "ENOTDIR";
  if (!canTraverse(host, user, path)) return "EACCES";
  const name = basename(path);
  const existing = parent.children[name];
  if (existing) {
    if (existing.type === "dir") return "EISDIR";
    if (!can(host, user, existing, "w")) return "EACCES";
    existing.content = opts.append ? existing.content + content : content;
    return null;
  }
  if (!can(host, user, parent, "w")) return "EACCES";
  const g = user === "root" ? "root" : user;
  parent.children[name] = file(content, opts.mode ?? 0o644, user, g);
  return null;
}

export function mkdirp(host: Host, user: string, path: string, mode = 0o755): FsError | null {
  let node: FsDir = host.fs;
  for (const part of splitPath(path)) {
    const next: FsNode | undefined = node.children[part];
    if (!next) {
      if (!can(host, user, node, "w")) return "EACCES";
      const created = dir(mode, user, user === "root" ? "root" : user);
      node.children[part] = created;
      node = created;
    } else if (next.type !== "dir") {
      return "ENOTDIR";
    } else {
      node = next;
    }
  }
  return null;
}

/** Force-write as root, creating parent dirs. For world builders only. */
export function put(host: Host, path: string, node: FsNode): void {
  const parts = splitPath(path);
  const name = parts.pop()!;
  let d: FsDir = host.fs;
  for (const part of parts) {
    let next = d.children[part];
    if (!next || next.type !== "dir") {
      next = dir();
      d.children[part] = next;
    }
    d = next;
  }
  d.children[name] = node;
}

export function removeNode(host: Host, path: string): void {
  const parent = getDir(host, dirname(path));
  if (parent) delete parent.children[basename(path)];
}

export function nodeSize(node: FsNode): number {
  if (node.type === "file") return node.content.length + (node.padBytes ?? 0);
  let total = 0;
  for (const c of Object.values(node.children)) total += nodeSize(c);
  return total;
}

export function modeString(node: FsNode): string {
  const t = node.type === "dir" ? "d" : "-";
  const bits = "rwxrwxrwx";
  let s = "";
  for (let i = 0; i < 9; i++) s += node.mode & (1 << (8 - i)) ? bits[i] : "-";
  if (node.mode & 0o1000) s = s.slice(0, 8) + (s[8] === "x" ? "t" : "T");
  return t + s;
}

export function octal(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(3, "0");
}

export function fsErrorText(err: FsError): string {
  switch (err) {
    case "ENOENT":
      return "No such file or directory";
    case "EACCES":
      return "Permission denied";
    case "ENOTDIR":
      return "Not a directory";
    case "EISDIR":
      return "Is a directory";
    case "EEXIST":
      return "File exists";
  }
}

export function listDir(host: Host, path: string): string[] {
  const d = getDir(host, path);
  return d ? Object.keys(d.children).sort() : [];
}
