// Plain-English meaning of every command option ("flag") the game uses.
// Flags are the "-h", "-la", "--now" bits after a command.
// A test checks that every flag used anywhere in the content is listed here.

export interface FlagInfo {
  cmd: string;
  flag: string;
  means: string;
}

export const FLAGS: FlagInfo[] = [
  { cmd: "ls", flag: "-l", means: "long list: one line per item, with owner, size and date" },
  { cmd: "ls", flag: "-a", means: "all: also show hidden files (names that start with a dot)" },
  { cmd: "ls", flag: "-A", means: "almost all: hidden files too, but not . and .." },
  { cmd: "ls", flag: "-h", means: "human-friendly sizes (K, M, G instead of raw bytes)" },
  { cmd: "free", flag: "-h", means: "human-friendly sizes: GB and MB instead of raw bytes" },
  { cmd: "df", flag: "-h", means: "human-friendly sizes: GB and MB instead of raw bytes" },
  { cmd: "curl", flag: "-I", means: "ask only for the short status summary, not the whole page" },
  { cmd: "curl", flag: "-v", means: "verbose: show every step of the conversation with the server" },
  { cmd: "curl", flag: "-s", means: "silent: hide the progress bar" },
  { cmd: "curl", flag: "-L", means: "follow redirects to the final page" },
  { cmd: "curl", flag: "-i", means: "include the status summary above the page" },
  { cmd: "ssh", flag: "-v", means: "verbose: print every step of the login, great for debugging" },
  { cmd: "ssh", flag: "-i", means: "use this key file instead of the default one" },
  { cmd: "ssh", flag: "-p", means: "connect to this port instead of 22" },
  { cmd: "ssh", flag: "-o", means: "set one SSH option just for this login" },
  { cmd: "ssh-keygen", flag: "-t", means: "type of key to make (ed25519 is the modern choice)" },
  { cmd: "ssh-keygen", flag: "-C", means: "a comment saved in the key, usually who it belongs to" },
  { cmd: "ssh-keygen", flag: "-f", means: "the file to save the key in" },
  { cmd: "ssh-keygen", flag: "-N", means: "the passphrase, given right away" },
  { cmd: "ssh-copy-id", flag: "-i", means: "which public key to copy" },
  { cmd: "usermod", flag: "-a", means: "add (append): keep the user's other groups" },
  { cmd: "usermod", flag: "-G", means: "the group list. Without -a it REPLACES all groups" },
  { cmd: "useradd", flag: "-m", means: "make a home folder for the user" },
  { cmd: "useradd", flag: "-s", means: "the shell the user gets (usually /bin/bash)" },
  { cmd: "useradd", flag: "-G", means: "extra groups for the new user" },
  { cmd: "journalctl", flag: "-u", means: "unit: only this service's logs" },
  { cmd: "journalctl", flag: "-n", means: "only the last N lines" },
  { cmd: "journalctl", flag: "-f", means: "follow: keep printing new lines as they come" },
  { cmd: "journalctl", flag: "-x", means: "add short explanations to some lines" },
  { cmd: "journalctl", flag: "-e", means: "jump to the end (newest lines)" },
  { cmd: "apt", flag: "-y", means: "answer yes to every question automatically" },
  { cmd: "apt", flag: "--upgradable", means: "with apt list: only software that has a newer version waiting" },
  { cmd: "apt-get", flag: "-y", means: "answer yes to every question automatically" },
  { cmd: "sshd", flag: "-t", means: "test the settings for mistakes, then stop" },
  { cmd: "sshd", flag: "-T", means: "print the settings sshd will REALLY use, after all files are read" },
  { cmd: "ss", flag: "-t", means: "TCP connections (web, SSH, databases)" },
  { cmd: "ss", flag: "-u", means: "UDP connections" },
  { cmd: "ss", flag: "-l", means: "listening: programs waiting for visitors" },
  { cmd: "ss", flag: "-n", means: "numbers: show 22, not the name ssh" },
  { cmd: "ss", flag: "-p", means: "program: which program owns each port (needs sudo)" },
  { cmd: "systemctl", flag: "--now", means: "also do it right now, not just at the next boot" },
  { cmd: "chown", flag: "-R", means: "recursive: the folder and everything inside it" },
  { cmd: "chmod", flag: "-R", means: "recursive: the folder and everything inside it" },
  { cmd: "mkdir", flag: "-p", means: "make missing parent folders too, and do not complain if it exists" },
  { cmd: "rm", flag: "-r", means: "recursive: delete a folder and everything inside it" },
  { cmd: "rm", flag: "-f", means: "force: do not ask, do not complain if missing" },
  { cmd: "cp", flag: "-r", means: "recursive: copy a folder and everything inside it" },
  { cmd: "cp", flag: "-a", means: "archive: copy everything and keep owners and dates" },
  { cmd: "grep", flag: "-i", means: "ignore case: Password and password both match" },
  { cmd: "grep", flag: "-n", means: "show line numbers" },
  { cmd: "grep", flag: "-v", means: "invert: show the lines that do NOT match" },
  { cmd: "grep", flag: "-c", means: "count matching lines instead of printing them" },
  { cmd: "head", flag: "-n", means: "how many lines to show" },
  { cmd: "tail", flag: "-n", means: "how many lines to show (from the end)" },
  { cmd: "tail", flag: "-f", means: "follow: keep printing new lines as they come" },
  { cmd: "sudo", flag: "-i", means: "become root in a full login shell, until you type exit" },
  { cmd: "sudo", flag: "-u", means: "run as this user instead of root" },
  { cmd: "su", flag: "-", means: "log in fully as that user: their home folder and settings" },
  { cmd: "uname", flag: "-a", means: "all: kernel version, machine and more" },
  { cmd: "hostname", flag: "-I", means: "print this machine's IP addresses" },
  { cmd: "wc", flag: "-l", means: "count lines" },
  { cmd: "tee", flag: "-a", means: "append: add to the end of the file instead of replacing it" },
  { cmd: "passwd", flag: "-l", means: "lock: switch password login off for that user" },
  { cmd: "psql", flag: "-U", means: "user: which database user to log in as" },
  { cmd: "psql", flag: "-d", means: "database: which database to open" },
  { cmd: "psql", flag: "-c", means: "command: run this one statement, then quit" },
  { cmd: "psql", flag: "-h", means: "host: which machine to connect to" },
  { cmd: "psql", flag: "-p", means: "port: which port Postgres listens on there" },
  { cmd: "pg_dump", flag: "-Fc", means: "format custom: one compact file that pg_restore reads" },
  { cmd: "pg_dump", flag: "-n", means: "only this schema (public holds your own tables)" },
  { cmd: "pg_dump", flag: "-f", means: "the file to write the dump into" },
  { cmd: "pg_restore", flag: "--no-owner", means: "do not try to give tables to their old owners (those roles do not exist here)" },
  { cmd: "pg_restore", flag: "--no-acl", means: "skip the old permission grants (also for roles that do not exist here)" },
  { cmd: "pg_restore", flag: "-h", means: "host: which machine to connect to" },
  { cmd: "pg_restore", flag: "-p", means: "port: which port Postgres listens on there" },
  { cmd: "pg_restore", flag: "-U", means: "user: which database user to log in as" },
  { cmd: "pg_restore", flag: "-d", means: "database: which database to load the data into" },
  { cmd: "ssh", flag: "-N", means: "no command: only keep the connection open (for a tunnel)" },
  { cmd: "ssh", flag: "-L", means: "local forward: LAPTOP_PORT:HOST:PORT, a tunnel from your laptop to there" },
  { cmd: "sed", flag: "-i", means: "in place: change the file itself instead of printing the result" },
  { cmd: "sed", flag: "-E", means: "extended patterns: write ( ) + ? without backslashes" },
  { cmd: "curl", flag: "-f", means: "fail: treat an error page as an error instead of saving it" },
  { cmd: "curl", flag: "-S", means: "show errors, even when -s keeps everything else quiet" },
  { cmd: "curl", flag: "-o", means: "output: save what you download into this file" },
  // Docker flags depend on the sub-command: -v in "docker run" attaches storage, in "docker compose down" it deletes it.
  { cmd: "docker run", flag: "-d", means: "detached: run in the background and give your terminal back" },
  { cmd: "docker run", flag: "-p", means: "publish a port, HOST:CONTAINER, so visitors to the server reach the container" },
  { cmd: "docker run", flag: "--name", means: "give the container a name you choose (otherwise Docker makes one up)" },
  { cmd: "docker run", flag: "--rm", means: "delete the container as soon as it stops" },
  { cmd: "docker run", flag: "-e", means: "environment variable: set NAME=value inside the container" },
  { cmd: "docker run", flag: "-v", means: "volume: attach storage, NAME:PATH, so data survives the container" },
  { cmd: "docker run", flag: "--restart", means: "restart policy: when Docker should start it again by itself" },
  { cmd: "docker run", flag: "-i", means: "interactive: keep the input open so you can type into it" },
  { cmd: "docker run", flag: "-t", means: "terminal: give it a proper terminal screen" },
  { cmd: "docker ps", flag: "-a", means: "all: also show stopped containers" },
  { cmd: "docker logs", flag: "-f", means: "follow: keep printing new lines as they come" },
  { cmd: "docker logs", flag: "--tail", means: "only the last N lines" },
  { cmd: "docker exec", flag: "-i", means: "interactive: keep the input open so you can type into it" },
  { cmd: "docker exec", flag: "-t", means: "terminal: give it a proper terminal screen" },
  { cmd: "docker rm", flag: "-f", means: "force: stop it first if it is still running" },
  { cmd: "docker build", flag: "-t", means: "tag: the name (and version after a colon) for the new image" },
  { cmd: "docker compose up", flag: "-d", means: "detached: start everything in the background and give your terminal back" },
  { cmd: "docker compose up", flag: "--build", means: "build images from their Dockerfile first, so code changes are included" },
  { cmd: "docker compose down", flag: "-v", means: "also delete the volumes. Your data is gone for good" },
  { cmd: "docker compose logs", flag: "-f", means: "follow: keep printing new lines as they come" },
  { cmd: "docker compose logs", flag: "--tail", means: "only the last N lines" },
  { cmd: "docker compose exec", flag: "-T", means: "no terminal: needed in scripts and cron, where nobody is typing" },
  { cmd: "docker compose exec", flag: "-w", means: "work directory: run the command inside this folder in the container" },
];

/** First words that have flags: "docker compose up" counts as "docker". */
const COMMANDS = new Set(FLAGS.map((f) => f.cmd.split(" ")[0]));

/** Docker sub-commands that take a second word: docker volume ls, docker system df. */
const DOCKER_GROUPS = new Set(["compose", "volume", "network", "system", "image", "container"]);
/** Flags that eat the next word as their value, per (sub-)command. */
const TAKES_VALUE: Record<string, string[]> = {
  "docker run": ["--name", "-e", "-v", "-p", "--network", "--restart", "-w", "-u", "--env-file"],
  "docker exec": ["-w", "-u", "-e"],
  "docker build": ["-t", "-f"],
  "docker logs": ["--tail", "-n"],
  "docker compose logs": ["--tail", "-n"],
  "docker compose exec": ["-w", "-u", "-e"],
  "docker compose run": ["-w", "-u", "-e"],
};

export interface SplitCommand {
  /** "ls", or "docker run", or "docker compose up" */
  cmd: string;
  /** How many words the command name used. */
  nameWords: number;
  /** Words after the name (flags, values, arguments), up to any inner command. */
  rest: string[];
  /** docker exec db psql -U crumb: the command run inside the container ("psql -U crumb"). */
  inner?: string[];
  /** Flags in `rest` that take the next word as a value. */
  valueFlags: string[];
}

/** Work out which command a run of words is, so flags are looked up in the right place. */
export function splitCommand(words: string[]): SplitCommand {
  if (words[0] !== "docker" || !words[1] || words[1].startsWith("-")) {
    return { cmd: words[0] ?? "", nameWords: 1, rest: words.slice(1), valueFlags: [] };
  }
  let n = 2;
  let cmd = `docker ${words[1]}`;
  if (DOCKER_GROUPS.has(words[1]) && words[2] && !words[2].startsWith("-")) {
    cmd += ` ${words[2]}`;
    n = 3;
  }
  const valueFlags = TAKES_VALUE[cmd] ?? [];
  const rest = words.slice(n);
  const runsInside = /^docker (compose )?(run|exec)$/.test(cmd);
  if (!runsInside) return { cmd, nameWords: n, rest, valueFlags };
  // After the flags, the first plain word is the image or service. Everything after it runs inside.
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    if (w.startsWith("-")) {
      if (valueFlags.includes(w)) i++;
      continue;
    }
    return { cmd, nameWords: n, rest: rest.slice(0, i + 1), inner: rest.slice(i + 1), valueFlags };
  }
  return { cmd, nameWords: n, rest, valueFlags };
}

export function flagKey(cmd: string, flag: string): string {
  return `${cmd} ${flag}`;
}

export interface FlagNote {
  /** e.g. "ls -la" */
  key: string;
  cmd: string;
  flag: string;
  /** Explanation; combined flags are split into letters. */
  parts: { flag: string; means: string }[];
}

function lookup(cmd: string, flag: string): { flag: string; means: string }[] | null {
  const exact = FLAGS.find((f) => f.cmd === cmd && f.flag === flag);
  if (exact) return [{ flag, means: exact.means }];
  // -la = -l + -a ; -aG = -a + -G
  if (/^-[A-Za-z]{2,}$/.test(flag)) {
    const parts = flag
      .slice(1)
      .split("")
      .map((ch) => FLAGS.find((f) => f.cmd === cmd && f.flag === `-${ch}`));
    if (parts.every(Boolean)) return parts.map((p) => ({ flag: p!.flag, means: p!.means }));
  }
  return null;
}

/** Split a command line into simple commands: "a && b | c" -> ["a", "b", "c"]. */
function segments(line: string): string[][] {
  return line
    .split(/&&|\|\||\||;/)
    .map((s) => s.trim().split(/\s+/).filter(Boolean))
    .filter((t) => t.length);
}

/** Flags in one command line, with their meanings. Unknown flags come back with empty parts. */
export function flagsIn(line: string): FlagNote[] {
  const out: FlagNote[] = [];
  const queue = segments(line);
  while (queue.length) {
    let words = queue.shift()!;
    while (words[0] === "sudo" && !(words[1]?.startsWith("-"))) words = words.slice(1);
    if (!words[0]) continue;
    const sc = splitCommand(words);
    for (let i = 0; i < sc.rest.length; i++) {
      const w = sc.rest[i];
      if (!/^-{1,2}[A-Za-z]/.test(w) && w !== "-") continue;
      out.push({ key: flagKey(sc.cmd, w), cmd: sc.cmd, flag: w, parts: lookup(sc.cmd, w) ?? [] });
      if (sc.valueFlags.includes(w)) i++;
    }
    if (sc.inner?.length) queue.unshift(sc.inner);
  }
  return out;
}

/** Find "cmd -flag" mentions inside prose, like an intel line. */
export function flagsInProse(text: string): FlagNote[] {
  const out: FlagNote[] = [];
  const re = /(?:^|[\s(`"'])([a-z][a-z-]*)(?=\s)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const cmd = m[1];
    if (!COMMANDS.has(cmd)) continue;
    const start = m.index + m[0].length - cmd.length;
    // "journalctl -u ssh -n 30": here ssh is an argument of -u, not a command.
    if (/-{1,2}[A-Za-z][\w-]*\s+$/.test(text.slice(0, start))) continue;
    // Cheat-sheet notation: "status|start|enable" means "one of these", and " / " separates commands.
    const clause = text
      .slice(start)
      .split(/[.,;:()"'`→]|\s{2,}| then | and | or | \/ /)[0]
      .replace(/(\w)\|(\w)/g, "$1/$2");
    out.push(...flagsIn(clause));
  }
  return out;
}

export function describeFlag(n: FlagNote): string {
  return n.parts.map((p) => `${p.flag} = ${p.means}`).join("; ");
}
