# Self-Hosting

A hands-on game that teaches self-hosting by doing: Linux, SSH, networking, Docker, Caddy/HTTPS, Postgres after Supabase, security and backups, GitLab CI/CD, Coolify, and debugging. Everything happens in a simulated Ubuntu 24.04 server that grows level by level.

## Run it

```bash
npm install
npm run dev      # http://localhost:3000
npm test         # simulator + content tests (every level goal is replayed through the sim)
npm run build
```

## Layout

- `src/sim/` pure TypeScript simulator: file system, users, permissions, apt, systemd, ufw, sshd (with the `sshd_config.d` first-value-wins rule), DNS, provider firewall, Docker model, and `traceHttp` which walks a request hop by hop.
- `src/content/` all learning content as typed data: worlds, levels, intel cards, quizzes, incidents, dictionary. Add levels here without touching game code.
- `src/engine/` game rules: canonical replay (each level starts from the previous level's end state), XP, combo, streaks, spaced review, progress schema and migration.
- `src/components/`, `src/app/` the React UI.

## Cloud save (optional)

Progress always saves in the browser. To also save online by player name, add **Upstash Redis** (free plan) from the Vercel Marketplace to the project. It sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`, which `/api/progress` reads. Without them the game simply stays local.
