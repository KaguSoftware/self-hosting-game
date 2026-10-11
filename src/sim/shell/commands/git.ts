// git on the laptop, for the clone of crumb/web: status, add, commit, push, log, switch,
// revert. Output follows git 2.43 (Ubuntu 24.04). A push to GitLab creates a pipeline.
import { getDir, getFile, put, file } from "../../fs";
import { clientKeys, keyBody } from "../../sshAuth";
import { dateTime } from "../../time";
import type { World } from "../../types";
import { hashHex } from "../../util";
import { createPipeline } from "../../gitlab/pipeline";
import {
  addCommit,
  AUTHOR,
  checkoutTree,
  commitsBetween,
  diffStat,
  findCommit,
  GITLAB_HOST,
  isAncestor,
  isProtected,
  shortSha,
  statLine,
  workingTree,
} from "../../gitlab/state";
import type { GitCommit, GitLabState, LocalRepo } from "../../gitlab/types";
import type { Command, Ctx } from "../ctx";

const REMOTE_SHOWN = `${GITLAB_HOST}:crumb/web.git`;

interface Repo {
  gl: GitLabState;
  r: LocalRepo;
}

function repoFor(ctx: Ctx): Repo | undefined {
  const gl = ctx.w.gitlab;
  const r = gl?.local;
  if (!gl || !r || ctx.frame.host !== "laptop") return undefined;
  const cwd = ctx.frame.cwd;
  if (cwd !== r.path && !cwd.startsWith(r.path + "/")) return undefined;
  if (!getDir(ctx.host, `${r.path}/.git`)) return undefined;
  return { gl, r };
}

function headSha(r: LocalRepo): string {
  return r.branches[r.branch];
}

function headFiles(gl: GitLabState, r: LocalRepo): Record<string, string> {
  return gl.commits[headSha(r)]?.files ?? {};
}

function title(c: GitCommit): string {
  return c.message.split("\n")[0];
}

/** Paths relative to the repo root for a path argument. */
function relPath(ctx: Ctx, r: LocalRepo, arg: string): string {
  const abs = ctx.path(arg);
  if (abs === r.path) return "";
  return abs.startsWith(r.path + "/") ? abs.slice(r.path.length + 1) : arg;
}

interface Status {
  staged: { path: string; kind: "new file" | "modified" | "deleted" }[];
  unstaged: { path: string; kind: "modified" | "deleted" }[];
  untracked: string[];
}

function status(ctx: Ctx, { gl, r }: Repo): Status {
  const head = headFiles(gl, r);
  const wt = workingTree(ctx.host, r.path);
  const st: Status = { staged: [], unstaged: [], untracked: [] };
  for (const p of [...new Set([...Object.keys(head), ...Object.keys(r.index)])].sort()) {
    if (head[p] === r.index[p]) continue;
    st.staged.push({ path: p, kind: !(p in head) ? "new file" : !(p in r.index) ? "deleted" : "modified" });
  }
  for (const p of Object.keys(r.index).sort()) {
    if (wt[p] === r.index[p]) continue;
    st.unstaged.push({ path: p, kind: p in wt ? "modified" : "deleted" });
  }
  const untracked = Object.keys(wt).filter((p) => !(p in r.index)).sort();
  // A folder with no tracked files shows as one line, "folder/".
  const shown = new Set<string>();
  for (const p of untracked) {
    const parts = p.split("/");
    let label = p;
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join("/");
      if (!Object.keys(r.index).some((t) => t.startsWith(d + "/"))) {
        label = d + "/";
        break;
      }
    }
    shown.add(label);
  }
  st.untracked = [...shown];
  return st;
}

function upstreamLine(gl: GitLabState, r: LocalRepo): string[] {
  const up = r.upstream[r.branch];
  if (!up) return [];
  const remote = r.remoteRefs[up];
  if (!remote) return [`Your branch is based on 'origin/${up}', but the upstream is gone.`, `  (use "git branch --unset-upstream" to fixup)`];
  const ahead = commitsBetween(gl, remote, headSha(r)).length;
  if (remote === headSha(r) || !ahead) return [`Your branch is up to date with 'origin/${up}'.`];
  return [`Your branch is ahead of 'origin/${up}' by ${ahead} commit${ahead === 1 ? "" : "s"}.`, `  (use "git push" to publish your local commits)`];
}

function statusText(ctx: Ctx, repo: Repo, forCommit = false): { text: string; clean: boolean } {
  const st = status(ctx, repo);
  const lines = [`On branch ${repo.r.branch}`, ...upstreamLine(repo.gl, repo.r)];
  if (st.staged.length) {
    lines.push("", "Changes to be committed:", `  (use "git restore --staged <file>..." to unstage)`);
    for (const s of st.staged) lines.push(`\t${(s.kind + ":").padEnd(12)}${s.path}`);
  }
  if (st.unstaged.length) {
    lines.push("", "Changes not staged for commit:", `  (use "git add${st.unstaged.some((u) => u.kind === "deleted") ? "/rm" : ""} <file>..." to update what will be committed)`, `  (use "git restore <file>..." to discard changes in working directory)`);
    for (const s of st.unstaged) lines.push(`\t${(s.kind + ":").padEnd(12)}${s.path}`);
  }
  if (st.untracked.length) {
    lines.push("", "Untracked files:", `  (use "git add <file>..." to include in what will be committed)`);
    for (const u of st.untracked) lines.push(`\t${u}`);
  }
  if (!st.staged.length) {
    lines.push("");
    if (st.unstaged.length) lines.push(`no changes added to commit (use "git add" and/or "git commit -a")`);
    else if (st.untracked.length) lines.push(`nothing added to commit but untracked files present (use "git add" to track)`);
    else lines.push("nothing to commit, working tree clean");
  } else if (forCommit) lines.push("");
  return { text: lines.join("\n"), clean: !st.staged.length };
}

function notRepo(ctx: Ctx): number {
  ctx.err("fatal: not a git repository (or any of the parent directories): .git");
  return 128;
}

function decorations(gl: GitLabState, r: LocalRepo, sha: string): string {
  const out: string[] = [];
  if (r.branches[r.branch] === sha) out.push(`HEAD -> ${r.branch}`);
  for (const b of Object.keys(r.branches).sort()) if (b !== r.branch && r.branches[b] === sha) out.push(b);
  for (const b of Object.keys(r.remoteRefs).sort()) {
    if (r.remoteRefs[b] !== sha) continue;
    out.push(`origin/${b}`);
    if (b === gl.project.defaultBranch) out.push("origin/HEAD");
  }
  return out.length ? ` (${out.join(", ")})` : "";
}

function gitDate(t: number): string {
  const [d, m, day, time, , year] = dateTime(t).split(" ");
  return `${d} ${m} ${Number(day)} ${time} ${year} +0000`;
}

function writeHead(ctx: Ctx, r: LocalRepo): void {
  const f = getFile(ctx.host, `${r.path}/.git/HEAD`);
  const text = `ref: refs/heads/${r.branch}\n`;
  if (f) f.content = text;
  else put(ctx.host, `${r.path}/.git/HEAD`, file(text, 0o644, ctx.realUser, ctx.realUser));
}

/** Tracked files with changes (staged or not). Untracked files never block a switch. */
function dirty(ctx: Ctx, repo: Repo): string[] {
  const st = status(ctx, repo);
  return [...new Set([...st.staged.map((s) => s.path), ...st.unstaged.map((s) => s.path)])];
}

function newCommit(ctx: Ctx, repo: Repo, message: string, files: Record<string, string>): GitCommit {
  const { gl, r } = repo;
  const parent = headSha(r);
  const c = addCommit(gl, { message, author: AUTHOR, parent, files: { ...files }, at: ctx.w.clock });
  r.branches[r.branch] = c.sha;
  return c;
}

function commitSummary(repo: Repo, c: GitCommit, before: Record<string, string>): string {
  const d = diffStat(before, c.files);
  const lines = [`[${repo.r.branch} ${shortSha(c.sha)}] ${title(c)}`, statLine(d)];
  for (const p of d.created) lines.push(` create mode 100644 ${p}`);
  for (const p of d.deleted) lines.push(` delete mode 100644 ${p}`);
  return lines.join("\n");
}

// ---------- subcommands ----------

function cmdAdd(ctx: Ctx, repo: Repo, args: string[]): number {
  const paths = args.filter((a) => !a.startsWith("-") || a === ".");
  const all = args.includes("-A") || args.includes("--all") || args.includes(".");
  if (!paths.length && !all) {
    ctx.err("Nothing specified, nothing added.\nhint: Maybe you wanted to say 'git add .'?\nhint: Disable this message with \"git config advice.addEmptyPathspec false\"");
    return 0;
  }
  const wt = workingTree(ctx.host, repo.r.path);
  const idx = repo.r.index;
  for (const raw of all ? ["."] : paths) {
    const rel = relPath(ctx, repo.r, raw);
    const under = (p: string) => rel === "" || p === rel || p.startsWith(rel + "/");
    const hits = [...new Set([...Object.keys(wt), ...Object.keys(idx)])].filter(under);
    if (!hits.length) {
      ctx.err(`fatal: pathspec '${raw}' did not match any files`);
      return 128;
    }
    for (const p of hits) {
      if (p in wt) idx[p] = wt[p];
      else delete idx[p];
    }
  }
  return 0;
}

function cmdCommit(ctx: Ctx, repo: Repo, args: string[]): number {
  const msgs: string[] = [];
  let all = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-m" || a === "--message") {
      if (i + 1 >= args.length) {
        ctx.err("error: switch `m' requires a value");
        return 129;
      }
      msgs.push(args[++i]);
    } else if (a.startsWith("--message=")) msgs.push(a.slice(10));
    else if (a === "-a" || a === "--all") all = true;
    else if (/^-a?m$/.test(a) || a === "-am") {
      all = all || a.includes("a");
      msgs.push(args[++i] ?? "");
    }
  }
  if (all) {
    const wt = workingTree(ctx.host, repo.r.path);
    for (const p of Object.keys(repo.r.index)) {
      if (p in wt) repo.r.index[p] = wt[p];
      else delete repo.r.index[p];
    }
  }
  const before = headFiles(repo.gl, repo.r);
  const st = statusText(ctx, repo, true);
  if (st.clean) {
    ctx.out(st.text);
    return 1;
  }
  if (!msgs.length || !msgs.join("").trim()) {
    ctx.info("In this game, give the message on the command line: git commit -m \"what changed\"");
    ctx.err("Aborting commit due to empty commit message.");
    return 1;
  }
  const c = newCommit(ctx, repo, msgs.join("\n\n"), repo.r.index);
  ctx.out(commitSummary(repo, c, before));
  return 0;
}

function pushDenied(ctx: Ctx, what: string): number {
  ctx.err(`${what}\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.`);
  return 128;
}

function cmdPush(ctx: Ctx, repo: Repo, args: string[]): number {
  const { gl, r } = repo;
  let setUpstream = false;
  let force = false;
  const opts: string[] = [];
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-u" || a === "--set-upstream") setUpstream = true;
    else if (a === "-f" || a === "--force" || a === "--force-with-lease") force = true;
    else if (a === "-o" || a === "--push-option") opts.push(args[++i] ?? "");
    else if (a.startsWith("--push-option=")) opts.push(a.slice(14));
    else if (!a.startsWith("-")) pos.push(a);
  }
  const remote = pos[0] ?? "origin";
  if (remote !== "origin") {
    return pushDenied(ctx, `fatal: '${remote}' does not appear to be a git repository`);
  }
  let branch = pos[1]?.split(":")[0] ?? r.branch;
  if (branch === "HEAD") branch = r.branch;
  if (!pos[1] && !r.upstream[branch] && !setUpstream) {
    ctx.err(
      `fatal: The current branch ${branch} has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n\n    git push --set-upstream origin ${branch}\n\nTo have this happen automatically for branches without a tracking\nupstream, see 'push.autoSetupRemote' in 'git help config'.\n`,
    );
    return 128;
  }
  const remoteBranch = pos[1]?.split(":")[1] ?? r.upstream[branch] ?? branch;

  // ssh to gitlab.com with the laptop's key.
  const kh = getFile(ctx.host, `${ctx.home}/.ssh/known_hosts`)?.content ?? "";
  if (!kh.split("\n").some((l) => l.split(/[\s,]/)[0] === GITLAB_HOST)) return pushDenied(ctx, "Host key verification failed.");
  const keys = clientKeys(ctx.host, ctx.realUser);
  const onProfile = gl.userKeys.map(keyBody);
  if (!keys.some((k) => onProfile.includes(keyBody(k.pub)))) return pushDenied(ctx, `git@${GITLAB_HOST}: Permission denied (publickey).`);

  const local = r.branches[branch];
  if (!local) {
    ctx.err(`error: src refspec ${branch} does not match any\nerror: failed to push some refs to '${REMOTE_SHOWN}'`);
    return 1;
  }
  const before = gl.branches[remoteBranch];
  const track = () => {
    if (!setUpstream) return;
    r.upstream[branch] = remoteBranch;
    ctx.out(`branch '${branch}' set up to track 'origin/${remoteBranch}'.`);
  };
  if (before === local) {
    ctx.out("Everything up-to-date");
    track();
    return 0;
  }
  const fastForward = !before || isAncestor(gl, before, local);
  if (!fastForward && !force) {
    ctx.err(
      `To ${REMOTE_SHOWN}\n ! [rejected]        ${branch} -> ${remoteBranch} (non-fast-forward)\nerror: failed to push some refs to '${REMOTE_SHOWN}'\nhint: Updates were rejected because the tip of your current branch is behind\nhint: its remote counterpart. If you want to integrate the remote changes,\nhint: use 'git pull' before pushing again.\nhint: See the 'Note about fast-forwards' in 'git push --help' for details.`,
    );
    return 1;
  }
  if (!fastForward && isProtected(gl, remoteBranch)) {
    ctx.err(
      `remote: GitLab: You are not allowed to force push code to a protected branch on this project.\nTo ${REMOTE_SHOWN}\n ! [remote rejected] ${branch} -> ${remoteBranch} (pre-receive hook declined)\nerror: failed to push some refs to '${REMOTE_SHOWN}'`,
    );
    return 1;
  }

  // What GitLab does not have yet: commits not reachable from any of its branches.
  const known = new Set<string>();
  for (const b of Object.values(gl.branches)) for (const c of commitsBetween(gl, undefined, b)) known.add(c.sha);
  const fresh = commitsBetween(gl, undefined, local).filter((c) => !known.has(c.sha));
  let blobs = 0;
  for (const c of fresh) blobs += diffStat(c.parent ? (gl.commits[c.parent]?.files ?? {}) : {}, c.files).files.filter((p) => p in c.files).length;
  const total = fresh.length * 2 + blobs;
  const enumerate = total + (fresh.length ? fresh.length + 1 : 0);
  const lines: string[] = [];
  if (total) {
    const bytes = 180 + blobs * 230 + fresh.length * 160;
    lines.push(
      `Enumerating objects: ${enumerate}, done.`,
      `Counting objects: 100% (${enumerate}/${enumerate}), done.`,
      `Delta compression using up to 8 threads`,
      `Compressing objects: 100% (${total}/${total}), done.`,
      `Writing objects: 100% (${total}/${total}), ${bytes} bytes | ${bytes}.00 KiB/s, done.`,
      `Total ${total} (delta ${Math.max(0, blobs - 1)}), reused 0 (delta 0), pack-reused 0`,
    );
  } else lines.push(`Total 0 (delta 0), reused 0 (delta 0), pack-reused 0`);

  gl.branches[remoteBranch] = local;
  r.remoteRefs[remoteBranch] = local;

  let mrIid: number | undefined;
  const wantsMr = opts.some((o) => o === "merge_request.create" || o === "mr.create");
  if (wantsMr && remoteBranch !== gl.project.defaultBranch) {
    const target = opts.find((o) => o.startsWith("merge_request.target="))?.split("=")[1] ?? gl.project.defaultBranch;
    const existing = gl.mergeRequests.find((m) => m.source === remoteBranch && m.state === "opened");
    if (existing) mrIid = existing.iid;
    else {
      mrIid = gl.mergeRequests.length + 1;
      gl.mergeRequests.push({ iid: mrIid, source: remoteBranch, target, title: title(gl.commits[local]), state: "opened" });
    }
    lines.push(`remote: `, `remote: View merge request for ${remoteBranch}:`, `remote:   ${gl.project.webUrl}/-/merge_requests/${mrIid}`, `remote: `);
  } else if (!before && remoteBranch !== gl.project.defaultBranch) {
    lines.push(
      `remote: `,
      `remote: To create a merge request for ${remoteBranch}, visit:`,
      `remote:   ${gl.project.webUrl}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(remoteBranch)}`,
      `remote: `,
    );
  }
  lines.push(`To ${REMOTE_SHOWN}`);
  const label = branch === remoteBranch ? `${branch} -> ${remoteBranch}` : `${branch} -> ${remoteBranch}`;
  if (!before) lines.push(` * [new branch]      ${label}`);
  else if (!fastForward) lines.push(` + ${shortSha(before)}...${shortSha(local)} ${label} (forced update)`);
  else lines.push(`   ${shortSha(before)}..${shortSha(local)}  ${label}`);
  ctx.out(lines.join("\n"));
  track();

  createPipeline(ctx.w, { ref: remoteBranch, sha: local, source: "push" });
  if (mrIid !== undefined) createPipeline(ctx.w, { ref: remoteBranch, sha: local, source: "merge_request_event", mergeRequest: mrIid });
  return 0;
}

function cmdLog(ctx: Ctx, repo: Repo, args: string[]): number {
  const { gl, r } = repo;
  const oneline = args.includes("--oneline");
  let abbrev = oneline || args.includes("--abbrev-commit") ? 7 : 40;
  const ab = args.find((a) => a.startsWith("--abbrev="));
  if (ab) abbrev = Number(ab.slice(9)) || 7;
  let limit = Infinity;
  for (let i = 0; i < args.length; i++) {
    if (/^-\d+$/.test(args[i])) limit = Number(args[i].slice(1));
    else if (args[i] === "-n") limit = Number(args[++i] ?? Infinity);
    else if (/^--max-count=\d+$/.test(args[i])) limit = Number(args[i].split("=")[1]);
  }
  const start = args.find((a) => !a.startsWith("-") && !/^\d+$/.test(a));
  const sha = start ? (r.branches[start] ?? (start.startsWith("origin/") ? r.remoteRefs[start.slice(7)] : findCommit(gl, start)?.sha)) : headSha(r);
  if (!sha) {
    ctx.err(`fatal: ambiguous argument '${start}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'`);
    return 128;
  }
  const commits = commitsBetween(gl, undefined, sha).slice(0, limit);
  const out: string[] = [];
  for (const c of commits) {
    if (oneline) out.push(`${shortSha(c.sha, abbrev)}${decorations(gl, r, c.sha)} ${title(c)}`);
    else {
      out.push(`commit ${shortSha(c.sha, abbrev)}${decorations(gl, r, c.sha)}`, `Author: ${c.author}`, `Date:   ${gitDate(c.at)}`, ``);
      for (const l of c.message.split("\n")) out.push(l ? `    ${l}` : "");
      out.push("");
    }
  }
  ctx.out(out.join("\n").replace(/\n+$/, ""));
  return 0;
}

function switchTo(ctx: Ctx, repo: Repo, name: string, create: boolean, how: "switch" | "checkout"): number {
  const { gl, r } = repo;
  if (create) {
    if (r.branches[name]) {
      ctx.err(`fatal: a branch named '${name}' already exists`);
      return 128;
    }
    if (!/^[\w./-]+$/.test(name) || name.endsWith("/") || name.includes("..")) {
      ctx.err(`fatal: '${name}' is not a valid branch name`);
      return 128;
    }
    r.branches[name] = headSha(r);
    r.branch = name;
    writeHead(ctx, r);
    ctx.out(`Switched to a new branch '${name}'`);
    return 0;
  }
  if (name === r.branch) {
    ctx.out(`Already on '${name}'`);
    for (const l of upstreamLine(gl, r)) ctx.out(l);
    return 0;
  }
  let target = r.branches[name];
  let tracking = false;
  if (!target && r.remoteRefs[name]) {
    target = r.remoteRefs[name];
    tracking = true;
  }
  if (!target) {
    ctx.err(how === "switch" ? `fatal: invalid reference: ${name}` : `error: pathspec '${name}' did not match any file(s) known to git`);
    return how === "switch" ? 128 : 1;
  }
  const from = headFiles(gl, r);
  const to = gl.commits[target].files;
  const conflicts = dirty(ctx, repo).filter((p) => from[p] !== to[p]);
  if (conflicts.length) {
    ctx.err(`error: Your local changes to the following files would be overwritten by checkout:\n${conflicts.map((p) => `\t${p}`).join("\n")}\nPlease commit your changes or stash them before you switch branches.\nAborting`);
    return 1;
  }
  const keep = dirty(ctx, repo);
  const wt = workingTree(ctx.host, r.path);
  checkoutTree(ctx.host, r.path, from, to, ctx.realUser);
  for (const p of keep) if (p in wt) put(ctx.host, `${r.path}/${p}`, file(wt[p], 0o644, ctx.realUser, ctx.realUser));
  const newIndex: Record<string, string> = { ...to };
  for (const p of keep) {
    if (p in r.index) newIndex[p] = r.index[p];
    else delete newIndex[p];
  }
  r.index = newIndex;
  if (tracking) {
    r.branches[name] = target;
    r.upstream[name] = name;
    ctx.out(`branch '${name}' set up to track 'origin/${name}'.`);
  }
  r.branch = name;
  writeHead(ctx, r);
  ctx.out(tracking ? `Switched to a new branch '${name}'` : `Switched to branch '${name}'`);
  for (const l of upstreamLine(gl, r)) ctx.out(l);
  return 0;
}

function resolveRev(repo: Repo, rev: string): GitCommit | undefined {
  const { gl, r } = repo;
  const m = /^(HEAD|@)((?:~\d*|\^)*)$/.exec(rev);
  let c: GitCommit | undefined;
  if (m) {
    c = gl.commits[headSha(r)];
    const steps = (m[2].match(/~(\d*)|\^/g) ?? []).reduce((n, s) => n + (s === "^" ? 1 : Number(s.slice(1) || 1)), 0);
    for (let i = 0; i < steps && c; i++) c = c.parent ? gl.commits[c.parent] : undefined;
    return c;
  }
  if (r.branches[rev]) return gl.commits[r.branches[rev]];
  return findCommit(gl, rev);
}

function cmdRevert(ctx: Ctx, repo: Repo, args: string[]): number {
  const rev = args.find((a) => !a.startsWith("-"));
  if (!rev) {
    ctx.err("usage: git revert [--[no-]edit] [-n] [-m <parent-number>] [-s] [-S[<keyid>]] <commit>...");
    return 129;
  }
  const c = resolveRev(repo, rev);
  if (!c) {
    ctx.err(`fatal: bad revision '${rev}'`);
    return 128;
  }
  if (dirty(ctx, repo).length) {
    ctx.err("error: your local changes would be overwritten by revert.\nhint: commit your changes or stash them to proceed.\nfatal: revert failed");
    return 128;
  }
  const parentFiles = c.parent ? (repo.gl.commits[c.parent]?.files ?? {}) : {};
  const head = headFiles(repo.gl, repo.r);
  const changed = diffStat(parentFiles, c.files).files;
  const conflict = changed.find((p) => head[p] !== c.files[p]);
  if (conflict) {
    ctx.err(
      `Auto-merging ${conflict}\nCONFLICT (content): Merge conflict in ${conflict}\nerror: could not revert ${shortSha(c.sha)}... ${title(c)}\nhint: After resolving the conflicts, mark them with\nhint: "git add/rm <pathspec>", then run\nhint: "git revert --continue".\nhint: You can instead skip this commit with "git revert --skip".\nhint: To abort and get back to the state before "git revert",\nhint: run "git revert --abort".`,
    );
    return 1;
  }
  const files = { ...head };
  for (const p of changed) {
    if (p in parentFiles) files[p] = parentFiles[p];
    else delete files[p];
  }
  const nc = newCommit(ctx, repo, `Revert "${title(c)}"\n\nThis reverts commit ${c.sha}.`, files);
  checkoutTree(ctx.host, repo.r.path, head, files, ctx.realUser);
  repo.r.index = { ...files };
  ctx.out(commitSummary(repo, nc, head));
  return 0;
}

function cmdBranch(ctx: Ctx, repo: Repo, args: string[]): number {
  const { r } = repo;
  const del = args.includes("-d") || args.includes("-D");
  const name = args.find((a) => !a.startsWith("-"));
  if (!name) {
    ctx.out(
      Object.keys(r.branches)
        .sort()
        .map((b) => `${b === r.branch ? "*" : " "} ${b}`)
        .join("\n"),
    );
    return 0;
  }
  if (del) {
    if (!r.branches[name]) {
      ctx.err(`error: branch '${name}' not found`);
      return 1;
    }
    if (name === r.branch) {
      ctx.err(`error: cannot delete branch '${name}' used by worktree at '${r.path}'`);
      return 1;
    }
    const sha = r.branches[name];
    delete r.branches[name];
    delete r.upstream[name];
    ctx.out(`Deleted branch ${name} (was ${shortSha(sha)}).`);
    return 0;
  }
  if (r.branches[name]) {
    ctx.err(`fatal: a branch named '${name}' already exists`);
    return 128;
  }
  r.branches[name] = headSha(r);
  return 0;
}

function cmdDiff(ctx: Ctx, repo: Repo, args: string[]): number {
  const staged = args.includes("--staged") || args.includes("--cached");
  const a = staged ? headFiles(repo.gl, repo.r) : repo.r.index;
  const wt = workingTree(ctx.host, repo.r.path);
  const b: Record<string, string> = staged ? repo.r.index : Object.fromEntries(Object.keys(repo.r.index).filter((p) => p in wt).map((p) => [p, wt[p]]));
  if (!staged) for (const p of Object.keys(repo.r.index)) if (!(p in wt)) delete b[p];
  const d = diffStat(a, b);
  if (args.includes("--stat")) {
    if (d.files.length) ctx.out([...d.files.map((p) => ` ${p} | changed`), statLine(d)].join("\n"));
    return 0;
  }
  const out: string[] = [];
  for (const p of d.files) {
    const la = (a[p] ?? "").split("\n").filter(Boolean);
    const lb = (b[p] ?? "").split("\n").filter(Boolean);
    out.push(`diff --git a/${p} b/${p}`);
    if (!(p in a)) out.push(`new file mode 100644`);
    if (!(p in b)) out.push(`deleted file mode 100644`);
    out.push(`index ${hashHex("blob" + (a[p] ?? ""), 7)}..${hashHex("blob" + (b[p] ?? ""), 7)}${p in a && p in b ? " 100644" : ""}`);
    out.push(p in a ? `--- a/${p}` : "--- /dev/null", p in b ? `+++ b/${p}` : "+++ /dev/null");
    out.push(`@@ -${la.length ? 1 : 0},${la.length} +${lb.length ? 1 : 0},${lb.length} @@`);
    const setB = new Set(lb);
    const setA = new Set(la);
    for (const l of la) out.push(setB.has(l) ? ` ${l}` : `-${l}`);
    for (const l of lb) if (!setA.has(l)) out.push(`+${l}`);
  }
  if (out.length) ctx.out(out.join("\n"));
  return 0;
}

function cmdRestore(ctx: Ctx, repo: Repo, args: string[]): number {
  const staged = args.includes("--staged") || args.includes("-S");
  const paths = args.filter((a) => !a.startsWith("-"));
  if (!paths.length) {
    ctx.err("fatal: you must specify path(s) to restore");
    return 128;
  }
  const head = headFiles(repo.gl, repo.r);
  for (const raw of paths) {
    const rel = relPath(ctx, repo.r, raw);
    const under = (p: string) => rel === "" || p === rel || p.startsWith(rel + "/");
    const pool = staged ? [...new Set([...Object.keys(head), ...Object.keys(repo.r.index)])] : Object.keys(repo.r.index);
    const hits = pool.filter(under);
    if (!hits.length) {
      ctx.err(`error: pathspec '${raw}' did not match any file(s) known to git`);
      return 1;
    }
    for (const p of hits) {
      if (staged) {
        if (p in head) repo.r.index[p] = head[p];
        else delete repo.r.index[p];
      } else checkoutTree(ctx.host, repo.r.path, {}, { [p]: repo.r.index[p] }, ctx.realUser);
    }
  }
  return 0;
}

function cmdRevParse(ctx: Ctx, repo: Repo, args: string[]): number {
  if (args.includes("--abbrev-ref")) {
    ctx.out(repo.r.branch);
    return 0;
  }
  if (args.includes("--show-toplevel")) {
    ctx.out(repo.r.path);
    return 0;
  }
  const short = args.find((a) => a.startsWith("--short"));
  const n = short ? Number(short.split("=")[1] ?? 7) : 40;
  const rev = args.find((a) => !a.startsWith("-")) ?? "HEAD";
  const c = resolveRev(repo, rev);
  if (!c) {
    ctx.err(`fatal: ambiguous argument '${rev}': unknown revision or path not in the working tree.`);
    return 128;
  }
  ctx.out(shortSha(c.sha, n));
  return 0;
}

const HELP = `usage: git [-v | --version] [-h | --help] [-C <path>] [-c <name>=<value>]
           <command> [<args>]

These are common Git commands used in various situations:

start a working area
   clone     Clone a repository into a new directory

work on the current change
   add       Add file contents to the index
   restore   Restore working tree files

examine the history and state
   diff      Show changes between commits, commit and working tree, etc
   log       Show commit logs
   status    Show the working tree status

grow, mark and tweak your common history
   branch    List, create, or delete branches
   commit    Record changes to the repository
   switch    Switch branches
   revert    Revert some existing commits

collaborate
   pull      Fetch from and integrate with another repository or a local branch
   push      Update remote refs along with associated objects`;

export const git: Command = {
  name: "git",
  summary: "save and share code (git status, git add ., git commit -m, git push)",
  run(ctx) {
    const args = ctx.argv.slice(1);
    const sub = args[0];
    if (!sub || sub === "--help" || sub === "help") {
      ctx.out(HELP);
      return sub ? 0 : 1;
    }
    if (sub === "--version" || sub === "-v" || sub === "version") {
      ctx.out("git version 2.43.0");
      return 0;
    }
    if (sub === "config") return 0;
    const KNOWN = ["status", "add", "commit", "push", "log", "switch", "checkout", "branch", "revert", "diff", "restore", "rev-parse", "remote", "pull", "fetch", "clone", "init", "show", "stash", "merge", "reset", "rm", "mv", "tag"];
    if (!KNOWN.includes(sub)) {
      ctx.err(`git: '${sub}' is not a git command. See 'git --help'.`);
      return 1;
    }
    const repo = repoFor(ctx);
    if (sub === "clone") {
      ctx.info("The repo is already cloned at ~/code/crumb. cd ~/code/crumb");
      return 1;
    }
    if (!repo) return notRepo(ctx);
    const rest = args.slice(1);
    switch (sub) {
      case "status": {
        if (rest.includes("-s") || rest.includes("--short")) {
          const st = status(ctx, repo);
          const lines: string[] = [];
          const map: Record<string, [string, string]> = {};
          for (const s of st.staged) map[s.path] = [s.kind === "new file" ? "A" : s.kind === "deleted" ? "D" : "M", " "];
          for (const u of st.unstaged) map[u.path] = [map[u.path]?.[0] ?? " ", u.kind === "deleted" ? "D" : "M"];
          for (const [p, [x, y]] of Object.entries(map).sort()) lines.push(`${x}${y} ${p}`);
          for (const u of st.untracked) lines.push(`?? ${u}`);
          if (lines.length) ctx.out(lines.join("\n"));
          return 0;
        }
        ctx.out(statusText(ctx, repo).text);
        return 0;
      }
      case "add":
        return cmdAdd(ctx, repo, rest);
      case "commit":
        return cmdCommit(ctx, repo, rest);
      case "push":
        return cmdPush(ctx, repo, rest);
      case "log":
        return cmdLog(ctx, repo, rest);
      case "switch": {
        const c = rest.indexOf("-c") >= 0 ? rest.indexOf("-c") : rest.indexOf("--create");
        const name = c >= 0 ? rest[c + 1] : rest.find((a) => !a.startsWith("-"));
        if (!name) {
          ctx.err("fatal: missing branch or commit argument");
          return 128;
        }
        return switchTo(ctx, repo, name, c >= 0, "switch");
      }
      case "checkout": {
        const b = rest.indexOf("-b");
        if (rest[0] === "--") return cmdRestore(ctx, repo, rest.slice(1));
        const name = b >= 0 ? rest[b + 1] : rest.find((a) => !a.startsWith("-"));
        if (!name) {
          ctx.err("fatal: you must specify path(s) to restore");
          return 128;
        }
        if (b < 0 && !repo.r.branches[name] && !repo.r.remoteRefs[name] && name in repo.r.index) return cmdRestore(ctx, repo, [name]);
        return switchTo(ctx, repo, name, b >= 0, "checkout");
      }
      case "branch":
        return cmdBranch(ctx, repo, rest);
      case "revert":
        return cmdRevert(ctx, repo, rest);
      case "diff":
        return cmdDiff(ctx, repo, rest);
      case "restore":
        return cmdRestore(ctx, repo, rest);
      case "rev-parse":
        return cmdRevParse(ctx, repo, rest);
      case "remote":
        ctx.out(rest.includes("-v") ? `origin\t${repo.gl.project.sshUrl} (fetch)\norigin\t${repo.gl.project.sshUrl} (push)` : "origin");
        return 0;
      case "pull":
      case "fetch":
        if (sub === "pull") ctx.out("Already up to date.");
        return 0;
      default:
        ctx.info(`git ${sub} is not in this game yet.`);
        return 1;
    }
  },
  complete: () => ["status", "add", "commit", "push", "log", "switch", "checkout", "branch", "revert", "diff", "restore", "rev-parse", "remote", "pull"],
};

/** Exposed for tests and level setups: the files git would commit right now. */
export function trackedSnapshot(w: World): Record<string, string> {
  const r = w.gitlab?.local;
  return r ? workingTree(w.hosts.laptop, r.path) : {};
}

export const GIT_COMMANDS = [git];
