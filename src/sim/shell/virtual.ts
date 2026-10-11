import type { Ctx } from "./ctx";

/** Files whose content is generated from world state. */
export function virtualRead(ctx: Ctx, path: string): string | undefined {
  const h = ctx.host;
  switch (path) {
    case "/etc/passwd":
      return (
        Object.values(h.users)
          .sort((a, b) => a.uid - b.uid)
          .map((u) => `${u.name}:x:${u.uid}:${u.uid}:${u.gecos ?? ""}:${u.home}:${u.shell}`)
          .join("\n") + "\n"
      );
    case "/etc/group":
      return (
        Object.values(h.groups)
          .sort((a, b) => a.gid - b.gid)
          .map((g) => `${g.name}:x:${g.gid}:${g.members.join(",")}`)
          .join("\n") + "\n"
      );
    case "/etc/shadow":
      if (ctx.user !== "root") return undefined;
      return (
        Object.values(h.users)
          .map((u) => `${u.name}:${u.password ? "$y$j9T$" + u.name.length + "Qx...hashed" : "*"}:20372:0:99999:7:::`)
          .join("\n") + "\n"
      );
    case "/proc/meminfo":
      return `MemTotal:       ${h.memMb * 1024} kB\nMemFree:        ${Math.round(h.memMb * 0.6) * 1024} kB\nMemAvailable:   ${Math.round(h.memMb * 0.8) * 1024} kB\n`;
    case "/proc/cpuinfo":
      return Array.from({ length: h.cpus }, (_, i) => `processor\t: ${i}\nmodel name\t: AMD EPYC Processor\n`).join("\n");
    case "/etc/hostname":
      return h.hostname + "\n";
    default:
      return undefined;
  }
}
