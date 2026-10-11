import * as P from "@/sim/predicates";
import type { Check } from "@/sim/predicates";
import { VPS_IP } from "@/sim/constants";
import { dir, file, getFile, put } from "@/sim/fs";
import { createGitLab, deployTokenValue, liveRevision, seedRegistry } from "@/sim/gitlab";
import { runDetached } from "@/sim/shell/run";
import type { MapControl, WorldDef } from "../schema";
import { composeWithLogging } from "./w8";

const IP = VPS_IP;
const REPO = "/home/you/code/crumb";
const TOKEN = deployTokenValue("crumb-pull", 1);
const IMAGE = "registry.gitlab.com/crumb/web";

const TEST_JOB = (img: string, ci: string) => `stages:
  - test
  - build
  - deploy

test:
  stage: test
  image: node:${img}
  script:
    - npm ${ci}
    - npm test
`;

const BUILD_JOB = (dind: string, tag: string) => `
build:
  stage: build
  image: docker:27
  services:
    - docker:${dind}
  variables:
    DOCKER_TLS_CERTDIR: "/certs"
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
  script:
    - echo "$CI_REGISTRY_PASSWORD" | docker login -u "$CI_REGISTRY_USER" --password-stdin $CI_REGISTRY
    - docker build -t $CI_REGISTRY_IMAGE:${tag} -t $CI_REGISTRY_IMAGE:latest .
    - docker push $CI_REGISTRY_IMAGE:${tag}
    - docker push $CI_REGISTRY_IMAGE:latest
`;

const DEPLOY_JOB = (user: string) => `
deploy:
  stage: deploy
  image: alpine:3.20
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
  before_script:
    - apk add --no-cache openssh-client
    - chmod 600 "$SSH_KEY"
  script:
    - ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new ${user}@${IP} "cd /srv/crumb && APP_TAG=$CI_COMMIT_SHORT_SHA docker compose pull app && APP_TAG=$CI_COMMIT_SHORT_SHA docker compose up -d app"
`;

const CI_TEST = TEST_JOB("24-alpine", "ci");
const CI_BUILD = CI_TEST + BUILD_JOB("27-dind", "$CI_COMMIT_SHORT_SHA");
export const CI_FULL = CI_BUILD + DEPLOY_JOB("ci");

/** World 8's compose file, with the app pulled from GitLab's registry instead of built on web-1. */
const VPS_COMPOSE = (img: string) => composeWithLogging("10m").replace("    build: ./app\n", `    image: ${img}\n`);

/** The live app runs the commit at the tip of main. */
const liveIsHead: Check = (g) => !!g.world.gitlab && liveRevision(g.world) === g.world.gitlab.branches.main;

const envReadableByCi: Check = (g) => {
  const f = getFile(g.world.hosts.vps, "/srv/crumb/.env");
  return !!f && f.group === "docker" && (f.mode & 0o777) === 0o640;
};

const gl = (label: string, on: MapControl["on"], off: MapControl["off"]): MapControl => ({ node: "gitlab", label, on, off });

export const world9: WorldDef = {
  id: 9,
  title: "GitLab CI/CD",
  tagline: "Push to deploy",
  cheatSheet: [
    { cmd: "Merge request = pull request", what: "GitLab words: pipeline, stage, job, runner, CI/CD variable" },
    { cmd: ".gitlab-ci.yml", what: "stages run in order, the jobs inside a stage run together" },
    { cmd: "Jobs start clean", what: "each job gets a fresh container and a fresh copy of the code" },
    { cmd: "git add FILE; git commit -m MESSAGE; git push", what: "send your change to GitLab and start a pipeline" },
    { cmd: "docker:27-dind", what: "Docker inside Docker, so a job can build images" },
    { cmd: "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA", what: "tag every image with its commit, plus latest" },
    { cmd: "ci user", what: "a deploy user in the docker group only: no sudo" },
    { cmd: "SSH_KEY: File + Protected", what: "the deploy key arrives as a file, and only on protected branches" },
    { cmd: "Deploy token", what: "lets web-1 pull images from the registry, read only" },
    { cmd: "image: ...:${APP_TAG:-latest}", what: "compose runs the tag CI asks for, or latest" },
    { cmd: "APP_TAG=v1.0 docker compose up -d app", what: "roll back to an older image in seconds" },
  ],
  levels: [
    {
      id: "w9-01",
      world: 9,
      title: "GitLab words",
      base: "chain",
      start: "laptop",
      setup: (w) => {
        // The shop's code moves to a GitLab project, cloned on your laptop in ~/code/crumb.
        if (!w.gitlab) createGitLab(w);
      },
      steps: [
        {
          id: "w9-01-a",
          mission: "At work the code lives on GitLab. Match the words.",
          intel: {
            lines: [
              "GitLab is GitHub with CI/CD built in. A merge request is a pull request.",
              "A pipeline is one run of your CI. A runner is the machine that does its jobs.",
              "Secrets for the pipeline are called CI/CD variables.",
            ],
          },
          task: {
            kind: "match",
            prompt: "Tap a GitLab word, then its GitHub twin.",
            buckets: ["Pull request", "A GitHub Actions run", "Actions runner", "Repository secret"],
            items: [
              { text: "Merge request", bucket: 0 },
              { text: "Pipeline", bucket: 1 },
              { text: "GitLab runner", bucket: 2 },
              { text: "CI/CD variable", bucket: 3 },
            ],
            why: "Same ideas, new names. The big difference: GitLab's CI is part of the same product.",
          },
          basis: { taught: ["self"] },
          tags: ["gitlab"],
        },
      ],
    },
    {
      id: "w9-02",
      world: 9,
      title: "From push to live",
      base: "chain",
      start: "laptop",
      steps: [
        {
          id: "w9-02-a",
          mission: "This is where you are heading. Put the steps in order.",
          intel: { lines: ["The registry is GitLab's storage for Docker images, next to your code."] },
          task: {
            kind: "order",
            prompt: "Top is first.",
            items: [
              "You git push to GitLab",
              "GitLab starts a pipeline from .gitlab-ci.yml",
              "A runner runs the test job",
              "The build job pushes an image to the registry",
              "The deploy job logs in to web-1 and starts the new image",
            ],
            why: "Each stage only starts when the one before passed. Broken tests never reach customers.",
          },
          basis: { taught: ["self", "w9-01-a"] },
          tags: ["gitlab"],
        },
      ],
    },
    {
      id: "w9-03",
      world: 9,
      title: "Jobs start clean",
      base: "chain",
      start: "laptop",
      steps: [
        {
          id: "w9-03-a",
          mission: "Two jobs, one after the other.",
          intel: { lines: ["Every job gets a fresh container and a fresh copy of your code."] },
          task: {
            kind: "predict",
            question: "The test job ran npm ci. Does the build job, in the next stage, have node_modules?",
            options: ["No: every job starts clean, unless files are passed on on purpose", "Yes, jobs share one folder", "Only on main"],
            answer: 0,
            why: "Clean starts make jobs repeatable. Passing files on is done with artifacts, or by doing the work again.",
          },
          basis: { taught: ["self"] },
          tags: ["gitlab"],
        },
      ],
    },
    {
      id: "w9-04",
      world: 9,
      title: "A test job",
      base: "chain",
      start: "laptop",
      steps: [
        {
          id: "w9-04-a",
          mission: "GitLab needs your laptop's public key before git push works, like web-1 did in World 3.",
          task: {
            kind: "map",
            mode: "toggle",
            prompt: "Use the switch on the GitLab box.",
            controls: [gl("Laptop SSH key", { type: "userKey", on: true }, { type: "userKey", on: false })],
            goals: [{ describe: "Your laptop's public key is on your GitLab profile", check: P.gitlabKeyAdded }],
            hints: ["One switch, on the GitLab box.", "Turn on Laptop SSH key."],
            showMe: [{ type: "userKey", on: true }],
          },
          tags: ["gitlab", "ssh-keys"],
        },
        {
          id: "w9-04-b",
          mission: "Write the first pipeline: a test job.",
          intel: {
            lines: [".gitlab-ci.yml lists stages and jobs. A stage is a group of jobs; stages run in order.", "npm ci installs exactly what package-lock.json says, which is what CI wants."],
          },
          task: {
            kind: "config",
            host: "laptop",
            path: `${REPO}/.gitlab-ci.yml`,
            lang: "yaml",
            mode: "blanks",
            start: TEST_JOB("{{img}}", "{{ci}}"),
            blanks: {
              img: { options: ["24-alpine", "latest"], answer: 0 },
              ci: { options: ["ci", "install"], answer: 0 },
            },
            checks: [
              { describe: "The job uses a pinned Node image", test: (t) => /image:\s*node:24-alpine/.test(t) },
              { describe: "It installs exactly the locked versions", test: (t) => /-\s*npm ci\s*$/m.test(t) },
            ],
            solution: CI_TEST,
            hints: ["Pin versions, like in World 5. ci is the strict install.", "24-alpine and ci"],
            writeToSim: true,
          },
          tags: ["gitlab"],
        },
        {
          id: "w9-04-c",
          mission: "Commit it, push, and give the runner a minute.",
          intel: { lines: ["git add picks the file, git commit -m saves it with a message, git push sends it to GitLab. The pipeline panel shows each job."] },
          task: {
            kind: "terminal",
            goals: [{ describe: "The test job passed", check: P.jobStatus("test", "success") }],
            hints: ["Run them from ~/code/crumb, then sleep 90 so the runner has time.", 'cd ~/code/crumb, git add .gitlab-ci.yml, git commit -m "Add CI", git push, sleep 90'],
            guide: ["cd ~/code/crumb", "git add .gitlab-ci.yml", 'git commit -m "Add CI"', "git push", "sleep 90"],
            showMe: ["cd ~/code/crumb", "git add .gitlab-ci.yml", 'git commit -m "Add CI"', "git push", "sleep 90"],
            chips: ["cd ~/code/crumb", "git status", "git add .gitlab-ci.yml", 'git commit -m "Add CI"', "git push", "sleep 90"],
          },
          after: "Every push now runs the tests. A red test job stops everything after it.",
          tags: ["gitlab"],
        },
      ],
    },
    {
      id: "w9-05",
      world: 9,
      title: "Build and push images",
      base: "chain",
      start: "laptop",
      steps: [
        {
          id: "w9-05-a",
          mission: "Add a build job that makes the shop's image and pushes it to the registry.",
          intel: {
            lines: ["dind (Docker in Docker) lets a job run Docker to build images.", "A SHA is a commit's unique id. Tag each image with it, and with latest, then push both."],
          },
          task: {
            kind: "config",
            host: "laptop",
            path: `${REPO}/.gitlab-ci.yml`,
            lang: "yaml",
            mode: "blanks",
            start: CI_TEST + BUILD_JOB("{{dind}}", "{{tag}}"),
            blanks: {
              dind: { options: ["27-dind", "27"], answer: 0 },
              tag: { options: ["$CI_COMMIT_SHORT_SHA", "today"], answer: 0 },
            },
            checks: [
              { describe: "A Docker daemon runs next to the job", test: (t) => /-\s*docker:27-dind/.test(t) },
              { describe: "Each image is tagged with its commit", test: (t) => /\$CI_REGISTRY_IMAGE:\$CI_COMMIT_SHORT_SHA/.test(t) },
            ],
            solution: CI_BUILD,
            hints: ["The service is the Docker daemon itself. The tag should point back to one exact commit.", "27-dind and $CI_COMMIT_SHORT_SHA"],
            writeToSim: true,
          },
          tags: ["gitlab", "docker"],
        },
        {
          id: "w9-05-b",
          mission: "Push it and wait for the image.",
          task: {
            kind: "terminal",
            goals: [
              { describe: "The build job passed", check: P.jobStatus("build", "success") },
              { describe: "The registry has a latest image", check: P.registryHas("latest") },
            ],
            hints: ["Same as before: add, commit, push, then wait longer: two stages now.", 'git add .gitlab-ci.yml, git commit -m "Build images", git push, sleep 120'],
            guide: ["cd ~/code/crumb", "git add .gitlab-ci.yml", 'git commit -m "Build images"', "git push", "sleep 120"],
            showMe: ["cd ~/code/crumb", "git add .gitlab-ci.yml", 'git commit -m "Build images"', "git push", "sleep 120"],
            chips: ["git add .gitlab-ci.yml", 'git commit -m "Build images"', "git push", "sleep 120", "git log --oneline"],
          },
          after: "The registry now holds the shop as an image, tagged with its commit's SHA and latest.",
          tags: ["gitlab", "docker"],
        },
      ],
    },
    {
      id: "w9-06",
      world: 9,
      title: "A limited deploy user",
      base: "chain",
      start: "vps-deploy",
      steps: [
        {
          id: "w9-06-a",
          mission: "The pipeline will log in to web-1 to deploy. As which user?",
          task: {
            kind: "predict",
            question: "Why give CI its own user, ci, instead of deploy?",
            options: ["If the CI key leaks, the thief only gets ci: docker, but no sudo", "ci is faster", "deploy cannot run docker"],
            answer: 0,
            why: "Give every key the least it needs. The docker group is still strong, so guard the key, but no sudo means one less door.",
          },
          basis: { guess: true },
          tags: ["security", "gitlab"],
        },
        {
          id: "w9-06-b",
          mission: "Create the ci user in the docker group, and let that group read the shop's .env.",
          intel: { lines: ["useradd -m makes the user's home, -s picks its shell, -G docker adds the group.", "chown deploy:docker .env plus chmod 640: deploy writes, the docker group reads."] },
          task: {
            kind: "terminal",
            goals: [
              { describe: "ci exists, in the docker group, without sudo", check: P.ciUserLimited },
              { describe: ".env is readable by the docker group, nobody else", check: envReadableByCi },
            ],
            hints: ["Three commands, all with sudo.", "sudo useradd -m -s /bin/bash -G docker ci, sudo chown deploy:docker /srv/crumb/.env, sudo chmod 640 /srv/crumb/.env"],
            guide: ["sudo useradd -m -s /bin/bash -G docker ci", "sudo chown deploy:docker /srv/crumb/.env", "sudo chmod 640 /srv/crumb/.env", "id ci"],
            showMe: ["sudo useradd -m -s /bin/bash -G docker ci", "{{deployPassword}}", "sudo chown deploy:docker /srv/crumb/.env", "sudo chmod 640 /srv/crumb/.env"],
            chips: ["id ci", "ls -la /srv/crumb/.env"],
          },
          tags: ["security", "users"],
        },
      ],
    },
    {
      id: "w9-07",
      world: 9,
      title: "Secrets for the pipeline",
      base: "chain",
      start: "laptop",
      setup: (w) => {
        // A key pair just for CI, already made on your laptop, with its padlock installed for ci (as in World 3).
        runDetached(w, { host: "laptop", user: "you", cwd: "/home/you", via: "local" }, 'ssh-keygen -t ed25519 -f /home/you/.ssh/crumb_ci -N "" -C ci@crumb');
        const pub = getFile(w.hosts.laptop, "/home/you/.ssh/crumb_ci.pub")?.content ?? "";
        const vps = w.hosts.vps;
        if (vps.users.ci) {
          put(vps, "/home/ci/.ssh", dir(0o700, "ci", "ci"));
          put(vps, "/home/ci/.ssh/authorized_keys", file(pub, 0o600, "ci", "ci"));
        }
      },
      steps: [
        {
          id: "w9-07-a",
          mission: "A CI key pair waits on your laptop (~/.ssh/crumb_ci), and ci trusts it. Hand GitLab the private key, safely.",
          intel: {
            lines: [
              "File: the job gets the key as a file, which ssh -i needs.",
              "Protected: only protected branches like main get it.",
              "A deploy token lets web-1 pull images, and nothing else.",
            ],
          },
          task: {
            kind: "map",
            mode: "toggle",
            prompt: "Use the switches on the GitLab box.",
            controls: [
              gl(
                "Key: File + Protected",
                { type: "ciVar", key: "SSH_KEY", value: "", varType: "file", protected: true, fromFile: { host: "laptop", path: "/home/you/.ssh/crumb_ci" } },
                { type: "ciVar", key: "SSH_KEY", value: null },
              ),
              gl(
                "Key: plain text",
                { type: "ciVar", key: "SSH_KEY", value: "", varType: "env_var", protected: false, fromFile: { host: "laptop", path: "/home/you/.ssh/crumb_ci" } },
                { type: "ciVar", key: "SSH_KEY", value: null },
              ),
              gl("Deploy token", { type: "deployToken", name: "crumb-pull", on: true }, { type: "deployToken", name: "crumb-pull", on: false }),
              gl("Protect main", { type: "protectBranch", branch: "main", on: true }, { type: "protectBranch", branch: "main", on: false }),
            ],
            goals: [
              { describe: "SSH_KEY is a File variable, protected", check: P.ciVar("SSH_KEY", { file: true, protected: true }) },
              { describe: "A deploy token can read the registry", check: P.deployTokenActive("read_registry") },
              { describe: "main is protected", check: P.protectedBranch("main") },
            ],
            hints: ["Plain text breaks ssh -i, and any branch could deploy.", "Turn on Key: File + Protected and Deploy token. Keep Protect main on."],
            showMe: [
              { type: "ciVar", key: "SSH_KEY", value: "", varType: "file", protected: true, fromFile: { host: "laptop", path: "/home/you/.ssh/crumb_ci" } },
              { type: "deployToken", name: "crumb-pull", on: true },
            ],
          },
          review: {
            id: "w9-07-a-q",
            q: "A Protected CI/CD variable is...",
            options: ["only given to jobs on protected branches", "hidden from everyone, forever", "encrypted twice"],
            answer: 0,
            why: "So a pipeline on any random branch cannot use your deploy key.",
            tag: "gitlab",
          },
          tags: ["gitlab", "security"],
        },
        {
          id: "w9-07-b",
          mission: `GitLab showed the new deploy token once: ${TOKEN}. Log in to the registry on web-1 as ci, then as deploy.`,
          intel: { lines: ["docker login stores the token for the user who runs it. ci needs it for deploys, deploy for when you run compose by hand."] },
          task: {
            kind: "terminal",
            goals: [
              { describe: "ci can pull from GitLab's registry", check: P.registryLoginWorks("ci") },
              { describe: "deploy can pull from GitLab's registry", check: P.registryLoginWorks("deploy") },
            ],
            hints: ["Log in as ci with its key (ssh -i ~/.ssh/crumb_ci ci@203.0.113.10), run docker login, exit, then the same as deploy.", `docker login registry.gitlab.com -u gitlab+deploy-token-1 -p ${TOKEN}`],
            guide: [`ssh -i ~/.ssh/crumb_ci ci@${IP}`, `docker login registry.gitlab.com -u gitlab+deploy-token-1 -p ${TOKEN}`, "exit", `ssh deploy@${IP}`, `docker login registry.gitlab.com -u gitlab+deploy-token-1 -p ${TOKEN}`, "exit"],
            showMe: [`ssh -i ~/.ssh/crumb_ci ci@${IP}`, `docker login registry.gitlab.com -u gitlab+deploy-token-1 -p ${TOKEN}`, "exit", `ssh deploy@${IP}`, `docker login registry.gitlab.com -u gitlab+deploy-token-1 -p ${TOKEN}`, "exit"],
            chips: [`ssh -i ~/.ssh/crumb_ci ci@${IP}`, `ssh deploy@${IP}`, "exit"],
          },
          after: "The warning about -p is real: on a shared machine, use --password-stdin so the token stays out of your shell history.",
          tags: ["gitlab", "docker"],
        },
      ],
    },
    {
      id: "w9-08",
      world: 9,
      title: "Deploy on push",
      base: "chain",
      start: "laptop",
      steps: [
        {
          id: "w9-08-a",
          mission: "On web-1, the app should run the image CI built, not build it there.",
          intel: { lines: ["${APP_TAG:-latest} means: use the tag in APP_TAG if it is set, otherwise latest."] },
          task: {
            kind: "config",
            host: "vps",
            path: "/srv/crumb/compose.yaml",
            lang: "yaml",
            mode: "blanks",
            start: VPS_COMPOSE(`${IMAGE}:{{tag}}`),
            blanks: { tag: { options: ["${APP_TAG:-latest}", "latest"], answer: 0 } },
            checks: [
              { describe: "The app image comes from the registry", test: (t) => t.includes(`image: ${IMAGE}:`) && !/build: \.\/app/.test(t) },
              { describe: "CI can choose the tag", test: (t) => t.includes("${APP_TAG:-latest}") },
            ],
            solution: VPS_COMPOSE(`${IMAGE}:\${APP_TAG:-latest}`),
            hints: ["Plain latest ignores the tag CI passes in.", "${APP_TAG:-latest}"],
            writeToSim: true,
          },
          tags: ["gitlab", "compose"],
        },
        {
          id: "w9-08-b",
          mission: "Now the deploy job: log in to web-1 as ci and start the new image.",
          task: {
            kind: "config",
            host: "laptop",
            path: `${REPO}/.gitlab-ci.yml`,
            lang: "yaml",
            mode: "blanks",
            start: CI_BUILD + DEPLOY_JOB("{{user}}"),
            blanks: { user: { options: ["ci", "root"], answer: 0 } },
            checks: [{ describe: "The deploy logs in as the limited ci user", test: (t) => new RegExp(`ssh -i "\\$SSH_KEY" .* ci@${IP.replace(/\./g, "\\.")}`).test(t) }],
            solution: CI_FULL,
            hints: ["Root login is off, and the CI key only opens ci.", "ci"],
            writeToSim: true,
          },
          tags: ["gitlab"],
        },
        {
          id: "w9-08-c",
          mission: "Push, then watch the pipeline deploy it.",
          task: {
            kind: "terminal",
            goals: [
              { describe: "The deploy job passed", check: P.jobStatus("deploy", "success") },
              { describe: "The live shop runs your latest commit", check: liveIsHead },
            ],
            hints: ["Three stages now: give it a few minutes.", 'cd ~/code/crumb, git add .gitlab-ci.yml, git commit -m "Deploy on push", git push, sleep 180'],
            guide: ["cd ~/code/crumb", "git add .gitlab-ci.yml", 'git commit -m "Deploy on push"', "git push", "sleep 180", "curl -I https://crumb.shop"],
            showMe: ["cd ~/code/crumb", "git add .gitlab-ci.yml", 'git commit -m "Deploy on push"', "git push", "sleep 180"],
            chips: ["git push", "sleep 180", "git log --oneline --abbrev=8", "curl -I https://crumb.shop"],
            url: "https://crumb.shop",
          },
          after: "x-app-version in curl's answer matches the commit you pushed. That is Vercel's git integration, built by you.",
          tags: ["gitlab"],
        },
      ],
    },
    {
      id: "w9-09",
      world: 9,
      title: "Roll back",
      base: "chain",
      start: "vps-deploy",
      setup: (w) => {
        // Last week's release, tagged v1.0 in the registry.
        const g = w.gitlab;
        const sha = g && Object.values(g.commits).find((c) => c.message === "Add Dockerfile and compose.yaml")?.sha;
        if (sha) seedRegistry(w, sha, ["v1.0"]);
      },
      steps: [
        {
          id: "w9-09-a",
          mission: "A release breaks checkout. Last week's image is tagged v1.0 in the registry.",
          task: {
            kind: "predict",
            question: "On web-1 you run APP_TAG=v1.0 docker compose up -d app. What happens?",
            options: ["The app goes back to the v1.0 image in seconds", "Nothing, CI must run again", "GitLab deletes the new release"],
            answer: 0,
            why: "Every image is still in the registry. Rolling back is just running an older tag.",
          },
          basis: { taught: ["w9-08-a", "w5-02-c"] },
          tags: ["gitlab", "docker"],
        },
        {
          id: "w9-09-b",
          mission: "Roll back to v1.0.",
          intel: { lines: ["APP_TAG=v1.0 in front of the command sets it for that one command only."] },
          task: {
            kind: "terminal",
            goals: [{ describe: "The live app runs v1.0", check: (g) => !!g.world.gitlab && !liveIsHead(g) && !!liveRevision(g.world) }],
            hints: ["Run it as deploy, in /srv/crumb.", "cd /srv/crumb, then APP_TAG=v1.0 docker compose up -d app"],
            guide: ["cd /srv/crumb", "APP_TAG=v1.0 docker compose up -d app", "curl -I https://crumb.shop"],
            showMe: ["cd /srv/crumb", "APP_TAG=v1.0 docker compose up -d app"],
            chips: ["cd /srv/crumb", "APP_TAG=v1.0 docker compose up -d app", "curl -I https://crumb.shop"],
          },
          tags: ["gitlab", "docker"],
        },
        {
          id: "w9-09-c",
          mission: "The fix is in. Roll forward to latest again.",
          task: {
            kind: "terminal",
            goals: [{ describe: "The live shop runs your latest commit again", check: liveIsHead }],
            hints: ["Without APP_TAG, compose uses latest.", "docker compose up -d app"],
            guide: ["docker compose up -d app", "curl -I https://crumb.shop"],
            showMe: ["cd /srv/crumb", "docker compose up -d app"],
            chips: ["docker compose up -d app", "curl -I https://crumb.shop"],
          },
          tags: ["gitlab", "docker"],
        },
      ],
    },
    {
      id: "w9-10",
      world: 9,
      title: "Incidents: the pipeline",
      base: "chain",
      start: "laptop",
      steps: [
        {
          id: "w9-10-a",
          mission: "Incident! A fix was pushed an hour ago and is still not live.",
          task: { kind: "incident", incidentId: "runner-pending" },
          tags: ["gitlab", "debugging"],
        },
        {
          id: "w9-10-b",
          mission: "Quick review between calls.",
          task: {
            kind: "rapid",
            seconds: 40,
            items: [
              { id: "w9-10-b1", q: "A merge request is GitLab's...", options: ["pull request", "deploy", "runner"], answer: 0, why: "Same idea.", tag: "gitlab" },
              { id: "w9-10-b2", q: "Jobs pending forever usually means...", options: ["no runner is online", "the tests failed", "DNS is down"], answer: 0, why: "Someone has to run them.", tag: "gitlab" },
              { id: "w9-10-b3", q: "The deploy key should be a...", options: ["File variable, Protected", "plain variable", "line in .gitlab-ci.yml"], answer: 0, why: "ssh -i needs a file. Protected keeps it to main.", tag: "gitlab" },
              { id: "w9-10-b4", q: "Tag images with...", options: ["the commit SHA, plus latest", "the date only", "nothing"], answer: 0, why: "So you can roll back to any commit.", tag: "gitlab" },
              { id: "w9-10-b5", q: "CI deploys as...", options: ["a limited ci user", "root", "your own user"], answer: 0, why: "Least access per key.", tag: "security" },
            ],
          },
          basis: { taught: ["w9-01-a", "w9-04-c", "w9-07-a", "w9-05-a", "w9-06-a"] },
          tags: ["gitlab"],
        },
        {
          id: "w9-10-c",
          mission: "Incident! The pipeline is green, but the old version is still live.",
          task: { kind: "incident", incidentId: "pinned-tag" },
          tags: ["gitlab", "debugging"],
        },
        {
          id: "w9-10-d",
          mission: "Incident! The deploy job fails.",
          task: { kind: "incident", incidentId: "ci-var-protected" },
          tags: ["gitlab", "debugging"],
        },
      ],
    },
  ],
};
