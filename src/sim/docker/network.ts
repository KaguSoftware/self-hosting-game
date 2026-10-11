// Docker networks: the default bridge (172.17.0.0/16) and user networks (172.18, 172.19, ...).
// Only user networks have name resolution between containers. The default bridge does not.
import type { Container, Host } from "../types";

export const DEFAULT_NETWORKS = ["bridge", "host", "none"];

/** "172.18" for a network. Assigned on creation; old hand-built networks get one by sorted position. */
export function subnetPrefix(host: Host, net: string): string {
  if (net === "bridge") return "172.17";
  const n = host.docker.networks[net];
  if (n?.subnet) return n.subnet.split(".").slice(0, 2).join(".");
  const others = Object.keys(host.docker.networks)
    .filter((k) => !DEFAULT_NETWORKS.includes(k))
    .sort();
  const i = Math.max(0, others.indexOf(net));
  return `172.${18 + i}`;
}

/** Create a network if missing. Returns true if it was created. */
export function ensureNetwork(host: Host, name: string, project?: string): boolean {
  if (host.docker.networks[name]) return false;
  if (name === "host" || name === "none") {
    host.docker.networks[name] = { name, driver: name === "host" ? "host" : "null" };
    return true;
  }
  if (name === "bridge") {
    host.docker.networks.bridge = { name: "bridge", driver: "bridge", subnet: "172.17.0.0/16" };
    return true;
  }
  const used = new Set(
    Object.keys(host.docker.networks)
      .filter((k) => k !== "host" && k !== "none")
      .map((k) => subnetPrefix(host, k)),
  );
  let second = 18;
  while (used.has(`172.${second}`)) second++;
  host.docker.networks[name] = { name, driver: "bridge", subnet: `172.${second}.0.0/16`, ...(project ? { project } : {}) };
  return true;
}

export function ensureDefaultNetworks(host: Host): void {
  for (const n of DEFAULT_NETWORKS) ensureNetwork(host, n);
}

/** The container's IP on a network (its first one by default). */
export function ipOf(host: Host, c: Container, net = c.networks[0] ?? "bridge"): string {
  const fixed = c.ips?.[net];
  if (fixed) return fixed;
  const peers = Object.values(host.docker.containers)
    .filter((o) => o.networks.includes(net))
    .sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
  return `${subnetPrefix(host, net)}.0.${2 + Math.max(0, peers.indexOf(c))}`;
}

/** Give a container a fixed IP on each of its networks (lowest free, from .2). */
export function allocIps(host: Host, c: Container): void {
  c.ips ??= {};
  for (const net of c.networks) {
    if (net === "host" || net === "none" || c.ips[net]) continue;
    const taken = new Set(
      Object.values(host.docker.containers)
        .filter((o) => o !== c && o.networks.includes(net))
        .map((o) => ipOf(host, o, net)),
    );
    const prefix = subnetPrefix(host, net);
    let n = 2;
    while (taken.has(`${prefix}.0.${n}`)) n++;
    c.ips[net] = `${prefix}.0.${n}`;
  }
}

export function gatewayOf(host: Host, net: string): string {
  return `${subnetPrefix(host, net)}.0.1`;
}

export function networkInUse(host: Host, net: string, except: Container[] = []): boolean {
  return Object.values(host.docker.containers).some((c) => !except.includes(c) && c.networks.includes(net));
}
