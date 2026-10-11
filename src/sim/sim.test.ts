import { describe, expect, it } from "vitest";
import { parse, tokenize } from "./shell/parse";
import { createShell, runLine, runScript, topFrame } from "./shell/run";
import { completeLine } from "./shell/complete";
import { createDemoWorld, createWorld, rentVps } from "./worlds";
import { traceHttp } from "./net";
import { sshCheck } from "./sshAuth";
import { effectiveSshd, runningSshd } from "./sshd";
import { getFile } from "./fs";
import { ROOT_PASSWORD, VPS_IP } from "./constants";
import { produce } from "immer";
import type { Shell, World } from "./types";

const laptopShell = (): Shell => createShell("t", { host: "laptop", user: "you", cwd: "/home/you", via: "local" });

function fresh(): { w: World; sh: Shell } {
  const w = produce(createWorld(), (d) => rentVps(d));
  return { w, sh: laptopShell() };
}

function text(r: { out: { text: string }[] }) {
  return r.out.map((o) => o.text).join("\n");
}

describe("parser", () => {
  it("handles quotes, vars and operators", () => {
    const toks = tokenize(`echo "hi $USER" 'raw $X' a\\ b`, { USER: "deploy" });
    expect(toks.map((t) => (t.t === "word" ? t.w.text : t.op))).toEqual(["echo", "hi deploy", "raw $X", "a b"]);
    const seq = parse("ls -la | grep ssh && cat x > y; pwd", {});
    expect(seq.items).toHaveLength(3);
    expect(seq.items[0].pipeline.cmds).toHaveLength(2);
    expect(seq.items[1].pipeline.cmds[0].redirect).toEqual({ op: ">", target: "y" });
  });
  it("rejects unbalanced quotes", () => {
    expect(() => parse(`echo "oops`, {})).toThrow();
  });
});

describe("files and permissions", () => {
  it("cd, ls, mkdir, chmod on the laptop", () => {
    let { w, sh } = fresh();
    ({ world: w, shell: sh } = runScript(w, sh, ["mkdir -p notes/a", "cd notes", "touch a/x.txt", "chmod 600 a/x.txt"]));
    expect(topFrame(sh).cwd).toBe("/home/you/notes");
    expect(getFile(w.hosts.laptop, "/home/you/notes/a/x.txt")?.mode).toBe(0o600);
    const r = runLine(w, sh, "ls -la a");
    expect(text(r)).toMatch(/-rw------- +1 you/);
  });
  it("sudo echo > root file fails because the redirect is yours", () => {
    let { w, sh } = fresh();
    const r = runLine(w, sh, "echo hi > /etc/motd");
    expect(text(r)).toMatch(/Permission denied/);
    void w;
    void sh;
  });
});

describe("first login and users", () => {
  it("ssh root with password, then create a sudo user", () => {
    let { w, sh } = fresh();
    const r1 = runScript(w, sh, [`ssh root@${VPS_IP}`, "yes", ROOT_PASSWORD]);
    ({ world: w, shell: sh } = r1);
    expect(topFrame(sh)).toMatchObject({ host: "vps", user: "root" });
    ({ world: w, shell: sh } = runScript(w, sh, ["adduser deploy", "pw-1", "pw-1", "usermod -aG sudo deploy", "su - deploy"]));
    expect(topFrame(sh).user).toBe("deploy");
    const denied = runLine(w, sh, "apt update");
    expect(text(denied)).toMatch(/are you root/);
    const r2 = runScript(w, sh, ["sudo whoami", "pw-1"]);
    expect(text(r2)).toMatch(/^root$/m);
  });
  it("apt install needs apt update first on a fresh box", () => {
    let { w, sh } = fresh();
    ({ world: w, shell: sh } = runScript(w, sh, [`ssh root@${VPS_IP}`, "yes", ROOT_PASSWORD]));
    expect(text(runLine(w, sh, "apt install ncdu"))).toMatch(/Unable to locate package/);
    const r = runScript(w, sh, ["apt update", "apt install ncdu"]);
    expect(r.world.hosts.vps.packages.ncdu).toBeTruthy();
  });
});

describe("ssh hardening", () => {
  function setup() {
    let { w, sh } = fresh();
    ({ world: w, shell: sh } = runScript(w, sh, [
      `ssh root@${VPS_IP}`,
      "yes",
      ROOT_PASSWORD,
      "adduser deploy",
      "pw-1",
      "pw-1",
      "usermod -aG sudo deploy",
      "exit",
      "ssh-keygen -t ed25519",
      "",
      "",
      "",
      `ssh-copy-id deploy@${VPS_IP}`,
      "pw-1",
    ]));
    return { w, sh };
  }

  it("key login works after ssh-copy-id", () => {
    const { w } = setup();
    expect(sshCheck(w, "you", "deploy", VPS_IP).keyOk).toBe(true);
  });

  it("cloud-init drop-in keeps password auth on until it is fixed", () => {
    let { w, sh } = setup();
    ({ world: w, shell: sh } = runScript(w, sh, [`ssh deploy@${VPS_IP}`]));
    expect(topFrame(sh).user).toBe("deploy");
    // edit main config only
    w = produce(w, (d) => {
      const f = getFile(d.hosts.vps, "/etc/ssh/sshd_config")!;
      f.content = f.content.replace("PermitRootLogin yes", "PermitRootLogin no").replace("#PasswordAuthentication yes", "PasswordAuthentication no");
    });
    ({ world: w, shell: sh } = runScript(w, sh, ["sudo systemctl restart ssh", "pw-1"]));
    expect(runningSshd(w.hosts.vps).permitrootlogin).toBe("no");
    expect(runningSshd(w.hosts.vps).passwordauthentication).toBe("yes"); // the drop-in wins
    ({ world: w, shell: sh } = runScript(w, sh, [
      "sudo rm /etc/ssh/sshd_config.d/50-cloud-init.conf",
      "sudo systemctl restart ssh",
    ]));
    expect(effectiveSshd(w.hosts.vps).passwordauthentication).toBe("no");
    expect(runningSshd(w.hosts.vps).passwordauthentication).toBe("no");
    expect(sshCheck(w, "you", "deploy", VPS_IP).keyOk).toBe(true);
    expect(sshCheck(w, "you", "root", VPS_IP).passwordWorks).toBe(false);
  });

  it("ufw enable without OpenSSH blocks new logins", () => {
    let { w, sh } = setup();
    ({ world: w, shell: sh } = runScript(w, sh, [`ssh deploy@${VPS_IP}`, "sudo ufw enable", "pw-1", "y"]));
    expect(w.hosts.vps.ufw.enabled).toBe(true);
    const c = sshCheck(w, "you", "deploy", VPS_IP);
    expect(c.netError).toMatch(/timed out/);
    expect(c.trace.failedAt).toBe("ufw");
  });

  it("bad modes on authorized_keys gives Permission denied (publickey)", () => {
    let { w } = setup();
    w = produce(w, (d) => {
      d.hosts.vps.services.ssh.loaded = { ...d.hosts.vps.services.ssh.loaded, passwordauthentication: "no" };
      getFile(d.hosts.vps, "/home/deploy/.ssh/authorized_keys")!.mode = 0o664;
    });
    const r = runLine(w, laptopShell(), `ssh deploy@${VPS_IP}`);
    expect(text(r)).toMatch(/Permission denied \(publickey\)/);
    expect(r.world.hosts.vps.journal.some((l) => /bad ownership or modes/.test(l.msg))).toBe(true);
  });
});

describe("trace", () => {
  it("demo world serves the site", () => {
    const w = createDemoWorld();
    const t = traceHttp(w, "https://crumb.shop");
    expect(t.ok).toBe(true);
    expect(t.status).toBe(200);
    expect(t.hops.map((h) => h.id)).toEqual(["browser", "dns", "provider-fw", "ufw", "caddy", "app", "db"]);
  });
  it("each broken hop is reported", () => {
    const base = createDemoWorld();
    const noDns = produce(base, (d) => {
      d.dns = [];
    });
    expect(traceHttp(noDns, "https://crumb.shop").failedAt).toBe("dns");
    const pfw = produce(base, (d) => {
      d.provider.firewall.rules = d.provider.firewall.rules.filter((r) => r.port !== 443);
    });
    expect(traceHttp(pfw, "https://crumb.shop").failedAt).toBe("provider-fw");
    const appDown = produce(base, (d) => {
      d.hosts.vps.docker.containers["crumb-app-1"].status = "exited";
    });
    const t = traceHttp(appDown, "https://crumb.shop");
    expect(t.failedAt).toBe("app");
    expect(t.status).toBe(502);
    const dbLocal = produce(base, (d) => {
      d.hosts.vps.docker.containers["crumb-app-1"].env.DATABASE_URL = "postgres://crumb:x@localhost:5432/crumb";
    });
    expect(traceHttp(dbLocal, "https://crumb.shop").failedAt).toBe("db");
  });
  it("curl prints a 502 from Caddy", () => {
    const w = produce(createDemoWorld(), (d) => {
      d.hosts.vps.docker.containers["crumb-app-1"].status = "exited";
    });
    const r = runLine(w, laptopShell(), "curl -I https://crumb.shop");
    expect(text(r)).toMatch(/HTTP\/2 502/);
    expect(r.trace?.failedAt).toBe("app");
  });
});

describe("completion", () => {
  it("completes commands and paths", () => {
    const { w, sh } = fresh();
    expect(completeLine(w, sh, "ssh-ke").line).toBe("ssh-keygen ");
    expect(completeLine(w, sh, "cd co").line).toBe("cd code/");
  });
});
