import { getDir, getFile } from "./fs";
import type { Host } from "./types";
import { globMatch } from "./util";

const KNOWN = new Set([
  "port",
  "listenaddress",
  "permitrootlogin",
  "pubkeyauthentication",
  "passwordauthentication",
  "permitemptypasswords",
  "kbdinteractiveauthentication",
  "challengeresponseauthentication",
  "usepam",
  "x11forwarding",
  "printmotd",
  "acceptenv",
  "subsystem",
  "include",
  "authorizedkeysfile",
  "strictmodes",
  "maxauthtries",
  "allowusers",
  "allowgroups",
  "denyusers",
  "clientaliveinterval",
  "clientalivecountmax",
  "logingracetime",
  "loglevel",
  "match",
  "allowtcpforwarding",
  "hostkey",
  "maxsessions",
  "banner",
]);

const DEFAULTS: Record<string, string> = {
  port: "22",
  permitrootlogin: "prohibit-password",
  pubkeyauthentication: "yes",
  passwordauthentication: "yes",
  permitemptypasswords: "no",
  kbdinteractiveauthentication: "yes",
  usepam: "no",
  strictmodes: "yes",
  maxauthtries: "6",
  x11forwarding: "no",
  authorizedkeysfile: ".ssh/authorized_keys .ssh/authorized_keys2",
  allowtcpforwarding: "yes",
  logingracetime: "120",
};

const YESNO = ["yes", "no"];
const VALUES: Record<string, string[]> = {
  permitrootlogin: ["yes", "no", "prohibit-password", "without-password", "forced-commands-only"],
  pubkeyauthentication: YESNO,
  passwordauthentication: YESNO,
  permitemptypasswords: YESNO,
  kbdinteractiveauthentication: YESNO,
  usepam: YESNO,
  strictmodes: YESNO,
  x11forwarding: YESNO,
  printmotd: YESNO,
};

export interface SshdLine {
  file: string;
  line: number;
  key: string;
  value: string;
}

export interface SshdParse {
  lines: SshdLine[];
  errors: string[];
}

function parseFile(host: Host, path: string, out: SshdParse, depth: number): void {
  const f = getFile(host, path);
  if (!f) return;
  const rows = f.content.split("\n");
  let inMatch = false;
  rows.forEach((raw, i) => {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) return;
    const m = /^(\S+)\s*(=\s*)?(.*)$/.exec(line);
    if (!m) return;
    const key = m[1].toLowerCase();
    const value = m[3].trim();
    if (!KNOWN.has(key)) {
      out.errors.push(`${path}: line ${i + 1}: Bad configuration option: ${m[1]}`);
      return;
    }
    if (key === "match") {
      inMatch = true;
      return;
    }
    if (inMatch) return; // Match blocks only apply to matching clients. Ignored for globals.
    if (VALUES[key] && !VALUES[key].includes(value.toLowerCase())) {
      out.errors.push(`${path} line ${i + 1}: unsupported option "${value}".`);
      return;
    }
    if (!value) {
      out.errors.push(`${path} line ${i + 1}: missing argument.`);
      return;
    }
    if (key === "include") {
      if (depth > 3) return;
      const pattern = value.startsWith("/") ? value : `/etc/ssh/${value}`;
      const slash = pattern.lastIndexOf("/");
      const dirPath = pattern.slice(0, slash);
      const glob = pattern.slice(slash + 1);
      const d = getDir(host, dirPath);
      if (!d) return;
      for (const name of Object.keys(d.children).sort()) {
        if (globMatch(glob, name)) parseFile(host, `${dirPath}/${name}`, out, depth + 1);
      }
      return;
    }
    out.lines.push({ file: path, line: i + 1, key, value });
  });
}

export function parseSshd(host: Host): SshdParse {
  const out: SshdParse = { lines: [], errors: [] };
  parseFile(host, "/etc/ssh/sshd_config", out, 0);
  return out;
}

/** sshd rule: for most keywords the FIRST value found wins. */
export function effectiveSshd(host: Host): Record<string, string> {
  const eff: Record<string, string> = { ...DEFAULTS };
  const seen = new Set<string>();
  for (const l of parseSshd(host).lines) {
    if (seen.has(l.key)) continue;
    seen.add(l.key);
    eff[l.key] = VALUES[l.key] ? l.value.toLowerCase() : l.value;
  }
  return eff;
}

/** Where did the winning value for a key come from. */
export function sshdSource(host: Host, key: string): SshdLine | undefined {
  return parseSshd(host).lines.find((l) => l.key === key.toLowerCase());
}

export function loadSshdConfig(host: Host): Record<string, string> {
  return effectiveSshd(host);
}

/** The config the RUNNING sshd uses (snapshot from last restart/reload). */
export function runningSshd(host: Host): Record<string, string> {
  return host.services.ssh?.loaded ?? effectiveSshd(host);
}

const T_ORDER = [
  "port",
  "permitrootlogin",
  "pubkeyauthentication",
  "passwordauthentication",
  "kbdinteractiveauthentication",
  "permitemptypasswords",
  "usepam",
  "strictmodes",
  "maxauthtries",
  "x11forwarding",
  "authorizedkeysfile",
  "allowtcpforwarding",
  "logingracetime",
];

/** Output of `sshd -T`. */
export function sshdDump(host: Host): string {
  const eff = effectiveSshd(host);
  const keys = [...T_ORDER, ...Object.keys(eff).filter((k) => !T_ORDER.includes(k)).sort()];
  return keys.filter((k) => eff[k] !== undefined && k !== "include").map((k) => `${k} ${eff[k]}`).join("\n");
}
