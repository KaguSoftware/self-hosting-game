import { APT_COMMANDS } from "./commands/apt";
import { FILE_COMMANDS } from "./commands/files";
import { NET_COMMANDS } from "./commands/net";
import { SCRIPT_COMMANDS, sed } from "./commands/scripts";
import { SSH_COMMANDS } from "./commands/ssh";
import { SYSTEM_COMMANDS } from "./commands/system";
import { SYSTEMD_COMMANDS } from "./commands/systemd";
import { TEXT_COMMANDS } from "./commands/text";
import { UFW_COMMANDS } from "./commands/ufw";
import { USER_COMMANDS } from "./commands/users";
import type { Command } from "./ctx";

const GROUPS: [string, Command[]][] = [
  ["Files", FILE_COMMANDS],
  ["Reading", [...TEXT_COMMANDS, sed]],
  ["System", SYSTEM_COMMANDS],
  ["Software", APT_COMMANDS],
  ["Services", SYSTEMD_COMMANDS],
  ["Users", USER_COMMANDS],
  ["Firewall", UFW_COMMANDS],
  ["SSH", SSH_COMMANDS],
  ["Network", NET_COMMANDS],
  ["Scripts", SCRIPT_COMMANDS],
];

const help: Command = {
  name: "help",
  summary: "this list",
  run(ctx) {
    const lines: string[] = ["Commands in this game (Tab completes, Up repeats, Ctrl+L clears):", ""];
    for (const [title, cmds] of GROUPS) {
      const shown = cmds.filter((c) => !c.hidden);
      lines.push(`${title}: ${shown.map((c) => c.name).join("  ")}`);
    }
    lines.push("", "Prefix with sudo to run as root. Type help NAME for one command.");
    const one = ctx.argv[1] && COMMANDS[ctx.argv[1]];
    if (one) {
      ctx.out(`${one.name}: ${one.summary}`);
      return 0;
    }
    ctx.out(lines.join("\n"));
    return 0;
  },
};

export const COMMANDS: Record<string, Command> = {};
for (const [, cmds] of GROUPS) for (const c of cmds) COMMANDS[c.name] = c;
COMMANDS.help = help;

/** Commands that exist only once a package is installed. */
export const NEEDS_PACKAGE: Record<string, string> = {
  htop: "htop",
  ncdu: "ncdu",
  tree: "tree",
  git: "git",
  rsync: "rsync",
  jq: "jq",
  psql: "postgresql-client",
  pg_dump: "postgresql-client",
  pg_restore: "postgresql-client",
  "fail2ban-client": "fail2ban",
  nginx: "nginx",
  docker: "docker-ce",
  caddy: "caddy",
};

/** Commands any one of several packages provides (docker comes from docker-ce or docker.io). */
export const NEEDS_ANY_PACKAGE: Record<string, string[]> = {
  docker: ["docker-ce", "docker.io"],
};

export const NOT_INSTALLED_HINT: Record<string, string> = {
  docker: "sudo snap install docker         # version 27.2.0, or\nsudo apt  install docker.io      # version 24.0.7-0ubuntu4.1",
  caddy: "sudo apt install caddy",
  psql: "sudo apt install postgresql-client-common",
};
