import { dir, file, put } from "@/sim/fs";
import * as P from "@/sim/predicates";
import type { WorldDef } from "../schema";

const HELLO_UNIT = `[Unit]
Description=Hello test app
After=network.target

[Service]
User=www-data
ExecStart=/usr/bin/python3 /srv/hello/server.py
Restart=on-failure

[Install]
WantedBy=multi-user.target
`;

export const world2: WorldDef = {
  id: 2,
  title: "Linux",
  tagline: "Find your way around the box",
  cheatSheet: [
    { cmd: "pwd / ls -la / cd PATH", what: "where am I / list all / move" },
    { cmd: "/etc /var/log /srv /home", what: "settings / logs / what you serve / people" },
    { cmd: "sudo CMD", what: "run one command as root" },
    { cmd: "adduser NAME; usermod -aG sudo NAME", what: "new user with sudo rights" },
    { cmd: "chmod 600 FILE", what: "owner can read+write, nobody else. Never 777" },
    { cmd: "chown -R user:group DIR", what: "change owner" },
    { cmd: "sudo apt update && sudo apt install X", what: "install software" },
    { cmd: "systemctl status|start|enable --now NAME", what: "manage services" },
    { cmd: "journalctl -u NAME -n 50", what: "a service's logs" },
    { cmd: "df -h / free -h / sudo ss -tlnp", what: "disk / RAM / open ports" },
  ],
  levels: [
    {
      id: "w2-01",
      world: 2,
      title: "Where am I?",
      base: "chain",
      start: "vps-root",
      steps: [
        {
          id: "w2-01-a",
          mission: "You are on web-1. Print the folder you are in.",
          intel: { lines: ["pwd prints where you are.", "Root's home folder is /root. Everyone else lives in /home/NAME."], terms: ["root"] },
          task: {
            kind: "terminal",
            goals: [{ describe: "Print the current folder", check: P.saw(/^\/root$/m, "vps") }],
            hints: ["Three letters: print working directory.", "pwd"],
            guide: ["pwd"],
            showMe: ["pwd"],
            chips: ["pwd", "ls"],
          },
          review: { id: "w2-01-a-q", q: "Which command prints the current folder?", options: ["pwd", "ls", "cd"], answer: 0, why: "print working directory.", tag: "linux-nav" },
          after: "/root is the home folder of root, the boss user on Linux.",
          tags: ["linux-nav"],
        },
        {
          id: "w2-01-b",
          mission: "Go to the log folder, /var/log, and list what is there.",
          intel: { lines: ["cd PATH moves you. ls lists files.", "Paths starting with / start from the very top."] },
          task: {
            kind: "terminal",
            goals: [
              { describe: "You are in /var/log", check: P.cwdIs("/var/log") },
              { describe: "List its files", check: P.saw(/syslog/, "vps") },
            ],
            hints: ["cd /var/log first. Then list.", "cd /var/log, then ls"],
            guide: ["cd /var/log", "ls"],
            showMe: ["cd /var/log", "ls"],
            chips: ["cd /var/log", "ls"],
          },
          after: "/var/log is where Linux keeps logs: diaries of what each program did.",
          tags: ["linux-nav"],
        },
        {
          id: "w2-01-c",
          mission: "You are in /var/log. You type: cd ../..",
          task: {
            kind: "predict",
            question: "Where are you now?",
            options: ["/", "/var", "/var/log/.."],
            answer: 0,
            why: ".. means one folder up. Twice up from /var/log is /.",
          },
          tags: ["linux-nav"],
        },
        {
          id: "w2-01-d",
          mission: "Go home and show the hidden files too.",
          intel: { lines: ["Files starting with a dot are hidden. ls -la shows them all, with details.", "cd with nothing after it takes you home."] },
          task: {
            kind: "terminal",
            goals: [{ describe: "See .bashrc in a listing", check: P.saw(/\.bashrc/, "vps") }],
            hints: ["cd alone goes home. Then ls with -la.", "cd, then ls -la"],
            guide: ["cd", "ls -la"],
            showMe: ["cd", "ls -la"],
            chips: ["cd", "ls -la"],
          },
          tags: ["linux-nav"],
        },
      ],
    },
    {
      id: "w2-02",
      world: 2,
      title: "The folder map",
      base: "chain",
      start: "vps-root",
      steps: [
        {
          id: "w2-02-a",
          mission: "Where does each thing live?",
          intel: { lines: ["Linux has a place for everything.", "/etc = settings. /var/log = logs. /srv = what you serve. /home = people."] },
          task: {
            kind: "match",
            prompt: "Tap an item, then a folder.",
            buckets: ["/etc", "/var/log", "/srv", "/home"],
            items: [
              { text: "SSH server settings", bucket: 0 },
              { text: "Login attempts log", bucket: 1 },
              { text: "The client's app files", bucket: 2 },
              { text: "deploy's own files", bucket: 3 },
              { text: "Firewall rules", bucket: 0 },
              { text: "System log (syslog)", bucket: 1 },
            ],
            why: "When something breaks: settings in /etc, clues in /var/log.",
          },
          review: { id: "w2-02-a-q", q: "Where do settings files live?", options: ["/etc", "/srv", "/var/log"], answer: 0, why: "/etc holds config.", tag: "linux-nav" },
          tags: ["linux-nav"],
        },
        {
          id: "w2-02-b",
          mission: "Read the SSH server's settings file: /etc/ssh/sshd_config",
          intel: { lines: ["cat FILE prints a file.", "Lines starting with # are comments: switched off."] },
          task: {
            kind: "terminal",
            goals: [{ describe: "Print sshd_config", check: P.saw(/PermitRootLogin/, "vps") }],
            hints: ["cat, then the full path.", "cat /etc/ssh/sshd_config"],
            guide: ["cat /etc/ssh/sshd_config"],
            showMe: ["cat /etc/ssh/sshd_config"],
            chips: ["cat /etc/ssh/sshd_config"],
          },
          after: "That is the settings file for SSH. Lines starting with # are switched off.",
          tags: ["linux-nav", "ssh"],
        },
      ],
    },
    {
      id: "w2-03",
      world: 2,
      title: "sudo and root",
      base: "chain",
      start: "vps-root",
      steps: [
        {
          id: "w2-03-a",
          mission: "You are root right now. That is a problem.",
          intel: { lines: ["root can do anything, including deleting everything by accident.", "So you make a normal user for daily work. sudo borrows root powers for one command."], terms: ["sudo"] },
          task: {
            kind: "predict",
            question: "Why make another user at all?",
            options: ["root is slower", "One typo as root can wreck the box, and bots guess root first", "Ubuntu forces you to"],
            answer: 1,
            why: "Every bot on the internet tries root. Your own username is one more thing to guess.",
          },
          tags: ["sudo"],
        },
        {
          id: "w2-03-b",
          mission: "Create a user called deploy and give it sudo rights.",
          intel: {
            lines: ["adduser NAME creates a user. It asks for a password twice. Remember it!", "usermod -aG sudo NAME adds them to the sudo group. -a means append."],
          },
          task: {
            kind: "terminal",
            goals: [
              { describe: "User deploy exists with a password", check: P.all(P.userExists("deploy"), P.hasPassword("deploy")) },
              { describe: "deploy is in the sudo group", check: P.inGroup("deploy", "sudo") },
            ],
            hints: ["Two commands: adduser deploy, then usermod with -aG.", "adduser deploy (set a password), then usermod -aG sudo deploy"],
            guide: ["adduser deploy", "usermod -aG sudo deploy"],
            showMe: ["adduser deploy", "{{deployPassword}}", "{{deployPassword}}", "usermod -aG sudo deploy"],
            chips: ["adduser deploy", "usermod -aG sudo deploy", "id deploy"],
          },
          review: { id: "w2-03-b-q", q: "Add deploy to the sudo group without removing other groups:", options: ["usermod -aG sudo deploy", "usermod -G sudo deploy", "sudo deploy"], answer: 0, why: "Without -a, -G replaces all groups.", tag: "sudo" },
          after: "deploy is your everyday user now. Being in the sudo group means it may borrow root powers.",
          tags: ["sudo", "users"],
        },
        {
          id: "w2-03-c",
          mission: "Become deploy. Try apt update without sudo, then with sudo.",
          intel: { lines: ["su - deploy switches you to deploy.", "sudo asks for deploy's OWN password, not root's."] },
          task: {
            kind: "terminal",
            goals: [
              { describe: "You are deploy", check: P.loggedInAs("vps", "deploy") },
              { describe: "See it fail without sudo", check: P.saw(/are you root\?/, "vps", "deploy") },
              { describe: "Run it with sudo", check: P.saw(/Reading package lists/, "vps", "deploy") },
            ],
            hints: ["su - deploy first. Then apt update. Then put sudo in front.", "su - deploy, apt update, sudo apt update (type deploy's password)"],
            guide: ["su - deploy", "apt update", "sudo apt update"],
            showMe: ["su - deploy", "apt update", "sudo apt update", "{{deployPassword}}"],
            chips: ["su - deploy", "apt update", "sudo apt update"],
          },
          tags: ["sudo"],
        },
      ],
    },
    {
      id: "w2-04",
      world: 2,
      title: "Permissions",
      base: "chain",
      start: "vps-deploy",
      setup: (w) => {
        const vps = w.hosts.vps;
        put(vps, "/srv/crumb", dir(0o755));
        put(vps, "/srv/crumb/.env", file("DATABASE_URL=postgres://crumb:s3cret-pg@db:5432/crumb\nSTRIPE_SECRET_KEY=sk_live_51Hx...\n", 0o777));
        put(vps, "/srv/crumb/README.md", file("# Crumb\nThe client's shop.\n", 0o644));
      },
      steps: [
        {
          id: "w2-04-a",
          mission: "The intern copied the client's secrets to /srv/crumb. Tap the dangerous line.",
          intel: {
            lines: ["Every file says who may read (r), write (w) and run (x) it.", "It says it three times: for the owner, for a group, and for everyone else."],
            terms: ["permissions"],
          },
          task: {
            kind: "spot",
            prompt: "Output of ls -la /srv/crumb",
            mono: true,
            lines: [
              "total 12",
              "drwxr-xr-x 2 root root 4096 Oct 11 09:00 .",
              "drwxr-xr-x 3 root root 4096 Oct 11 09:00 ..",
              "-rwxrwxrwx 1 root root  141 Oct 11 09:00 .env",
              "-rw-r--r-- 1 root root   31 Oct 11 09:00 README.md",
            ],
            bugs: [3],
            why: "rwxrwxrwx is 777: every user and program on the box can read AND change your secrets.",
          },
          review: { id: "w2-04-a-q", q: "What does chmod 777 mean?", options: ["Only the owner can use it", "Everyone can read, write and run it", "Nobody can open it"], answer: 1, why: "7 = rwx, for owner, group and everyone.", tag: "permissions" },
          tags: ["permissions"],
        },
        {
          id: "w2-04-b",
          mission: "Lock .env so only its owner can read and write it.",
          intel: { lines: ["As numbers: read=4, write=2, run=1. Add them: 6 = read+write.", "chmod 600 FILE: owner reads and writes, nobody else gets anything."] },
          task: {
            kind: "terminal",
            goals: [
              {
                describe: "/srv/crumb/.env is 600",
                check: (g) => P.modeAtMost("vps", "/srv/crumb/.env", 0o600)(g) && P.fileMode("vps", "/srv/crumb/.env", 0o600)(g),
              },
            ],
            hints: ["sudo chmod NUMBER PATH. Owner rw = 6, others 0.", "sudo chmod 600 /srv/crumb/.env"],
            guide: ["sudo chmod 600 /srv/crumb/.env"],
            showMe: ["sudo chmod 600 /srv/crumb/.env", "{{deployPassword}}"],
            chips: ["sudo chmod 600 /srv/crumb/.env", "ls -la /srv/crumb"],
          },
          review: { id: "w2-04-b-q", q: "Secrets file: owner reads and writes, nobody else. Which mode?", options: ["600", "644", "777"], answer: 0, why: "6 = rw for the owner, 0 for group and others.", tag: "permissions" },
          tags: ["permissions"],
        },
        {
          id: "w2-04-c",
          mission: "Make deploy the owner of the whole /srv/crumb folder.",
          intel: { lines: ["chown USER:GROUP PATH changes the owner. -R does everything inside too."] },
          task: {
            kind: "terminal",
            goals: [
              {
                describe: "deploy owns /srv/crumb and everything in it",
                check: P.all(P.fileOwner("vps", "/srv/crumb", "deploy"), P.fileOwner("vps", "/srv/crumb/.env", "deploy"), P.fileOwner("vps", "/srv/crumb/README.md", "deploy")),
              },
            ],
            hints: ["chown needs sudo, and -R for a whole folder.", "sudo chown -R deploy:deploy /srv/crumb"],
            guide: ["sudo chown -R deploy:deploy /srv/crumb"],
            showMe: ["sudo chown -R deploy:deploy /srv/crumb"],
            chips: ["sudo chown -R deploy:deploy /srv/crumb", "ls -la /srv/crumb"],
          },
          tags: ["permissions"],
        },
      ],
    },
    {
      id: "w2-05",
      world: 2,
      title: "Installing software",
      base: "chain",
      start: "vps-deploy",
      steps: [
        {
          id: "w2-05-a",
          mission: "apt is the app store of Ubuntu. It keeps a local list of packages.",
          intel: { lines: ["apt update refreshes the list.", "apt upgrade installs newer versions of what you have."], terms: ["apt"] },
          task: {
            kind: "predict",
            question: "You run apt upgrade on a box where nobody ran apt update for months. What happens?",
            options: ["You get the newest versions", "It upgrades from an old list, so you may miss fixes", "It errors out"],
            answer: 1,
            why: "apt only knows what its list says. Always update first.",
          },
          tags: ["apt"],
        },
        {
          id: "w2-05-b",
          mission: "Refresh the package list, then install ncdu, a disk usage explorer.",
          intel: { lines: ["sudo apt update, then sudo apt install NAME.", "Read the errors. They usually say exactly what is wrong."] },
          task: {
            kind: "terminal",
            goals: [{ describe: "ncdu is installed", check: P.pkgInstalled("ncdu") }],
            hints: ["Update the list first, then install.", "sudo apt update, then sudo apt install ncdu"],
            guide: ["sudo apt update", "sudo apt install ncdu"],
            showMe: ["sudo apt update", "{{deployPassword}}", "sudo apt install -y ncdu"],
            chips: ["sudo apt update", "sudo apt install ncdu"],
          },
          review: { id: "w2-05-b-q", q: "apt says: Unable to locate package. First thing to try?", options: ["sudo apt update", "reboot", "chmod 777"], answer: 0, why: "The list may be empty or old.", tag: "apt" },
          tags: ["apt"],
        },
        {
          id: "w2-05-c",
          mission: "12 updates are waiting. Install them all.",
          intel: { lines: ["sudo apt upgrade installs them. -y answers yes for you."] },
          task: {
            kind: "terminal",
            goals: [{ describe: "All updates installed", check: (g) => !!g.world.hosts.vps.upgraded }],
            hints: ["The command is apt upgrade, with sudo.", "sudo apt upgrade -y"],
            guide: ["sudo apt upgrade -y"],
            showMe: ["sudo apt upgrade -y"],
            chips: ["sudo apt upgrade -y", "apt list --upgradable"],
          },
          tags: ["apt"],
        },
      ],
    },
    {
      id: "w2-06",
      world: 2,
      title: "Services",
      base: "chain",
      start: "vps-deploy",
      setup: (w) => {
        const vps = w.hosts.vps;
        put(vps, "/etc/systemd/system/hello.service", file(HELLO_UNIT));
        put(vps, "/srv/hello", dir(0o755));
        put(vps, "/srv/hello/server.py", file("import http.server\n# serves Hello from web-1 on port 8080\n", 0o755));
        vps.services.hello = {
          name: "hello",
          description: "Hello test app",
          unitPath: "/etc/systemd/system/hello.service",
          enabled: false,
          state: "inactive",
          since: w.clock,
          pid: 2101,
          listens: [{ port: 8080, addr: "0.0.0.0", proc: "python3" }],
        };
      },
      steps: [
        {
          id: "w2-06-a",
          mission: "The intern left a test app called hello. Here is its status.",
          intel: {
            lines: ["systemd starts programs at boot and keeps them running. Each one is a service.", "systemctl status NAME tells you how it is doing."],
            terms: ["systemd"],
          },
          task: {
            kind: "spot",
            prompt: "systemctl status hello. Tap the line that says it is down.",
            mono: true,
            lines: [
              "○ hello.service - Hello test app",
              "     Loaded: loaded (/etc/systemd/system/hello.service; disabled; preset: enabled)",
              "     Active: inactive (dead)",
            ],
            bugs: [2],
            why: "Active is the line to read. Also note disabled: it will not start at boot either.",
          },
          review: { id: "w2-06-a-q", q: "Which systemctl status line tells you if it runs right now?", options: ["Active:", "Loaded:", "Docs:"], answer: 0, why: "Active: active (running) is what you want.", tag: "systemd" },
          tags: ["systemd"],
        },
        {
          id: "w2-06-b",
          mission: "Start hello now, and make it start on every boot.",
          intel: { lines: ["start = run it now. enable = run it at boot.", "enable --now does both at once."] },
          task: {
            kind: "terminal",
            goals: [
              { describe: "hello is running", check: P.serviceActive("hello") },
              { describe: "hello starts at boot", check: P.serviceEnabled("hello") },
            ],
            hints: ["Changing services needs sudo.", "sudo systemctl enable --now hello"],
            guide: ["sudo systemctl enable --now hello"],
            showMe: ["sudo systemctl enable --now hello", "{{deployPassword}}"],
            chips: ["sudo systemctl enable --now hello", "systemctl status hello"],
          },
          review: { id: "w2-06-b-q", q: "Start a service now AND at every boot:", options: ["systemctl enable --now NAME", "systemctl start NAME", "systemctl boot NAME"], answer: 0, why: "enable = at boot, --now = also right now.", tag: "systemd" },
          after: "hello is running now, and will start again by itself after a reboot.",
          tags: ["systemd"],
        },
        {
          id: "w2-06-c",
          mission: "Quick check on start vs enable.",
          task: {
            kind: "predict",
            question: "A service was started but never enabled. The server reboots. Now it is...",
            options: ["Running", "Not running", "Running, but slower"],
            answer: 1,
            why: "start only lasts until reboot. enable is what survives one.",
          },
          tags: ["systemd"],
        },
        {
          id: "w2-06-d",
          mission: "Read hello's logs to find which port it serves on.",
          intel: { lines: ["journalctl -u NAME shows a service's logs.", "Logs are where the answers live. Get used to reading them."], terms: ["journalctl"] },
          task: {
            kind: "terminal",
            goals: [{ describe: "Find the port in the logs", check: P.saw(/port 8080/, "vps") }],
            hints: ["journalctl with -u and the service name. System logs need sudo.", "sudo journalctl -u hello"],
            guide: ["sudo journalctl -u hello"],
            showMe: ["sudo journalctl -u hello"],
            chips: ["sudo journalctl -u hello", "journalctl -u hello -n 20"],
          },
          tags: ["systemd", "logs"],
        },
      ],
    },
    {
      id: "w2-07",
      world: 2,
      title: "Is the box OK?",
      base: "chain",
      start: "vps-deploy",
      steps: [
        {
          id: "w2-07-a",
          mission: "Check how much disk space is left.",
          intel: { lines: ["df -h = disk free, in human units.", "Watch Use% on the / line. Over 90% means trouble soon."] },
          task: {
            kind: "terminal",
            goals: [{ describe: "Show disk usage", check: P.saw(/Filesystem\s+Size\s+Used/, "vps") }],
            hints: ["Two letters, plus -h.", "df -h"],
            guide: ["df -h"],
            showMe: ["df -h"],
            chips: ["df -h", "free -h"],
          },
          after: "Look at the line ending in /. Use% is how full the disk is.",
          tags: ["linux-health"],
        },
        {
          id: "w2-07-b",
          mission: "The disk hits 100%.",
          task: {
            kind: "predict",
            question: "What breaks first?",
            options: ["Nothing, Linux compresses files", "Anything that writes: databases, logs, uploads", "Only SSH"],
            answer: 1,
            why: "Postgres can't write, logs can't append, apps crash. A full disk takes everything down.",
          },
          tags: ["linux-health"],
        },
        {
          id: "w2-07-c",
          mission: "Find every program listening on a port, and its name.",
          intel: { lines: ["A port is a numbered door on a computer. Each program listens at its own door.", "sudo ss -tlnp lists the open doors and the program behind each."] },
          task: {
            kind: "terminal",
            goals: [
              { describe: "See sshd on port 22", check: P.saw(/users:\(\("sshd"/, "vps") },
              { describe: "Spot hello's port", check: P.saw(/0\.0\.0\.0:8080/, "vps") },
            ],
            hints: ["ss with the letters t, l, n, p. Add sudo to see names.", "sudo ss -tlnp"],
            guide: ["sudo ss -tlnp"],
            showMe: ["sudo ss -tlnp", "{{deployPassword}}"],
            chips: ["sudo ss -tlnp", "ss -tln"],
          },
          review: { id: "w2-07-c-q", q: "Which command lists open ports with program names?", options: ["sudo ss -tlnp", "df -h", "ls /ports"], answer: 0, why: "ss = socket statistics.", tag: "networking" },
          after: "22 is SSH, 8080 is hello. Every open door is a way in, so keep as few as possible.",
          tags: ["linux-health", "networking"],
        },
        {
          id: "w2-07-d",
          mission: "ss shows hello on 0.0.0.0:8080.",
          task: {
            kind: "predict",
            question: "Who can reach hello?",
            options: ["Only this server", "Anyone on the internet, if no firewall stops them", "Only you"],
            answer: 1,
            why: "0.0.0.0 means every network card. 127.0.0.1 would mean only this machine.",
          },
          tags: ["networking"],
        },
      ],
    },
    {
      id: "w2-08",
      world: 2,
      title: "Rapid review",
      base: "chain",
      start: "vps-deploy",
      steps: [
        {
          id: "w2-08-a",
          mission: "30 seconds. Go.",
          task: {
            kind: "rapid",
            seconds: 30,
            items: [
              { id: "w2-r1", q: "Logs live in...", options: ["/var/log", "/etc", "/srv"], answer: 0, why: "var = variable data.", tag: "linux-nav" },
              { id: "w2-r2", q: "chmod 600 means...", options: ["owner rw, nobody else", "everyone rw", "owner runs it"], answer: 0, why: "6 = 4+2 = rw.", tag: "permissions" },
              { id: "w2-r3", q: "sudo asks for...", options: ["your own password", "root's password", "an SSH key"], answer: 0, why: "It proves it is you.", tag: "sudo" },
              { id: "w2-r4", q: "Make a service start at boot:", options: ["systemctl enable", "systemctl start", "systemctl boot"], answer: 0, why: "enable = at boot.", tag: "systemd" },
              { id: "w2-r5", q: "A service's logs:", options: ["journalctl -u NAME", "cat NAME", "systemctl logs NAME"], answer: 0, why: "journal = systemd's log.", tag: "systemd" },
              { id: "w2-r6", q: "Disk space:", options: ["df -h", "free -h", "du"], answer: 0, why: "df = disk free.", tag: "linux-health" },
              { id: "w2-r7", q: "Never use chmod...", options: ["777", "600", "644"], answer: 0, why: "777 = anyone can change it.", tag: "permissions" },
              { id: "w2-r8", q: "Install software:", options: ["sudo apt install X", "npm i -g X", "get X"], answer: 0, why: "apt is Ubuntu's package manager.", tag: "apt" },
            ],
          },
          tags: ["linux-nav"],
        },
      ],
    },
  ],
};
