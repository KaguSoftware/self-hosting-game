# Self-Hosting (learning game)

An interactive game that teaches a beginner (a Next.js developer who has only used Vercel and Supabase) to self-host: Linux, SSH, networking, Docker, Caddy, Postgres, backups, GitLab CI, Coolify and debugging, on one simulated Ubuntu 24.04 server.

@AGENTS.md

## Read first
- `BUILD_PLAN.md`: what exists, the architecture, the plan for Worlds 4 to 12, and which work can run in parallel.
- `CONTENT_GUIDE.md`: the rules for writing levels. **Never ask what has not been taught, never show a word or flag before it is explained.** Tests enforce this.

## Commands
- `npm run dev`: play locally at http://localhost:3000
- `npm test`: simulator and content tests. Every level is replayed through the simulator. All must pass.
- `npx tsc --noEmit -p .` and `npx next build` before calling anything done.

## Rules
- Plain, simple language in all game copy. No em or en dashes. No invented brand names.
- Black and white UI. Green = right or healthy, red = wrong or down. Nothing else colored.
- Content is data in `src/content/`, and the simulator is pure TypeScript in `src/sim/` (no React).
- Commit messages: no AI co-author lines. A push to `main` deploys to https://self-hosting-game.vercel.app.
