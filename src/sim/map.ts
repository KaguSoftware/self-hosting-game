// Pure derivation of the server map from the world, plus map gestures as data.
import { produce } from "immer";
import { listeners } from "./net";
import { runningSshd } from "./sshd";
import { getFile } from "./fs";
import type { World } from "./types";
import { rentVps } from "./worlds";

export type NodeStatus = "ok" | "off" | "warn" | "down" | "ghost";

export interface MapNode {
  id: string;
  kind: "client" | "laptop" | "dns" | "pfw" | "vps" | "ufw" | "sshd" | "caddy" | "app" | "db" | "svc" | "volume" | "gitlab";
  label: string;
  sub: string;
  status: NodeStatus;
  /** Container or service name behind the node. */
  ref?: string;
}

export interface MapEdge {
  from: string;
  to: string;
  kind: "web" | "ssh" | "data";
}

export interface MapModel {
  nodes: MapNode[];
  edges: MapEdge[];
}

export function deriveMap(w: World): MapModel {
  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const vps = w.hosts.vps;
  const rented = w.provider.rented;

  nodes.push({ id: "client", kind: "client", label: "Visitor", sub: "a browser somewhere", status: "ok" });
  const hasKey = !!getFile(w.hosts.laptop, "/home/you/.ssh/id_ed25519");
  nodes.push({ id: "laptop", kind: "laptop", label: "Your laptop", sub: hasKey ? "has an SSH key" : "no SSH key yet", status: "ok" });

  const aRecords = w.dns.filter((r) => r.type === "A" || r.type === "CNAME");
  nodes.push({
    id: "dns",
    kind: "dns",
    label: "DNS",
    sub: aRecords.length ? aRecords.map((r) => `${r.name} → ${r.value}`).slice(0, 2).join("\n") : "no records",
    status: aRecords.length ? (aRecords.some((r) => r.type === "A" && r.value !== vps.publicIp) ? "warn" : "ok") : "ghost",
  });
  edges.push({ from: "client", to: "dns", kind: "web" });

  if (!rented) {
    nodes.push({ id: "vps", kind: "vps", label: "No server yet", sub: "rent one in World 1", status: "ghost" });
    return { nodes, edges };
  }

  const fw = w.provider.firewall;
  nodes.push({
    id: "pfw",
    kind: "pfw",
    label: "Provider firewall",
    sub: fw.enabled ? (fw.rules.length ? "open: " + fw.rules.map((r) => r.port).join(" ") : "everything blocked") : "off (all ports open)",
    status: fw.enabled ? "ok" : "off",
  });
  edges.push({ from: "dns", to: "pfw", kind: "web" }, { from: "laptop", to: "pfw", kind: "ssh" });

  nodes.push({
    id: "vps",
    kind: "vps",
    label: `${vps.hostname}`,
    sub: `${vps.publicIp} · ${vps.cpus} vCPU · ${Math.round((vps.memMb + 250) / 1024)} GB`,
    status: "ok",
  });

  nodes.push({
    id: "ufw",
    kind: "ufw",
    label: "ufw",
    sub: vps.ufw.enabled ? (vps.ufw.rules.length ? "allows " + [...new Set(vps.ufw.rules.filter((r) => r.action !== "deny").map((r) => r.port))].join(" ") : "blocks everything") : "off",
    status: vps.ufw.enabled ? "ok" : "off",
  });
  edges.push({ from: "pfw", to: "ufw", kind: "web" });

  const ssh = vps.services.ssh;
  const cfg = runningSshd(vps);
  const risky = cfg.permitrootlogin === "yes" || cfg.passwordauthentication === "yes";
  nodes.push({
    id: "sshd",
    kind: "sshd",
    label: "sshd",
    sub: `root login: ${cfg.permitrootlogin === "no" ? "no" : cfg.permitrootlogin === "yes" ? "yes" : "key only"} · passwords: ${cfg.passwordauthentication}`,
    status: ssh?.state === "active" ? (risky ? "warn" : "ok") : "down",
    ref: "ssh",
  });
  edges.push({ from: "ufw", to: "sshd", kind: "ssh" });

  for (const l of listeners(vps)) {
    if (l.source.kind !== "service" || l.source.name === "ssh") continue;
    const s = vps.services[l.source.name];
    if (nodes.some((n) => n.id === `svc:${s.name}`)) continue;
    nodes.push({ id: `svc:${s.name}`, kind: "svc", label: s.name, sub: `port ${l.port}`, status: "ok", ref: s.name });
    edges.push({ from: "ufw", to: `svc:${s.name}`, kind: "web" });
  }
  for (const s of Object.values(vps.services)) {
    if (s.name === "ssh" || !s.listens?.length || s.state === "active") continue;
    nodes.push({ id: `svc:${s.name}`, kind: "svc", label: s.name, sub: s.state, status: "down", ref: s.name });
  }

  for (const c of Object.values(vps.docker.containers)) {
    const role = c.kind === "caddy" ? "caddy" : c.kind === "nextjs" ? "app" : c.kind === "postgres" ? "db" : null;
    const id = role && !nodes.some((n) => n.id === role) ? role : `c:${c.name}`;
    const status: NodeStatus = c.status === "running" ? "ok" : c.status === "restarting" ? "warn" : "down";
    const ports = c.ports.map((p) => `${p.hostIp === "127.0.0.1" ? "127.0.0.1:" : ""}${p.hostPort}`).join(" ");
    nodes.push({
      id,
      kind: role ?? "svc",
      label: c.service ?? c.name,
      sub: `${c.image}${ports ? " · ports " + ports : ""}${c.status !== "running" ? " · " + c.status : ""}`,
      status,
      ref: c.name,
    });
  }
  if (nodes.some((n) => n.id === "caddy")) edges.push({ from: "ufw", to: "caddy", kind: "web" });
  if (nodes.some((n) => n.id === "app")) edges.push({ from: "caddy", to: "app", kind: "web" });
  if (nodes.some((n) => n.id === "db")) edges.push({ from: "app", to: "db", kind: "web" });

  for (const v of Object.values(vps.docker.volumes)) {
    nodes.push({ id: `vol:${v.name}`, kind: "volume", label: v.name.replace(/^crumb_/, ""), sub: `${v.sizeMb} MB`, status: "ok" });
    const user = Object.values(vps.docker.containers).find((c) => c.mounts.some((m) => m.source === v.name));
    const userNode = nodes.find((n) => n.ref === user?.name);
    if (userNode) edges.push({ from: userNode.id, to: `vol:${v.name}`, kind: "data" });
  }
  return { nodes, edges };
}

// ---------- gestures ----------

export type MapAction =
  | { type: "container"; name: string; running: boolean }
  | { type: "pfwRule"; port: number; on: boolean }
  | { type: "pfw"; enabled: boolean }
  | { type: "dnsA"; name: string; value: string | null }
  | { type: "ufw"; enabled: boolean }
  | { type: "ufwRule"; port: number; on: boolean }
  | { type: "service"; name: string; running: boolean }
  | { type: "env"; container: string; key: string; value: string | null }
  | { type: "flag"; name: string; value: string | number | boolean }
  | { type: "rent"; plan: string };

export function applyMapAction(w: World, a: MapAction): World {
  return produce(w, (d) => {
    const vps = d.hosts.vps;
    switch (a.type) {
      case "container": {
        const c = vps.docker.containers[a.name];
        if (c) c.status = a.running ? "running" : "exited";
        break;
      }
      case "pfwRule": {
        const rules = d.provider.firewall.rules.filter((r) => r.port !== a.port);
        if (a.on) rules.push({ port: a.port, source: "0.0.0.0/0" });
        d.provider.firewall.rules = rules.sort((x, y) => x.port - y.port);
        break;
      }
      case "pfw":
        d.provider.firewall.enabled = a.enabled;
        break;
      case "dnsA": {
        d.dns = d.dns.filter((r) => !(r.name === a.name && r.type === "A"));
        if (a.value) d.dns.push({ name: a.name, type: "A", value: a.value, ttl: 300 });
        break;
      }
      case "ufw":
        vps.ufw.enabled = a.enabled;
        break;
      case "ufwRule": {
        vps.ufw.rules = vps.ufw.rules.filter((r) => r.port !== a.port);
        if (a.on) vps.ufw.rules.push({ port: a.port, proto: "tcp", action: "allow", label: a.port === 22 ? "OpenSSH" : `${a.port}/tcp` });
        break;
      }
      case "service": {
        const s = vps.services[a.name];
        if (s) s.state = a.running ? "active" : "inactive";
        break;
      }
      case "env": {
        const c = vps.docker.containers[a.container];
        if (c) {
          if (a.value === null) delete c.env[a.key];
          else c.env[a.key] = a.value;
        }
        break;
      }
      case "flag":
        d.flags[a.name] = a.value;
        break;
      case "rent":
        if (!d.provider.rented) rentVps(d, a.plan);
        break;
    }
  });
}

export function applyMapActions(w: World, actions: MapAction[]): World {
  return actions.reduce(applyMapAction, w);
}

/** Is the world already in the state this action would produce? */
export function isActionActive(w: World, a: MapAction): boolean {
  const vps = w.hosts.vps;
  switch (a.type) {
    case "container":
      return (vps.docker.containers[a.name]?.status === "running") === a.running;
    case "pfwRule":
      return w.provider.firewall.rules.some((r) => r.port === a.port) === a.on;
    case "pfw":
      return w.provider.firewall.enabled === a.enabled;
    case "dnsA": {
      const r = w.dns.find((x) => x.name === a.name && x.type === "A");
      return a.value === null ? !r : r?.value === a.value;
    }
    case "ufw":
      return vps.ufw.enabled === a.enabled;
    case "ufwRule":
      return vps.ufw.rules.some((r) => r.port === a.port && r.action !== "deny") === a.on;
    case "service":
      return (vps.services[a.name]?.state === "active") === a.running;
    case "env":
      return (vps.docker.containers[a.container]?.env[a.key] ?? null) === a.value;
    case "flag":
      return w.flags[a.name] === a.value;
    case "rent":
      return w.provider.rented;
  }
}
