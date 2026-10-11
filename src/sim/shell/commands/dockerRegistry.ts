// docker login, logout, tag and push on a real host (the VPS). login stores the
// credentials in ~/.docker/config.json of whoever ran it; pulls read them back.
import { checkLogin, readAuths, registryOf, removeLogin, saveLogin } from "../../docker/auth";
import { digestOf, localImage, normalizeRef, repoOf, tagOf } from "../../docker/images";
import { API_VERSION, dockerActive, dockerInstalled } from "../../docker/runtime";
import { userGroups } from "../../fs";
import { hashHex } from "../../util";
import type { Ctx } from "../ctx";

const SOCK = "unix:///var/run/docker.sock";

function reachable(ctx: Ctx, method: string, path: string): boolean {
  if (!dockerInstalled(ctx.host) || !dockerActive(ctx.host)) {
    ctx.err(`Cannot connect to the Docker daemon at ${SOCK}. Is the docker daemon running?`);
    return false;
  }
  const groups = ctx.user === ctx.realUser && ctx.frame.loginGroups ? ctx.frame.loginGroups : userGroups(ctx.host, ctx.user);
  if (ctx.user !== "root" && !groups.includes("docker")) {
    ctx.err(
      `permission denied while trying to connect to the Docker daemon socket at ${SOCK}: ${method} "http://%2Fvar%2Frun%2Fdocker.sock${path}": dial unix /var/run/docker.sock: connect: permission denied`,
    );
    return false;
  }
  return true;
}

function serverOf(arg: string | undefined): string {
  if (!arg) return "https://index.docker.io/v1/";
  return arg.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

export function cmdLogin(ctx: Ctx, args: string[]): number {
  let username = "";
  let password: string | undefined;
  let stdin = false;
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-u" || a === "--username") username = args[++i] ?? "";
    else if (a.startsWith("--username=")) username = a.slice(11);
    else if (a === "-p" || a === "--password") password = args[++i] ?? "";
    else if (a.startsWith("--password=")) password = a.slice(11);
    else if (a === "--password-stdin") stdin = true;
    else if (!a.startsWith("-")) pos.push(a);
  }
  const server = serverOf(pos[0]);
  if (stdin) password = (ctx.stdin ?? "").replace(/\n$/, "");
  if (!username || password === undefined) {
    ctx.info("In this game, give both: docker login registry.gitlab.com -u NAME --password-stdin (or -p TOKEN).");
    ctx.err("Error: Cannot perform an interactive login from a non TTY device");
    return 1;
  }
  if (stdin && !password) {
    ctx.err("Error: Password Required");
    return 1;
  }
  if (!reachable(ctx, "Post", `/v${API_VERSION}/auth`)) return 1;
  if (!stdin) ctx.out("WARNING! Using --password via the CLI is insecure. Use --password-stdin.");
  const registry = server === "https://index.docker.io/v1/" ? "docker.io" : server;
  const check = checkLogin(ctx.w, registry, { username, password });
  if (!check.ok) {
    ctx.err(`Error response from daemon: Get "https://${registry === "docker.io" ? "registry-1.docker.io" : registry}/v2/": unauthorized: HTTP Basic: Access denied`);
    return 1;
  }
  const path = saveLogin(ctx.host, ctx.user, server, { username, password });
  ctx.out(
    [
      `WARNING! Your password will be stored unencrypted in ${path}.`,
      `Configure a credential helper to remove this warning. See`,
      `https://docs.docker.com/engine/reference/commandline/login/#credential-stores`,
      ``,
      `Login Succeeded`,
    ].join("\n"),
  );
  return 0;
}

export function cmdLogout(ctx: Ctx, args: string[]): number {
  const server = serverOf(args.find((a) => !a.startsWith("-")));
  if (!removeLogin(ctx.host, ctx.user, server)) {
    ctx.out(`Not logged in to ${server}`);
    return 0;
  }
  ctx.out(`Removing login credentials for ${server}`);
  return 0;
}

export function cmdTag(ctx: Ctx, args: string[]): number {
  const [src, dst] = args.filter((a) => !a.startsWith("-"));
  if (!src || !dst) {
    ctx.err(`"docker tag" requires exactly 2 arguments.\nSee 'docker tag --help'.\n\nUsage:  docker tag SOURCE_IMAGE[:TAG] TARGET_IMAGE[:TAG]\n\nCreate a tag TARGET_IMAGE that refers to SOURCE_IMAGE`);
    return 1;
  }
  if (!reachable(ctx, "Post", `/v${API_VERSION}/images/${src}/tag`)) return 1;
  const img = localImage(ctx.host, src);
  if (!img) {
    ctx.err(`Error response from daemon: No such image: ${src}`);
    return 1;
  }
  const n = normalizeRef(dst);
  ctx.host.docker.images[n] = { ...img, ref: n };
  return 0;
}

export function cmdPush(ctx: Ctx, args: string[]): number {
  const ref = args.find((a) => !a.startsWith("-"));
  if (!ref) {
    ctx.err(`"docker push" requires exactly 1 argument.\nSee 'docker push --help'.\n\nUsage:  docker push [OPTIONS] NAME[:TAG]\n\nUpload an image to a registry`);
    return 1;
  }
  if (!reachable(ctx, "Post", `/v${API_VERSION}/images/${ref}/push`)) return 1;
  const n = normalizeRef(ref);
  const img = localImage(ctx.host, n);
  const repo = repoOf(n);
  if (!img) {
    ctx.err(`An image does not exist locally with the tag: ${repo}`);
    return 1;
  }
  const registry = registryOf(n);
  ctx.out(`The push refers to repository [${registry === "docker.io" ? `docker.io/${repo.includes("/") ? repo : "library/" + repo}` : repo}]`);
  const cred = readAuths(ctx.host, ctx.user)[registry];
  const check = cred ? checkLogin(ctx.w, registry, cred) : undefined;
  const own = !ctx.w.gitlab || repo === `registry.gitlab.com/${ctx.w.gitlab.project.path}`;
  if (!cred || !check?.ok || registry === "docker.io") {
    ctx.err("denied: requested access to the resource is denied");
    return 1;
  }
  if (!check.push || !own) {
    ctx.err("denied: access forbidden");
    return 1;
  }
  const already = Object.values(ctx.w.registry ?? {}).some((x) => x.id === img.id);
  const layers = Array.from({ length: 6 }, (_, i) => hashHex(`${img.id}#push${i}`, 12));
  ctx.out(layers.map((l) => `${l}: ${already ? "Layer already exists" : "Pushed"}`).join("\n"));
  ctx.out(`${tagOf(n)}: digest: ${digestOf(n + img.id)} size: 1996`);
  ctx.w.registry ??= {};
  ctx.w.registry[n] = { ref: n, id: img.id, sizeMb: img.sizeMb, kind: img.kind, ageDays: 0, meta: { ...(img.meta ?? {}) } };
  return 0;
}
