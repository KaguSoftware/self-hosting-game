// Tiny Caddyfile reader. Enough for site blocks, reverse_proxy, tls and respond.

export interface CaddySite {
  addresses: string[]; // "crumb.shop", "www.crumb.shop", ":80", "http://x"
  upstreams: string[]; // "app:3000"
  tls?: string; // "internal" | email
  respond?: string;
  line: number;
}

export interface CaddyParse {
  sites: CaddySite[];
  errors: string[];
}

export function parseCaddyfile(text: string): CaddyParse {
  const out: CaddyParse = { sites: [], errors: [] };
  const lines = text.split("\n");
  let depth = 0;
  let current: CaddySite | null = null;
  let globalBlock = false;
  lines.forEach((raw, i) => {
    const line = raw.replace(/(^|\s)#.*/, "").trim();
    if (!line) return;
    if (depth === 0) {
      if (line === "{") {
        globalBlock = true;
        depth = 1;
        return;
      }
      const m = /^(.+?)\s*\{$/.exec(line);
      if (!m) {
        out.errors.push(`Caddyfile:${i + 1}: unrecognized line '${line}' (expected a site address followed by {)`);
        return;
      }
      current = {
        addresses: m[1].split(/[\s,]+/).filter(Boolean),
        upstreams: [],
        line: i + 1,
      };
      out.sites.push(current);
      depth = 1;
      return;
    }
    if (line === "}") {
      depth--;
      if (depth === 0) {
        current = null;
        globalBlock = false;
      }
      return;
    }
    if (line.endsWith("{")) {
      depth++;
    }
    if (globalBlock || !current || depth > 1) {
      return;
    }
    const [directive, ...args] = line.split(/\s+/);
    const site: CaddySite = current;
    if (directive === "reverse_proxy") site.upstreams.push(...args.filter((a) => a !== "{"));
    else if (directive === "tls") site.tls = args[0];
    else if (directive === "respond") site.respond = args.join(" ");
    else if (!["encode", "file_server", "root", "header", "log", "redir", "handle", "route", "basic_auth", "basicauth"].includes(directive)) {
      out.errors.push(`Caddyfile:${i + 1}: unrecognized directive: ${directive}`);
    }
  });
  if (depth !== 0) out.errors.push("Caddyfile: unexpected EOF, a block is missing its closing }");
  return out;
}

export function hostOf(address: string): string {
  return address.replace(/^https?:\/\//, "").replace(/:\d+$/, "");
}

export function findSite(parse: CaddyParse, domain: string): CaddySite | undefined {
  return parse.sites.find((s) => s.addresses.some((a) => hostOf(a) === domain));
}
