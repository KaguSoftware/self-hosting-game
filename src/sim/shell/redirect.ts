import { fsErrorText, resolvePath, writeFile } from "../fs";
import type { Frame, World } from "../types";

/** Shell redirection (> and >>) always runs as the logged-in user. */
export function writeRedirect(w: World, frame: Frame, target: string, content: string, append: boolean): string | null {
  if (target === "/dev/null") return null;
  const host = w.hosts[frame.host];
  const home = host.users[frame.user]?.home ?? "/";
  const path = resolvePath(frame.cwd, target, home);
  const err = writeFile(host, frame.user, path, content ? content + "\n" : "", { append });
  return err ? fsErrorText(err) : null;
}
