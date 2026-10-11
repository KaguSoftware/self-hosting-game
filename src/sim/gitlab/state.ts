// Setting up the GitLab project and the laptop's clone, plus small helpers on both.
import { LAPTOP_USER } from "../constants";
import { dir, file, getDir, getFile, put, removeNode } from "../fs";
import { APP_REPO } from "../docker/images";
import type { Host, RegistryImage, World } from "../types";
import { globMatch, hashB64, hashHex } from "../util";
import type { GitCommit, GitLabState, Pipeline, Runner } from "./types";

export const GITLAB_HOST = "gitlab.com";
export const GITLAB_IP = "172.65.251.78";
export const GITLAB_HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf";
export const GITLAB_HOST_FP = "SHA256:eUXGGm1YGsMAS7vkcx6JOJdOGHPem5gQp4taiCfCLB8";
export const PROJECT_PATH = "crumb/web";
export const REPO_PATH = `/home/${LAPTOP_USER}/code/crumb`;
export const AUTHOR = "You <you@crumb.shop>";
export const RUNNER_VERSION = "17.5.2";
export const RUNNER_REVISION = "c6eae8d7";

// ---------- the shop's code ----------

const PACKAGE_JSON = `{
  "name": "crumb",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run"
  },
  "dependencies": {
    "next": "16.0.0",
    "pg": "8.13.1",
    "react": "19.2.0",
    "react-dom": "19.2.0"
  },
  "devDependencies": {
    "typescript": "5.9.3",
    "vitest": "3.2.4"
  }
}
`;

const PACKAGE_LOCK = `{
  "name": "crumb",
  "version": "0.1.0",
  "lockfileVersion": 3,
  "requires": true
}
`;

export const REPO_DOCKERFILE = `FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_SHOP_NAME
RUN npm run build

FROM node:24-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
`;

export const REPO_COMPOSE = `services:
  app:
    image: ${APP_REPO}:\${APP_TAG:-latest}
    restart: unless-stopped
    env_file: .env
`;

const BASE_FILES: Record<string, string> = {
  ".gitignore": "node_modules\n.next\n.env*\n",
  "README.md": "# crumb\n\nThe Crumb bakery shop. Next.js 16.\n\n```\nnpm run dev\n```\n",
  "package.json": PACKAGE_JSON,
  "package-lock.json": PACKAGE_LOCK,
  "next.config.ts": `import type { NextConfig } from "next";\n\nconst config: NextConfig = { output: "standalone" };\nexport default config;\n`,
  "app/layout.tsx": `export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return <html lang="en"><body>{children}</body></html>;\n}\n`,
  "app/page.tsx": `export default function Home() {\n  return <main><h1>{process.env.NEXT_PUBLIC_SHOP_NAME ?? "Crumb"}</h1></main>;\n}\n`,
  "lib/env.ts": `if (!process.env.AUTH_SECRET) throw new Error("AUTH_SECRET is not set");\nexport const authSecret = process.env.AUTH_SECRET;\n`,
  "public/logo.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="14"/></svg>\n`,
};

const CART_FILES: Record<string, string> = {
  "lib/cart.ts": `export type Line = { price: number; qty: number };\n\nexport function total(lines: Line[]): number {\n  return lines.reduce((sum, l) => sum + l.price * l.qty, 0);\n}\n`,
  "lib/cart.test.ts": `import { expect, it } from "vitest";\nimport { total } from "./cart";\n\nit("adds up the lines", () => {\n  expect(total([{ price: 3, qty: 2 }, { price: 1, qty: 1 }])).toBe(7);\n});\n\nit("is zero for an empty cart", () => {\n  expect(total([])).toBe(0);\n});\n\nit("counts quantity", () => {\n  expect(total([{ price: 2, qty: 5 }])).toBe(10);\n});\n`,
};

const DOCKER_FILES: Record<string, string> = {
  Dockerfile: REPO_DOCKERFILE,
  ".dockerignore": "node_modules\n.next\n.git\n.env*\n",
  "compose.yaml": REPO_COMPOSE,
};

/** A complete pipeline: test, build and push by SHA and latest, deploy over SSH as ci. Handy for tests and show me. */
export const FULL_CI = `stages:
  - test
  - build
  - deploy

test:
  stage: test
  image: node:24-alpine
  script:
    - npm ci
    - npm test

build:
  stage: build
  image: docker:27
  services:
    - docker:27-dind
  variables:
    DOCKER_TLS_CERTDIR: "/certs"
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
  script:
    - echo "$CI_REGISTRY_PASSWORD" | docker login -u "$CI_REGISTRY_USER" --password-stdin $CI_REGISTRY
    - docker build -t $CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA -t $CI_REGISTRY_IMAGE:latest .
    - docker push $CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA
    - docker push $CI_REGISTRY_IMAGE:latest

deploy:
  stage: deploy
  image: alpine:3.20
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
  before_script:
    - apk add --no-cache openssh-client
    - chmod 600 "$SSH_KEY"
  script:
    - ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new ci@203.0.113.10 "cd /srv/crumb && APP_TAG=$CI_COMMIT_SHORT_SHA docker compose pull app && APP_TAG=$CI_COMMIT_SHORT_SHA docker compose up -d app"
`;

// ---------- helpers ----------

export function commitSha(parent: string | undefined, message: string, files: Record<string, string>, at: number): string {
  return hashHex(`commit|${parent ?? ""}|${message}|${JSON.stringify(files)}|${at}`, 40);
}

/** git's default abbreviation is 7 characters. GitLab's CI_COMMIT_SHORT_SHA is 8. */
export function shortSha(sha: string, n = 7): string {
  return sha.slice(0, n);
}

export function addCommit(gl: GitLabState, c: Omit<GitCommit, "sha">): GitCommit {
  const sha = commitSha(c.parent, c.message, c.files, c.at);
  const commit: GitCommit = { sha, ...c };
  gl.commits[sha] = commit;
  return commit;
}

/** Find a commit by full or abbreviated sha. */
export function findCommit(gl: GitLabState, ref: string): GitCommit | undefined {
  if (gl.commits[ref]) return gl.commits[ref];
  if (ref.length < 4) return undefined;
  const hits = Object.values(gl.commits).filter((c) => c.sha.startsWith(ref));
  return hits.length === 1 ? hits[0] : undefined;
}

/** Is `ancestor` reachable from `sha` by following parents? */
export function isAncestor(gl: GitLabState, ancestor: string, sha: string): boolean {
  let cur: string | undefined = sha;
  for (let i = 0; cur && i < 1000; i++) {
    if (cur === ancestor) return true;
    cur = gl.commits[cur]?.parent;
  }
  return false;
}

/** Commits on `sha` that `base` does not have, newest first. */
export function commitsBetween(gl: GitLabState, base: string | undefined, sha: string): GitCommit[] {
  const out: GitCommit[] = [];
  let cur: string | undefined = sha;
  for (let i = 0; cur && cur !== base && i < 1000; i++) {
    const c: GitCommit | undefined = gl.commits[cur];
    if (!c) break;
    out.push(c);
    cur = c.parent;
  }
  return out;
}

export function isProtected(gl: GitLabState, ref: string): boolean {
  return gl.protectedBranches.some((p) => p === ref || (p.includes("*") && globMatch(p, ref)));
}

/** Newest pipeline, optionally only for one ref. */
export function latestPipeline(gl: GitLabState | undefined, ref?: string): Pipeline | undefined {
  if (!gl) return undefined;
  for (let i = gl.pipelines.length - 1; i >= 0; i--) {
    const p = gl.pipelines[i];
    if (!ref || p.ref === ref) return p;
  }
  return undefined;
}

// ---------- working tree on the laptop ----------

function ignoreRes(text: string | undefined): RegExp[] {
  if (!text) return [];
  const out: RegExp[] = [];
  for (const raw of text.split("\n")) {
    const p = raw.trim().replace(/^\/+/, "").replace(/\/+$/, "");
    if (!p || p.startsWith("#") || p.startsWith("!")) continue;
    const src = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
    // A bare name matches at any depth; anything inside a matching folder is ignored too.
    out.push(new RegExp(`${p.includes("/") ? "^" : "(^|/)"}${src}(/.*)?$`));
  }
  return out;
}

/** Every file in the working tree (relative path to content), minus .git and .gitignore matches. */
export function workingTree(host: Host, root: string = REPO_PATH): Record<string, string> {
  const res = ignoreRes(getFile(host, `${root}/.gitignore`)?.content);
  const out: Record<string, string> = {};
  const walk = (abs: string, rel: string) => {
    const d = getDir(host, abs);
    if (!d) return;
    for (const [name, node] of Object.entries(d.children)) {
      const r = rel ? `${rel}/${name}` : name;
      if (r === ".git" || res.some((re) => re.test(r))) continue;
      if (node.type === "dir") walk(`${abs}/${name}`, r);
      else out[r] = node.content;
    }
  };
  walk(root, "");
  return out;
}

/** Make the working tree match `to`, removing tracked files from `from` that are gone. */
export function checkoutTree(host: Host, root: string, from: Record<string, string>, to: Record<string, string>, owner = LAPTOP_USER): void {
  for (const p of Object.keys(from)) if (!(p in to)) removeNode(host, `${root}/${p}`);
  for (const [p, c] of Object.entries(to)) {
    const existing = getFile(host, `${root}/${p}`);
    if (existing) existing.content = c;
    else {
      const parts = p.split("/");
      for (let i = 1; i < parts.length; i++) {
        const d = `${root}/${parts.slice(0, i).join("/")}`;
        if (!getDir(host, d)) put(host, d, dir(0o755, owner, owner));
      }
      put(host, `${root}/${p}`, file(c, 0o644, owner, owner));
    }
  }
}

export interface DiffStat {
  files: string[];
  created: string[];
  deleted: string[];
  insertions: number;
  deletions: number;
}

/** Line counts like `git commit` prints (multiset of lines, good enough for small files). */
export function diffStat(a: Record<string, string>, b: Record<string, string>): DiffStat {
  const out: DiffStat = { files: [], created: [], deleted: [], insertions: 0, deletions: 0 };
  const paths = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const p of paths) {
    if (a[p] === b[p]) continue;
    out.files.push(p);
    if (!(p in a)) out.created.push(p);
    if (!(p in b)) out.deleted.push(p);
    const la = (a[p] ?? "").split("\n").filter((l, i, arr) => !(i === arr.length - 1 && l === ""));
    const lb = (b[p] ?? "").split("\n").filter((l, i, arr) => !(i === arr.length - 1 && l === ""));
    const count = new Map<string, number>();
    for (const l of la) count.set(l, (count.get(l) ?? 0) + 1);
    let common = 0;
    for (const l of lb) {
      const n = count.get(l) ?? 0;
      if (n > 0) {
        common++;
        count.set(l, n - 1);
      }
    }
    out.insertions += lb.length - common;
    out.deletions += la.length - common;
  }
  return out;
}

export function statLine(d: DiffStat): string {
  const parts = [`${d.files.length} file${d.files.length === 1 ? "" : "s"} changed`];
  if (d.insertions || !d.deletions) parts.push(`${d.insertions} insertion${d.insertions === 1 ? "" : "s"}(+)`);
  if (d.deletions) parts.push(`${d.deletions} deletion${d.deletions === 1 ? "" : "s"}(-)`);
  return " " + parts.join(", ");
}

// ---------- registry ----------

/** An app image in the GitLab registry as if CI had built `sha` (for level setups). */
export function registryImageFor(sha: string, tag: string): RegistryImage {
  return {
    ref: `${APP_REPO}:${tag}`,
    id: hashHex(`crumb-web-build|${sha}`, 12),
    sizeMb: 212,
    kind: "nextjs",
    ageDays: 1,
    meta: {
      flavor: "node",
      version: "24.11.0",
      env: { NODE_ENV: "production", HOSTNAME: "0.0.0.0", PORT: "3000" },
      entrypoint: ["docker-entrypoint.sh"],
      cmd: ["node", "server.js"],
      exposed: [3000],
      workdir: "/app",
      requiredEnv: ["AUTH_SECRET"],
      built: true,
      revision: sha,
    },
  };
}

/** Put images for `sha` in the registry under these tags. */
export function seedRegistry(w: World, sha: string, tags: string[]): void {
  w.registry ??= {};
  for (const t of tags) w.registry[`${APP_REPO}:${t}`] = registryImageFor(sha, t);
}

/** Which commit an image id was built from, if the registry knows. */
export function revisionOfImage(w: World, imageId: string | undefined): string | undefined {
  if (!imageId) return undefined;
  for (const r of Object.values(w.registry ?? {})) if (r.id === imageId && r.meta?.revision) return r.meta.revision;
  for (const h of Object.values(w.hosts)) {
    for (const i of Object.values(h.docker.images)) if (i.id === imageId && i.meta?.revision) return i.meta.revision;
  }
  return undefined;
}

/**
 * The commit the live app was built from: the running app container's image, looked up
 * in the registry. Undefined when nobody knows (an image built by hand on the server).
 */
export function liveRevision(w: World): string | undefined {
  const cs = Object.values(w.hosts.vps.docker.containers).filter((c) => c.status === "running");
  const app = cs.find((c) => c.service === "app") ?? cs.find((c) => c.kind === "nextjs");
  return app ? revisionOfImage(w, app.imageId) : undefined;
}

// ---------- creating it all ----------

export interface GitLabOpts {
  /** .gitlab-ci.yml in the last commit. */
  ci?: string;
  /** The laptop's key is already on the GitLab profile. */
  userKey?: boolean;
  /** The project's runner. Default: one online, privileged runner with no tags. */
  runners?: Runner[];
  protectedBranches?: string[];
  /** Registry already has the HEAD image under its short sha and latest. */
  seedRegistry?: boolean;
}

export function defaultRunner(over: Partial<Runner> = {}): Runner {
  return {
    id: 1,
    description: "crumb-runner",
    online: true,
    tags: [],
    executor: "docker",
    privileged: true,
    runUntagged: true,
    defaultImage: "alpine:3.20",
    shortToken: "t3xQaB9c",
    ...over,
  };
}

/** Create crumb/web on GitLab with a short history, and its clone on the laptop at ~/code/crumb. */
export function createGitLab(w: World, opts: GitLabOpts = {}): GitLabState {
  const gl: GitLabState = {
    project: {
      path: PROJECT_PATH,
      name: "web",
      visibility: "private",
      defaultBranch: "main",
      sshUrl: `git@${GITLAB_HOST}:${PROJECT_PATH}.git`,
      webUrl: `https://${GITLAB_HOST}/${PROJECT_PATH}`,
    },
    protectedBranches: opts.protectedBranches ?? ["main"],
    branches: {},
    commits: {},
    variables: [],
    runners: opts.runners ?? [defaultRunner()],
    pipelines: [],
    nextPipelineId: 1401,
    nextJobId: 8801,
    deployTokens: [],
    deployKeys: [],
    userKeys: [],
    mergeRequests: [],
  };
  const t0 = w.clock - 3 * 86400;
  const c1 = addCommit(gl, { message: "Initial commit from Create Next App", author: AUTHOR, files: { ...BASE_FILES }, at: t0 });
  const c2 = addCommit(gl, { message: "Add cart totals with tests", author: AUTHOR, parent: c1.sha, files: { ...c1.files, ...CART_FILES }, at: t0 + 86400 });
  let head = addCommit(gl, { message: "Add Dockerfile and compose.yaml", author: AUTHOR, parent: c2.sha, files: { ...c2.files, ...DOCKER_FILES }, at: t0 + 2 * 86400 });
  if (opts.ci) {
    head = addCommit(gl, { message: "Add .gitlab-ci.yml", author: AUTHOR, parent: head.sha, files: { ...head.files, ".gitlab-ci.yml": opts.ci }, at: t0 + 2 * 86400 + 3600 });
  }
  gl.branches.main = head.sha;
  gl.local = {
    path: REPO_PATH,
    branch: "main",
    branches: { main: head.sha },
    upstream: { main: "main" },
    remoteRefs: { main: head.sha },
    index: { ...head.files },
  };
  w.gitlab = gl;

  const laptop = w.hosts.laptop;
  const home = `/home/${LAPTOP_USER}`;
  if (!getDir(laptop, REPO_PATH)) put(laptop, REPO_PATH, dir(0o755, LAPTOP_USER));
  put(laptop, `${REPO_PATH}/.git`, dir(0o755, LAPTOP_USER));
  put(laptop, `${REPO_PATH}/.git/HEAD`, file("ref: refs/heads/main\n", 0o644, LAPTOP_USER));
  put(
    laptop,
    `${REPO_PATH}/.git/config`,
    file(
      `[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n[remote "origin"]\n\turl = ${gl.project.sshUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n`,
      0o644,
      LAPTOP_USER,
    ),
  );
  checkoutTree(laptop, REPO_PATH, {}, head.files);
  if (!laptop.packages.git) laptop.packages.git = { version: "1:2.43.0-1ubuntu7.3" };
  // The clone already talked to gitlab.com once, so its host key is known.
  if (!getDir(laptop, `${home}/.ssh`)) put(laptop, `${home}/.ssh`, dir(0o700, LAPTOP_USER));
  const kh = getFile(laptop, `${home}/.ssh/known_hosts`);
  const line = `${GITLAB_HOST} ${GITLAB_HOST_KEY}\n`;
  if (!kh) put(laptop, `${home}/.ssh/known_hosts`, file(line, 0o644, LAPTOP_USER));
  else if (!kh.content.includes(GITLAB_HOST + " ")) kh.content += line;
  if (opts.userKey) {
    const pub = getFile(laptop, `${home}/.ssh/id_ed25519.pub`)?.content;
    if (pub) gl.userKeys.push(pub.trim());
  }
  if (opts.seedRegistry) seedRegistry(w, head.sha, [shortSha(head.sha, 8), "latest"]);
  return gl;
}

/** A deploy token value, like GitLab shows once after creating it. */
export function deployTokenValue(name: string, id: number): string {
  return `gldt-${hashB64(`deploy-token|${name}|${id}`, 20).replace(/[+/]/g, "x")}`;
}
