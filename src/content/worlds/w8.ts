import * as P from "@/sim/predicates";
import { dir, file, getDir, getFile, put } from "@/sim/fs";
import { UNATTENDED_UPGRADES } from "@/sim/worlds";
import type { Check } from "@/sim/predicates";
import type { WorldDef } from "../schema";

const BACKUP_BLANKS = `#!/bin/sh
set -e
cd /srv/crumb
docker compose exec {{t}} db pg_dump -U crumb -Fc crumb > /home/deploy/backups/crumb-{{date}}.dump
`;
const BACKUP = BACKUP_BLANKS.replace("{{t}}", "-T").replace("{{date}}", "$(date +%F)");

const UU_FIXED = UNATTENDED_UPGRADES.replace('//Unattended-Upgrade::Automatic-Reboot "false";', 'Unattended-Upgrade::Automatic-Reboot "true";').replace(
  '//Unattended-Upgrade::Automatic-Reboot-Time "02:00";',
  'Unattended-Upgrade::Automatic-Reboot-Time "04:00";',
);

const LOGGING = `    logging:
      driver: json-file
      options:
        max-size: {{size}}
        max-file: "3"
`;

/** The World 7 compose file, with a logging block on every service. */
export function composeWithLogging(size: string): string {
  return `services:
  caddy:
    image: caddy:2
    restart: unless-stopped
${LOGGING.replace("{{size}}", size)}    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
  app:
    build: ./app
    env_file: .env
    restart: unless-stopped
${LOGGING.replace("{{size}}", size)}    depends_on:
      db:
        condition: service_healthy
  db:
    image: postgres:17
    env_file: .env
    restart: unless-stopped
${LOGGING.replace("{{size}}", size)}    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U crumb -d crumb"]
      interval: 5s
      retries: 5
    ports:
      - "127.0.0.1:5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
  caddy_data:
`;
}

/** A pg_dump file in /home/deploy/backups dated `day` (2026-10-12), or any date if omitted. */
const backupFile =
  (day?: string): Check =>
  (g) => {
    const d = getDir(g.world.hosts.vps, "/home/deploy/backups");
    return Object.entries(d?.children ?? {}).some(([n, f]) => f.type === "file" && /^crumb-\d{4}-\d\d-\d\d\.dump$/.test(n) && (!day || n.includes(day)) && f.content.startsWith("PGDMP"));
  };

const offsiteHas: Check = (g) => Object.entries(g.world.storage?.buckets ?? {}).some(([k, b]) => k.startsWith("offsite:") && Object.keys(b).some((n) => n.endsWith(".dump")));

const cronRunsBackup: Check = (g) => /^[^#].*\/home\/deploy\/backup\.sh/m.test(getFile(g.world.hosts.vps, "/var/spool/cron/crontabs/deploy")?.content ?? "");

const helloOff: Check = (g) => {
  const s = g.world.hosts.vps.services.hello;
  return !s || (s.state !== "active" && !s.enabled);
};

const everyServiceLogged: Check = (g) => {
  const cs = Object.values(g.world.hosts.vps.docker.containers).filter((c) => c.project === "crumb" && c.status === "running");
  return cs.length >= 3 && cs.every((c) => !!c.logging?.options?.["max-size"]);
};

export const world8: WorldDef = {
  id: 8,
  title: "Security and backups",
  tagline: "3-2-1, cron, disk full",
  cheatSheet: [
    { cmd: "sudo ss -tlnp", what: "every open door. Close what you do not use" },
    { cmd: "sudo systemctl disable --now NAME", what: "stop a service now and at every boot" },
    { cmd: "50unattended-upgrades", what: "security updates install daily. Automatic-Reboot \"true\" lets kernel updates take effect" },
    { cmd: ".env in .gitignore", what: "never commit secrets. A leaked secret must be changed, not just deleted" },
    { cmd: "3-2-1", what: "3 copies, 2 kinds of storage, 1 somewhere else" },
    { cmd: "docker compose exec -T db pg_dump -U crumb -Fc crumb > file.dump", what: "a backup. -T because scripts and cron have no terminal" },
    { cmd: "15 3 * * * /home/deploy/backup.sh", what: "a crontab line: every day at 03:15. Keep % out of crontab lines" },
    { cmd: "rclone copy /home/deploy/backups offsite:crumb-backups", what: "the offsite copy" },
    { cmd: "Restore test", what: "load a backup into a test database and count. A backup you never restored is a hope, not a backup" },
    { cmd: "logging: max-size 10m, max-file \"3\"", what: "cap each container's logs, or they fill the disk" },
    { cmd: "Uptime monitor", what: "checks the site from outside, so it can tell you when web-1 is down" },
  ],
  levels: [
    {
      id: "w8-01",
      world: 8,
      title: "Only what you need",
      base: "chain",
      start: "vps-deploy",
      steps: [
        {
          id: "w8-01-a",
          mission: "Look at every open door on web-1. Tap the one that has no reason to be there.",
          intel: { lines: ["Attack surface: every door a stranger could try. Fewer doors, fewer ways in.", "The hello test app from World 2 still listens on 8080."] },
          task: {
            kind: "spot",
            prompt: "sudo ss -tlnp on web-1",
            mono: true,
            lines: [
              'LISTEN 0  4096        0.0.0.0:22      0.0.0.0:*   users:(("sshd",pid=1029,fd=3))',
              'LISTEN 0  4096        0.0.0.0:80      0.0.0.0:*   users:(("docker-proxy",pid=2080,fd=3))',
              'LISTEN 0  4096        0.0.0.0:443     0.0.0.0:*   users:(("docker-proxy",pid=2443,fd=3))',
              'LISTEN 0  4096      127.0.0.1:5432    0.0.0.0:*   users:(("docker-proxy",pid=7432,fd=3))',
              'LISTEN 0  4096        0.0.0.0:8080    0.0.0.0:*   users:(("python3",pid=2118,fd=3))',
            ],
            bugs: [4],
            why: "Both firewalls block 8080 today, but one mistake later and it is open. Remove what you do not use.",
          },
          basis: { taught: ["self", "w4-02-a"] },
          tags: ["security"],
        },
        {
          id: "w8-01-b",
          mission: "Stop hello now, and keep it from starting at boot.",
          intel: { lines: ["sudo systemctl disable --now hello stops it now and at every boot."] },
          task: {
            kind: "terminal",
            goals: [{ describe: "hello is stopped and will not start at boot", check: helloOff }],
            hints: ["disable on its own only affects the next boot. --now also stops it now.", "sudo systemctl disable --now hello"],
            guide: ["sudo systemctl disable --now hello", "sudo ss -tlnp"],
            showMe: ["sudo systemctl disable --now hello", "{{deployPassword}}"],
            chips: ["sudo systemctl disable --now hello", "sudo ss -tlnp"],
          },
          tags: ["security"],
        },
      ],
    },
    {
      id: "w8-02",
      world: 8,
      title: "Updates while you sleep",
      base: "chain",
      start: "vps-deploy",
      steps: [
        {
          id: "w8-02-a",
          mission: "web-1 installs security updates by itself every day (unattended-upgrades).",
          intel: { lines: ["The kernel is the core of Linux: the part that talks to the hardware."] },
          task: {
            kind: "predict",
            question: "Last night it installed a new Linux kernel. Is that kernel running now?",
            options: ["No: it waits for a reboot, and unattended-upgrades does not reboot unless you allow it", "Yes, right away", "Only after you log in"],
            answer: 0,
            why: "A new kernel only starts at boot. Ubuntu leaves /var/run/reboot-required as a reminder.",
          },
          basis: { guess: true },
          tags: ["security", "updates"],
        },
        {
          id: "w8-02-b",
          mission: "Let it reboot by itself at 04:00, a quiet hour for the shop.",
          intel: { lines: ["Lines starting with // are switched off. Remove the // and set the values to switch a setting on."] },
          task: {
            kind: "config",
            host: "vps",
            path: "/etc/apt/apt.conf.d/50unattended-upgrades",
            lang: "text",
            mode: "fix",
            start: UNATTENDED_UPGRADES,
            checks: [
              { describe: "Automatic reboot is on", test: (t) => /^Unattended-Upgrade::Automatic-Reboot "true";\s*$/m.test(t) },
              { describe: "It reboots at a set time", test: (t) => /^Unattended-Upgrade::Automatic-Reboot-Time "\d\d:\d\d";\s*$/m.test(t) },
            ],
            solution: UU_FIXED,
            hints: ["Two lines near the bottom: remove the // in front of each.", 'Automatic-Reboot "true" and Automatic-Reboot-Time "04:00"'],
            writeToSim: true,
          },
          tags: ["security", "updates"],
        },
      ],
    },
    {
      id: "w8-03",
      world: 8,
      title: "Secrets stay out of git",
      base: "chain",
      start: "laptop",
      steps: [
        {
          id: "w8-03-a",
          mission: "A teammate's repo, file by file. Tap the one that must never be committed.",
          intel: { lines: ["Anyone who can read a git repo can read every file in its history, even after it is deleted."] },
          task: {
            kind: "spot",
            prompt: "git ls-files",
            mono: true,
            lines: [".gitignore", ".env", "Caddyfile", "compose.yaml", "app/Dockerfile", "app/package.json"],
            bugs: [1],
            why: ".env holds the database password and AUTH_SECRET. List it in .gitignore. A secret that leaked must be changed, not just deleted.",
          },
          basis: { taught: ["self"] },
          tags: ["security"],
        },
      ],
    },
    {
      id: "w8-04",
      world: 8,
      title: "3-2-1 backups",
      base: "chain",
      start: "laptop",
      steps: [
        {
          id: "w8-04-a",
          mission: "Supabase used to back up your data. Now that is your job.",
          intel: { lines: ["3-2-1: keep 3 copies of your data, on 2 kinds of storage, with 1 somewhere else."] },
          task: {
            kind: "predict",
            question: "Your only backup is a dump file on web-1's own disk. The disk dies. What do you have left?",
            options: ["Nothing", "Yesterday's orders", "Everything"],
            answer: 0,
            why: "A backup on the same disk dies with it. The 1 in 3-2-1 is a copy somewhere else.",
          },
          basis: { taught: ["self"] },
          tags: ["backups"],
        },
      ],
    },
    {
      id: "w8-05",
      world: 8,
      title: "A nightly backup",
      base: "chain",
      start: "vps-deploy",
      steps: [
        {
          id: "w8-05-a",
          mission: "Write the backup script: dump the shop's database into a dated file.",
          intel: {
            lines: ["-T: scripts and cron have no terminal, so docker compose exec must not ask for one.", "$(date +%F) puts today's date in the name, like crumb-2026-10-11.dump."],
          },
          task: {
            kind: "config",
            host: "vps",
            path: "/home/deploy/backup.sh",
            lang: "text",
            mode: "blanks",
            start: BACKUP_BLANKS,
            blanks: {
              t: { options: ["-T", "-it"], answer: 0 },
              date: { options: ["$(date +%F)", "today"], answer: 0 },
            },
            checks: [
              { describe: "No terminal is requested", test: (t) => /docker compose exec -T db pg_dump/.test(t) },
              { describe: "Each file gets the date in its name", test: (t) => /crumb-\$\(date \+%F\)\.dump/.test(t) },
            ],
            solution: BACKUP,
            hints: ["-it asks for a terminal, which cron does not have.", "-T and $(date +%F)"],
            writeToSim: true,
          },
          tags: ["backups"],
        },
        {
          id: "w8-05-b",
          mission: "Make the script runnable, then run it once by hand.",
          intel: { lines: ["chmod +x marks a file as a program you may run.", "./backup.sh runs the script in the folder you are in."] },
          task: {
            kind: "terminal",
            goals: [{ describe: "A dated backup file exists", check: backupFile() }],
            hints: ["The backups folder must exist first: mkdir -p.", "mkdir -p /home/deploy/backups, chmod +x backup.sh, ./backup.sh"],
            guide: ["mkdir -p /home/deploy/backups", "chmod +x backup.sh", "./backup.sh", "ls -lh /home/deploy/backups"],
            showMe: ["mkdir -p /home/deploy/backups", "chmod +x backup.sh", "./backup.sh"],
            chips: ["mkdir -p /home/deploy/backups", "chmod +x backup.sh", "./backup.sh", "ls -lh /home/deploy/backups"],
          },
          tags: ["backups"],
        },
        {
          id: "w8-05-c",
          mission: "Schedule it every night at 03:15, then skip ahead and check it ran.",
          intel: {
            lines: ["cron runs scheduled jobs. crontab -e opens your list: one job per line.", "15 3 * * * means minute 15, hour 3, every day. sleep 20h skips the game ahead."],
          },
          task: {
            kind: "terminal",
            goals: [
              { describe: "A cron job runs backup.sh", check: cronRunsBackup },
              { describe: "cron made a backup during the night", check: backupFile("2026-10-12") },
            ],
            hints: [
              "In crontab -e add one line: 15 3 * * * /home/deploy/backup.sh, save, then sleep 20h.",
              "Or in one go: echo '15 3 * * * /home/deploy/backup.sh' | crontab -   then sleep 20h",
            ],
            guide: ["crontab -e", "crontab -l", "sleep 20h", "ls -lh /home/deploy/backups"],
            showMe: ["echo '15 3 * * * /home/deploy/backup.sh' | crontab -", "crontab -l", "sleep 20h"],
            chips: ["crontab -e", "crontab -l", "sleep 20h", "ls -lh /home/deploy/backups"],
          },
          after: "cron ran it at 03:15 while you slept. % has a special meaning inside crontab lines, which is why the date lives in the script.",
          review: {
            id: "w8-05-c-q",
            q: "Every day at 03:15 in crontab:",
            options: ["15 3 * * *", "3 15 * * *", "* * 3 15 *"],
            answer: 0,
            why: "Minute first, then hour.",
            tag: "cron",
          },
          tags: ["backups", "cron"],
        },
      ],
    },
    {
      id: "w8-06",
      world: 8,
      title: "A copy somewhere else",
      base: "chain",
      start: "vps-deploy",
      setup: (w) => {
        // The storage provider gave you a ready-made rclone config for its S3-compatible bucket.
        const vps = w.hosts.vps;
        for (const p of ["/home/deploy/.config", "/home/deploy/.config/rclone"]) if (!getDir(vps, p)) put(vps, p, dir(0o700, "deploy", "deploy"));
        put(
          vps,
          "/home/deploy/.config/rclone/rclone.conf",
          file("[offsite]\ntype = s3\nprovider = Other\nendpoint = https://s3.example-storage.eu\naccess_key_id = AKEXAMPLE7Q2\nsecret_access_key = example-secret-not-real\n", 0o600, "deploy", "deploy"),
        );
      },
      steps: [
        {
          id: "w8-06-a",
          mission: "Backups run every night on web-1.",
          task: {
            kind: "predict",
            question: "The provider loses web-1 completely: disk, backups, everything. What saves the shop?",
            options: ["A copy of the backups somewhere else", "The nightly cron job", "The healthcheck"],
            answer: 0,
            why: "That is the 1 in 3-2-1. Copy each backup to storage that does not live on web-1.",
          },
          basis: { taught: ["w8-04-a"] },
          tags: ["backups"],
        },
        {
          id: "w8-06-b",
          mission: "Copy the backups to the offsite bucket with rclone.",
          intel: { lines: ["rclone copies files to cloud storage. Your storage provider's settings are already in ~/.config/rclone/rclone.conf, as a remote named offsite."] },
          task: {
            kind: "terminal",
            goals: [{ describe: "The offsite bucket holds a backup", check: offsiteHas }],
            hints: ["Install rclone with apt, then rclone copy FOLDER offsite:crumb-backups.", "sudo apt install -y rclone, then rclone copy /home/deploy/backups offsite:crumb-backups"],
            guide: ["sudo apt install -y rclone", "rclone copy /home/deploy/backups offsite:crumb-backups", "rclone ls offsite:crumb-backups"],
            showMe: ["sudo apt install -y rclone", "{{deployPassword}}", "rclone copy /home/deploy/backups offsite:crumb-backups"],
            chips: ["sudo apt install -y rclone", "rclone copy /home/deploy/backups offsite:crumb-backups", "rclone ls offsite:crumb-backups"],
          },
          after: "Add that rclone line to the end of backup.sh, and every night's dump goes offsite by itself.",
          tags: ["backups"],
        },
      ],
    },
    {
      id: "w8-07",
      world: 8,
      title: "Restore test",
      base: "chain",
      start: "vps-deploy",
      steps: [
        {
          id: "w8-07-a",
          mission: "A backup nobody has restored is a hope, not a backup. Restore one into a test database.",
          intel: { lines: ["Make an empty test database, load a dump into it with pg_restore, then count the orders."] },
          task: {
            kind: "terminal",
            goals: [{ describe: "restore_test holds the orders", check: P.pgTableRows("restore_test", "orders", 1000) }],
            hints: ["The dump is fed in with < from the server, so docker compose exec needs -T.", "Tap each Type this button in order."],
            guide: [
              "cd /srv/crumb",
              'docker compose exec db psql -U crumb -c "create database restore_test;"',
              "docker compose exec -T db pg_restore -U crumb -d restore_test < /home/deploy/backups/crumb-2026-10-11.dump",
              'docker compose exec db psql -U crumb -d restore_test -c "select count(*) from orders;"',
            ],
            showMe: [
              "cd /srv/crumb",
              'docker compose exec db psql -U crumb -c "create database restore_test;"',
              "docker compose exec -T db pg_restore -U crumb -d restore_test < /home/deploy/backups/crumb-2026-10-11.dump",
            ],
            chips: ["cd /srv/crumb", "ls /home/deploy/backups"],
          },
          after: "1,284 orders came back. Do this every month, and after any change to the backup script.",
          tags: ["backups", "postgres"],
        },
        {
          id: "w8-07-b",
          mission: "Backups review. Go fast.",
          task: {
            kind: "rapid",
            seconds: 40,
            items: [
              { id: "w8-07-b1", q: "3-2-1 means 3 copies, 2 kinds of storage, and...", options: ["1 somewhere else", "1 password", "1 server"], answer: 0, why: "The offsite copy.", tag: "backups" },
              { id: "w8-07-b2", q: "In a cron job, docker compose exec needs...", options: ["-T", "-it", "sudo"], answer: 0, why: "Cron has no terminal.", tag: "cron" },
              { id: "w8-07-b3", q: "15 3 * * * runs...", options: ["every day at 03:15", "every 15 minutes", "on the 15th at 3"], answer: 0, why: "Minute, hour, day, month, weekday.", tag: "cron" },
              { id: "w8-07-b4", q: "Proof that a backup works:", options: ["restoring it", "its file size", "cron said it ran"], answer: 0, why: "Restore into a test database and count.", tag: "backups" },
              { id: "w8-07-b5", q: ".env ended up in git. You...", options: ["change every secret in it", "delete the file and move on", "make the repo private"], answer: 0, why: "Git history keeps it forever.", tag: "security" },
            ],
          },
          basis: { taught: ["w8-04-a", "w8-05-a", "w8-05-c", "w8-07-a", "w8-03-a"] },
          tags: ["backups"],
        },
      ],
    },
    {
      id: "w8-08",
      world: 8,
      title: "Log limits and an outside check",
      base: "chain",
      start: "vps-deploy",
      steps: [
        {
          id: "w8-08-a",
          mission: "Every container writes a log file on web-1. By default, it grows forever.",
          intel: { lines: ["Log rotation: keep a log at a set size, start a new file, and delete the oldest.", "In compose, logging options do that per service."] },
          task: {
            kind: "config",
            host: "vps",
            path: "/srv/crumb/compose.yaml",
            lang: "yaml",
            mode: "blanks",
            start: composeWithLogging("{{size}}"),
            blanks: { size: { options: ["10m", "unlimited"], answer: 0 } },
            checks: [{ describe: "Every service keeps at most 3 files of 10 MB", test: (t) => (t.match(/max-size: 10m/g) ?? []).length === 3 && (t.match(/max-file: "3"/g) ?? []).length === 3 }],
            solution: composeWithLogging("10m"),
            hints: ["Three files of 10 MB at most, per service.", "10m"],
            writeToSim: true,
          },
          tags: ["logs", "compose"],
        },
        {
          id: "w8-08-b",
          mission: "Apply it. Logging options only apply to new containers, so compose recreates them.",
          task: {
            kind: "terminal",
            goals: [{ describe: "Every service runs with log limits", check: everyServiceLogged }],
            hints: ["Same command as every compose change.", "cd /srv/crumb, docker compose up -d"],
            guide: ["cd /srv/crumb", "docker compose up -d"],
            showMe: ["cd /srv/crumb", "docker compose up -d"],
            chips: ["cd /srv/crumb", "docker compose up -d", "docker compose ps"],
          },
          tags: ["logs", "compose"],
        },
        {
          id: "w8-08-c",
          mission: "Last piece: something should tell you when the shop is down.",
          intel: { lines: ["An uptime monitor visits your site every minute and alerts you when it fails."] },
          task: {
            kind: "predict",
            question: "Where should the uptime monitor run?",
            options: ["Somewhere else, like a monitoring service", "On web-1, next to the shop", "In the app container"],
            answer: 0,
            why: "If web-1 goes down, a monitor on web-1 goes down with it and tells no one.",
          },
          basis: { taught: ["self"] },
          tags: ["monitoring"],
        },
      ],
    },
    {
      id: "w8-09",
      world: 8,
      title: "Incident: the disk is full",
      base: "chain",
      start: "vps-deploy",
      steps: [
        {
          id: "w8-09-a",
          mission: "Incident! Orders fail and the database keeps restarting.",
          task: { kind: "incident", incidentId: "disk-full-logs" },
          tags: ["logs", "debugging"],
        },
      ],
    },
  ],
};
