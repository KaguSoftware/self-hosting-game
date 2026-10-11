# Build plan: Worlds 4 to 12

This is the plan any chat can follow to keep building the game. Read it, `CONTENT_GUIDE.md`, `CLAUDE.md` and `LEVEL_DESIGNS.md` (step-by-step designs for each world, plus code facts) before touching code.

## What exists (done)

- **Live:** https://self-hosting-game.vercel.app. A push to `main` deploys it (Vercel is connected to GitHub `KaguSoftware/self-hosting-game`).
- **Worlds:** Start here, then 0 (big picture), 1 (servers), 2 (Linux), 3 (SSH, plus the incident "Permission denied (publickey)").
- **Engine:** level player; task kinds `terminal`, `map` (route, match, toggle), `config`, `predict`, `spot`, `order`, `match`, `rapid`, `allocate`, `budget`, `incident`; XP, combo, streak, review queue, hints, show me, sounds, dictionary (words and flags), cheat sheets, profile, export/import, cloud save (Upstash Redis via `/api/progress`).
- **Guard tests:** every level is replayed through the simulator, plus checks for basis, jargon, flags, word count, answer mix and dashes. See `CONTENT_GUIDE.md`.
- **Not built yet:** Worlds 4 to 12, the remaining incidents, the final mission, On-call mode, the Docker, Compose, Caddy, Postgres, cron and GitLab parts of the simulator, and DNS and provider-firewall dashboard panels.

## Where things live

| Path | What |
|---|---|
| `src/sim/` | Pure TypeScript simulator. No React. `types.ts` is the world model. `net.ts` `traceHttp` walks a request hop by hop. `sshAuth.ts`, `sshd.ts` (drop-in "first value wins"), `caddy.ts` (Caddyfile parser), `map.ts` (server map model and map actions), `predicates.ts` (goal checks), `worlds.ts` (fresh VPS, demo stack) |
| `src/sim/shell/` | Bash-lite parser, runner, completion. One file per command group in `commands/`. Register in `registry.ts`. Commands that need a package go in `NEEDS_PACKAGE` |
| `src/content/` | All learning content as data. One file per world in `worlds/`. Register in `index.ts` (`AUTHORED`), plus `incidents.ts`, `dictionary.ts`, `jargon.ts`, `flags.ts`, `schema.ts` |
| `src/engine/` | `replay.ts` (each chain level starts from the previous level's end, by replaying every earlier step's solution), `rules.ts` (XP, streak, review), `progress.ts` (save schema and migration) |
| `src/components/play/` | One component per task kind, plus `LevelPlayer.tsx` |

## How to add a world

1. **Simulator first.** Add whatever the levels need (commands, world state, trace hops, map nodes) with unit tests in `src/sim/*.test.ts`.
2. **Write `src/content/worlds/wN.ts`** following `CONTENT_GUIDE.md`. Every terminal step needs `goals` (checked on world state, never on exact commands), `hints`, `showMe`, and `guide` on a command's first use. Every question needs `basis`. Add new words to `jargon.ts` and new flags to `flags.ts`.
3. **Register** the world in `src/content/index.ts` and remove it from `UPCOMING`.
4. **Add incidents** to `incidents.ts`. Each one is data: `after` (level whose end state it starts from), `breakIt`, `goals`, `fix` (commands the test runs), `fastestPath`, `debrief`.
5. **Add dictionary terms and a cheat sheet** for the world.
6. **Verify:** `npm test` (all must pass), `npx tsc --noEmit -p .`, `npx next build`, then play every new level in the browser (`npm run dev`) on desktop and phone width.
7. **Commit and push to `main`.** No AI co-author lines in commits. The commit message says what the player gets.

## Who the player is (non-negotiable)

- A Next.js developer who has only used Vercel and Supabase, with **weak terminal and Linux basics**. Explain everything plainly. Short sentences. Analogies help.
- **Never ask what has not been taught. Never show a word or flag before it is explained.** The tests enforce this. Do not weaken them.
- Look: black and white. Green means right or healthy, red means wrong or down. Nothing else is colored. The result of a step is a centered modal.
- No em or en dashes in UI copy. No invented brand names.
- Accuracy target: Ubuntu 24.04, Docker Compose v2, Caddy 2, Postgres 17, GitLab CI. The real gotchas are the most valuable part, so keep them.

## The server so far (end of World 3)

The chain world after `w3-06`: VPS `web-1` (203.0.113.10, plan S: 2 vCPU, 4 GB) is rented. User `deploy` has sudo and the laptop's ed25519 key. Root login and password login are off (the cloud-init drop-in was fixed). ufw is on and allows 22 only. The `hello` service runs on 0.0.0.0:8080 (kept on purpose: World 8 removes it as attack surface). `/srv/crumb/.env` is 600 and owned by deploy. `ncdu` is installed and packages are upgraded. **There are no DNS records, the provider firewall is off, and Docker is not installed.** Each world must leave the server in a state the next world can build on.

## World plans

Each world has 5 to 8 short levels. Mix interaction kinds: never three of the same kind in a row (a test checks this). Words to explain first are listed per world. Add them to `jargon.ts` and teach them before use.

### World 4: Networking
- **Simulator needs:** DNS dashboard panel (map toggle or a small form to add A and CNAME records, with TTL); provider firewall panel; `dig` and `curl` already exist. A pre-placed container that publishes a port, to show the Docker-bypasses-ufw trap without the Docker CLI yet.
- **Teach first:** public vs private IP, localhost and 127.0.0.1, 0.0.0.0, port, A record, CNAME, TTL, provider firewall.
- **Levels:**
  1. Three kinds of address: public, private, localhost (rapid, basis taught)
  2. Ports and who listens (terminal: `sudo ss -tlnp`)
  3. 127.0.0.1 vs 0.0.0.0, on a host and inside a container (predict, then map)
  4. Point the domain: add A records for crumb.shop and www (CNAME), check with `dig` (map, then terminal)
  5. Open the web ports in ufw (terminal: `ufw allow 80,443/tcp`)
  6. Two firewalls in a row: the provider dashboard firewall (map toggle)
  7. The trap: Docker published ports skip ufw (predict, then fix by binding to 127.0.0.1)
- **Leaves:** DNS A crumb.shop and CNAME www pointing to the VPS, ufw allowing 22/80/443, provider firewall on with 22/80/443.
- **Incidents:** wrong DNS A record; provider firewall blocks 443.

### World 5: Docker
- **Simulator needs (the big one, build first):** `docker` CLI (`run`, `ps`, `ps -a`, `logs`, `stop`, `start`, `rm`, `images`, `pull`, `exec`, `volume ls`, `network ls`, `inspect`) and `docker compose` (`up -d`, `down`, `down -v`, `ps`, `logs`, `restart`, `pull`, `build`, `exec`). Compose reads the real `compose.yaml` from the sim filesystem (parse with `yaml`). Images, containers, volumes, networks, restart policies, healthchecks, `env_file`, published ports, crash loop when required env is missing. Install via the official repo (`docker-ce`, `docker-compose-plugin`) or `get.docker.com`. Explain that the `docker` group is effectively root.
- **Teach first:** image, container, volume, Dockerfile, layer, compose, service name, healthcheck, restart policy.
- **Levels:**
  1. Install Docker and run hello-world (terminal)
  2. Image vs container: run, ps, stop, rm (terminal)
  3. Volumes: restart keeps data, recreating without a volume loses it, `down -v` deletes it (predict)
  4. Dockerfile layer caching (config reorder)
  5. Multi-stage Next.js standalone Dockerfile: `HOSTNAME=0.0.0.0`, `NEXT_PUBLIC_` is baked in at build time, `.dockerignore` (config blanks)
  6. Compose: service names as hostnames, the ECONNREFUSED 127.0.0.1 trap (config, then terminal)
  7. Healthchecks, restart policies, pinned versions (spot)
- **Leaves:** `/srv/crumb/compose.yaml` with `app` and `db` running, no published ports yet.
- **Incidents:** DATABASE_URL uses localhost; crash loop from a missing env var; app listening on 127.0.0.1 inside its container.

### World 6: Reverse proxy and HTTPS
- **Simulator needs:** a Caddy container in compose (`caddy:2`) reading the bind-mounted Caddyfile; `docker compose exec caddy caddy reload`; certificate issuance when DNS points here, 80 and 443 are reachable and the site block exists (a world reconcile step, so `w.certs` gets filled and Caddy logs "certificate obtained successfully"); `caddy_data` volume.
- **Teach first:** reverse proxy, certificate, Let's Encrypt, 502, site block.
- **Levels:** one program owns 443 (map); Caddy as the only service with ports, plus caddy_data (config); route by domain (config); Let's Encrypt needs three green lights (map); 502 means nothing answered behind Caddy (terminal); incident.
- **Leaves:** https://crumb.shop works end to end (`traceHttp` ok).
- **Incidents:** Caddyfile domain typo; certificate warning on a new domain (DNS not pointing yet).

### World 7: Life after Supabase
- **Simulator needs:** Postgres model inside the db container (databases, tables, row counts) stored in the volume; `psql` through `docker compose exec db psql -U ...` with a few meta commands (`\l`, `\dt`, `select count(*)`); `pg_dump` and `pg_restore` (custom format, `--no-owner --no-acl`); SSH tunnels (`ssh -N -L 5433:127.0.0.1:5432 deploy@...`) with the db published on 127.0.0.1 only.
- **Teach first:** connection string, migration, ORM, RLS, S3-compatible storage, SSH tunnel.
- **Levels:** what moves and what gets replaced (map match); Postgres 17 in compose with no public port (config); psql inside the container (terminal); connection strings with host `db` (spot); SSH tunnel for a GUI client (terminal); auth, storage, API and RLS versus server-side checks (predict and rapid); migrations in git (order); move data from Supabase with pg_dump and pg_restore (terminal).
- **Incident:** database port published to the internet.

### World 8: Security and backups
- **Simulator needs:** `crontab -e` and `crontab -l` (through the nano editor), cron runs on a sim clock tick; disk usage that grows with unbounded container logs; Docker log rotation (`logging` options in compose, or daemon.json); offsite copy (`rclone` or `restic` to a pretend bucket); `unattended-upgrades` config.
- **Levels:** only 22/80/443 open, remove hello (map, then terminal); unattended upgrades (terminal); secrets out of git (spot); 3-2-1 backups (order); pg_dump plus cron (terminal); offsite copy (terminal); restore test (terminal); log limits and an outside uptime monitor (config).
- **Incident:** disk full from unbounded logs.

### World 9: GitLab CI/CD
- **Simulator needs:** a GitLab model (project, `.gitlab-ci.yml` parsed by meaning, pipelines with stages and jobs, runners online or offline, CI/CD variables with File and Protected types, container registry tags by commit SHA and latest, deploy keys, deploy tokens); `git push` from the laptop triggers a pipeline; the deploy job runs SSH commands on the VPS as a separate deploy user.
- **Teach first:** merge request (= pull request), pipeline, stage, job, runner, artifact, registry, variable.
- **Levels:** GitLab words versus GitHub (rapid); pipelines, stages, jobs, runners (map); jobs start clean (predict); test job plus default-branch rules (config); build with docker:dind and push SHA and latest (config); deploy user, deploy key, File and Protected variables (map); deploy over SSH plus a deploy token so the server can pull (config, then terminal); roll back by SHA (terminal).
- **Incidents:** stuck on pending (no runner); deploy passed but the old version is live (pinned tag); CI key variable missing or not protected.

### World 10: Coolify and the work VM
- Mostly conceptual. **Levels:** what Coolify or Dokploy do underneath (map match against the pieces already built); raw setup vs dashboard trade-offs (predict); Coolify's footprint, ports and Docker ownership (rapid); questions for the boss (order, which produces a copyable checklist: access and VPN, sudo, Docker allowed, internet exposure, ports, DNS, internal HTTPS, snapshots, runners, registry, existing conventions); internal-only HTTPS behind a VPN (config, `tls internal`).

### World 11: Debugging
- **Levels:** the method: find the hop, test outside in, one change at a time (order); test outside in with `dig`, `curl -v`, `ss`, `docker ps` and logs (terminal); a symptom finder (rapid); three incident drills reusing earlier incidents.

### World 12: Final mission, then On-call
- **Final mission:** one long level from a fresh VPS to a live HTTPS app with Postgres, backups, monitoring and push-to-deploy. No guides and no hints. It is graded by a checklist of state predicates (`predicates.ts` plus new ones).
- **On-call mode:** after the final mission, an endless random stream of incidents (reusing `INCIDENTS`) that gets harder: two breaks at once, less time, no hints. Track the best run in `progress.onCall`.

## Order and parallel work

Every chain world starts from the end state of the one before (see `replay.ts`), so content depends on earlier worlds. The simulator pieces are shared.

```
Track A (start now):  World 4 Networking          (needs DNS and firewall panels only)
Track B (start now):  Docker + Compose simulator  -> World 5
After B:              World 6 Caddy   and   World 7 Postgres   (can run side by side)
After 7:              World 8 (needs pg_dump, cron)
After 5:              World 9 GitLab (needs docker build and registry)
Any time after 6:     World 10
After 4 to 9:         World 11, then World 12 + On-call
```

To run chats in parallel:
- Give each chat **one track** and its own git branch (`git switch -c world-4` and so on). Merge to `main` in the order above and rerun `npm test` after each merge.
- Shared files conflict easily: `src/content/index.ts`, `src/content/schema.ts`, `src/sim/types.ts`, `src/sim/shell/registry.ts`, `jargon.ts`, `flags.ts`, `dictionary.ts`. Keep edits there small and additive.
- World 5 and later need the Docker simulator, so do not start their content before Track B is merged.

A prompt that works for a new chat: **"Read BUILD_PLAN.md, CONTENT_GUIDE.md and CLAUDE.md, then build World 4 (Track A) on a branch called world-4. Follow the verify steps and tell me when it is ready to play."**
