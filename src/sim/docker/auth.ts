// Registry logins. `docker login` writes ~/.docker/config.json for the user who ran it,
// and every pull from the private GitLab registry reads it back. The docker CLI sets the
// client (host and user) around each command so the daemon side knows whose file to read.
import { dir, file, getDir, getFile, put } from "../fs";
import type { Host, HostId, World } from "../types";
import { hashB64 } from "../util";

export const GITLAB_REGISTRY = "registry.gitlab.com";

let client: { host: HostId; user: string } | undefined;

/** Run `fn` as if the docker CLI of `user` on `host` sent the requests. */
export function withDockerClient<T>(host: Host, user: string, fn: () => T): T {
  const prev = client;
  client = { host: host.id, user };
  try {
    return fn();
  } finally {
    client = prev;
  }
}

/** "registry.gitlab.com/crumb/web:1" -> "registry.gitlab.com". Docker Hub refs give "docker.io". */
export function registryOf(ref: string): string {
  const first = ref.split("/")[0];
  return ref.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost") ? first : "docker.io";
}

export function dockerConfigPath(host: Host, user: string): string {
  const home = host.users[user]?.home ?? (user === "root" ? "/root" : `/home/${user}`);
  return `${home}/.docker/config.json`;
}

export interface Cred {
  username: string;
  password: string;
}

function b64(s: string): string {
  return btoa(s);
}

function unb64(s: string): string {
  try {
    return atob(s);
  } catch {
    return "";
  }
}

export function readAuths(host: Host, user: string): Record<string, Cred> {
  const text = getFile(host, dockerConfigPath(host, user))?.content;
  if (!text) return {};
  try {
    const json = JSON.parse(text) as { auths?: Record<string, { auth?: string }> };
    const out: Record<string, Cred> = {};
    for (const [reg, v] of Object.entries(json.auths ?? {})) {
      const raw = unb64(v.auth ?? "");
      const i = raw.indexOf(":");
      if (i > 0) out[reg.replace(/^https?:\/\//, "").replace(/\/.*$/, "")] = { username: raw.slice(0, i), password: raw.slice(i + 1) };
    }
    return out;
  } catch {
    return {};
  }
}

function writeAuths(host: Host, user: string, auths: Record<string, Cred>): string {
  const path = dockerConfigPath(host, user);
  const dirPath = path.slice(0, path.lastIndexOf("/"));
  if (!getDir(host, dirPath)) put(host, dirPath, dir(0o700, user, user));
  const body: Record<string, { auth: string }> = {};
  for (const [reg, c] of Object.entries(auths)) body[reg] = { auth: b64(`${c.username}:${c.password}`) };
  const text = JSON.stringify({ auths: body }, null, "\t") + "\n";
  const existing = getFile(host, path);
  if (existing) existing.content = text;
  else put(host, path, file(text, 0o600, user, user));
  return path;
}

/** Store a login. Returns the config.json path (for the warning line). */
export function saveLogin(host: Host, user: string, registry: string, cred: Cred): string {
  return writeAuths(host, user, { ...readAuths(host, user), [registry]: cred });
}

/** Forget a login. False if there was none. */
export function removeLogin(host: Host, user: string, registry: string): boolean {
  const auths = readAuths(host, user);
  if (!auths[registry]) return false;
  delete auths[registry];
  writeAuths(host, user, auths);
  return true;
}

export interface LoginCheck {
  ok: boolean;
  pull: boolean;
  push: boolean;
}

/** CI_JOB_TOKEN of a job. It only works while that job runs. */
export function jobTokenFor(jobId: number): string {
  return `glcbt-64_${hashB64(`job-token|${jobId}`, 20).replace(/[+/]/g, "x")}`;
}

/**
 * Does the registry accept these credentials? GitLab's registry takes deploy tokens
 * (read_registry to pull, write_registry to push) and the token of a job that is running.
 */
export function checkLogin(w: World, registry: string, cred: Cred): LoginCheck {
  if (registry !== GITLAB_REGISTRY || !w.gitlab) return { ok: !!cred.username && !!cred.password, pull: true, push: true };
  if (cred.username === "gitlab-ci-token") {
    const live = w.gitlab.pipelines.some((p) => p.jobs.some((j) => j.status === "running" && jobTokenFor(j.id) === cred.password));
    return { ok: live, pull: live, push: live };
  }
  const t = w.gitlab.deployTokens.find((d) => !d.revoked && d.username === cred.username && d.token === cred.password);
  if (!t) return { ok: false, pull: false, push: false };
  return { ok: true, pull: t.scopes.includes("read_registry") || t.scopes.includes("write_registry"), push: t.scopes.includes("write_registry") };
}

/** The daemon's error when the current client may not pull `ref`, or undefined when it may. */
export function pullAuthError(w: World, host: Host, ref: string): string | undefined {
  const gl = w.gitlab;
  if (!gl || gl.project.visibility === "public" || registryOf(ref) !== GITLAB_REGISTRY) return undefined;
  const cred = client && client.host === host.id ? readAuths(host, client.user)[GITLAB_REGISTRY] : undefined;
  if (!cred) return "denied: access forbidden";
  const c = checkLogin(w, GITLAB_REGISTRY, cred);
  if (!c.ok) return "unauthorized: HTTP Basic: Access denied";
  return c.pull ? undefined : "denied: access forbidden";
}
