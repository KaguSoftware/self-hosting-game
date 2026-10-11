import { dir, file, put } from "../../fs";
import type { Command, Ctx } from "../ctx";

const SKEL_BASHRC = `# ~/.bashrc
HISTSIZE=1000
alias ll='ls -alF'
`;

function nextUid(ctx: Ctx): number {
  const used = Object.values(ctx.host.users).map((u) => u.uid);
  let uid = 1000;
  while (used.includes(uid)) uid++;
  return uid;
}

function validName(n: string): boolean {
  return /^[a-z_][a-z0-9_-]*$/.test(n) && n.length <= 32;
}

function createUser(ctx: Ctx, name: string, withHome: boolean, homeMode: number, extraGroups: string[]) {
  const uid = nextUid(ctx);
  const home = `/home/${name}`;
  ctx.host.users[name] = { name, uid, home, shell: "/bin/bash" };
  ctx.host.groups[name] = { name, gid: uid, members: [] };
  for (const g of extraGroups) ctx.host.groups[g]?.members.push(name);
  if (withHome) {
    put(ctx.host, home, dir(homeMode, name, name));
    put(ctx.host, `${home}/.bashrc`, file(SKEL_BASHRC, 0o644, name, name));
    put(ctx.host, `${home}/.profile`, file("# ~/.profile\n", 0o644, name, name));
  }
  return uid;
}

export const adduser: Command = {
  name: "adduser",
  summary: "create a user, the friendly way (sudo adduser deploy)",
  run(ctx) {
    const args = ctx.argv.slice(1).filter((a) => !a.startsWith("-"));
    if (args.length === 2) {
      // adduser USER GROUP
      return usermod.run({ ...ctx, argv: ["usermod", "-aG", args[1], args[0]] }) === 0
        ? (ctx.out(`info: Adding user \`${args[0]}' to group \`${args[1]}' ...`), 0)
        : 1;
    }
    const name = args[0];
    if (!name) {
      ctx.err("fatal: Only one or two names allowed.");
      return 1;
    }
    if (ctx.user !== "root") {
      ctx.err("fatal: Only root may add a user or group to the system.");
      return 1;
    }
    if (ctx.host.users[name]) {
      ctx.err(`fatal: The user \`${name}' already exists.`);
      return 1;
    }
    if (!validName(name)) {
      ctx.err(`fatal: Please enter a username matching the regular expression\nconfigured via the NAME_REGEX configuration variable.`);
      return 1;
    }
    const uid = createUser(ctx, name, true, 0o750, ["users"].filter((g) => ctx.host.groups[g]));
    ctx.out(
      [
        `info: Adding user \`${name}' ...`,
        `info: Selecting UID/GID from range 1000 to 59999 ...`,
        `info: Adding new group \`${name}' (${uid}) ...`,
        `info: Adding new user \`${name}' (${uid}) with group \`${name} (${uid})' ...`,
        `info: Creating home directory \`/home/${name}' ...`,
        `info: Copying files from \`/etc/skel' ...`,
      ].join("\n"),
    );
    ctx.prompt({ prompt: "New password: ", secret: true, data: { name, stage: "pw1" } });
    return 0;
  },
  resume(ctx, p, input) {
    const name = String(p.data.name);
    if (p.data.stage === "pw1") {
      if (!input) {
        ctx.out("No password has been supplied.");
        ctx.prompt({ prompt: "New password: ", secret: true, data: { name, stage: "pw1" } });
        return 1;
      }
      ctx.prompt({ prompt: "Retype new password: ", secret: true, data: { name, stage: "pw2", pw: input } });
      return 0;
    }
    if (p.data.stage === "pw2") {
      if (input !== p.data.pw) {
        ctx.out("Sorry, passwords do not match.\npasswd: Authentication token manipulation error\npasswd: password unchanged");
        ctx.prompt({ prompt: "New password: ", secret: true, data: { name, stage: "pw1" } });
        return 1;
      }
      ctx.host.users[name].password = input;
      ctx.out(
        [
          "passwd: password updated successfully",
          `Changing the user information for ${name}`,
          "Enter the new value, or press ENTER for the default",
          "\tFull Name []: ",
          "\tRoom Number []: ",
          "\tWork Phone []: ",
          "\tHome Phone []: ",
          "\tOther []: ",
          "Is the information correct? [Y/n] Y",
          `info: Adding new user \`${name}' to supplemental / extra groups \`users' ...`,
          `info: Adding user \`${name}' to group \`users' ...`,
        ].join("\n"),
      );
      return 0;
    }
    return 0;
  },
};

export const useradd: Command = {
  name: "useradd",
  summary: "create a user, the low level way (useradd -m -s /bin/bash NAME)",
  run(ctx) {
    const args = ctx.argv.slice(1);
    let withHome = false;
    let groupsArg: string[] = [];
    let name: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-m" || a === "--create-home") withHome = true;
      else if (a === "-s" || a === "-d" || a === "-c" || a === "-u") i++;
      else if (a === "-G") groupsArg = (args[++i] ?? "").split(",").filter(Boolean);
      else if (!a.startsWith("-")) name = a;
    }
    if (!name) {
      ctx.err("Usage: useradd [options] LOGIN");
      return 2;
    }
    if (ctx.user !== "root") {
      ctx.err("useradd: Permission denied.\nuseradd: cannot lock /etc/passwd; try again later.");
      return 1;
    }
    if (ctx.host.users[name]) {
      ctx.err(`useradd: user '${name}' already exists`);
      return 9;
    }
    for (const g of groupsArg) {
      if (!ctx.host.groups[g]) {
        ctx.err(`useradd: group '${g}' does not exist`);
        return 6;
      }
    }
    createUser(ctx, name, withHome, 0o750, groupsArg);
    ctx.info(`${name} has no password yet, so sudo will not work for them. Set one with: passwd ${name}`);
    return 0;
  },
};

export const usermod: Command = {
  name: "usermod",
  summary: "change a user (usermod -aG sudo deploy)",
  run(ctx) {
    const args = ctx.argv.slice(1);
    let append = false;
    let groupList: string[] | null = null;
    let name: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-a" || a === "--append") append = true;
      else if (a === "-aG" || a === "-Ga") {
        append = true;
        groupList = (args[++i] ?? "").split(",").filter(Boolean);
      } else if (a === "-G" || a === "--groups") groupList = (args[++i] ?? "").split(",").filter(Boolean);
      else if (a === "-L" || a === "-U") {
        /* lock/unlock: no-op */
      } else if (!a.startsWith("-")) name = a;
    }
    if (!name || !groupList) {
      ctx.err("Usage: usermod [options] LOGIN\n  -a, --append   append the user to the supplemental GROUPS\n  -G, --groups   new list of supplementary GROUPS");
      return 2;
    }
    if (ctx.user !== "root") {
      ctx.err("usermod: Permission denied.\nusermod: cannot lock /etc/passwd; try again later.");
      return 1;
    }
    if (!ctx.host.users[name]) {
      ctx.err(`usermod: user '${name}' does not exist`);
      return 6;
    }
    for (const g of groupList) {
      if (!ctx.host.groups[g]) {
        ctx.err(`usermod: group '${g}' does not exist`);
        return 6;
      }
    }
    if (!append) {
      for (const g of Object.values(ctx.host.groups)) {
        if (g.members.includes(name) && !groupList.includes(g.name)) g.members = g.members.filter((m) => m !== name);
      }
      ctx.info("Without -a, -G REPLACES all of the user's groups. Usually you want -aG.");
    }
    for (const g of groupList) {
      const grp = ctx.host.groups[g];
      if (!grp.members.includes(name)) grp.members.push(name);
    }
    return 0;
  },
};

export const passwd: Command = {
  name: "passwd",
  summary: "set a password (sudo passwd deploy)",
  run(ctx) {
    const args = ctx.argv.slice(1).filter((a) => !a.startsWith("-"));
    const name = args[0] ?? ctx.realUser;
    if (name !== ctx.realUser && ctx.user !== "root") {
      ctx.err(`passwd: You may not view or modify password information for ${name}.`);
      return 1;
    }
    if (!ctx.host.users[name]) {
      ctx.err(`passwd: user '${name}' does not exist`);
      return 1;
    }
    if (ctx.argv.includes("-l")) {
      ctx.host.users[name].password = undefined;
      ctx.out(`passwd: password changed.`);
      return 0;
    }
    ctx.prompt({ prompt: "New password: ", secret: true, data: { name, stage: "pw1" } });
    return 0;
  },
  resume(ctx, p, input) {
    const name = String(p.data.name);
    if (p.data.stage === "pw1") {
      ctx.prompt({ prompt: "Retype new password: ", secret: true, data: { name, stage: "pw2", pw: input } });
      return 0;
    }
    if (input !== p.data.pw || !input) {
      ctx.err("Sorry, passwords do not match.\npasswd: Authentication token manipulation error\npasswd: password unchanged");
      return 10;
    }
    ctx.host.users[name].password = input;
    ctx.out("passwd: password updated successfully");
    return 0;
  },
};

export const deluser: Command = {
  name: "deluser",
  summary: "remove a user",
  run(ctx) {
    const name = ctx.argv.slice(1).find((a) => !a.startsWith("-"));
    if (!name) {
      ctx.err("fatal: Only one or two names allowed.");
      return 1;
    }
    if (ctx.user !== "root") {
      ctx.err("fatal: Only root may remove a user or group from the system.");
      return 1;
    }
    if (!ctx.host.users[name] || name === "root") {
      ctx.err(`fatal: The user \`${name}' does not exist.`);
      return 2;
    }
    delete ctx.host.users[name];
    delete ctx.host.groups[name];
    for (const g of Object.values(ctx.host.groups)) g.members = g.members.filter((m) => m !== name);
    ctx.out(`info: Removing crontab ...\ninfo: Removing user \`${name}' ...\ninfo: Done.`);
    return 0;
  },
};

export const USER_COMMANDS = [adduser, useradd, usermod, passwd, deluser];
