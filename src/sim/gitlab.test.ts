import { describe, expect, it } from "vitest";
import { produce } from "immer";
import { createShell, runScript } from "./shell/run";
import { createDemoWorld, DEMO_CADDYFILE } from "./worlds";
import { dir, file, getFile, put } from "./fs";
import { applyMapAction, applyMapActions, deriveMap } from "./map";
import * as P from "./predicates";
import type { GoalCtx } from "./predicates";
import { createGitLab, defaultRunner, FULL_CI, latestPipeline, REPO_PATH, runPipeline, shortSha, type GitLabOpts } from "./gitlab";
import { parseCi, evalExpr } from "./gitlab/ci";
import type { Shell, World } from "./types";

const laptopSh = (): Shell => createShell("l", { host: "laptop", user: "you", cwd: REPO_PATH, via: "local" });
const rootSh = (): Shell => createShell("r", { host: "vps", user: "root", cwd: "/root", via: "console" });
const ciSh = (): Shell => createShell("c", { host: "vps", user: "ci", cwd: "/home/ci", via: "ssh", remote: "203.0.113.10", loginGroups: ["ci", "docker"] });
const g = (w: World): GoalCtx => ({ world: w, shells: [], log: [] });

function run(w: World, lines: string[], sh: Shell = laptopSh()) {
  const r = runScript(w, sh, lines);
  return { ...r, text: r.out.map((o) => o.text).join("\n") };
}

const VPS_COMPOSE = `services:
  caddy:
    image: caddy:2.8
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
  app:
    image: registry.gitlab.com/crumb/web:\${APP_TAG:-latest}
    restart: unless-stopped
    env_file: .env

volumes:
  caddy_data:
`;

/**
 * The live shop (Caddy in front), a GitLab project with the laptop's clone, the laptop's
 * key on the GitLab profile, a CI key pair on the laptop, and a limited `ci` user on the
 * server that trusts that CI key. The app container is gone: CI will deploy it.
 */
function world(opts: GitLabOpts = {}): World {
  let w = createDemoWorld();
  w = run(w, ['ssh-keygen -t ed25519 -f /home/you/.ssh/id_ed25519 -N "" -C you@laptop', 'ssh-keygen -t ed25519 -f /home/you/.ssh/crumb_ci -N "" -C ci@crumb'], createShell("k", { host: "laptop", user: "you", cwd: "/home/you", via: "local" })).world;
  return produce(w, (d) => {
    createGitLab(d, { userKey: true, ...opts });
    const vps = d.hosts.vps;
    vps.groups.docker = { name: "docker", gid: 988, members: ["deploy", "ci"] };
    vps.users.deploy = { name: "deploy", uid: 1000, home: "/home/deploy", shell: "/bin/bash", password: "correct-horse-42" };
    vps.groups.deploy = { name: "deploy", gid: 1000, members: [] };
    vps.groups.sudo.members.push("deploy");
    vps.users.ci = { name: "ci", uid: 1001, home: "/home/ci", shell: "/bin/bash" };
    vps.groups.ci = { name: "ci", gid: 1001, members: [] };
    put(vps, "/home/deploy", dir(0o750, "deploy"));
    put(vps, "/home/ci", dir(0o750, "ci"));
    put(vps, "/home/ci/.ssh", dir(0o700, "ci"));
    put(vps, "/home/ci/.ssh/authorized_keys", file(getFile(d.hosts.laptop, "/home/you/.ssh/crumb_ci.pub")!.content, 0o600, "ci"));
    put(vps, "/srv/crumb", dir(0o755, "deploy"));
    put(vps, "/srv/crumb/compose.yaml", file(VPS_COMPOSE, 0o644, "deploy"));
    put(vps, "/srv/crumb/Caddyfile", file(DEMO_CADDYFILE, 0o644, "deploy"));
    put(vps, "/srv/crumb/.env", file("AUTH_SECRET=7f3c9a1e5b2d8f4a6c0e9b7d3f1a5c8e\n", 0o640, "deploy", "docker"));
    delete vps.docker.containers["crumb-app-1"];
    delete vps.docker.containers["crumb-db-1"];
    delete vps.docker.images["registry.gitlab.com/crumb/web:latest"];
  });
}

/** Write files in the laptop's clone. */
function edit(w: World, files: Record<string, string>): World {
  return produce(w, (d) => {
    for (const [p, c] of Object.entries(files)) put(d.hosts.laptop, `${REPO_PATH}/${p}`, file(c, 0o644, "you", "you"));
  });
}

function commitAndPush(w: World, files: Record<string, string>, msg: string, sh = laptopSh()) {
  return run(edit(w, files), ["git add .", `git commit -m "${msg}"`, "git push"], sh);
}

const wait = (w: World, secs: number) => run(w, [`sleep ${secs}`]).world;

function job(w: World, name: string) {
  const p = latestPipeline(w.gitlab);
  return p?.jobs.find((j) => j.name === name);
}

const logOf = (w: World, name: string) => job(w, name)?.log.join("\n") ?? "";

const TEST_ONLY = `stages:
  - test

test:
  stage: test
  image: node:24-alpine
  script:
    - npm ci
    - npm test
`;

function sshKeyVar(w: World, opts: { file?: boolean; protected?: boolean } = { file: true, protected: true }): World {
  return applyMapAction(w, {
    type: "ciVar",
    key: "SSH_KEY",
    value: null,
    fromFile: { host: "laptop", path: "/home/you/.ssh/crumb_ci" },
    varType: opts.file === false ? "env_var" : "file",
    protected: opts.protected !== false,
  });
}

/** ci logs in to the registry with a deploy token, so the server can pull private images. */
function ciLogin(w: World): World {
  w = applyMapAction(w, { type: "deployToken", name: "web-1", on: true });
  const t = w.gitlab!.deployTokens[0];
  return run(w, [`docker login registry.gitlab.com -u ${t.username} -p ${t.token}`], ciSh()).world;
}

describe("git on the laptop", () => {
  it("status, add, commit print like git 2.43", () => {
    let w = world();
    let r = run(w, ["git status"]);
    expect(r.text).toBe("On branch main\nYour branch is up to date with 'origin/main'.\n\nnothing to commit, working tree clean");
    w = edit(w, { ".gitlab-ci.yml": TEST_ONLY, "app/page.tsx": "export default function Home() { return <h1>Crumb!</h1>; }\n" });
    r = run(w, ["git status"]);
    expect(r.text).toContain("Changes not staged for commit:\n");
    expect(r.text).toContain("\tmodified:   app/page.tsx");
    expect(r.text).toContain("Untracked files:\n  (use \"git add <file>...\" to include in what will be committed)\n\t.gitlab-ci.yml");
    r = run(r.world, ["git add .", "git status", 'git commit -m "Add CI"', "git status", "git log --oneline -2"]);
    expect(r.text).toContain("Changes to be committed:");
    expect(r.text).toContain("\tnew file:   .gitlab-ci.yml");
    expect(r.text).toMatch(/^\[main [0-9a-f]{7}\] Add CI$/m);
    expect(r.text).toMatch(/^ 2 files changed, \d+ insertions\(\+\), 3 deletions\(-\)$/m);
    expect(r.text).toContain(" create mode 100644 .gitlab-ci.yml");
    expect(r.text).toContain("Your branch is ahead of 'origin/main' by 1 commit.");
    expect(r.text).toMatch(/^[0-9a-f]{7} \(HEAD -> main\) Add CI\n[0-9a-f]{7} \(origin\/main, origin\/HEAD\) Add Dockerfile and compose.yaml$/m);
  });

  it("outside the repo git says so", () => {
    const r = run(world(), ["git status"], createShell("x", { host: "laptop", user: "you", cwd: "/home/you", via: "local" }));
    expect(r.text).toBe("fatal: not a git repository (or any of the parent directories): .git");
  });

  it("push needs the laptop's key on the GitLab profile", () => {
    const w = world({ userKey: false });
    const r = commitAndPush(w, { "README.md": "# crumb\n" }, "Docs");
    expect(r.text).toContain("git@gitlab.com: Permission denied (publickey).\nfatal: Could not read from remote repository.");
    expect(r.world.gitlab!.pipelines).toHaveLength(0);
    const w2 = applyMapAction(r.world, { type: "userKey", on: true });
    expect(P.gitlabKeyAdded(g(w2))).toBe(true);
    const r2 = run(w2, ["git push"]);
    expect(r2.text).toMatch(/To gitlab\.com:crumb\/web\.git\n {3}[0-9a-f]{7}\.\.[0-9a-f]{7} {2}main -> main/);
    expect(P.pushed("main")(g(r2.world))).toBe(true);
  });

  it("a new branch needs -u the first time, then gets its own pipeline", () => {
    let w = world({ ci: TEST_ONLY });
    let r = run(w, ["git switch -c feature", "git push"]);
    expect(r.text).toContain("Switched to a new branch 'feature'");
    expect(r.text).toContain("fatal: The current branch feature has no upstream branch.");
    r = run(r.world, ["git push -u origin feature"]);
    expect(r.text).toContain("remote: To create a merge request for feature, visit:");
    expect(r.text).toContain(" * [new branch]      feature -> feature");
    expect(r.text).toContain("branch 'feature' set up to track 'origin/feature'.");
    w = r.world;
    const p = latestPipeline(w.gitlab, "feature")!;
    expect(p.protectedRef).toBe(false);
    expect(p.jobs.map((j) => j.name)).toEqual(["test"]);
  });

  it("git revert HEAD --no-edit undoes the last commit as a new commit", () => {
    let r = commitAndPush(world(), { "app/page.tsx": "broken\n" }, "Break the page");
    r = run(r.world, ["git revert HEAD --no-edit", "git log --oneline -1", "cat app/page.tsx"]);
    expect(r.text).toMatch(/^\[main [0-9a-f]{7}\] Revert "Break the page"$/m);
    expect(r.text).toContain(" 1 file changed, 3 insertions(+), 1 deletion(-)");
    expect(r.text).toContain("NEXT_PUBLIC_SHOP_NAME");
  });
});

describe(".gitlab-ci.yml", () => {
  it("a typo in a key fails the pipeline with GitLab's wording and no jobs", () => {
    const bad = TEST_ONLY.replace("  script:", "  scirpt:");
    expect(parseCi(bad).errors).toEqual(["jobs:test config contains unknown keys: scirpt"]);
    const r = commitAndPush(world(), { ".gitlab-ci.yml": bad }, "Add CI");
    const p = latestPipeline(r.world.gitlab)!;
    expect(p.status).toBe("failed");
    expect(p.jobs).toHaveLength(0);
    expect(p.errors).toEqual(["jobs:test config contains unknown keys: scirpt"]);
    expect(P.pipelineStatus("main", "failed")(g(r.world))).toBe(true);
  });

  it("other checks: missing script, unknown stage, bad needs", () => {
    expect(parseCi("test:\n  image: node:24\n").errors).toEqual(["jobs:test config should implement the script:, run:, or trigger: keyword"]);
    expect(parseCi("stages: [test]\nbuild:\n  stage: build\n  script: [echo]\n").errors[0]).toBe("build job: chosen stage build does not exist; available stages are .pre, test, .post");
    expect(parseCi("a: [1\n").errors[0]).toMatch(/^\(<unknown>\): .* at line \d+ column \d+$/);
  });

  it("rules: default branch only, and merge request pipelines", () => {
    const vars = { CI_COMMIT_BRANCH: "main", CI_DEFAULT_BRANCH: "main", CI_PIPELINE_SOURCE: "push" };
    expect(evalExpr("$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH", vars)).toBe(true);
    expect(evalExpr("$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH", { ...vars, CI_COMMIT_BRANCH: "feature" })).toBe(false);
    expect(evalExpr('$CI_PIPELINE_SOURCE == "merge_request_event"', vars)).toBe(false);
    expect(evalExpr('$CI_PIPELINE_SOURCE == "merge_request_event" || $CI_COMMIT_BRANCH', vars)).toBe(true);
    expect(evalExpr("$NOPE", vars)).toBe(false);
  });
});

describe("pipelines and runners", () => {
  it("a push creates a pipeline; jobs go pending, running, success", () => {
    let r = commitAndPush(world(), { ".gitlab-ci.yml": TEST_ONLY }, "Add CI");
    expect(r.text).toMatch(/Enumerating objects: \d+, done\./);
    const p = latestPipeline(r.world.gitlab)!;
    expect(p.ref).toBe("main");
    expect(p.sha).toBe(r.world.gitlab!.local!.branches.main);
    expect(["pending", "running"]).toContain(p.status);
    r = run(r.world, ["sleep 60"]);
    expect(P.pipelineStatus("main", "success")(g(r.world))).toBe(true);
    expect(P.jobStatus("test", "success")(g(r.world))).toBe(true);
    const log = logOf(r.world, "test");
    expect(log).toMatch(/^Running with gitlab-runner 17\.5\.2 \(c6eae8d7\)\n {2}on crumb-runner t3xQaB9c, system ID: s_[0-9a-f]{12}\nPreparing the "docker" executor\nUsing Docker executor with image node:24-alpine \.\.\./);
    expect(log).toContain("Getting source from Git repository\nFetching changes with git depth set to 20...");
    expect(log).toContain(`Checking out ${shortSha(p.sha, 8)} as detached HEAD (ref is main)...`);
    expect(log).toContain("$ npm ci\n\nadded 412 packages");
    expect(log).toContain("$ npm test\n\n> crumb@0.1.0 test\n> vitest run");
    expect(log).toContain(" ✓ lib/cart.test.ts (3 tests)");
    expect(log.endsWith("Cleaning up project directory and file based variables\nJob succeeded")).toBe(true);
    expect(deriveMap(r.world).nodes.find((n) => n.id === "gitlab")?.status).toBe("ok");
  });

  it("no runner online: the job stays pending with GitLab's stuck message, then runs once a runner is back", () => {
    let w = world({ runners: [defaultRunner({ online: false })] });
    w = wait(commitAndPush(w, { ".gitlab-ci.yml": TEST_ONLY }, "Add CI").world, 120);
    expect(P.pipelineStatus("main", "pending")(g(w))).toBe(true);
    expect(job(w, "test")?.status).toBe("pending");
    expect(job(w, "test")?.stuck).toBe("This job is stuck because the project doesn't have any runners online assigned to it.");
    expect(deriveMap(w).nodes.find((n) => n.id === "gitlab")?.sub).toContain("no runner online");
    w = applyMapAction(w, { type: "runner", id: 1, online: true });
    expect(P.runnerOnline(g(w))).toBe(true);
    w = wait(w, 60);
    expect(P.pipelineStatus("main", "success")(g(w))).toBe(true);
  });

  it("job tags no runner has: the stuck message lists the tags", () => {
    const tagged = TEST_ONLY.replace("  image: node:24-alpine", "  image: node:24-alpine\n  tags: [crumb-vps]");
    const w = wait(commitAndPush(world(), { ".gitlab-ci.yml": tagged }, "Add CI").world, 30);
    expect(job(w, "test")?.stuck).toBe("This job is stuck because you don't have any active runners online or available with any of these tags assigned to them: crumb-vps");
  });

  it("jobs start clean: node_modules from an earlier job is gone unless passed as an artifact", () => {
    const ci = (artifacts: boolean) => `stages: [install, check]

install:
  stage: install
  image: node:24-alpine
  script:
    - npm ci
    - ls node_modules${artifacts ? "\n  artifacts:\n    paths:\n      - node_modules/" : ""}

check:
  stage: check
  image: node:24-alpine
  script:
    - ls node_modules
    - npm test
`;
    let w = wait(commitAndPush(world(), { ".gitlab-ci.yml": ci(false) }, "Add CI").world, 90);
    expect(job(w, "install")?.status).toBe("success");
    expect(job(w, "check")?.status).toBe("failed");
    expect(logOf(w, "check")).toContain("$ ls node_modules\nls: node_modules: No such file or directory");
    expect(logOf(w, "check")).toContain("ERROR: Job failed: exit code 1");
    expect(P.pipelineStatus("main", "failed")(g(w))).toBe(true);

    w = wait(commitAndPush(w, { ".gitlab-ci.yml": ci(true) }, "Pass node_modules on").world, 90);
    expect(logOf(w, "install")).toContain("Uploading artifacts for successful job");
    expect(logOf(w, "check")).toContain(`Downloading artifacts for install (${job(w, "install")!.id})...`);
    expect(job(w, "check")?.status).toBe("success");
  });

  it("a failed stage skips the later stages", () => {
    const ci = TEST_ONLY.replace("stages:\n  - test", "stages:\n  - test\n  - deploy") + "\ndeploy:\n  stage: deploy\n  script: [echo hi]\n";
    const w = wait(commitAndPush(world(), { ".gitlab-ci.yml": ci, "lib/cart.test.ts": 'import { it } from "vitest";\nit("boom", () => { throw new Error("boom"); });\n' }, "Break tests").world, 90);
    expect(job(w, "test")?.status).toBe("failed");
    expect(logOf(w, "test")).toContain("Test Files  1 failed | 0 passed (1)");
    expect(job(w, "deploy")?.status).toBe("skipped");
  });
});

describe("docker build and the registry", () => {
  it("docker build without a dind service cannot reach a daemon", () => {
    const ci = `build:
  stage: build
  image: docker:27
  script:
    - docker build -t $CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA .
`;
    const w = wait(commitAndPush(world(), { ".gitlab-ci.yml": ci }, "Build").world, 90);
    expect(job(w, "build")?.status).toBe("failed");
    expect(logOf(w, "build")).toContain("ERROR: Cannot connect to the Docker daemon at tcp://docker:2375. Is the docker daemon running?");
  });

  it("dind on a runner that is not privileged fails too, with the service warning", () => {
    const w0 = world({ runners: [defaultRunner({ privileged: false })] });
    const ci = FULL_CI.split("\ndeploy:")[0];
    const w = wait(commitAndPush(w0, { ".gitlab-ci.yml": ci }, "Build").world, 120);
    expect(logOf(w, "build")).toContain("mount: permission denied (are you root?)");
    expect(job(w, "build")?.status).toBe("failed");
  });

  it("build with dind, push the SHA and latest tags", () => {
    const ci = FULL_CI.split("\ndeploy:")[0];
    const r = commitAndPush(world(), { ".gitlab-ci.yml": ci }, "Build");
    const w = wait(r.world, 120);
    const sha = w.gitlab!.branches.main;
    expect(job(w, "build")?.status).toBe("success");
    const log = logOf(w, "build");
    expect(log).toContain("Starting service docker:27-dind ...");
    expect(log).toContain("$ echo \"$CI_REGISTRY_PASSWORD\" | docker login -u \"$CI_REGISTRY_USER\" --password-stdin $CI_REGISTRY");
    expect(log).toContain("Login Succeeded");
    expect(log).toContain("WARNING! Your password will be stored unencrypted in /root/.docker/config.json.");
    expect(log).toMatch(/\[\+\] Building [\d.]+s \(\d+\/\d+\) FINISHED/);
    expect(log).toContain("The push refers to repository [registry.gitlab.com/crumb/web]");
    expect(log).toContain(`${shortSha(sha, 8)}: digest: sha256:`);
    expect(log).toContain("Layer already exists");
    expect(P.registryHas(shortSha(sha, 8))(g(w))).toBe(true);
    expect(P.registryHas(sha)(g(w))).toBe(true);
    expect(P.registryHas("latest")(g(w))).toBe(true);
    expect(w.registry![`registry.gitlab.com/crumb/web:latest`].meta?.revision).toBe(sha);
  });

  it("docker push without docker login is denied", () => {
    const ci = `build:
  image: docker:27
  services: [docker:27-dind]
  script:
    - docker build -t $CI_REGISTRY_IMAGE:latest .
    - docker push $CI_REGISTRY_IMAGE:latest
`;
    const w = wait(commitAndPush(world(), { ".gitlab-ci.yml": ci }, "Build").world, 120);
    expect(logOf(w, "build")).toContain("denied: requested access to the resource is denied");
    expect(P.registryHas("latest")(g(w))).toBe(false);
  });

  it("the server needs a docker login (deploy token) to pull from the private registry", () => {
    let w = world({ seedRegistry: true });
    let r = run(w, ["cd /srv/crumb", "docker compose pull app"], ciSh());
    expect(r.text).toContain("Error response from daemon: denied: access forbidden");
    w = applyMapAction(r.world, { type: "deployToken", name: "web-1", on: true });
    const t = w.gitlab!.deployTokens[0];
    expect(t.username).toBe("gitlab+deploy-token-1");
    r = run(w, [`docker login registry.gitlab.com -u ${t.username} -p wrong-token`], ciSh());
    expect(r.text).toContain('Error response from daemon: Get "https://registry.gitlab.com/v2/": unauthorized: HTTP Basic: Access denied');
    r = run(r.world, [`docker login registry.gitlab.com -u ${t.username} -p ${t.token}`, "cd /srv/crumb", "docker compose pull app"], ciSh());
    expect(r.text).toContain("WARNING! Using --password via the CLI is insecure. Use --password-stdin.");
    expect(r.text).toContain("WARNING! Your password will be stored unencrypted in /home/ci/.docker/config.json.");
    expect(r.text).toContain("Login Succeeded");
    expect(r.text).toContain(" ✔ app Pulled");
    expect(P.registryLoginWorks("ci")(g(r.world))).toBe(true);
    expect(getFile(r.world.hosts.vps, "/home/ci/.docker/config.json")?.mode).toBe(0o600);
  });
});

const DEPLOY_ANY_BRANCH = `deploy:
  image: alpine:3.20
  before_script:
    - apk add --no-cache openssh-client
  script:
    - chmod 600 "$SSH_KEY"
    - ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new ci@203.0.113.10 "cd /srv/crumb && docker compose ps"
`;

describe("deploying over SSH as ci", () => {
  it("a protected File variable is empty on an unprotected branch, so the deploy fails there but works on main", () => {
    let w = sshKeyVar(world({ ci: DEPLOY_ANY_BRANCH }));
    expect(P.ciVar("SSH_KEY", { file: true, protected: true })(g(w))).toBe(true);
    let r = run(w, ["git switch -c feature", "git push -u origin feature"]);
    w = wait(r.world, 60);
    expect(job(w, "deploy")?.status).toBe("failed");
    expect(logOf(w, "deploy")).toContain('$ chmod 600 "$SSH_KEY"\nchmod: : No such file or directory');

    // "Run pipeline" on main.
    w = wait(produce(run(w, ["git switch main"]).world, (d) => void runPipeline(d, "main")), 60);
    expect(latestPipeline(w.gitlab)!.ref).toBe("main");
    expect(job(w, "deploy")?.status).toBe("success");
    const log = logOf(w, "deploy");
    expect(log).toContain("Warning: Permanently added '203.0.113.10' (ED25519) to the list of known hosts.");
    expect(log).toContain("crumb-caddy-1");
    expect(w.hosts.vps.journal.some((j) => /Accepted publickey for ci from 34\.74\.226\.18/.test(j.msg))).toBe(true);
  });

  it("an env_var (not File) key, a missing chmod, and no host key handling each fail the way ssh does", () => {
    let w = sshKeyVar(world({ ci: DEPLOY_ANY_BRANCH }), { file: false, protected: true });
    w = wait(produce(w, (d) => void runPipeline(d, "main")), 60);
    expect(logOf(w, "deploy")).toContain("chmod: -----BEGIN OPENSSH PRIVATE KEY-----");

    const noChmod = DEPLOY_ANY_BRANCH.replace('    - chmod 600 "$SSH_KEY"\n', "");
    w = sshKeyVar(world({ ci: noChmod }));
    w = wait(produce(w, (d) => void runPipeline(d, "main")), 60);
    expect(logOf(w, "deploy")).toContain("WARNING: UNPROTECTED PRIVATE KEY FILE!");
    expect(logOf(w, "deploy")).toContain("Permissions 0666 for '/builds/crumb/web.tmp/SSH_KEY' are too open.");
    expect(logOf(w, "deploy")).toContain('Load key "/builds/crumb/web.tmp/SSH_KEY": bad permissions');
    // The demo server still allows passwords (the cloud-init drop-in), so ssh lists both methods.
    expect(logOf(w, "deploy")).toMatch(/Permanently added[^]*UNPROTECTED[^]*ci@203\.0\.113\.10: Permission denied \(publickey,password\)\./);

    const strict = DEPLOY_ANY_BRANCH.replace(" -o StrictHostKeyChecking=accept-new", "");
    w = sshKeyVar(world({ ci: strict }));
    w = wait(produce(w, (d) => void runPipeline(d, "main")), 60);
    expect(logOf(w, "deploy")).toContain("Host key verification failed.");

    const noVar = world({ ci: DEPLOY_ANY_BRANCH.replace('    - chmod 600 "$SSH_KEY"\n', "") });
    w = wait(produce(noVar, (d) => void runPipeline(d, "main")), 60);
    expect(logOf(w, "deploy")).toContain("Warning: Identity file  not accessible: No such file or directory.");
    expect(logOf(w, "deploy")).toMatch(/ci@203\.0\.113\.10: Permission denied \(publickey/);
  });

  it("the full pipeline deploys the new commit as ci; curl shows the version", () => {
    let w = ciLogin(sshKeyVar(world()));
    w = wait(commitAndPush(w, { ".gitlab-ci.yml": FULL_CI }, "Add CI").world, 180);
    const sha = w.gitlab!.branches.main;
    expect(P.pipelineStatus("main", "success")(g(w))).toBe(true);
    expect(logOf(w, "deploy")).toContain(" ✔ app Pulled");
    expect(P.liveVersion(sha)(g(w))).toBe(true);
    expect(P.liveVersion(shortSha(sha, 8))(g(w))).toBe(true);
    const r = run(w, ["curl -I https://crumb.shop"]);
    expect(r.text).toContain(`x-app-version: ${shortSha(sha, 8)}`);
    const body = run(w, ["curl https://crumb.shop"]);
    expect(body.text).toContain(`<footer>version ${shortSha(sha, 8)}</footer>`);

    // A second commit goes live too.
    w = wait(commitAndPush(w, { "app/page.tsx": "export default function Home() { return <h1>Crumb 2</h1>; }\n" }, "New headline").world, 180);
    const sha2 = w.gitlab!.branches.main;
    expect(P.liveVersion(sha2)(g(w))).toBe(true);
    expect(P.liveVersion(sha)(g(w))).toBe(false);

    // Roll back by redeploying the old sha.
    const r2 = run(w, ["cd /srv/crumb", `APP_TAG=${shortSha(sha, 8)} docker compose up -d app`], ciSh());
    // The old image is still on the server from the first deploy, so nothing is pulled.
    expect(r2.text).toMatch(/ ✔ Container crumb-app-1\s+Recreated/);
    expect(P.liveVersion(sha)(g(r2.world))).toBe(true);
  });

  it(":latest without docker compose pull leaves the old version live, even though the pipeline passed", () => {
    const ci = FULL_CI.replace(/ssh -i .*$/m, 'ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new ci@203.0.113.10 "cd /srv/crumb && docker compose up -d app"');
    let w = ciLogin(sshKeyVar(world()));
    w = wait(commitAndPush(w, { ".gitlab-ci.yml": ci }, "Add CI").world, 180);
    const v1 = w.gitlab!.branches.main;
    expect(P.liveVersion(v1)(g(w))).toBe(true);
    w = wait(commitAndPush(w, { "app/page.tsx": "export default function Home() { return <h1>v2</h1>; }\n" }, "v2").world, 180);
    const v2 = w.gitlab!.branches.main;
    expect(P.pipelineStatus("main", "success")(g(w))).toBe(true);
    expect(P.registryHas(shortSha(v2, 8))(g(w))).toBe(true);
    expect(P.liveVersion(v2)(g(w))).toBe(false);
    expect(P.liveVersion(v1)(g(w))).toBe(true);
    expect(run(w, ["curl -I https://crumb.shop"]).text).toContain(`x-app-version: ${shortSha(v1, 8)}`);
  });

  it("masked variables print as [MASKED]", () => {
    const ci = `show:\n  image: alpine:3.20\n  script:\n    - echo "token is $API_TOKEN"\n`;
    let w = world({ ci });
    w = applyMapActions(w, [{ type: "ciVar", key: "API_TOKEN", value: "s3cr3t-value-123", masked: true }]);
    w = wait(produce(w, (d) => void runPipeline(d, "main")), 30);
    expect(logOf(w, "show")).toContain("token is [MASKED]");
    expect(logOf(w, "show")).not.toContain("s3cr3t-value-123");
  });
});

describe("merge requests, manual jobs, retry", () => {
  it("push -o merge_request.create opens an MR and runs a merge request pipeline for jobs whose rules ask for it", () => {
    const ci = `test:
  image: node:24-alpine
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
  script:
    - npm ci
    - npm test
`;
    const r = run(world({ ci }), ["git switch -c feature", "git push -u origin feature -o merge_request.create"]);
    expect(r.text).toContain("remote: View merge request for feature:\nremote:   https://gitlab.com/crumb/web/-/merge_requests/1");
    const ps = r.world.gitlab!.pipelines;
    // The branch pipeline has no jobs (rules), so only the merge request pipeline exists.
    expect(ps).toHaveLength(1);
    expect(ps[0].source).toBe("merge_request_event");
    expect(r.world.gitlab!.mergeRequests[0]).toMatchObject({ iid: 1, source: "feature", target: "main", state: "opened" });
  });

  it("a when: manual job waits for play", () => {
    const ci = `deploy:\n  image: alpine:3.20\n  when: manual\n  script: [echo deployed]\n`;
    let w = wait(produce(world({ ci }), (d) => void runPipeline(d, "main")), 10);
    expect(job(w, "deploy")?.status).toBe("manual");
    // A job-level manual job may fail, so it does not block: the pipeline counts as passed.
    expect(P.pipelineStatus("main", "success")(g(w))).toBe(true);
    w = wait(applyMapAction(w, { type: "playJob", job: "deploy" }), 30);
    expect(job(w, "deploy")?.status).toBe("success");
    expect(logOf(w, "deploy")).toContain("$ echo deployed\ndeployed");
  });

  it("fix the variable, retry the job: the incident path for a missing CI key", () => {
    let w = world({ ci: DEPLOY_ANY_BRANCH });
    w = wait(produce(w, (d) => void runPipeline(d, "main")), 60);
    expect(job(w, "deploy")?.status).toBe("failed");
    const firstId = job(w, "deploy")!.id;
    w = sshKeyVar(w);
    w = wait(applyMapAction(w, { type: "retryJob", job: "deploy" }), 60);
    expect(job(w, "deploy")?.id).not.toBe(firstId);
    expect(job(w, "deploy")?.status).toBe("success");
    expect(P.pipelineStatus("main", "success")(g(w))).toBe(true);
  });
});

describe("settings and the ci user", () => {
  it("ciUserLimited and protectedBranch", () => {
    let w = world();
    expect(P.ciUserLimited(g(w))).toBe(true);
    expect(P.protectedBranch("main")(g(w))).toBe(true);
    w = applyMapAction(w, { type: "protectBranch", branch: "main", on: false });
    expect(P.protectedBranch("main")(g(w))).toBe(false);
    w = produce(w, (d) => void d.hosts.vps.groups.sudo.members.push("ci"));
    expect(P.ciUserLimited(g(w))).toBe(false);
    const r = run(world(), ["useradd -m -s /bin/bash ci2", "usermod -aG docker ci2"], rootSh());
    expect(r.world.hosts.vps.users.ci2).toBeTruthy();
  });
});
