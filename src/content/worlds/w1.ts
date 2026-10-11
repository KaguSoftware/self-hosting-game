import * as P from "@/sim/predicates";
import { rentVps } from "@/sim/worlds";
import type { WorldDef } from "../schema";

const IP = "203.0.113.10";

export const world1: WorldDef = {
  id: 1,
  title: "Servers, VMs, VPSs",
  tagline: "What a server really is, and renting your first one",
  cheatSheet: [
    { cmd: "Server", what: "a computer that never sleeps and has a public IP" },
    { cmd: "Hypervisor", what: "slices one physical machine into many VMs" },
    { cmd: "VM", what: "a full virtual computer with its own kernel" },
    { cmd: "Container", what: "a boxed app sharing the host's kernel" },
    { cmd: "VPS", what: "a VM you rent by the month" },
    { cmd: "Sizing", what: "pick by RAM first. CPU can be shared, RAM cannot" },
    { cmd: "ssh root@IP", what: "first login with the provider's password" },
    { cmd: "nproc / free -h / hostnamectl", what: "CPUs / RAM / OS and machine info" },
  ],
  levels: [
    {
      id: "w1-01",
      world: 1,
      title: "A server is just a computer",
      base: "chain",
      steps: [
        {
          id: "w1-01-a",
          mission: "You run the client's site with next start on your laptop. Then you close the lid.",
          intel: { lines: ["A server is just a computer that stays on and has a public address.", "No screen. You talk to it over the network."] },
          task: {
            kind: "predict",
            question: "Is the site still up?",
            options: ["Yes, the internet keeps it", "No, the computer serving it is asleep", "For about an hour"],
            answer: 1,
            why: "No computer awake, no site. Vercel kept computers awake for you.",
          },
          tags: ["servers"],
        },
        {
          id: "w1-01-b",
          mission: "Laptop or server? Sort them.",
          task: {
            kind: "match",
            prompt: "Tap an item, then a bucket.",
            buckets: ["Your laptop", "A server"],
            items: [
              { text: "Has a screen and keyboard", bucket: 0 },
              { text: "Has a public IP address", bucket: 1 },
              { text: "Sleeps when you close it", bucket: 0 },
              { text: "Runs 24/7 in a data center", bucket: 1 },
              { text: "You log in over SSH", bucket: 1 },
            ],
            why: "Same kind of machine, different job.",
          },
          tags: ["servers"],
        },
      ],
    },
    {
      id: "w1-02",
      world: 1,
      title: "Slicing a big box",
      base: "chain",
      steps: [
        {
          id: "w1-02-a",
          mission: "You own one big computer: 16 CPUs, 32 GB RAM. Fill it with client VMs.",
          intel: {
            lines: ["One big computer can be split into smaller pretend computers, called VMs.", "CPU (the brain) can be shared. RAM (desk space) cannot: each GB belongs to one VM."],
            terms: ["hypervisor", "vm"],
          },
          task: {
            kind: "allocate",
            prompt: "Tap VMs to place them. Fill all 32 GB of RAM.",
            host: { cpus: 16, ramGb: 32 },
            vms: [
              { name: "shop", cpus: 4, ramGb: 8 },
              { name: "blog", cpus: 4, ramGb: 8 },
              { name: "ci", cpus: 8, ramGb: 8 },
              { name: "crm", cpus: 8, ramGb: 8 },
              { name: "big-db", cpus: 4, ramGb: 16 },
            ],
            goal: "fit-ram",
            hints: ["CPU can go above 100%. RAM can not.", "Four 8 GB VMs fill 32 GB exactly, even if CPU says 150%."],
          },
          review: {
            id: "w1-02-a-q",
            q: "Which resource can a hypervisor safely overcommit?",
            options: ["RAM", "CPU", "Disk space"],
            answer: 1,
            why: "VMs rarely all need CPU at once, so CPU time is shared. RAM is reserved.",
            tag: "vps",
          },
          tags: ["vps"],
        },
        {
          id: "w1-02-b",
          mission: "Your VPS plan says 2 vCPU.",
          task: {
            kind: "predict",
            question: "What did you really get?",
            options: ["Two physical cores, just for you", "A share of CPU time on a bigger machine", "Two separate servers"],
            answer: 1,
            why: "vCPU means virtual CPU: a share of a real CPU's time. Neighbours share it too. Usually fine.",
          },
          tags: ["vps"],
        },
      ],
    },
    {
      id: "w1-03",
      world: 1,
      title: "VM vs container",
      base: "chain",
      steps: [
        {
          id: "w1-03-a",
          mission: "VM or container? 30 seconds.",
          intel: {
            lines: ["A VM is a whole pretend computer with its own operating system.", "A container is a lighter box around just one app. Docker makes containers."],
            analogy: "VM = a whole house. Container = a room in your house.",
            terms: ["container"],
          },
          task: {
            kind: "rapid",
            seconds: 30,
            items: [
              { id: "w1-r1", q: "Has its own full operating system", options: ["VM", "Container"], answer: 0, why: "A VM starts a whole OS.", tag: "containers" },
              { id: "w1-r2", q: "Starts in under a second", options: ["VM", "Container"], answer: 1, why: "A container is just a process with walls.", tag: "containers" },
              { id: "w1-r3", q: "Your VPS is a...", options: ["VM", "Container"], answer: 0, why: "Providers sell VMs.", tag: "vps" },
              { id: "w1-r4", q: "Docker runs...", options: ["VMs", "Containers"], answer: 1, why: "Docker runs containers inside your VM.", tag: "containers" },
              { id: "w1-r5", q: "Uses the least RAM per app", options: ["VM", "Container"], answer: 1, why: "No extra OS to run.", tag: "containers" },
              { id: "w1-r6", q: "Can run a different operating system than the host", options: ["VM", "Container"], answer: 0, why: "Containers share the host's.", tag: "containers" },
            ],
          },
          tags: ["containers"],
        },
      ],
    },
    {
      id: "w1-04",
      world: 1,
      title: "Rent your VPS",
      base: "chain",
      steps: [
        {
          id: "w1-04-a",
          mission: "Pick a plan for the client: Next.js + Postgres + Caddy, about 2,000 visitors a day.",
          intel: {
            lines: ["A VPS is a VM you rent by the month. It will be your server.", "Pick by RAM first. Out of RAM, programs crash. A slow CPU just means slower."],
            terms: ["vps"],
          },
          task: {
            kind: "predict",
            question: "Which plan?",
            options: ["XS: 1 vCPU, 1 GB, €3.50", "S: 2 vCPU, 4 GB, €4.50", "M: 4 vCPU, 8 GB, €8.50", "L: 8 vCPU, 16 GB, €16.90"],
            answer: 1,
            fixedOrder: true,
            why: "Next.js ~300 MB, Postgres ~200 MB, plus builds and headroom. 4 GB fits. You can resize later.",
            playout: { actions: [{ type: "rent", plan: "S" }], persist: true },
          },
          tags: ["vps"],
        },
        {
          id: "w1-04-b",
          mission: "The welcome email arrived. Tap the two lines you need to log in.",
          task: {
            kind: "spot",
            prompt: "Tap the lines you need.",
            lines: [
              "Your server web-1 is ready!",
              `IPv4: ${IP}`,
              "IPv6: 2001:db8::1/64",
              "Root password: Tq7-mango-river",
              "Location: Falkenstein, DE",
              "Price: €4.50 / month",
            ],
            bugs: [1, 3],
            why: "The IP says where. The password says who. Soon you will switch passwords off.",
          },
          tags: ["vps", "ssh"],
        },
      ],
    },
    {
      id: "w1-05",
      world: 1,
      title: "First login",
      base: "chain",
      setup: (w) => {
        if (!w.provider.rented) rentVps(w, "S");
      },
      steps: [
        {
          id: "w1-05-a",
          mission: "Log in to your new server as root.",
          intel: {
            lines: ["ssh logs you in to another computer: ssh user@address.", "First time, it asks if you trust the server. Type yes.", "Then the password: Tq7-mango-river"],
            terms: ["ssh", "root"],
          },
          task: {
            kind: "terminal",
            goals: [{ describe: "You are logged in to web-1 as root", check: P.loggedInAs("vps", "root") }],
            hints: ["The pattern is ssh root@IP. The IP was in the email.", `ssh root@${IP}, then yes, then the password.`],
            guide: ["ssh root@203.0.113.10", "yes", "Tq7-mango-river"],
            showMe: [`ssh root@${IP}`, "yes", "Tq7-mango-river"],
            chips: ["ssh", `root@${IP}`, "yes"],
          },
          review: {
            id: "w1-05-a-q",
            q: "How do you log in to 203.0.113.10 as root?",
            options: ["ssh root@203.0.113.10", "login 203.0.113.10 root", "curl root@203.0.113.10"],
            answer: 0,
            why: "ssh user@address.",
            tag: "ssh",
          },
          after: "You are now typing ON the server, not your laptop. The prompt says root@web-1.",
          tags: ["ssh"],
        },
        {
          id: "w1-05-b",
          mission: "Check what you paid for: CPUs and RAM.",
          intel: { lines: ["nproc counts CPUs.", "free -h shows RAM in human units (Gi = gigabytes)."] },
          task: {
            kind: "terminal",
            goals: [
              { describe: "Count the CPUs", check: P.saw(/^2$/m, "vps") },
              { describe: "Show RAM usage", check: P.saw(/Mem:/, "vps") },
            ],
            hints: ["Two short commands: one counts CPUs, one shows memory.", "nproc, then free -h"],
            guide: ["nproc", "free -h"],
            showMe: ["nproc", "free -h"],
            chips: ["nproc", "free -h", "hostnamectl"],
          },
          review: {
            id: "w1-05-b-q",
            q: "Which command shows RAM?",
            options: ["df -h", "free -h", "nproc"],
            answer: 1,
            why: "free = memory. df = disk.",
            tag: "linux-health",
          },
          after: "2 CPUs. free shows memory (RAM). Gi is about a gigabyte.",
          tags: ["linux-health"],
        },
        {
          id: "w1-05-c",
          mission: "free says the total is 3.7Gi, not 4.",
          task: {
            kind: "predict",
            question: "Did the provider cheat you?",
            options: ["Yes, complain", "No: the kernel and firmware keep some RAM", "The disk borrowed it"],
            answer: 1,
            why: "A slice of RAM is reserved before Linux even starts. 3.7 of 4 is normal.",
          },
          tags: ["linux-health"],
        },
      ],
    },
    {
      id: "w1-06",
      world: 1,
      title: "Rapid review",
      base: "chain",
      steps: [
        {
          id: "w1-06-a",
          mission: "30 seconds. Go.",
          task: {
            kind: "rapid",
            seconds: 30,
            items: [
              { id: "w1-r7", q: "Out of RAM, Linux...", options: ["slows down a bit", "kills a program (OOM killer)", "uses the CPU instead"], answer: 1, why: "The OOM killer picks a victim, often your database.", tag: "vps" },
              { id: "w1-r8", q: "A VPS is a...", options: ["VM you rent", "container you rent", "physical server you own"], answer: 0, why: "Rented slice of a big machine.", tag: "vps" },
              { id: "w1-r9", q: "First login to a fresh VPS is usually as...", options: ["root", "admin", "vercel"], answer: 0, why: "Then you make your own user.", tag: "ssh" },
              { id: "w1-r10", q: "Which can a host overcommit safely?", options: ["CPU", "RAM"], answer: 0, why: "CPU time is shared.", tag: "vps" },
              { id: "w1-r11", q: "free -h shows...", options: ["RAM", "disk", "CPUs"], answer: 0, why: "Memory.", tag: "linux-health" },
              { id: "w1-r12", q: "Typing yes on the first ssh means...", options: ["I trust this server's fingerprint", "make me root", "save my password"], answer: 0, why: "ssh remembers the server in known_hosts.", tag: "ssh" },
            ],
          },
          tags: ["vps"],
        },
      ],
    },
  ],
};
