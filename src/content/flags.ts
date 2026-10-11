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
];

const COMMANDS = new Set(FLAGS.map((f) => f.cmd));

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
  for (let words of segments(line)) {
    while (words[0] === "sudo" && !(words[1]?.startsWith("-"))) words = words.slice(1);
    const cmd = words[0];
    if (!cmd) continue;
    for (const w of words.slice(1)) {
      if (!/^-{1,2}[A-Za-z]/.test(w) && w !== "-") continue;
      out.push({ key: flagKey(cmd, w), cmd, flag: w, parts: lookup(cmd, w) ?? [] });
    }
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
