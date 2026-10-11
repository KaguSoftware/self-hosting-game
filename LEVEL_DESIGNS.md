# Level designs: Worlds 4 to 12

Detailed designs that go with `BUILD_PLAN.md`. They follow `CONTENT_GUIDE.md`. When a design and the tests disagree, the tests win: fix the design.

## Code facts to know first

- Request tracing lives in `src/sim/net.ts` (`traceHttp`). SSH tracing is in `src/sim/sshAuth.ts`.
- A step's review field is `tags`. New worlds go in `AUTHORED` (`src/content/index.ts`) **and** `AUTHORED_FOR_TEST` (`src/content/content.test.ts`).
- `level.setup` carries forward into the chain. A level that needs throwaway state (W4's Docker trap) uses `base: "side"`: it starts from the chain but never feeds it.
- Config saves never trigger anything. You still need `docker compose up -d` or `caddy reload`, just like a real server.
- The admin sudo user is `deploy`. The CI deploy user is `ci`.
- `unattended-upgrades` is already installed and on (`worlds.ts`). W8 teaches how to check it and turn on automatic reboot.
- Let's Encrypt needs port 80 **or** 443 reachable, not both.
- `postgresql-client` on the host is version 16. Running `pg_dump` against Postgres 17 fails with a version mismatch. Keep this gotcha.
- Real standalone Next.js without `HOSTNAME=0.0.0.0` binds the container's own IP. Other containers can reach it, but a `localhost` healthcheck fails.

### Jargon pitfalls
- Do not add "public IP" or "provider firewall" to `jargon.ts`. They already appear in W0 and W1.
- No "job" entry, because it clashes with w0-05-b ("Sort the jobs"). Teach CI jobs in intel instead.
- `TTL` must be a case-sensitive regex ("little" matches with `-i`).
- If you add "certificate", also add `teaches: ["certificate"]` to w0-01-a. It is a map step, so that is allowed.

## World 4: Networking

**Start:** end of w3-06. **Jargon, in order:** private IP, localhost, A record, CNAME, TTL.

- **w4-01 Three kinds of address**
  - a. **match.** Public / private / this machine. Intel teaches all three.
  - b. **terminal.** `ip a`. Goal: saw 127.0.0.1, the public IP and the private IP.
  - c. **rapid.** Review of a and b.
- **w4-02 Who listens, who can reach**
  - a. **spot.** In `ss -tlnp` output, tap the 127.0.0.53 line.
  - b. **predict.** hello listens on 0.0.0.0:8080. Can the laptop reach it? No, it times out: ufw only allows 22.
  - c. **terminal.** curl hello from web-1 (works), then from the laptop (timeout).
- **w4-03 127.0.0.1 vs 0.0.0.0**
  - a. **predict.** A 127.0.0.1 listener stays unreachable even with ufw open.
  - b. **predict.** Inside a container, 127.0.0.1 is that container.
  - c. **match.** "Only itself" vs "others can reach it".
- **w4-04 Point the domain**
  - a. **map toggle**, DNS panel. A crumb.shop goes to the VPS (decoy: an old IP), and CNAME www goes to crumb.shop.
  - b. **terminal.** `dig crumb.shop +short`, `dig www.crumb.shop`.
  - c. **predict.** TTL 3600 and you move servers: some visitors hit the old one for up to an hour.
- **w4-05 Open the web ports**
  - a. **predict.** ufw allows 443, but nothing listens yet.
  - b. **terminal.** `sudo ufw allow 80,443/tcp`.
  - c. **terminal.** curl http://crumb.shop: refused, and refused is not a timeout.
- **w4-06 Two firewalls in a row**
  - a. **predict.** Switch the provider firewall on with no rules: new SSH logins time out.
  - b. **map toggle**, provider panel. On, with 22, 80 and 443 only. Decoys: 8080 and 5432.
  - c. **order.** The stops a web request passes through.
- **w4-07 The trap: Docker skips ufw** (`base: "side"`, a friend's server)
  - a. **predict (guess).** A published 0.0.0.0:5432 is reachable despite ufw.
  - b. **config blanks.** `"127.0.0.1:5432:5432"`.
  - c. **rapid.** World review.
- **w4-08 Incidents:** `dns-wrong-a`, then `pfw-blocks-443`. These are dashboard fixes, so they use `fixMap` and controls.

**Leaves:** A crumb.shop and CNAME www point to the VPS, ufw allows 22/80/443, the provider firewall is on with 22/80/443, and hello still runs on 8080 (blocked by both firewalls).

## World 5: Docker

**Jargon:** image, volume, Dockerfile, layer, compose, healthcheck, restart policy. "tag" is folded into image.

**Flags:** keyed by subcommand (`docker run -v` vs `docker compose down -v`).

- **w5-01 Install Docker**
  - **predict.** Image vs container.
  - **terminal.** `curl -fsSL https://get.docker.com -o get-docker.sh` then `sudo sh get-docker.sh`.
  - **terminal.** `sudo docker run hello-world`.
- **w5-02 Image vs container**
  - **predict (guess).** The docker group is effectively root.
  - **terminal.** `usermod -aG docker deploy`, log in again, `docker ps`. Groups only count from your next login.
  - **terminal.** `docker run -d --name web nginx:1.27`.
  - **spot.** An Exited container in `ps -a`.
  - **terminal.** stop, rm, images.
- **w5-03 Volumes**
  - **predict.** No volume means data is gone.
  - **terminal.** Run postgres with `-v pgdata:...`.
  - **predict.** Remove the container and run it again: data survives.
  - **terminal.** `docker volume rm` really deletes it.
- **w5-04 Layer caching**
  - **spot.** `COPY . .` comes before `npm ci`.
  - **config reorder.**
  - **predict.** What reruns after a code edit.
- **w5-05 A Next.js Dockerfile** (setup places `/srv/crumb/app`)
  - **predict.** `NEXT_PUBLIC_` is baked in at build.
  - **config blanks.** Multi-stage, `ARG NEXT_PUBLIC_...`, `ENV HOSTNAME=0.0.0.0`, `CMD ["node","server.js"]`.
  - **match.** `.dockerignore`.
- **w5-06 Compose** (setup: `.env` has the localhost DATABASE_URL)
  - **config blanks.** compose.yaml with pinned postgres:17 and a volume.
  - **terminal.** `up -d --build`, then logs show ECONNREFUSED 127.0.0.1:5432.
  - **predict.** Why: localhost is the app container.
  - **config fix.** `.env` localhost becomes db.
  - **terminal.** `up -d`. `restart` does not re-read `.env`.
- **w5-07 Healthy, restarting, pinned**
  - **spot.** latest, `restart: "no"` and a published 5432.
  - **config blanks.** restart policy, healthcheck `pg_isready`, depends_on `service_healthy`.
  - **terminal.** `up -d`, `ps`, healthy.
  - **predict.** `down -v` wipes the data.
  - **rapid.**
- **w5-08 Incidents:** `crash-loop-env`, then `db-localhost`. The `app-127` incident moves to W6, where Caddy can see it.

**Leaves:** compose with app (built from ./app, HOSTNAME 0.0.0.0) and db (postgres:17, volume, healthcheck, unless-stopped), both healthy, no published ports. deploy is in the docker group.

## World 6: Reverse proxy and HTTPS

**Jargon:** reverse proxy, certificate, Let's Encrypt, Caddyfile, site block.

1. **predict.** One port, one owner ("port is already allocated"). **map match.** certs / code / orders.
2. **config.** caddy service: `caddy:2`, the only ports 80/443, Caddyfile bind, `caddy_data:/data`. **predict.** No caddy_data, recreated six times: Let's Encrypt rate limit.
3. **spot.** A failing issuance log ("Timeout during connect (likely firewall problem)"). The intel names the three green lights. **config.** Caddyfile `crumb.shop, www.crumb.shop { reverse_proxy app:3000 }`.
4. **terminal.** `up -d`, `logs caddy`, `curl -I https://crumb.shop`. **predict.** http gives 308.
5. **terminal.** A wrong upstream port gives 502: `sed -i`, then `docker compose exec -w /etc/caddy caddy caddy reload`. **spot.** The dial error line.
6. **incident** `caddy-typo`, **rapid**, **incident** `cert-new-domain`, **incident** `app-127`.

**Leaves:** https://crumb.shop and www both trace OK. Caddy is the only service with ports.

## World 7: Life after Supabase

**Jargon:** connection string, psql, ORM, migration, RLS, S3, SSH tunnel, pg_dump.

1. **match.** What moves, what gets rebuilt, what becomes a separate service.
2. **spot.** A published 5432. **predict.** POSTGRES_PASSWORD is only read on first init.
3. **terminal.** `docker compose exec db psql -U crumb -d crumb`, `\dt`, `select count(*)`.
4. **spot.** DATABASE_URL variants.
5. **config.** db ports `"127.0.0.1:5432:5432"`. **terminal.** `ssh -N -L 5433:127.0.0.1:5432` in window 2.
6. **predict.** RLS no longer guards you: check in server code. **rapid.**
7. **order.** Migration flow.
8. **terminal.** `pg_dump -Fc -n public --no-owner --no-acl` from Supabase. **terminal.** `pg_restore` through the tunnel.
9. **incident** `db-port-public`.

## World 8: Security and backups

**Jargon:** attack surface, 3-2-1, cron, offsite, log rotation, uptime monitor.

1. **spot.** hello on 0.0.0.0:8080. **terminal.** `systemctl disable --now hello`.
2. **predict.** unattended-upgrades does not reboot. **terminal.** Check it and turn on automatic reboot.
3. **spot.** `.env` committed to git.
4. **order.** 3-2-1.
5. **config.** `backup.sh` with `exec -T` and `$(date +%F)`. **terminal.** `crontab -e`, then skip time and check the backup exists. Gotchas: escape `%`; no TTY in cron.
6. **predict.** A backup on the same disk. **terminal.** `rclone copy`.
7. **terminal.** Restore test into a scratch DB. **rapid.**
8. **config.** logging max-size / max-file. **predict.** The uptime monitor must live outside the server.
9. **incident** `disk-full-logs`.

## World 9: GitLab CI/CD

**Jargon:** merge request, pipeline, stage, runner, artifact, registry, CI/CD variable, protected branch, deploy key, deploy token, SHA, dind.

1. **match.** GitHub words to GitLab words (basis known).
2. **map route.** laptop, gitlab, runner, registry, vps.
3. **predict.** Jobs start clean.
4. **config.** stages, the test job, default-branch rules.
5. **config.** docker:dind build, push SHA and latest.
6. **map toggle.** GitLab panel: SSH key as a File variable plus Protected; main protected.
7. **config.** Deploy job over ssh as `ci`. **terminal.** Set up `ci` on the VPS, deploy token login, compose `image: ...:${APP_TAG}`, `git push`.
8. **terminal.** Roll back: `APP_TAG=<old sha> docker compose up -d app`.
9. **incident** `runner-pending`, **rapid**, **incident** `pinned-tag`, **incident** `ci-var-protected`.

## World 10: Coolify and the work VM

**Jargon:** Coolify, VPN, snapshot.

- **map match.** Coolify's parts onto what you built.
- **predict.** Trade-offs.
- **predict.** Footprint: 8000, owns 80/443, manages Docker.
- **rapid.**
- **order.** Questions for your boss (copyable checklist).
- **config.** `tls internal`, as a side level.
- **predict.** Browsers warn until the internal root certificate is trusted.

## World 11: Debugging

- **order.** The method.
- **terminal.** Outside in: dig, `curl -v`, ss, compose ps, logs.
- **rapid.** Symptom to hop.
- Then three incident drills on the latest state, separated by a spot and a predict.

## World 12: Final mission and On-call

**Final mission:** a fresh VPS and one `mission` step: no guide, no hints, no show me. It is graded by state checks. Core checks (access, network, Docker, HTTPS) must all pass; the rest earn stars.

1. **Access:** deploy has sudo and key login; root login and password login are off; packages upgraded.
2. **Network:** ufw allows only 22/80/443; provider firewall the same; DNS for crumb.shop and www.
3. **Docker:** app, db and caddy healthy with restart policies, no `latest` tags, only Caddy published.
4. **HTTPS:** certificates for both names, traceOk, 5432 not reachable.
5. **Data:** orders restored; `.env` is 600.
6. **Backups:** a cron job, a backup file, an offsite copy.
7. **Ops:** log limits, an uptime monitor, hello gone.
8. **CI/CD:** a runner online, a green pipeline, `SSH_KEY` as a File and Protected variable, the live tag equals HEAD.

**On-call:** incidents marked `oncall` replayed on the final state.
- Incidents 1 to 3: one break, hints allowed.
- 4 to 6: hints cost time, timer ×0.85.
- 7 to 9: two breaks from different layers, no hints.
- 10 and up: also a red herring; the timer shrinks 10% each, with a floor of 90s.
- Seeded; no repeat within 3. The run ends at zero uptime.
