import { normalizeRef } from "../../docker/images";
import { externalUrl } from "../../docker/install";
import { fsErrorText, writeFile } from "../../fs";
import { isIp, resolveName, traceHttp } from "../../net";
import { dateTime } from "../../time";
import type { TraceResult } from "../../types";
import { liveRevision } from "../../gitlab/state";
import type { Command, Ctx } from "../ctx";

function httpDate(ctx: Ctx) {
  const d = dateTime(ctx.w.clock).split(" ");
  return `${d[0]}, ${d[2]} ${d[1]} ${d[5]} ${d[3]} GMT`;
}

const REASONS: Record<number, string> = { 200: "OK", 308: "Permanent Redirect", 500: "Internal Server Error", 502: "Bad Gateway" };

function headers(ctx: Ctx, t: TraceResult, url: string): string[] {
  const status = t.status ?? 200;
  const https = url.startsWith("https");
  const viaCaddy = t.hops.some((h) => h.id === "caddy");
  const svc = t.hops.find((h) => h.node.startsWith("svc:"));
  const host = /^https?:\/\/([^/:]+)/.exec(url)?.[1] ?? "";
  if (status === 308) {
    return [`HTTP/1.1 308 Permanent Redirect`, `Connection: close`, `Location: https://${host}/`, `Server: Caddy`, `Date: ${httpDate(ctx)}`];
  }
  const proto = https && viaCaddy ? "HTTP/2" : "HTTP/1.1";
  const lines = [`${proto} ${status}${proto === "HTTP/1.1" ? " " + (REASONS[status] ?? "") : " "}`];
  if (viaCaddy && https) lines.push(`alt-svc: h3=":443"; ma=2592000`);
  if (status === 200 && !svc) lines.push(`content-type: text/html; charset=utf-8`);
  if (svc) lines.push(`Server: SimpleHTTP/0.6 Python/3.12.3`, `Content-type: text/html; charset=utf-8`);
  lines.push(`date: ${httpDate(ctx)}`);
  if (viaCaddy) lines.push(`server: Caddy`);
  if (t.hops.some((h) => h.id === "app" && h.ok) && status !== 502) {
    lines.push(`x-powered-by: Next.js`);
    // The shop stamps every response with the commit it was built from.
    const rev = liveRevision(ctx.w);
    if (rev) lines.push(`x-app-version: ${rev.slice(0, 8)}`);
  }
  if (status === 502) lines.push(`content-length: 0`);
  return lines;
}

function body(t: TraceResult, ctx: Ctx): string {
  const status = t.status ?? 200;
  if (status === 502) return "";
  if (status === 500) return "Internal Server Error";
  if (t.hops.some((h) => h.node === "svc:hello")) return "<h1>Hello from web-1</h1>";
  if (t.hops.some((h) => h.node.startsWith("svc:nginx"))) return "<h1>Welcome to nginx!</h1>";
  // A container answering directly (docker run -p 8080:80 nginx).
  const direct = t.hops.find((h) => h.node.startsWith("c:"));
  const c = direct && ctx.w.hosts.vps.docker.containers[direct.node.slice(2)];
  if (c && ctx.w.hosts.vps.docker.images[normalizeRef(c.image)]?.meta?.flavor === "nginx") return "<!DOCTYPE html>\n<html>\n<head>\n<title>Welcome to nginx!</title>";
  const rev = t.hops.some((h) => h.id === "app" && h.ok) ? liveRevision(ctx.w) : undefined;
  const footer = rev ? `<footer>version ${rev.slice(0, 8)}</footer>` : "";
  return `<!DOCTYPE html><html lang="en"><head><title>Crumb | Fresh bread, daily</title></head><body><main><h1>Crumb</h1>...</main>${footer}</body></html>`;
}

export const curl: Command = {
  name: "curl",
  summary: "make a web request (curl -I https://crumb.shop)",
  run(ctx) {
    const args = ctx.argv.slice(1);
    const head = args.some((a) => a === "-I" || a === "--head" || (/^-[a-zA-Z]+$/.test(a) && a.includes("I")));
    const verbose = args.some((a) => a === "-v" || a === "--verbose" || (/^-[a-zA-Z]+$/.test(a) && a.includes("v")));
    const include = args.some((a) => a === "-i" || (/^-[a-zA-Z]+$/.test(a) && a.includes("i")));
    const short = (ch: string) => args.some((a) => /^-[a-zA-Z]+$/.test(a) && a.includes(ch));
    const fail = short("f") || args.includes("--fail");
    // -s hides errors too, unless -S brings them back.
    const quietErrors = (short("s") || args.includes("--silent")) && !(short("S") || args.includes("--show-error"));
    let output: string | undefined;
    const words: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-o" || a === "--output") output = args[++i];
      else if (/^-[a-zA-Z]*o$/.test(a)) output = args[++i];
      else if (a.startsWith("--output=")) output = a.slice(9);
      else if (!a.startsWith("-")) words.push(a);
    }
    let url = words[0];
    if (!url) {
      ctx.err("curl: try 'curl --help' for more information");
      return 2;
    }
    if (short("O") && !output) output = url.replace(/[?#].*$/, "").split("/").pop() || "index.html";
    const err = (s: string) => {
      if (!quietErrors) ctx.err(s);
    };
    const save = (bodyText: string): number => {
      if (output === undefined || output === "-") {
        ctx.out(bodyText.replace(/\n$/, ""));
        return 0;
      }
      const e = writeFile(ctx.host, ctx.user, ctx.path(output), bodyText);
      if (e) {
        if (!quietErrors) ctx.err(`Warning: Failed to open the file ${output}: ${fsErrorText(e)}`);
        err(`curl: (23) Failure writing output to destination, passed ${bodyText.length} returned 4294967295`);
        return 23;
      }
      return 0;
    };
    // Files out on the internet (install scripts, signing keys).
    const external = externalUrl(url);
    if (external !== undefined) {
      if (head) {
        ctx.out(`HTTP/2 200 \ncontent-type: text/plain; charset=utf-8\ncontent-length: ${external.length}\ndate: ${httpDate(ctx)}`);
        return 0;
      }
      return save(external);
    }
    if (!/^https?:\/\//.test(url)) url = "http://" + url;
    const from = ctx.frame.host === "vps" ? "vps" : "laptop";
    const t = traceHttp(ctx.w, url, { from });
    ctx.emit.trace = t;
    const name = /^https?:\/\/([^/:]+)/.exec(url)?.[1] ?? "";
    const port = /:(\d+)/.exec(url.replace(/^https?:\/\//, ""))?.[1] ?? (url.startsWith("https") ? "443" : "80");
    if (verbose) {
      const ip = name === "localhost" ? "127.0.0.1" : resolveName(ctx.w, name).ip;
      const v: string[] = [];
      if (ip) v.push(`* Host ${name}:${port} was resolved.`, `* IPv4: ${ip}`, `*   Trying ${ip}:${port}...`);
      if (!t.error || t.error.includes("(35)")) {
        v.push(`* Connected to ${name} (${ip}) port ${port}`);
        if (url.startsWith("https") && !t.error) {
          v.push(
            `* SSL connection using TLSv1.3 / TLS_AES_128_GCM_SHA256 / X25519 / id-ecPublicKey`,
            `* Server certificate:`,
            `*  subject: CN=${name}`,
            `*  issuer: C=US; O=Let's Encrypt; CN=E6`,
            `*  SSL certificate verify ok.`,
          );
        }
        if (!t.error) v.push(`> ${head ? "HEAD" : "GET"} / HTTP/2`, `> Host: ${name}`, `> User-Agent: curl/8.5.0`, `>`);
      }
      ctx.err(v.join("\n"));
    }
    if (t.error) {
      err(t.error);
      const m = /curl: \((\d+)\)/.exec(t.error);
      return m ? Number(m[1]) : 7;
    }
    if (t.status === 0) {
      err(`curl: (52) Empty reply from server`);
      ctx.info("Something answered, but it does not speak HTTP. Postgres maybe?");
      return 52;
    }
    if (fail && (t.status ?? 200) >= 400) {
      err(`curl: (22) The requested URL returned error: ${t.status}`);
      return 22;
    }
    const hs = headers(ctx, t, url);
    if (head) ctx.out(hs.join("\n"));
    else {
      if (verbose) ctx.err(hs.map((h) => "< " + h).join("\n"));
      if (include) ctx.out(hs.join("\n") + "\n");
      const b = body(t, ctx);
      if (output !== undefined) return save(b + "\n");
      if (b) ctx.out(b);
    }
    return 0;
  },
};

export const dig: Command = {
  name: "dig",
  summary: "ask DNS (dig crumb.shop +short)",
  run(ctx) {
    const args = ctx.argv.slice(1);
    const short = args.includes("+short");
    const words = args.filter((a) => !a.startsWith("+") && !a.startsWith("@") && !a.startsWith("-"));
    const name = words.find((w) => !["A", "AAAA", "CNAME", "TXT", "MX", "NS"].includes(w.toUpperCase()));
    const type = (words.find((w) => ["A", "AAAA", "CNAME", "TXT", "MX", "NS"].includes(w.toUpperCase())) ?? "A").toUpperCase();
    if (!name) {
      ctx.err("Usage: dig name [type] [+short]");
      return 1;
    }
    const answers: { name: string; ttl: number; type: string; value: string }[] = [];
    if (type === "A") {
      let current = name;
      for (let i = 0; i < 6; i++) {
        const c = ctx.w.dns.find((r) => r.name === current && r.type === "CNAME");
        if (c) {
          answers.push({ name: current, ttl: c.ttl, type: "CNAME", value: c.value });
          current = c.value.replace(/\.$/, "");
          continue;
        }
        for (const a of ctx.w.dns.filter((r) => r.name === current && r.type === "A")) answers.push({ name: current, ttl: a.ttl, type: "A", value: a.value });
        break;
      }
    } else {
      for (const r of ctx.w.dns.filter((r) => r.name === name && r.type === type)) answers.push({ name, ttl: r.ttl, type, value: r.value });
    }
    if (short) {
      if (answers.length) ctx.out(answers.map((a) => (a.type === "CNAME" ? a.value + "." : a.value)).join("\n"));
      return 0;
    }
    const status = answers.length || ctx.w.dns.some((r) => r.name === name) ? "NOERROR" : "NXDOMAIN";
    ctx.out(
      [
        `; <<>> DiG 9.18.28-0ubuntu0.24.04.1-Ubuntu <<>> ${name}${type !== "A" ? " " + type : ""}`,
        `;; global options: +cmd`,
        `;; Got answer:`,
        `;; ->>HEADER<<- opcode: QUERY, status: ${status}, id: 41827`,
        `;; flags: qr rd ra; QUERY: 1, ANSWER: ${answers.length}, AUTHORITY: 0, ADDITIONAL: 1`,
        ``,
        `;; QUESTION SECTION:`,
        `;${name}.\t\t\tIN\t${type}`,
        ...(answers.length ? [``, `;; ANSWER SECTION:`, ...answers.map((a) => `${a.name}.\t\t${a.ttl}\tIN\t${a.type}\t${a.type === "CNAME" ? a.value + "." : a.value}`)] : []),
        ``,
        `;; Query time: 23 msec`,
        `;; SERVER: 127.0.0.53#53(127.0.0.53) (UDP)`,
        `;; WHEN: ${dateTime(ctx.w.clock)}`,
      ].join("\n"),
    );
    return 0;
  },
};

export const nslookup: Command = {
  name: "nslookup",
  summary: "ask DNS, older tool",
  run(ctx) {
    const name = ctx.argv[1];
    if (!name) return 1;
    const r = resolveName(ctx.w, name);
    const lines = [`Server:\t\t127.0.0.53`, `Address:\t127.0.0.53#53`, ``];
    if (!r.ip) {
      lines.push(`** server can't find ${name}: NXDOMAIN`);
      ctx.out(lines.join("\n"));
      return 1;
    }
    lines.push(`Non-authoritative answer:`);
    for (const c of r.chain.filter((x) => x.includes("CNAME"))) {
      const [n, , v] = c.split(" ");
      lines.push(`${n}\tcanonical name = ${v}.`);
    }
    lines.push(`Name:\t${r.chain.length ? r.chain[r.chain.length - 1].split(" ")[0] : name}`, `Address: ${r.ip}`);
    ctx.out(lines.join("\n"));
    return 0;
  },
};

export const hostCmd: Command = {
  name: "host",
  summary: "ask DNS, short answer",
  run(ctx) {
    const name = ctx.argv[1];
    if (!name) return 1;
    const r = resolveName(ctx.w, name);
    if (!r.ip) {
      ctx.out(`Host ${name} not found: 3(NXDOMAIN)`);
      return 1;
    }
    ctx.out(r.chain.map((c) => (c.includes("CNAME") ? `${c.split(" ")[0]} is an alias for ${c.split(" ")[2]}.` : `${c.split(" ")[0]} has address ${c.split(" ")[2]}`)).join("\n"));
    return 0;
  },
};

export const ping: Command = {
  name: "ping",
  summary: "is it alive (ping -c 3 IP)",
  run(ctx) {
    const name = ctx.argv.slice(1).find((a) => !a.startsWith("-") && !/^\d+$/.test(a));
    if (!name) {
      ctx.err("ping: usage error: Destination address required");
      return 1;
    }
    const r = resolveName(ctx.w, name);
    if (!r.ip) {
      ctx.err(`ping: ${name}: Name or service not known`);
      return 2;
    }
    const alive = r.ip === "127.0.0.1" || (ctx.w.provider.rented && r.ip === ctx.w.hosts.vps.publicIp) || r.ip === ctx.w.hosts.laptop.privateIp;
    const lines = [`PING ${name} (${r.ip}) 56(84) bytes of data.`];
    if (alive) {
      for (let i = 1; i <= 3; i++) lines.push(`64 bytes from ${isIp(name) ? r.ip : name} (${r.ip}): icmp_seq=${i} ttl=52 time=${(18 + i * 0.7).toFixed(1)} ms`);
      lines.push(``, `--- ${name} ping statistics ---`, `3 packets transmitted, 3 received, 0% packet loss, time 2003ms`);
    } else {
      lines.push(``, `--- ${name} ping statistics ---`, `3 packets transmitted, 0 received, 100% packet loss, time 2047ms`);
    }
    ctx.out(lines.join("\n"));
    return alive ? 0 : 1;
  },
};

export const NET_COMMANDS = [curl, dig, nslookup, hostCmd, ping];
