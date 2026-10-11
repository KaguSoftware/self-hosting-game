// Every part of a command, explained plainly: the command, its sub-command, each flag,
// each value and argument, and symbols like | && > ~ and :.
// A test fails if any part of any command the game shows has no explanation.
import { FLAGS, splitCommand } from "./flags";

export interface Part {
  text: string;
  /** Plain explanation. Empty means "nobody explained this yet" (the test catches it). */
  means: string;
}

const COMMANDS: Record<string, string> = {
  sudo: "run the rest as root (the all-powerful admin). It asks for YOUR password, not root's",
  ls: "list what is in a folder",
  cd: "change directory: move into a folder",
  pwd: "print working directory: where am I right now",
  cat: "print a file's contents on the screen",
  echo: "print the text that follows",
  mkdir: "make a new folder",
  touch: "create an empty file (or update its date)",
  rm: "remove (delete) a file. There is no trash can",
  cp: "copy a file",
  mv: "move or rename a file",
  chmod: "change mode: who may read, write or run a file",
  chown: "change owner: which user and group own a file",
  nano: "open a file in nano, a simple text editor (Ctrl+O saves, Ctrl+X quits)",
  tee: "write what comes in to a file AND to the screen",
  grep: "show only the lines that contain some text",
  head: "show the first lines",
  tail: "show the last lines",
  wc: "count lines, words or bytes",
  sort: "sort lines",
  less: "read long text page by page (q quits)",
  sed: "stream editor: find and replace text",
  whoami: "print which user you are",
  id: "show a user's id number and groups",
  hostname: "print this machine's name",
  hostnamectl: "show this machine's name, operating system and more",
  uname: "show the kernel (core of the system) version",
  nproc: "count how many CPUs this machine has",
  free: "show how much memory (RAM) is used and free",
  df: "disk free: how full each disk is",
  du: "disk usage: how big folders are",
  ps: "list running programs",
  top: "a live view of busy programs (q quits)",
  htop: "a nicer live view of busy programs (q quits)",
  ss: "socket statistics: which programs listen on which ports",
  ip: "show or change network settings",
  history: "list the commands you typed before",
  clear: "clear the screen",
  exit: "leave this shell. On a server, that logs you out back to your laptop",
  logout: "log out of this shell",
  su: "switch user: become another user",
  apt: "Ubuntu's app store for the server: install and update software",
  "apt-get": "the older form of apt. Same job",
  systemctl: "control services: the programs systemd keeps running",
  service: "the older way to control services",
  journalctl: "read the logs systemd keeps for every service",
  adduser: "create a new user, asking a few friendly questions",
  useradd: "create a new user (the bare-bones version of adduser)",
  usermod: "change an existing user, for example their groups",
  passwd: "change a password",
  deluser: "delete a user",
  ufw: "uncomplicated firewall: the server's own firewall",
  ssh: "secure shell: open a terminal on another machine, safely",
  "ssh-keygen": "make a new SSH key pair (padlock + key)",
  "ssh-copy-id": "copy your public key (padlock) onto a server so you can log in with your key",
  sshd: "the SSH server program itself",
  curl: "a browser without a screen: make a web request and print the answer",
  dig: "ask DNS a question: what IP does this name point to",
  nslookup: "ask DNS a question (older tool)",
  host: "ask DNS a question, short answer",
  ping: "check if a machine answers at all",
  help: "list the commands this game knows",
  sh: "run a script file with the basic shell",
  bash: "run a script file with bash, the usual shell",
  sleep: "wait this long. Time moves on for everything",
  truncate: "cut a file down to a size. -s 0 empties it, even while a program writes to it",
  reboot: "restart the whole server",
  find: "search for files by name, age or size",
  export: "set a variable that the commands you run next will see",
  docker: "run and manage containers",
  git: "version control: track changes to code and share them",
  psql: "the Postgres command line: talk to a database",
  pg_dump: "copy a whole Postgres database into one file (a backup)",
  pg_restore: "load a pg_dump backup file into a database",
  crontab: "edit or list your scheduled jobs (cron)",
  rclone: "copy files to and from cloud storage",
  caddy: "the Caddy web server and reverse proxy",
};

const SUB: Record<string, Record<string, string>> = {
  apt: {
    update: "refresh the list of available software. Installs nothing",
    upgrade: "install newer versions of everything already installed",
    install: "install the software named next",
    remove: "uninstall the software named next",
    list: "list software",
  },
  ufw: {
    allow: "add a rule that lets traffic in",
    deny: "add a rule that blocks traffic",
    limit: "allow, but block anyone who tries too often",
    enable: "turn the firewall on (and keep it on after reboots)",
    disable: "turn the firewall off",
    status: "show whether it is on and which rules exist",
    delete: "remove a rule",
    reset: "remove every rule and turn it off",
  },
  systemctl: {
    status: "show if the service runs, since when, and its last log lines",
    start: "start the service now",
    stop: "stop the service now",
    restart: "stop it and start it again, so it reads its settings again",
    reload: "ask it to re-read its settings without stopping",
    enable: "start it automatically at every boot",
    disable: "do not start it at boot",
  },
};
SUB["apt-get"] = SUB.apt;
SUB.caddy = {
  reload: "load the Caddyfile again without stopping. Visitors notice nothing",
  validate: "check the Caddyfile for mistakes without loading it",
  version: "print Caddy's version",
  fmt: "print the Caddyfile neatly formatted",
};
SUB.git = {
  status: "show what changed since the last commit",
  add: "pick a file to go into the next commit",
  commit: "save the picked changes as one step in history",
  push: "send your commits to GitLab (this starts a pipeline)",
  log: "list past commits",
  revert: "make a new commit that undoes an old one",
  switch: "change to another branch",
};
SUB.rclone = {
  copy: "copy files from the first place to the second (it never deletes anything)",
  ls: "list the files in a bucket",
  lsd: "list the buckets",
  listremotes: "list the remotes in your rclone config",
};
SUB.ip = {
  a: "short for address: show each network card and its addresses",
  addr: "show each network card and its addresses",
  route: "show where network traffic is sent",
};

/** Flags that take the next word as their value, and what that value is. */
const FLAG_VALUE: Record<string, (v: string) => string> = {
  "journalctl -u": (v) => `the service whose logs you want: ${v}`,
  "journalctl -n": (v) => `how many lines: the last ${v}`,
  "head -n": (v) => `how many lines: ${v}`,
  "tail -n": (v) => `how many lines: ${v}`,
  "ssh-keygen -t": (v) => (v === "ed25519" ? "ed25519: the modern, short, safe kind of key" : `the kind of key: ${v}`),
  "ssh-keygen -f": (v) => `the file to save the key in: ${v}`,
  "ssh-keygen -C": () => "a comment saved in the key, usually who it belongs to",
  "ssh -i": (v) => `the private key file to use: ${v}`,
  "ssh -p": (v) => `the port to connect to: ${v}`,
  "ssh-copy-id -i": (v) => `which public key to copy: ${v}`,
  "ssh -L": (v) => {
    const [lp, h, rp] = v.split(":");
    return `laptop port ${lp} leads to ${h}${h === "127.0.0.1" ? " (as seen from the server: the server itself)" : ""} port ${rp}`;
  },
  "psql -U": (v) => `the database user: ${v}`,
  "psql -d": (v) => `the database: ${v}`,
  "psql -h": (v) => `the machine: ${v}${v === "127.0.0.1" ? " (your end of the tunnel)" : ""}`,
  "psql -p": (v) => `the port: ${v}`,
  "psql -c": () => "the statement to run, in quotes",
  "pg_dump -U": (v) => `the database user: ${v}`,
  "git -m": (v) => `the commit message: ${v}`,
  "docker login -u": (v) => `the user: ${v}${v.startsWith("gitlab+deploy-token") ? " (the deploy token's name)" : ""}`,
  "docker login -p": () => "the deploy token itself, used as the password",
  "truncate -s": (v) => (v === "0" ? "the new size: 0, so the file becomes empty" : `the new size: ${v}`),
  "pg_dump -n": (v) => `the schema: ${v}${v === "public" ? " (your own tables, not Supabase's extras)" : ""}`,
  "pg_dump -f": (v) => `the file to write: ${v}`,
  "pg_restore -h": (v) => `the machine: ${v}${v === "127.0.0.1" ? " (your end of the tunnel)" : ""}`,
  "pg_restore -p": (v) => `the port: ${v}`,
  "pg_restore -U": (v) => `the database user: ${v}`,
  "pg_restore -d": (v) => `the database to load into: ${v}`,
  "sudo -u": (v) => `the user to run as: ${v}`,
  "usermod -G": (v) => `the group: ${v}${v === "sudo" ? " (members may use sudo)" : v === "docker" ? " (members may use docker, which is as strong as root)" : ""}`,
  "useradd -G": (v) => `the extra group: ${v}`,
  "useradd -s": (v) => `the shell the user gets: ${v}`,
};

const DOCKER_SUB: Record<string, string> = {
  run: "create a new container from an image and start it",
  ps: "list containers (only running ones, unless you add -a)",
  logs: "print what a container has written to its log",
  stop: "stop a running container. It still exists, just stopped",
  start: "start a stopped container again",
  restart: "stop it and start it again",
  rm: "remove a container for good",
  images: "list the images on this server",
  pull: "download an image",
  exec: "run a command inside a container that is already running",
  build: "build an image from a Dockerfile",
  inspect: "print every detail about it, as JSON",
  login: "log in to an image registry, so pulls of private images work",
  version: "print Docker's version",
  info: "print a summary of this Docker install",
  compose: "Docker Compose: start and manage every container described in compose.yaml, together",
  volume: "work with volumes: storage that outlives containers",
  network: "work with Docker's private networks",
  system: "Docker as a whole",
};
const COMPOSE_SUB: Record<string, string> = {
  up: "create and start every service in compose.yaml. Only services whose settings changed get recreated",
  down: "stop and remove the containers and their network. Volumes stay, unless you add -v",
  ps: "list this project's containers and how they are doing",
  logs: "print the services' logs",
  restart: "restart the containers as they are. It does NOT pick up changes to .env or compose.yaml",
  exec: "run a command inside a running service's container",
  build: "build the images that have a build: section",
  pull: "download newer versions of the images",
  config: "print the final settings, with every variable filled in",
  run: "start a one-off container for a service",
  stop: "stop the services without removing them",
  start: "start stopped services again",
};
const GROUP_SUB: Record<string, string> = {
  ls: "list them",
  rm: "remove one",
  inspect: "print every detail about one",
  df: "show how much disk space Docker uses",
  prune: "delete everything unused to free disk space",
};

function imageMeaning(ref: string): string {
  const at = ref.lastIndexOf(":");
  const hasTag = at > ref.lastIndexOf("/");
  const name = hasTag ? ref.slice(0, at) : ref;
  const tag = hasTag ? ref.slice(at + 1) : "";
  return tag
    ? `the image: ${name}, version (tag) ${tag}. The part after the colon picks the version`
    : `the image: ${name}. No tag means :latest, whatever version that happens to be today`;
}

function portMap(v: string): string {
  const parts = v.split(":");
  const [ip, host, ctr] = parts.length === 3 ? parts : ["", parts[0], parts[1] ?? parts[0]];
  return `server port ${host} leads to port ${ctr} inside the container${ip ? `, but only on ${ip}${ip === "127.0.0.1" ? " (this machine only)" : ""}` : " (on every address, and Docker skips ufw)"}`;
}

const DOCKER_VALUE: Record<string, (v: string) => string> = {
  "-p": portMap,
  "-v": (v) => {
    const [src, dst] = v.split(":");
    return `${src.startsWith("/") || src.startsWith(".") ? `the server folder ${src}` : `the volume ${src}`}, shown inside the container at ${dst}`;
  },
  "-e": (v) => `sets ${v.split("=")[0]} to "${v.slice(v.indexOf("=") + 1)}" inside the container`,
  "--name": (v) => `the name you pick: ${v}`,
  "--restart": (v) => `the restart policy: ${v}`,
  "--tail": (v) => `how many lines: the last ${v}`,
  "-t": (v) => `${imageMeaning(v).replace("the image", "the name for the new image")}`,
  "-w": (v) => `the folder inside the container: ${v}`,
  "-u": (v) => `the user inside the container: ${v}`,
};

/** Explain one docker command: names, flags, values, target, and the command it runs inside. */
function explainDocker(words: string[]): Part[] {
  const sc = splitCommand(words);
  const parts: Part[] = [{ text: "docker", means: COMMANDS.docker }];
  const names = words.slice(1, sc.nameWords);
  names.forEach((n, i) => {
    const means = i === 0 ? DOCKER_SUB[n] : words[1] === "compose" ? COMPOSE_SUB[n] : GROUP_SUB[n];
    parts.push({ text: n, means: means ?? "" });
  });
  const rest = sc.rest;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (/^-{1,2}[A-Za-z]/.test(t)) {
      parts.push({ text: t, means: flagMeaning(sc.cmd, t) });
      if (sc.valueFlags.includes(t) && rest[i + 1] !== undefined) {
        const v = rest[++i];
        parts.push({ text: v, means: DOCKER_VALUE[t]?.(v) ?? "" });
      }
      continue;
    }
    let means = "";
    if (/^docker (run|pull|image rm)$/.test(sc.cmd)) means = imageMeaning(t);
    else if (sc.cmd === "docker build") means = t === "." ? "the build context: this folder. Docker sends its files to the build" : pathMeaning(t);
    else if (/^docker compose /.test(sc.cmd)) means = `only this service: ${t}`;
    else if (/^docker (volume|network) /.test(sc.cmd)) means = `the ${sc.cmd.split(" ")[1]}: ${t}`;
    else if (sc.cmd === "docker login") means = `the registry to log in to: ${t}${t === "registry.gitlab.com" ? " (GitLab's image storage)" : ""}`;
    else means = `the container: ${t}`;
    if (sc.cmd === "docker compose exec" || sc.cmd === "docker compose run") means = `the service to run it in: ${t}`;
    if (sc.cmd === "docker exec") means = `the container to run it in: ${t}`;
    parts.push({ text: t, means });
  }
  if (sc.inner?.length) {
    const inner = explainSimple(sc.inner);
    if (inner[0]) inner[0] = { ...inner[0], means: inner[0].means ? `runs inside the container: ${inner[0].means}` : "" };
    parts.push(...inner);
  }
  return parts;
}

const OPERATORS: Record<string, string> = {
  "|": "pipe: send the output of the command on the left into the command on the right",
  "&&": "and then: run the next command only if this one worked",
  "||": "or else: run the next command only if this one failed",
  ";": "then: run the next command no matter what",
  ">": "write the output into this file instead of the screen (replaces what was there)",
  ">>": "add the output to the end of this file",
  "<": "feed this file in as the command's input",
};

const FOLDERS: [RegExp, string][] = [
  [/^\/etc\/ssh\/sshd_config\.d\b/, "the folder of extra SSH server settings files, read first"],
  [/^\/etc\/ssh\/sshd_config$/, "the SSH server's main settings file"],
  [/^\/etc\b/, "/etc is where settings files live"],
  [/^\/var\/log\b/, "/var/log is where log files live"],
  [/^\/srv\/crumb\/\.env$/, "the secrets file for your app (.env, the dot hides it)"],
  [/^\/srv\b/, "/srv holds what this server serves: your apps"],
  [/^\/home\/(\w+)\/\.ssh\/authorized_keys$/, "the list of padlocks (public keys) allowed to log in as that user"],
  [/^\/home\/(\w+)\/\.ssh$/, "that user's hidden SSH folder (the dot hides it)"],
  [/^\/home\/(\w+)/, "a user's home folder"],
  [/^~\/\.ssh\/id_ed25519\.pub$/, "your public key: the padlock. Safe to share"],
  [/^~\/\.ssh\/id_ed25519$/, "your private key: never share it"],
  [/^~\/\.ssh$/, "your hidden SSH folder inside your home (~ = home, the dot hides it)"],
  [/^~/, "~ means your home folder"],
  [/^\/tmp\b/, "/tmp is for temporary files"],
  [/(^|\/)Caddyfile$/, "Caddy's settings file"],
  [/(^|\/)\.env$/, "the app's secrets file (the dot hides it)"],
  [/(^|\/)compose\.ya?ml$/, "the compose file: every service of the shop"],
  [/(^|\/)Dockerfile$/, "the recipe for the app's image"],
  [/\.sh$/, "a script: a file of commands to run in order"],
  [/\.dump$/, "a database dump: a whole database copied into one file"],
  [/\.bak$/, "a backup copy of a file"],
];

function pathMeaning(p: string): string {
  if (p === "..") return "the folder one level up";
  if (p === ".") return "this folder";
  if (p === "~") return "~ means your home folder";
  if (p === "/") return "the very top of the whole file system";
  const hit = FOLDERS.find(([re]) => re.test(p));
  const start = p.startsWith("/") ? "a path from the top of the file system (it starts with /)" : p.startsWith("~") ? "a path inside your home folder" : "a file or folder inside the current folder";
  return hit ? `${start}: ${hit[1]}` : start;
}

/** chmod numbers: 6 = read + write, 7 = read + write + run, one digit each for owner, group, everyone. */
function modeMeaning(m: string): string {
  const who = ["owner", "group", "everyone else"];
  const bits = (d: number) => {
    if (d === 0) return "nothing";
    const out = [];
    if (d & 4) out.push("read");
    if (d & 2) out.push("write");
    if (d & 1) out.push("run (or enter, for a folder)");
    return out.join(" + ");
  };
  const digits = m.slice(-3).split("").map(Number);
  return `permissions as numbers. Each digit is one person: ${digits.map((d, i) => `${who[i]} ${d} = ${bits(d)}`).join(", ")}. (read = 4, write = 2, run = 1, added up)`;
}

const PLACEHOLDERS: Record<string, string> = {
  FILE: "a placeholder: put a real file name here",
  NAME: "a placeholder: put a real name here",
  DIR: "a placeholder: put a real folder here",
  PATH: "a placeholder: put a real path here",
  URL: "a placeholder: put a real web address here",
  IP: "a placeholder: put a real IP address here",
  X: "a placeholder: put the real software name here",
  CMD: "a placeholder: put a real command here",
};

const PACKAGES: Record<string, string> = {
  ncdu: "ncdu, a tool that shows what fills your disk",
  rclone: "rclone, a tool that copies files to cloud storage",
  htop: "htop, a live view of busy programs",
  "docker-ce": "Docker, from Docker's own repository",
  caddy: "the Caddy web server",
  "postgresql-client": "the Postgres command line tools",
};

const SERVICES: Record<string, string> = {
  ssh: "the SSH server (on Ubuntu the service is called ssh, not sshd)",
  hello: "the little hello web app on port 8080",
  docker: "the Docker engine",
  cron: "the scheduler that runs jobs on a timetable",
  ufw: "the firewall",
};

function argMeaning(cmd: string, sub: string | undefined, a: string, prev: string[]): string {
  if (PLACEHOLDERS[a]) return PLACEHOLDERS[a];
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) return `sets ${a.split("=")[0]} to "${a.slice(a.indexOf("=") + 1)}" just for this command`;
  if (/^\$\(/.test(a)) {
    const inner = a.slice(2, -1).trim();
    return `runs ${inner.split(/\s+/).slice(0, 2).join(" ")} first and puts what it prints right here${/LogPath/.test(inner) ? ": the path of the container's log file" : /date/.test(inner) ? ": today's date" : ""}`;
  }
  if (/^\$\{?\w+/.test(a)) return `the value of the variable ${a.replace(/[${}]/g, "")}`;
  if (cmd === "rclone" && /^[\w-]+:/.test(a)) {
    const [remote, ...rest] = a.split(":");
    return `the remote called ${remote} (set up in rclone.conf)${rest.join(":") ? `, bucket ${rest.join(":")}` : ""}`;
  }
  if (cmd === "truncate" && a.startsWith("/var/lib/docker/")) return "a container's log file on the server";
  if (/^["']?postgres(ql)?:\/\//.test(a)) return "a connection string: user, password, machine, port and database in one line (in quotes so the shell leaves it alone)";
  if (cmd === "sed" && /^(['"])s(.)/.test(a)) {
    const d = a[2];
    const [, from, to] = a.slice(1, -1).split(d);
    return `the edit, in quotes so the shell leaves it alone: s${d}OLD${d}NEW${d} means swap "${from}" for "${to}" (the first one on each line)`;
  }
  if (/^(['"]).*\1$/.test(a)) return "text in quotes, kept together as one piece";
  const userHost = /^([\w.-]+)@([\w.-]+)$/.exec(a);
  if (userHost) return `log in as the user ${userHost[1]} on the machine ${userHost[2]}`;
  const url = /^(https?):\/\/([^/:]+)(?::(\d+))?/.exec(a);
  if (url) {
    const port = url[3] ? `, port ${url[3]}` : url[1] === "https" ? " (port 443)" : " (port 80)";
    return `the web address to ask: ${url[1] === "https" ? "https = encrypted" : "http = plain, not encrypted"}, the machine ${url[2]}${port}`;
  }
  const hostPort = /^(localhost|[\d.]+):(\d+)$/.exec(a);
  if (hostPort) return `${hostPort[1] === "localhost" ? "localhost = this same machine" : `the machine ${hostPort[1]}`}, port ${hostPort[2]}`;
  if (cmd === "chown") {
    const ug = /^(\w+):(\w+)$/.exec(a);
    if (ug) return `owner:group. Left of the colon is the new owner (${ug[1]}), right is the new group (${ug[2]})`;
  }
  if (cmd === "chmod") {
    if (/^[0-7]{3,4}$/.test(a)) return modeMeaning(a);
    if (/^[ugoa]*[+\-=][rwx]+$/.test(a)) return `${a.includes("+") ? "add" : a.includes("-") ? "remove" : "set"} permission ${a.replace(/^[ugoa]*[+\-=]/, "")}${a.includes("x") ? " (x = may be run as a program)" : ""}`;
  }
  if (cmd === "ufw") {
    if (a === "OpenSSH") return "the SSH profile: port 22. The capital letters matter";
    const ports = /^([\d,]+)(?:\/(tcp|udp))?$/.exec(a);
    if (ports) {
      const list = ports[1].split(",");
      return `port${list.length > 1 ? "s" : ""} ${list.join(" and ")}${ports[2] ? `, ${ports[2]} only (${ports[2] === "tcp" ? "web and SSH traffic use TCP" : "UDP traffic"})` : ""}`;
    }
  }
  if (cmd === "dig" && a === "+short") return "print just the answer, not the whole report";
  if ((cmd === "systemctl" || cmd === "service") && /^[\w.-]+$/.test(a)) return `the service to act on: ${SERVICES[a] ?? a}`;
  if ((cmd === "apt" || cmd === "apt-get") && sub === "install") return `the software to install: ${PACKAGES[a] ?? a}`;
  if (cmd === "grep" && !a.startsWith("-")) return `the text to look for: "${a}"`;
  if (cmd === "su" && /^\w+$/.test(a)) return `the user to become: ${a}`;
  if ((cmd === "adduser" || cmd === "useradd") && /^\w+$/.test(a)) return `the new user's name: ${a}`;
  if ((cmd === "usermod" || cmd === "id" || cmd === "passwd" || cmd === "deluser") && /^\w+$/.test(a)) return `the user: ${a}`;
  if (["dig", "nslookup", "host", "ping"].includes(cmd) && /^[\w.-]+$/.test(a)) return `the name to look up: ${a}`;
  if (cmd === "echo") return "the text to print";
  if (cmd === "git" && sub === "add") return pathMeaning(a);
  if (cmd === "git" && sub === "revert" && a === "HEAD") return "HEAD: the newest commit on this branch";
  if (cmd === "pg_dump" && /^\w+$/.test(a)) return `the database to copy: ${a}`;
  if (cmd === "sleep" && /^\d+[smh]?$/.test(a)) return `how long to wait: ${a}`;
  if (/^[~/.]/.test(a) || a.includes("/") || /\.\w+$/.test(a)) return pathMeaning(a);
  if (["ls", "cd", "cat", "rm", "mkdir", "touch", "nano", "less", "head", "tail", "cp", "mv", "sed", "grep", "sh", "bash"].includes(cmd) && /^[\w.-]+$/.test(a)) return pathMeaning(a);
  void prev;
  return "";
}

function flagMeaning(cmd: string, flag: string): string {
  if (flag.startsWith("--") && flag.includes("=")) {
    const [f, v] = [flag.slice(0, flag.indexOf("=")), flag.slice(flag.indexOf("=") + 1)];
    const m = flagMeaning(cmd, f);
    return m ? `${m} (here: ${v})` : "";
  }
  const exact = FLAGS.find((f) => f.cmd === cmd && f.flag === flag);
  if (exact) return exact.means;
  if (/^-[A-Za-z]{2,}$/.test(flag)) {
    const parts = flag
      .slice(1)
      .split("")
      .map((ch) => FLAGS.find((f) => f.cmd === cmd && f.flag === `-${ch}`));
    if (parts.every(Boolean)) return parts.map((p) => `${p!.flag} = ${p!.means}`).join("; ");
  }
  return "";
}

/** Split into words, keeping quoted text together and operators separate. */
function words(line: string): string[] {
  const out: string[] = [];
  // a|b|c with no spaces is cheat sheet notation for "one of these", not a pipe.
  const re = /\s*(\$\([^)]*\)|"[^"]*"|'[^']*'|\w+(?:\|\w+)+(?=\s|$)|&&|\|\||>>|[|;<>]|[^\s|;<>]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) if (m[1]) out.push(m[1]);
  return out;
}

export function explainLine(line: string): Part[] {
  const parts: Part[] = [];
  const toks = words(line.trim());
  let i = 0;
  while (i < toks.length) {
    // one simple command
    if (OPERATORS[toks[i]]) {
      const op = toks[i];
      parts.push({ text: op, means: OPERATORS[op] });
      i++;
      if ((op === ">" || op === ">>" || op === "<") && toks[i]) {
        parts.push({ text: toks[i], means: pathMeaning(toks[i]) });
        i++;
      }
      continue;
    }
    while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) {
      parts.push({ text: toks[i], means: argMeaning("", undefined, toks[i], []) });
      i++;
    }
    if (toks[i] === "sudo") {
      parts.push({ text: "sudo", means: COMMANDS.sudo });
      i++;
      while (toks[i]?.startsWith("-")) {
        const f = toks[i];
        parts.push({ text: f, means: flagMeaning("sudo", f) });
        i++;
        if (f === "-u" && toks[i]) {
          parts.push({ text: toks[i], means: FLAG_VALUE["sudo -u"](toks[i]) });
          i++;
        }
      }
    }
    const seg: string[] = [];
    while (i < toks.length && !OPERATORS[toks[i]]) seg.push(toks[i++]);
    if (!seg.length) break;
    parts.push(...explainSimple(seg));
  }
  return parts;
}

/** One simple command (no operators, no sudo): the command, sub-command, flags, values, arguments. */
function explainSimple(toks: string[]): Part[] {
  if (toks[0] === "docker") return explainDocker(toks);
  const parts: Part[] = [];
  let i = 0;
  {
    const cmd = toks[i];
    if (!cmd) return parts;
    const script = /^\.?\.?\//.test(cmd) ? `run the script ${cmd}. ./ means "in this folder", and it needs the x (run) permission` : "";
    parts.push({ text: cmd, means: COMMANDS[cmd] ?? script ?? "" });
    if (!COMMANDS[cmd] && !script && PLACEHOLDERS[cmd]) parts[parts.length - 1].means = PLACEHOLDERS[cmd];
    i++;
    let sub: string | undefined;
    const alts = toks[i]?.includes("|") ? toks[i].split("|") : null;
    if (SUB[cmd] && alts && alts.every((a) => SUB[cmd][a])) {
      sub = alts[0];
      parts.push({ text: toks[i], means: `one of these: ${alts.map((a) => `${a} = ${SUB[cmd][a]}`).join("; ")}` });
      i++;
    } else if (SUB[cmd] && toks[i] && SUB[cmd][toks[i]]) {
      sub = toks[i];
      parts.push({ text: sub, means: SUB[cmd][sub] });
      i++;
    }
    const seen: string[] = [];
    while (i < toks.length) {
      const t = toks[i];
      if (/^-{1,2}[A-Za-z]/.test(t) || t === "-") {
        parts.push({ text: t, means: flagMeaning(cmd, t) });
        i++;
        // A flag that takes a value: the last letter of a group decides (-aG sudo).
        const last = t.startsWith("--") ? t : `-${t.slice(-1)}`;
        const val = FLAG_VALUE[`${cmd} ${last}`];
        if (val && toks[i]) {
          parts.push({ text: toks[i], means: val(toks[i]) });
          i++;
        }
        continue;
      }
      parts.push({ text: t, means: argMeaning(cmd, sub, t, seen) });
      seen.push(t);
      i++;
    }
  }
  return parts;
}

/** Does this line look like a command (not an answer to a prompt like "yes" or a password)? */
export function looksLikeCommand(line: string): boolean {
  const first = words(line.trim()).find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  return !!first && (first === "sudo" || !!COMMANDS[first]);
}
