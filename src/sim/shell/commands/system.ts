import { nodeSize, userGroups } from "../../fs";
import { listeners } from "../../net";
import { dateTime, hhmmss, strftime } from "../../time";
import type { Host } from "../../types";
import { pad, padL } from "../../util";
import { flagSet, type Command, type Ctx } from "../ctx";
import { COMMANDS } from "../registry";

export const whoami: Command = {
  name: "whoami",
  summary: "which user am I",
  run(ctx) {
    ctx.out(ctx.user);
    return 0;
  },
};

function idLine(host: Host, user: string): string {
  const u = host.users[user];
  const groups = userGroups(host, user)
    .map((g) => host.groups[g])
    .filter(Boolean)
    .sort((a, b) => a.gid - b.gid);
  return `uid=${u.uid}(${u.name}) gid=${u.uid}(${u.name}) groups=${groups.map((g) => `${g.gid}(${g.name})`).join(",")}`;
}

export const id: Command = {
  name: "id",
  summary: "show user and groups",
  run(ctx) {
    const who = ctx.argv[1] ?? ctx.user;
    if (!ctx.host.users[who]) {
      ctx.err(`id: '${who}': no such user`);
      return 1;
    }
    ctx.out(idLine(ctx.host, who));
    return 0;
  },
};

export const groups: Command = {
  name: "groups",
  summary: "which groups a user is in",
  run(ctx) {
    const who = ctx.argv[1] ?? ctx.user;
    if (!ctx.host.users[who]) {
      ctx.err(`groups: '${who}': no such user`);
      return 1;
    }
    const g = userGroups(ctx.host, who).join(" ");
    ctx.out(ctx.argv[1] ? `${who} : ${g}` : g);
    return 0;
  },
};

export const hostname: Command = {
  name: "hostname",
  summary: "name of this machine (hostname -I shows its IPs)",
  run(ctx) {
    if (ctx.argv[1] === "-I") ctx.out([ctx.host.publicIp, ctx.host.privateIp].filter(Boolean).join(" ") + " ");
    else ctx.out(ctx.host.hostname);
    return 0;
  },
};

export const hostnamectl: Command = {
  name: "hostnamectl",
  summary: "machine name, OS and kernel",
  run(ctx) {
    const vps = ctx.host.id === "vps";
    ctx.out(
      [
        ` Static hostname: ${ctx.host.hostname}`,
        `       Icon name: ${vps ? "computer-vm" : "computer-laptop"}`,
        `         Chassis: ${vps ? "vm 🖴" : "laptop 💻"}`,
        `      Machine ID: 3f9c2b1e8a7d4c6f9e0b1a2c3d4e5f60`,
        vps ? `  Virtualization: kvm` : "",
        `Operating System: ${ctx.host.os}`,
        `          Kernel: Linux 6.8.0-45-generic`,
        `    Architecture: x86-64`,
        vps ? ` Hardware Vendor: QEMU` : ` Hardware Vendor: Framework`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return 0;
  },
};

export const uname: Command = {
  name: "uname",
  summary: "kernel info (uname -a)",
  run(ctx) {
    if (ctx.argv.includes("-a"))
      ctx.out(`Linux ${ctx.host.hostname} 6.8.0-45-generic #45-Ubuntu SMP PREEMPT_DYNAMIC x86_64 x86_64 x86_64 GNU/Linux`);
    else if (ctx.argv.includes("-r")) ctx.out("6.8.0-45-generic");
    else ctx.out("Linux");
    return 0;
  },
};

export const date: Command = {
  name: "date",
  summary: "current date and time (date +%F for 2026-10-11)",
  run(ctx) {
    const fmt = ctx.argv.slice(1).find((a) => a.startsWith("+"));
    if (fmt) {
      ctx.out(strftime(ctx.w.clock, fmt.slice(1)));
      return 0;
    }
    ctx.out(dateTime(ctx.w.clock));
    return 0;
  },
};

function memUsedMb(ctx: Ctx): number {
  const running = Object.values(ctx.host.docker.containers).filter((c) => c.status === "running");
  const fromContainers = running.reduce(
    (s, c) => s + (c.kind === "nextjs" ? 180 : c.kind === "postgres" ? 90 : c.kind === "caddy" ? 25 : 20),
    0,
  );
  return Math.round(300 + Object.keys(ctx.host.services).length * 8 + fromContainers);
}

export const uptime: Command = {
  name: "uptime",
  summary: "how long the machine has been up, and load",
  run(ctx) {
    const mins = Math.floor(ctx.w.clock / 60) + 12;
    ctx.out(` ${hhmmss(ctx.w.clock)} up ${mins} min,  1 user,  load average: 0.08, 0.05, 0.01`);
    return 0;
  },
};

export const nproc: Command = {
  name: "nproc",
  summary: "number of CPUs",
  run(ctx) {
    ctx.out(String(ctx.host.cpus));
    return 0;
  },
};

function fmtMem(mb: number, human: boolean): string {
  if (!human) return String(mb * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)}Gi`;
  return `${mb}Mi`;
}

export const free: Command = {
  name: "free",
  summary: "RAM usage (free -h)",
  run(ctx) {
    const human = ctx.argv.some((a) => a.includes("h"));
    const total = ctx.host.memMb;
    const used = memUsedMb(ctx);
    const cache = Math.round(total * 0.15);
    const freeMb = total - used - cache;
    const avail = total - used;
    const c = (n: number) => padL(fmtMem(n, human), 12);
    ctx.out(
      [
        `               total        used        free      shared  buff/cache   available`,
        `Mem:    ${c(total)}${c(used)}${c(freeMb)}${c(1)}${c(cache)}${c(avail)}`,
        `Swap:   ${c(0)}${c(0)}${c(0)}`,
      ].join("\n"),
    );
    return 0;
  },
};

export function diskUsedMb(host: Host): number {
  const files = nodeSize(host.fs) / (1024 * 1024);
  const images = Object.values(host.docker.images).reduce((s, i) => s + i.sizeMb, 0);
  const volumes = Object.values(host.docker.volumes).reduce((s, v) => s + v.sizeMb, 0);
  const logs = Object.values(host.docker.containers).reduce((s, c) => s + c.logs.length * 0.0002, 0);
  return host.baseUsedMb + files + images + volumes + logs;
}

function g(mb: number): string {
  if (mb >= 1024) {
    const gb = mb / 1024;
    return gb < 10 ? `${gb.toFixed(1)}G` : `${Math.round(gb)}G`;
  }
  return `${Math.round(mb)}M`;
}

export const df: Command = {
  name: "df",
  summary: "disk space (df -h)",
  run(ctx) {
    const human = ctx.argv.some((a) => a.includes("h"));
    const size = ctx.host.diskGb * 1024 - 1600;
    const used = Math.min(size, diskUsedMb(ctx.host));
    const avail = Math.max(0, size - used);
    const pct = Math.round((used / size) * 100);
    const f = (mb: number) => (human ? g(mb) : String(Math.round(mb * 1024)));
    const row = (fs: string, s: string, u: string, a: string, p: string, m: string) =>
      `${pad(fs, 15)}${padL(s, 5)}${padL(u, 6)}${padL(a, 6)}${padL(p, 5)} ${m}`;
    ctx.out(
      [
        `Filesystem      Size  Used Avail Use% Mounted on`,
        row("tmpfs", human ? "197M" : "201216", human ? "1.1M" : "1124", human ? "196M" : "200092", "1%", "/run"),
        row("/dev/sda1", f(size), f(used), f(avail), `${pct}%`, "/"),
        row("tmpfs", human ? "982M" : "1005568", "0", human ? "982M" : "1005568", "0%", "/dev/shm"),
        row("/dev/sda15", human ? "105M" : "106858", human ? "6.1M" : "6186", human ? "99M" : "100672", "6%", "/boot/efi"),
      ].join("\n"),
    );
    return 0;
  },
};

function processes(ctx: Ctx): { user: string; pid: number; cmd: string; mem: number }[] {
  const out = [{ user: "root", pid: 1, cmd: "/sbin/init", mem: 0.6 }];
  for (const s of Object.values(ctx.host.services)) {
    if (s.state !== "active" || !s.pid) continue;
    const cmd =
      s.name === "ssh"
        ? "sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups"
        : s.name === "docker"
          ? "/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock"
          : s.name === "cron"
            ? "/usr/sbin/cron -f -P"
            : s.name === "hello"
              ? "/usr/bin/python3 /srv/hello/server.py"
              : `/usr/sbin/${s.name}`;
    out.push({ user: s.name === "hello" ? "www-data" : "root", pid: s.pid, cmd, mem: 0.4 });
  }
  for (const c of Object.values(ctx.host.docker.containers)) {
    if (c.status !== "running") continue;
    const cmd =
      c.kind === "nextjs" ? "node server.js" : c.kind === "postgres" ? "postgres" : c.kind === "caddy" ? "caddy run --config /etc/caddy/Caddyfile" : c.image;
    out.push({ user: c.kind === "postgres" ? "999" : "root", pid: 3000 + c.name.length * 13, cmd, mem: c.kind === "nextjs" ? 4.6 : 2.1 });
  }
  if (ctx.frame.via === "ssh") out.push({ user: ctx.realUser, pid: 4242, cmd: `sshd: ${ctx.realUser}@pts/0`, mem: 0.2 });
  out.push({ user: ctx.realUser, pid: 4250, cmd: "-bash", mem: 0.1 });
  return out;
}

export const ps: Command = {
  name: "ps",
  summary: "running programs (ps aux)",
  run(ctx) {
    const rows = processes(ctx);
    ctx.out(
      [
        `USER         PID %CPU %MEM COMMAND`,
        ...rows.map((r) => `${pad(r.user, 10)} ${padL(String(r.pid), 5)}  0.0 ${padL(r.mem.toFixed(1), 4)} ${r.cmd}`),
      ].join("\n"),
    );
    return 0;
  },
};

export const top: Command = {
  name: "top",
  summary: "live view of programs (a snapshot here)",
  run(ctx) {
    const used = memUsedMb(ctx);
    const rows = processes(ctx);
    ctx.out(
      [
        `top - ${hhmmss(ctx.w.clock)} up 12 min,  1 user,  load average: 0.08, 0.05, 0.01`,
        `Tasks: ${rows.length + 80} total,   1 running, ${rows.length + 79} sleeping,   0 stopped,   0 zombie`,
        `%Cpu(s):  1.3 us,  0.7 sy,  0.0 ni, 97.9 id,  0.0 wa,  0.0 hi,  0.1 si,  0.0 st`,
        `MiB Mem :  ${ctx.host.memMb.toFixed(1)} total,  ${(ctx.host.memMb - used).toFixed(1)} free,  ${used.toFixed(1)} used`,
        ``,
        `    PID USER      %CPU  %MEM COMMAND`,
        ...rows.map((r) => `${padL(String(r.pid), 7)} ${pad(r.user, 9)}  0.3 ${padL(r.mem.toFixed(1), 5)} ${r.cmd.split(" ")[0]}`),
        ``,
      ].join("\n"),
    );
    ctx.info("(A snapshot. On a real server, press q to quit top.)");
    return 0;
  },
};

export const htop: Command = { ...top, name: "htop", summary: "nicer top" };

export const ss: Command = {
  name: "ss",
  summary: "open ports (sudo ss -tlnp)",
  run(ctx) {
    const { flags } = flagSet(ctx.argv.slice(1));
    if (!flags.has("l")) {
      ctx.out(
        [
          `Netid State Recv-Q Send-Q        Local Address:Port      Peer Address:Port`,
          ctx.frame.via === "ssh" ? `tcp   ESTAB 0      0      ${ctx.host.publicIp}:22   84.20.11.5:51234` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      ctx.info("Tip: add -l to see what is LISTENING: ss -tlnp");
      return 0;
    }
    const showProc = flags.has("p");
    const ls = listeners(ctx.host).sort((a, b) => a.port - b.port);
    const rows = [`State  Recv-Q Send-Q   Local Address:Port    Peer Address:Port Process`];
    for (const l of ls) {
      const proc = showProc && ctx.user === "root" ? `users:(("${l.proc}",pid=${l.pid},fd=3))` : "";
      rows.push(`LISTEN 0      4096    ${padL(`${l.addr}:${l.port}`, 18)}        0.0.0.0:*     ${proc}`);
      if (l.addr === "0.0.0.0") rows.push(`LISTEN 0      4096    ${padL(`[::]:${l.port}`, 18)}           [::]:*     ${proc}`);
    }
    rows.push(`LISTEN 0      4096    ${padL("127.0.0.53%lo:53", 18)}        0.0.0.0:*     ${showProc && ctx.user === "root" ? 'users:(("systemd-resolve",pid=601,fd=15))' : ""}`);
    ctx.out(rows.join("\n"));
    if (showProc && ctx.user !== "root") ctx.info("The Process column is empty: only root can see other users' programs. Try sudo.");
    return 0;
  },
};

export const ip: Command = {
  name: "ip",
  summary: "network interfaces (ip a)",
  run(ctx) {
    const sub = ctx.argv[1] ?? "";
    if (!["a", "addr", "address"].includes(sub)) {
      ctx.err(`Only "ip a" is in this game.`);
      return 1;
    }
    const h = ctx.host;
    const rows = [
      `1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN`,
      `    inet 127.0.0.1/8 scope host lo`,
      `2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP`,
      h.publicIp ? `    inet ${h.publicIp}/32 scope global dynamic eth0` : `    inet ${h.privateIp}/24 brd 192.168.1.255 scope global dynamic wlan0`,
    ];
    if (h.publicIp) rows.push(`3: enp7s0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1450 state UP`, `    inet ${h.privateIp}/32 scope global enp7s0`);
    if (h.services.docker) rows.push(`4: docker0: <NO-CARRIER,BROADCAST,MULTICAST,UP> mtu 1500 state DOWN`, `    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0`);
    ctx.out(rows.join("\n"));
    return 0;
  },
};

export const history: Command = {
  name: "history",
  summary: "commands you typed",
  run(ctx) {
    ctx.out(ctx.sh.history.map((h, i) => `${padL(String(i + 1), 5)}  ${h}`).join("\n"));
    return 0;
  },
};

export const clear: Command = {
  name: "clear",
  summary: "clear the screen (or Ctrl+L)",
  run(ctx) {
    ctx.emit.clear = true;
    return 0;
  },
};

export const which: Command = {
  name: "which",
  summary: "where a program lives",
  run(ctx) {
    const name = ctx.argv[1];
    if (!name) return 1;
    if (!COMMANDS[name]) return 1;
    ctx.out(name === "sshd" ? "/usr/sbin/sshd" : `/usr/bin/${name}`);
    return 0;
  },
};

export const man: Command = {
  name: "man",
  summary: "manual pages",
  run(ctx) {
    ctx.info(`Manual pages are long. Open the dictionary (the book icon) or ask Claude with "Copy context". Try: ${ctx.argv[1] ?? "ls"} --help`);
    return 0;
  },
};

export const exit: Command = {
  name: "exit",
  summary: "leave this session (logout)",
  run(ctx) {
    const sh = ctx.sh;
    if (sh.frames.length <= 1) {
      ctx.info("This is your laptop's terminal. It stays open.");
      return 0;
    }
    const f = sh.frames.pop()!;
    if (f.via === "ssh") {
      ctx.out(`logout\nConnection to ${f.remote ?? ctx.w.hosts[f.host].publicIp} closed.`);
    } else if (f.via === "console") {
      ctx.out("logout");
    } else {
      ctx.out("logout");
    }
    return 0;
  },
};

export const logout: Command = { ...exit, name: "logout", hidden: true };

export const su: Command = {
  name: "su",
  summary: "switch user (su - deploy)",
  run(ctx) {
    const rest = ctx.argv.slice(1).filter((a) => a !== "-" && a !== "-l" && a !== "--login");
    const target = rest[0] ?? "root";
    const u = ctx.host.users[target];
    if (!u) {
      ctx.err(`su: user ${target} does not exist or the user entry does not contain all the required fields`);
      return 1;
    }
    if (ctx.user === "root") {
      ctx.sh.frames.push({ host: ctx.frame.host, user: target, cwd: u.home, via: "su", loginGroups: userGroups(ctx.host, target) });
      return 0;
    }
    ctx.prompt({ prompt: "Password: ", secret: true, data: { target } });
    return 0;
  },
  resume(ctx, p, input) {
    const target = String(p.data.target);
    const u = ctx.host.users[target];
    if (!u?.password || u.password !== input) {
      ctx.err("su: Authentication failure");
      if (target === "root") ctx.info("Tip: with sudo rights you can use sudo -i instead, with YOUR password.");
      return 1;
    }
    ctx.sh.frames.push({ host: ctx.frame.host, user: target, cwd: u.home, via: "su", loginGroups: userGroups(ctx.host, target) });
    return 0;
  },
};

export const SYSTEM_COMMANDS = [
  whoami,
  id,
  groups,
  hostname,
  hostnamectl,
  uname,
  date,
  uptime,
  nproc,
  free,
  df,
  ps,
  top,
  htop,
  ss,
  ip,
  history,
  clear,
  which,
  man,
  exit,
  logout,
  su,
];
