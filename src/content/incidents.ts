import { getDir, getFile } from "@/sim/fs";
import * as P from "@/sim/predicates";
import type { Incident } from "./schema";

const IP = "203.0.113.10";

export const INCIDENTS: Incident[] = [
  {
    id: "publickey",
    title: "Permission denied (publickey)",
    client: {
      name: "Maya, your teammate",
      message:
        "Can't SSH in anymore: Permission denied (publickey). Deploys are stuck! Only thing I did today was run a script that 'shares' home folders with the team.",
    },
    after: "w3-06",
    start: "laptop",
    breakIt: (w) => {
      const vps = w.hosts.vps;
      const sshDir = getDir(vps, "/home/deploy/.ssh");
      const ak = getFile(vps, "/home/deploy/.ssh/authorized_keys");
      if (sshDir) sshDir.mode = 0o775;
      if (ak) ak.mode = 0o664;
    },
    goals: [{ describe: "deploy can log in with the key again", check: P.keyLoginWorks("deploy") }],
    hints: [
      "Passwords are off and root login is off. You need another way in: the provider console.",
      "In the console: journalctl -u ssh -n 20. Then fix the modes: .ssh needs 700, authorized_keys needs 600.",
    ],
    fastestPath: [
      `ssh -v deploy@${IP}   → the key is offered and refused`,
      "Open the provider console (a root shell that does not need SSH)",
      "journalctl -u ssh -n 20   → bad ownership or modes",
      "chmod 700 /home/deploy/.ssh",
      "chmod 600 /home/deploy/.ssh/authorized_keys",
    ],
    fix: ["chmod 700 /home/deploy/.ssh", "chmod 600 /home/deploy/.ssh/authorized_keys"],
    fixShell: 1,
    debrief: [
      "sshd ignores keys if the .ssh folder or authorized_keys can be written by others.",
      "Your screen only says Permission denied. The reason is in the server log.",
      "Locked out of SSH? The provider's web console is the back door.",
    ],
    timeLimit: 300,
    console: true,
    sshUser: "deploy",
  },
];

export function incidentById(id: string): Incident | undefined {
  return INCIDENTS.find((i) => i.id === id);
}
