import { checkDockerRepo, dockerPostInstall, PKG_VERSIONS } from "../../docker/install";
import type { Host, Service } from "../../types";
import type { Command, Ctx } from "../ctx";

interface PkgInfo {
  version: string;
  section: string;
  sizeKb: number;
  deps: string[];
  service?: Omit<Service, "since" | "pid"> & { pid: number };
  /** Only installable after this extra repository was added and apt update ran ("docker"). */
  repo?: string;
  /** Extra setup after unpacking (groups, folders, services). */
  onInstall?: (ctx: Ctx) => void;
}

const dockerSetup = (ctx: Ctx) => dockerPostInstall(ctx.w, ctx.host);

export const CATALOG: Record<string, PkgInfo> = {
  ncdu: { version: "1.19-0.1", section: "universe", sizeKb: 50, deps: [] },
  rclone: { version: "1.60.1+dfsg-3ubuntu0.24.04.2", section: "universe", sizeKb: 15360, deps: ["fuse3"] },
  htop: { version: "3.3.0-4build1", section: "main", sizeKb: 171, deps: ["libnl-3-200", "libnl-genl-3-200"] },
  tree: { version: "2.1.1-2ubuntu3", section: "universe", sizeKb: 47, deps: [] },
  git: { version: "1:2.43.0-1ubuntu7.1", section: "main", sizeKb: 3680, deps: ["git-man", "liberror-perl"] },
  rsync: { version: "3.2.7-1ubuntu1", section: "main", sizeKb: 436, deps: [] },
  jq: { version: "1.7.1-3build1", section: "main", sizeKb: 65, deps: ["libjq1", "libonig5"] },
  "postgresql-client": { version: "16+257build1", section: "main", sizeKb: 1520, deps: ["postgresql-client-16", "libpq5"] },
  fail2ban: {
    version: "1.0.2-3ubuntu0.1",
    section: "universe",
    sizeKb: 409,
    deps: ["python3-pyasyncore", "python3-pyinotify", "whois"],
    service: {
      name: "fail2ban",
      description: "Fail2Ban Service",
      unitPath: "/usr/lib/systemd/system/fail2ban.service",
      enabled: true,
      state: "active",
      pid: 1501,
    },
  },
  nginx: {
    version: "1.24.0-2ubuntu7",
    section: "main",
    sizeKb: 520,
    deps: ["nginx-common"],
    service: {
      name: "nginx",
      description: "A high performance web server and a reverse proxy server",
      unitPath: "/usr/lib/systemd/system/nginx.service",
      enabled: true,
      state: "active",
      pid: 1620,
      listens: [{ port: 80, addr: "0.0.0.0", proc: "nginx" }],
    },
  },
  "unattended-upgrades": { version: "2.9.1+nmu4ubuntu1", section: "main", sizeKb: 49, deps: [] },
  ufw: { version: "0.36.2-6", section: "main", sizeKb: 169, deps: [] },
  curl: { version: "8.5.0-2ubuntu10.4", section: "main", sizeKb: 226, deps: [] },
  "docker.io": { version: "24.0.7-0ubuntu4.1", section: "universe", sizeKb: 29300, deps: ["containerd", "runc", "bridge-utils", "pigz", "ubuntu-fan"], onInstall: dockerSetup },
  "docker-compose-v2": { version: "2.24.6+ds1-0ubuntu2~24.04.1", section: "universe", sizeKb: 14300, deps: [] },
  "docker-buildx": { version: "0.12.1-0ubuntu2", section: "universe", sizeKb: 15900, deps: [] },
  // Docker's own repository (download.docker.com). apt installs recommended packages too, so the plugins come along.
  "docker-ce": {
    version: PKG_VERSIONS["docker-ce"],
    section: "stable",
    sizeKb: 25800,
    deps: ["docker-ce-cli", "containerd.io", "docker-buildx-plugin", "docker-compose-plugin", "docker-ce-rootless-extras", "pigz", "slirp4netns"],
    repo: "docker",
    onInstall: dockerSetup,
  },
  "docker-ce-cli": { version: PKG_VERSIONS["docker-ce-cli"], section: "stable", sizeKb: 14200, deps: [], repo: "docker" },
  "containerd.io": { version: PKG_VERSIONS["containerd.io"], section: "stable", sizeKb: 30500, deps: [], repo: "docker" },
  "docker-buildx-plugin": { version: PKG_VERSIONS["docker-buildx-plugin"], section: "stable", sizeKb: 30200, deps: [], repo: "docker" },
  "docker-compose-plugin": { version: PKG_VERSIONS["docker-compose-plugin"], section: "stable", sizeKb: 12800, deps: [], repo: "docker" },
  "docker-ce-rootless-extras": { version: PKG_VERSIONS["docker-ce-rootless-extras"], section: "stable", sizeKb: 9600, deps: [], repo: "docker" },
};

const ALIASES: Record<string, string> = { "postgresql-client-common": "postgresql-client" };

function needRoot(ctx: Ctx): boolean {
  if (ctx.user === "root") return true;
  ctx.err(
    "E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\nE: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?",
  );
  return false;
}

function header(ctx: Ctx) {
  ctx.out("Reading package lists... Done\nBuilding dependency tree... Done\nReading state information... Done");
}

function upgradable(host: Host): number {
  return host.upgraded ? 0 : 12;
}

function doInstall(ctx: Ctx, names: string[]): number {
  const host = ctx.host;
  const newOnes = names.filter((n) => !host.packages[n]);
  for (const n of names.filter((n) => host.packages[n])) {
    ctx.out(`${n} is already the newest version (${CATALOG[n]?.version ?? host.packages[n].version}).`);
  }
  if (!newOnes.length) {
    ctx.out(`0 upgraded, 0 newly installed, 0 to remove and ${upgradable(host)} not upgraded.`);
    return 0;
  }
  const allNew = newOnes.flatMap((n) => [n, ...CATALOG[n].deps.filter((d) => !host.packages[d])]);
  const kb = newOnes.reduce((s, n) => s + CATALOG[n].sizeKb, 0);
  let i = 1;
  const lines = [
    `The following NEW packages will be installed:`,
    `  ${allNew.join(" ")}`,
    `0 upgraded, ${allNew.length} newly installed, 0 to remove and ${upgradable(host)} not upgraded.`,
    `Need to get ${kb} kB of archives.`,
    `After this operation, ${kb * 3} kB of additional disk space will be used.`,
  ];
  ctx.out(lines.join("\n"));
  const fetch: string[] = [];
  for (const n of allNew) {
    const info = CATALOG[n];
    const mirror = info?.repo === "docker" ? "https://download.docker.com/linux/ubuntu noble/stable" : `http://archive.ubuntu.com/ubuntu noble/${info?.section ?? "main"}`;
    fetch.push(`Get:${i++} ${mirror} amd64 ${n} amd64 ${info?.version ?? "1.0"} [${info?.sizeKb ?? 30} kB]`);
  }
  fetch.push(`Fetched ${kb} kB in 1s (${kb * 2} kB/s)`);
  for (const n of allNew) {
    const info = CATALOG[n];
    fetch.push(`Selecting previously unselected package ${n}.`, `Setting up ${n} (${info?.version ?? "1.0"}) ...`);
    host.packages[n] = { version: info?.version ?? "1.0" };
    if (info?.service) {
      host.services[info.service.name] = { ...info.service, since: ctx.w.clock };
      fetch.push(
        `Created symlink /etc/systemd/system/multi-user.target.wants/${info.service.name}.service → ${info.service.unitPath}.`,
      );
      ctx.journal(info.service.name, `Started ${info.service.name}.service - ${info.service.description}.`, "systemd[1]");
    }
    if (info?.onInstall) {
      const had = !!host.services.docker;
      info.onInstall(ctx);
      if (!had && host.services.docker) {
        fetch.push(
          "Created symlink /etc/systemd/system/multi-user.target.wants/docker.service → /usr/lib/systemd/system/docker.service.",
          "Created symlink /etc/systemd/system/sockets.target.wants/docker.socket → /usr/lib/systemd/system/docker.socket.",
        );
      }
    }
  }
  fetch.push("Processing triggers for man-db (2.12.0-4build2) ...");
  ctx.out(fetch.join("\n"));
  host.baseUsedMb += kb / 300;
  return 0;
}

export const apt: Command = {
  name: "apt",
  summary: "install software (sudo apt update, sudo apt install NAME)",
  run(ctx) {
    const args = ctx.argv.slice(1);
    const yes = args.includes("-y") || args.includes("--yes");
    const rest = args.filter((a) => !a.startsWith("-"));
    const sub = rest[0];
    const names = rest.slice(1).map((n) => ALIASES[n] ?? n);
    const host = ctx.host;
    switch (sub) {
      case undefined:
        ctx.out("apt 2.7.14 (amd64)\nUsage: apt [options] command\n\nMost used commands:\n  list - list packages\n  update - update list of available packages\n  install - install packages\n  remove - remove packages\n  upgrade - upgrade the system by installing/upgrading packages");
        return 0;
      case "update": {
        if (!needRoot(ctx)) return 100;
        const dockerRepo = checkDockerRepo(host, 6);
        host.aptRepos = (host.aptRepos ?? []).filter((r) => r !== "docker");
        if (dockerRepo?.ok) host.aptRepos.push("docker");
        if (dockerRepo?.errors.length) {
          ctx.out(
            [
              "Hit:1 http://archive.ubuntu.com/ubuntu noble InRelease",
              "Hit:2 http://archive.ubuntu.com/ubuntu noble-updates InRelease",
              "Hit:3 http://security.ubuntu.com/ubuntu noble-security InRelease",
              "Hit:4 http://archive.ubuntu.com/ubuntu noble-backports InRelease",
              ...dockerRepo.lines,
              "Reading package lists... Done",
            ].join("\n"),
          );
          ctx.err(dockerRepo.errors.join("\n"));
          host.aptFresh = true;
          return 100;
        }
        ctx.out(
          [
            "Hit:1 http://archive.ubuntu.com/ubuntu noble InRelease",
            "Get:2 http://archive.ubuntu.com/ubuntu noble-updates InRelease [126 kB]",
            "Get:3 http://security.ubuntu.com/ubuntu noble-security InRelease [126 kB]",
            "Get:4 http://archive.ubuntu.com/ubuntu noble-backports InRelease [126 kB]",
            "Get:5 http://archive.ubuntu.com/ubuntu noble/universe amd64 Packages [15.0 MB]",
            ...(dockerRepo?.lines ?? []),
            "Fetched 21.4 MB in 3s (7,120 kB/s)",
            "Reading package lists... Done",
            "Building dependency tree... Done",
            "Reading state information... Done",
            upgradable(host)
              ? `${upgradable(host)} packages can be upgraded. Run 'apt list --upgradable' to see them.`
              : "All packages are up to date.",
          ].join("\n"),
        );
        host.aptFresh = true;
        return 0;
      }
      case "install": {
        if (!names.length) {
          ctx.err("E: No packages given. Try: sudo apt install ncdu");
          return 100;
        }
        if (!needRoot(ctx)) return 100;
        header(ctx);
        for (const n of names) {
          const repo = CATALOG[n]?.repo;
          if (repo && !host.packages[n] && !(host.aptRepos ?? []).includes(repo)) {
            ctx.err(`E: Unable to locate package ${n}`);
            if (repo === "docker") ctx.info(`${n} comes from Docker's own package repository. Add it in /etc/apt/sources.list.d/docker.list, then run sudo apt update.`);
            return 100;
          }
          if (!CATALOG[n] && !host.packages[n]) {
            ctx.err(`E: Unable to locate package ${n}`);
            if (!host.aptFresh) ctx.info("The package list on this box is empty or stale. Run sudo apt update first.");
            return 100;
          }
          if (!host.aptFresh && !host.packages[n]) {
            ctx.err(`E: Unable to locate package ${n}`);
            ctx.info("The package list on this box is empty or stale. Run sudo apt update first.");
            return 100;
          }
        }
        const deps = names.flatMap((n) => CATALOG[n]?.deps ?? []).filter((d) => !host.packages[d]);
        if (deps.length && !yes) {
          ctx.prompt({ prompt: "Do you want to continue? [Y/n] ", secret: false, data: { names } });
          return 0;
        }
        return doInstall(ctx, names);
      }
      case "remove":
      case "purge": {
        if (!needRoot(ctx)) return 100;
        header(ctx);
        for (const n of names) {
          if (!host.packages[n]) {
            ctx.out(`Package '${n}' is not installed, so not removed`);
            continue;
          }
          if (n === "openssh-server") {
            ctx.err("The game stops you here: removing the SSH server on a remote box locks you out for good.");
            return 1;
          }
          delete host.packages[n];
          const s = CATALOG[n]?.service;
          if (s) delete host.services[s.name];
          ctx.out(`The following packages will be REMOVED:\n  ${n}\nRemoving ${n} (${CATALOG[n]?.version ?? ""}) ...`);
        }
        return 0;
      }
      case "upgrade":
      case "full-upgrade": {
        if (!needRoot(ctx)) return 100;
        header(ctx);
        if (!upgradable(host)) {
          ctx.out("Calculating upgrade... Done\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.");
          return 0;
        }
        if (!yes) {
          ctx.out(
            "Calculating upgrade... Done\nThe following packages will be upgraded:\n  libssl3t64 openssh-client openssh-server openssh-sftp-server openssl\n  python3-urllib3 snapd sudo systemd systemd-resolved tzdata ubuntu-pro-client\n12 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.",
          );
          ctx.prompt({ prompt: "Do you want to continue? [Y/n] ", secret: false, data: { upgrade: true } });
          return 0;
        }
        host.upgraded = true;
        ctx.out("Calculating upgrade... Done\n12 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\nSetting up openssh-server (1:9.6p1-3ubuntu13.5) ...\nSetting up sudo (1.9.15p5-3ubuntu5.24.04.1) ...");
        return 0;
      }
      case "list": {
        if (args.includes("--upgradable")) {
          ctx.out(
            upgradable(host)
              ? "Listing... Done\nopenssh-server/noble-updates 1:9.6p1-3ubuntu13.5 amd64 [upgradable from: 1:9.6p1-3ubuntu13.4]\nsudo/noble-updates 1.9.15p5-3ubuntu5.24.04.1 amd64 [upgradable from: 1.9.15p5-3ubuntu5]\n(and 10 more)"
              : "Listing... Done",
          );
          return 0;
        }
        ctx.out(
          "Listing... Done\n" +
            Object.keys(host.packages)
              .sort()
              .map((n) => `${n}/noble,now ${host.packages[n].version} amd64 [installed]`)
              .join("\n"),
        );
        return 0;
      }
      case "search": {
        const q = names[0] ?? "";
        ctx.out(
          Object.keys(CATALOG)
            .filter((n) => n.includes(q))
            .map((n) => `${n}/noble ${CATALOG[n].version} amd64`)
            .join("\n") || "Sorting... Done\nFull Text Search... Done",
        );
        return 0;
      }
      case "autoremove":
        if (!needRoot(ctx)) return 100;
        header(ctx);
        ctx.out("0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.");
        return 0;
      default:
        ctx.err(`E: Invalid operation ${sub}`);
        return 100;
    }
  },
  resume(ctx, p, input) {
    const ans = input.trim().toLowerCase();
    if (ans !== "" && ans !== "y" && ans !== "yes") {
      ctx.out("Abort.");
      return 1;
    }
    if (p.data.upgrade) {
      ctx.host.upgraded = true;
      ctx.out("Setting up openssh-server (1:9.6p1-3ubuntu13.5) ...\nSetting up sudo (1.9.15p5-3ubuntu5.24.04.1) ...\nProcessing triggers for libc-bin (2.39-0ubuntu8.3) ...");
      return 0;
    }
    return doInstall(ctx, p.data.names as string[]);
  },
  complete: () => ["update", "install", "remove", "upgrade", "list", "search"],
};

export const aptGet: Command = { ...apt, name: "apt-get", hidden: true };

export const APT_COMMANDS = [apt, aptGet];
