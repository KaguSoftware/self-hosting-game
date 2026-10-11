import type { UfwRule } from "../../types";
import { pad } from "../../util";
import type { Command, Ctx } from "../ctx";

const APPS: Record<string, { port: number; proto: "tcp" }> = {
  OpenSSH: { port: 22, proto: "tcp" },
};
const SERVICES: Record<string, number> = { ssh: 22, http: 80, https: 443, postgresql: 5432 };

/** Parse "OpenSSH", "22", "80/tcp", "443", "http", or extended "from any to any port 80 proto tcp". */
function parseSpec(words: string[]): { rules: UfwRule[]; error?: string } {
  if (!words.length) return { rules: [], error: "ERROR: Wrong number of arguments" };
  if (words[0] === "proto" || words[0] === "from" || words[0] === "in") {
    const pi = words.indexOf("port");
    const port = pi >= 0 ? Number(words[pi + 1]) : NaN;
    const proto = (words[words.indexOf("proto") + 1] as "tcp" | "udp") ?? "any";
    if (!Number.isInteger(port)) return { rules: [], error: "ERROR: Need a port. Example: ufw allow from any to any port 443 proto tcp" };
    return { rules: [{ port, proto: words.includes("proto") ? proto : "any", action: "allow", label: `${port}${words.includes("proto") ? "/" + proto : ""}` }] };
  }
  const spec = words[0];
  if (APPS[spec]) return { rules: [{ port: APPS[spec].port, proto: "tcp", action: "allow", label: spec }] };
  if (/^openssh$/i.test(spec)) return { rules: [], error: `ERROR: Could not find a profile matching '${spec}'. Profile names are case sensitive: OpenSSH` };
  const m = /^([\w,:-]+)(?:\/(tcp|udp))?$/.exec(spec);
  if (!m) return { rules: [], error: `ERROR: Bad port` };
  const proto = (m[2] as "tcp" | "udp" | undefined) ?? "any";
  const ports = m[1].split(",");
  if (ports.length > 1 && proto === "any") return { rules: [], error: "ERROR: Must specify 'tcp' or 'udp' with multiple ports" };
  const rules: UfwRule[] = [];
  for (const p of ports) {
    const n = SERVICES[p] ?? Number(p);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return { rules: [], error: `ERROR: Bad port` };
    const label = SERVICES[p] ? p : ports.length > 1 ? `${n}/${proto}` : `${n}${proto !== "any" ? "/" + proto : ""}`;
    rules.push({ port: n, proto: SERVICES[p] ? "any" : proto, action: "allow", label });
  }
  return { rules };
}

function needRoot(ctx: Ctx): boolean {
  if (ctx.user === "root") return true;
  ctx.err("ERROR: You need to be root to run this script");
  return false;
}

function statusTable(ctx: Ctx, numbered: boolean, verbose: boolean): string {
  const ufw = ctx.host.ufw;
  if (!ufw.enabled) return "Status: inactive";
  const lines = ["Status: active"];
  if (verbose) {
    lines.push("Logging: on (low)", `Default: ${ufw.defaultIncoming} (incoming), allow (outgoing), deny (routed)`, "New profiles: skip");
  }
  lines.push("");
  if (!ufw.rules.length) return lines.join("\n");
  const action = (r: UfwRule) => (r.action.toUpperCase() + (verbose || numbered ? " IN" : "")).padEnd(numbered || verbose ? 12 : 12);
  lines.push(`${numbered ? "     " : ""}To                         Action      From`, `${numbered ? "     " : ""}--                         ------      ----`);
  const all = [...ufw.rules.map((r) => ({ r, v6: false })), ...ufw.rules.map((r) => ({ r, v6: true }))];
  all.forEach(({ r, v6 }, i) => {
    const to = r.label + (v6 ? " (v6)" : "");
    lines.push(`${numbered ? `[${String(i + 1).padStart(2)}] ` : ""}${pad(to, 27)}${action(r)}Anywhere${v6 ? " (v6)" : ""}`);
  });
  return lines.join("\n");
}

export const ufw: Command = {
  name: "ufw",
  summary: "the firewall (sudo ufw allow OpenSSH, sudo ufw enable)",
  run(ctx) {
    const args = ctx.argv.slice(1);
    const sub = args[0];
    const fw = ctx.host.ufw;
    if (!sub) {
      ctx.err("ERROR: not enough args");
      return 1;
    }
    if (sub === "app" && args[1] === "list") {
      ctx.out("Available applications:\n  OpenSSH");
      return 0;
    }
    if (!needRoot(ctx)) return 1;
    switch (sub) {
      case "status":
        ctx.out(statusTable(ctx, args[1] === "numbered", args[1] === "verbose"));
        return 0;
      case "enable":
        if (fw.enabled) {
          ctx.out("Firewall is active and enabled on system startup");
          return 0;
        }
        ctx.prompt({ prompt: "Command may disrupt existing ssh connections. Proceed with operation (y|n)? ", secret: false, data: { action: "enable" } });
        return 0;
      case "disable":
        fw.enabled = false;
        ctx.out("Firewall stopped and disabled on system startup");
        return 0;
      case "reset":
        ctx.prompt({ prompt: "Resetting all rules to installed defaults. Proceed with operation (y|n)? ", secret: false, data: { action: "reset" } });
        return 0;
      case "default": {
        const pol = args[1] as "allow" | "deny";
        const dir = args[2];
        if (!["allow", "deny", "reject"].includes(pol) || !dir) {
          ctx.err("ERROR: Usage: ufw default allow|deny|reject incoming|outgoing");
          return 1;
        }
        if (dir === "incoming") fw.defaultIncoming = pol === "allow" ? "allow" : "deny";
        ctx.out(`Default ${dir} policy changed to '${pol}'\n(be sure to update your rules accordingly)`);
        return 0;
      }
      case "allow":
      case "deny":
      case "limit": {
        const parsed = parseSpec(args.slice(1));
        if (parsed.error) {
          ctx.err(parsed.error);
          return 1;
        }
        const msgs: string[] = [];
        for (const r of parsed.rules) {
          r.action = sub;
          const existing = fw.rules.find((x) => x.port === r.port && x.proto === r.proto);
          if (existing && existing.action === sub) {
            msgs.push("Skipping adding existing rule", "Skipping adding existing rule (v6)");
            continue;
          }
          if (existing) {
            existing.action = sub;
            existing.label = r.label;
          } else fw.rules.push(r);
          msgs.push("Rules updated", "Rules updated (v6)");
        }
        ctx.out(fw.enabled ? msgs.join("\n") : msgs.join("\n"));
        return 0;
      }
      case "delete": {
        const rest = args.slice(1);
        if (/^\d+$/.test(rest[0] ?? "")) {
          const n = Number(rest[0]);
          const count = fw.rules.length;
          const idx = n <= count ? n - 1 : n - 1 - count;
          if (idx < 0 || idx >= count) {
            ctx.err("ERROR: Could not find rule '" + n + "'");
            return 1;
          }
          const r = fw.rules[idx];
          ctx.prompt({
            prompt: `Deleting:\n allow ${r.label}\nProceed with operation (y|n)? `,
            secret: false,
            data: { action: "delete", idx },
          });
          return 0;
        }
        const words = rest[0] === "allow" || rest[0] === "deny" || rest[0] === "limit" ? rest.slice(1) : rest;
        const parsed = parseSpec(words);
        if (parsed.error) {
          ctx.err(parsed.error);
          return 1;
        }
        let removed = false;
        for (const r of parsed.rules) {
          const i = fw.rules.findIndex((x) => x.port === r.port && (x.proto === r.proto || r.label === x.label));
          if (i >= 0) {
            fw.rules.splice(i, 1);
            removed = true;
          }
        }
        ctx.out(removed ? "Rule deleted\nRule deleted (v6)" : "Could not delete non-existent rule\nCould not delete non-existent rule (v6)");
        return 0;
      }
      default:
        ctx.err(`ERROR: Invalid syntax\n\nUsage: ufw COMMAND`);
        return 1;
    }
  },
  resume(ctx, p, input) {
    const yes = /^y(es)?$/i.test(input.trim());
    if (!yes) {
      ctx.out("Aborted");
      return 1;
    }
    const fw = ctx.host.ufw;
    if (p.data.action === "enable") {
      fw.enabled = true;
      ctx.out("Firewall is active and enabled on system startup");
    } else if (p.data.action === "reset") {
      fw.enabled = false;
      fw.rules = [];
      fw.defaultIncoming = "deny";
      ctx.out("Backing up 'user.rules' to '/etc/ufw/user.rules.20261011_090000'");
    } else if (p.data.action === "delete") {
      fw.rules.splice(Number(p.data.idx), 1);
      ctx.out("Rule deleted");
    }
    return 0;
  },
  complete: () => ["status", "allow", "deny", "enable", "disable", "delete", "limit", "default", "app", "OpenSSH"],
};

export const UFW_COMMANDS = [ufw];
