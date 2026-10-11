// Installing Docker: the official apt repository, Ubuntu's docker.io, and the get.docker.com script.
import { dir, file, getDir, getFile, put } from "../fs";
import { isoTime } from "../time";
import type { Host, World } from "../types";
import { ensureDefaultNetworks } from "./network";
import { COMPOSE_VERSION, DOCKER_VERSION } from "./runtime";

export const DOCKER_LIST = "/etc/apt/sources.list.d/docker.list";
export const DOCKER_GPG_URL = "https://download.docker.com/linux/ubuntu/gpg";
export const INSTALL_SCRIPT_MARKER = "# docker-install-script";
export const INSTALL_SCRIPT_COMMIT = "711a0b9a5a17f5ad4a3bce5c5d6bcc38c44a9cbb";

const DOCKER_GPG = `-----BEGIN PGP PUBLIC KEY BLOCK-----

mQINBFit2ioBEADhWpZ8/wvZ6hUTiXOwQHXMAlaFHcPH9hAtr4F1y2+OYdbtMuth
lqqwp028AqyY+PRfVMtSYMbjuQuu5byyKR01BbqYhuS3jtqQmljZ/bJvXqnmiVXh
38UuLa+z077PxyxQhu5BbqntTPQMfiyqEiU+BKbq2WmANUKQf+1AmZY/IruOXbnq
L4C1+gJ8vfmXQt99npCaxEjaNRVYfOS8QcixNzHUYnb6emjlANyEVlZzeqo7XKl7
UrwV5inawTSzWNvtjEjj4nJL8NsLwscpLPQUhTQ+7BbQXAwAmeHCUTQIvvWXqw0N
cmhh4HgeQscQHYgOJjjDVfoY5MucvglbIgCqfzAHW9jxmRL4qbMZj+b1XoePEtht
ku4bIQN1X5P07fNWzlgaRL5Z4POXDDZTlIQ/El58j9kp4bnWRCJW0lya+f8ocodo
=7AW3
-----END PGP PUBLIC KEY BLOCK-----
`;

/** The script get.docker.com hands out. The real one is 700 lines; this one calls the sim's installer. */
export const GET_DOCKER_SH = `#!/bin/sh
set -e
${INSTALL_SCRIPT_MARKER}
# Docker Engine for Linux installation script.
#
# This script is intended as a convenient way to configure docker's package
# repositories and to install Docker Engine. This script is not recommended
# for production environments. Before running this script, make yourself
# familiar with potential risks and limitations, and refer to the installation
# manual at https://docs.docker.com/engine/install/ for alternative
# installation methods.
#
# Usage
# ==============================================================================
#
# To install the latest stable versions of Docker CLI, Docker Engine, and their
# dependencies:
#
# 1. download the script
#
#   $ curl -fsSL https://get.docker.com -o install-docker.sh
#
# 2. verify the script's content
#
#   $ cat install-docker.sh
#
# 3. run the script with --dry-run to verify the steps it executes
#
#   $ sh install-docker.sh --dry-run
#
# 4. run the script either as root, or using sudo to perform the installation.
#
#   $ sudo sh install-docker.sh
#
# Git commit from https://github.com/docker/docker-install when
# the script was uploaded (Should only be modified by upload job):
__docker_install "$@"
`;

/** Files on the internet that curl can download (outside our own server). */
export const EXTERNAL_URLS: Record<string, string> = {
  "https://get.docker.com": GET_DOCKER_SH,
  "https://get.docker.com/": GET_DOCKER_SH,
  [DOCKER_GPG_URL]: DOCKER_GPG,
};

export function externalUrl(url: string): string | undefined {
  return EXTERNAL_URLS[url.trim()];
}

/** Packages that make `docker` and its plugins. */
export const DOCKER_CE_PACKAGES = ["docker-ce", "docker-ce-cli", "containerd.io", "docker-buildx-plugin", "docker-compose-plugin"];

export const PKG_VERSIONS: Record<string, string> = {
  "docker-ce": `5:${DOCKER_VERSION}-1~ubuntu.24.04~noble`,
  "docker-ce-cli": `5:${DOCKER_VERSION}-1~ubuntu.24.04~noble`,
  "containerd.io": "1.7.22-1",
  "docker-buildx-plugin": "0.17.1-1~ubuntu.24.04~noble",
  "docker-compose-plugin": `${COMPOSE_VERSION}-1~ubuntu.24.04~noble`,
  "docker-ce-rootless-extras": `5:${DOCKER_VERSION}-1~ubuntu.24.04~noble`,
};

/** After any Docker engine package is installed: the docker group, its folders, default networks, the service. */
export function dockerPostInstall(w: World, host: Host): void {
  if (!host.groups.docker) host.groups.docker = { name: "docker", gid: 988, members: [] };
  if (!getDir(host, "/var/lib/docker")) put(host, "/var/lib/docker", dir(0o710));
  if (!getDir(host, "/etc/docker")) put(host, "/etc/docker", dir());
  if (!getFile(host, "/run/docker.sock")) put(host, "/run/docker.sock", file("", 0o660, "root", "docker"));
  ensureDefaultNetworks(host);
  if (!host.services.docker) {
    host.services.docker = {
      name: "docker",
      description: "Docker Application Container Engine",
      unitPath: "/usr/lib/systemd/system/docker.service",
      enabled: true,
      state: "active",
      since: w.clock,
      pid: 901,
      triggeredBy: "docker.socket",
    };
    host.journal.push({ t: w.clock, unit: "docker", msg: "Starting docker.service - Docker Application Container Engine...", proc: "systemd[1]" });
    host.journal.push({ t: w.clock, unit: "docker", msg: `time="${isoTime(w.clock)}" level=info msg="API listen on /run/docker.sock"` });
    host.journal.push({ t: w.clock, unit: "docker", msg: "Started docker.service - Docker Application Container Engine.", proc: "systemd[1]" });
  }
}

export interface RepoCheck {
  /** Lines apt update prints for this repo. */
  lines: string[];
  /** W: and E: lines. */
  errors: string[];
  ok: boolean;
}

/** What `apt update` does with /etc/apt/sources.list.d/docker.list, if it exists. */
export function checkDockerRepo(host: Host, startIndex: number): RepoCheck | undefined {
  const list = getFile(host, DOCKER_LIST)?.content;
  if (list === undefined) return undefined;
  const line = list.split("\n").find((l) => /^\s*deb\s/.test(l));
  if (!line || !line.includes("download.docker.com/linux/ubuntu")) return { lines: [], errors: [], ok: false };
  const suite = /download\.docker\.com\/linux\/ubuntu\/?\s+(\S+)/.exec(line)?.[1] ?? "noble";
  const repo = `https://download.docker.com/linux/ubuntu ${suite}`;
  const signedBy = /signed-by=([^\s\]]+)/.exec(line)?.[1];
  const key = signedBy ? getFile(host, signedBy) : undefined;
  if (!key || !key.content.includes("BEGIN PGP PUBLIC KEY BLOCK")) {
    return {
      lines: [`Get:${startIndex} ${repo} InRelease [48.8 kB]`],
      errors: [
        `W: GPG error: ${repo} InRelease: The following signatures couldn't be verified because the public key is not available: NO_PUBKEY 7EA0A9C3F273FCD8`,
        `E: The repository '${repo} InRelease' is not signed.`,
        `N: Updating from such a repository can't be done securely, and is therefore disabled by default.`,
        `N: See apt-secure(8) manpage for repository creation and user configuration details.`,
      ],
      ok: false,
    };
  }
  return {
    lines: [`Get:${startIndex} ${repo} InRelease [48.8 kB]`, `Get:${startIndex + 1} ${repo}/stable amd64 Packages [17.4 kB]`],
    errors: [],
    ok: suite === "noble",
  };
}

/** The tail the install script prints after `docker version`. */
export const INSTALL_SCRIPT_FOOTER = [
  "",
  "================================================================================",
  "",
  "To run Docker as a non-privileged user, consider setting up the",
  "Docker daemon in rootless mode for your user:",
  "",
  "    dockerd-rootless-setuptool.sh install",
  "",
  "Visit https://docs.docker.com/go/rootless/ to learn about rootless mode.",
  "",
  "",
  "To run the Docker daemon as a fully privileged service, but granting non-root",
  "users access, refer to https://docs.docker.com/go/daemon-access/",
  "",
  "WARNING: Access to the remote API on a privileged Docker daemon is equivalent",
  "         to root access on the host. Refer to the 'Docker daemon attack surface'",
  "         documentation for details: https://docs.docker.com/go/attack-surface/",
  "",
  "================================================================================",
  "",
];

/** What the install script does to the machine: the same as the apt repository route. */
export function scriptInstall(w: World, host: Host): void {
  if (!getDir(host, "/etc/apt/keyrings")) put(host, "/etc/apt/keyrings", dir());
  put(host, "/etc/apt/keyrings/docker.asc", file(DOCKER_GPG, 0o644));
  put(
    host,
    DOCKER_LIST,
    file("deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable\n", 0o644),
  );
  host.aptFresh = true;
  host.aptRepos = [...new Set([...(host.aptRepos ?? []), "docker"])];
  for (const p of [...DOCKER_CE_PACKAGES, "docker-ce-rootless-extras"]) host.packages[p] = { version: PKG_VERSIONS[p] };
  host.baseUsedMb += 420;
  dockerPostInstall(w, host);
}
