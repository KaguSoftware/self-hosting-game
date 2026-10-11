import * as P from "@/sim/predicates";
import { VPS_IP } from "@/sim/constants";
import type { WorldDef } from "../schema";

const IP = VPS_IP;
/** Drills replay earlier incidents on today's server: the end of World 10. */
const NOW = "w10-03";

export const world11: WorldDef = {
  id: 11,
  title: "Debugging",
  tagline: "Find the hop",
  cheatSheet: [
    { cmd: "Outside in", what: "start where the visitor starts, walk in until one stop says no" },
    { cmd: "dig crumb.shop +short", what: "1. DNS: is it the right IP?" },
    { cmd: "curl -v https://crumb.shop", what: "2. which step fails: resolve, connect, TLS, or the answer" },
    { cmd: "Could not resolve host", what: "DNS" },
    { cmd: "Timeout", what: "a firewall: provider or ufw" },
    { cmd: "Couldn't connect (refused)", what: "nothing listens on that port" },
    { cmd: "TLS alert / certificate error", what: "Caddy has no site block or certificate for that name" },
    { cmd: "502", what: "Caddy is fine, the app behind it is not answering" },
    { cmd: "500", what: "the app answered with an error, often the database" },
    { cmd: "docker compose ps; docker compose logs --tail 20 SERVICE", what: "which service is down, and why" },
    { cmd: "One change at a time", what: "then test again from outside" },
  ],
  levels: [
    {
      id: "w11-01",
      world: 11,
      title: "The method",
      base: "chain",
      start: "laptop",
      steps: [
        {
          id: "w11-01-a",
          mission: "Every outage gets the same calm routine. Put it in order.",
          intel: {
            lines: ["A visit passes DNS, the provider firewall, ufw, Caddy, the app and the database.", "Start outside and walk in until one stop says no. Change one thing, then test again.", "curl -v shows every step of a request."],
          },
          task: {
            kind: "order",
            prompt: "Top is first.",
            items: [
              "Read the exact error, and ask what changed",
              "Test from outside: dig, then curl -v",
              "Find the first stop that says no",
              "Read that stop's logs",
              "Change one thing",
              "Test again from outside",
            ],
            why: "Guessing and changing three things at once is how outages get longer. One stop, one change, one test.",
          },
          basis: { taught: ["self"] },
          tags: ["debugging"],
        },
      ],
    },
    {
      id: "w11-02",
      world: 11,
      title: "Outside in",
      base: "chain",
      start: "laptop",
      setup: (w) => {
        // Someone stopped the app "for a minute" and went to lunch.
        const app = Object.values(w.hosts.vps.docker.containers).find((c) => c.service === "app");
        if (app) {
          app.status = "exited";
          app.exitCode = 0;
          app.manuallyStopped = true;
        }
      },
      steps: [
        {
          id: "w11-02-a",
          mission: "The shop is down. Walk in from outside, find the stop that says no, and bring the shop back.",
          intel: { lines: ["curl -v shows each step: resolving the name, connecting, TLS, then the answer."] },
          task: {
            kind: "terminal",
            goals: [
              { describe: "Find the failing stop from outside", check: P.saw(/HTTP\/2 502|< HTTP\/2 502/, "laptop") },
              { describe: "https://crumb.shop answers again", check: P.traceOk("https://crumb.shop") },
            ],
            hints: [
              "dig is fine, curl gets a 502: Caddy works, the app does not. On web-1, docker compose ps.",
              "The app is Exited. cd /srv/crumb, then docker compose up -d app.",
            ],
            guide: ["dig crumb.shop +short", "curl -v https://crumb.shop", `ssh deploy@${IP}`, "cd /srv/crumb", "docker compose ps", "docker compose up -d app"],
            showMe: ["dig crumb.shop +short", "curl -v https://crumb.shop", `ssh deploy@${IP}`, "cd /srv/crumb", "docker compose ps", "docker compose up -d app"],
            chips: ["dig crumb.shop +short", "curl -v https://crumb.shop", `ssh deploy@${IP}`, "docker compose ps", "docker compose logs --tail 20 app"],
            url: "https://crumb.shop",
          },
          after: "DNS said yes, the firewalls said yes, Caddy said 502: the first no was the app. Its status said Exited, and the fix was one command.",
          tags: ["debugging"],
        },
      ],
    },
    {
      id: "w11-03",
      world: 11,
      title: "Symptom finder",
      base: "chain",
      start: "laptop",
      steps: [
        {
          id: "w11-03-a",
          mission: "Each error points at one stop. Go fast.",
          task: {
            kind: "rapid",
            seconds: 45,
            items: [
              { id: "w11-03-a1", q: "curl: (6) Could not resolve host", options: ["DNS", "A firewall", "The app"], answer: 0, why: "The name did not turn into an IP.", tag: "debugging" },
              { id: "w11-03-a2", q: "curl: (28) Timeout was reached", options: ["A firewall dropped it", "Nothing listens", "The database"], answer: 0, why: "Silence means something dropped the visit.", tag: "debugging" },
              { id: "w11-03-a3", q: "curl: (7) Couldn't connect to server", options: ["Nothing listens on that port", "DNS", "A firewall"], answer: 0, why: "Refused comes back fast from the machine itself.", tag: "debugging" },
              { id: "w11-03-a4", q: "TLS alert internal error", options: ["Caddy has no site or certificate for the name", "The app crashed", "ufw"], answer: 0, why: "Check the Caddyfile and Caddy's logs.", tag: "debugging" },
              { id: "w11-03-a5", q: "502 Bad Gateway", options: ["The app behind Caddy is not answering", "DNS is wrong", "The certificate expired"], answer: 0, why: "Down, wrong port, or listening on 127.0.0.1.", tag: "debugging" },
              { id: "w11-03-a6", q: "500 Internal Server Error", options: ["The app answered with an error, often the database", "Caddy is down", "A firewall"], answer: 0, why: "Read the app's logs.", tag: "debugging" },
              { id: "w11-03-a7", q: "Permission denied (publickey)", options: ["The SSH key, or the modes of .ssh", "The provider firewall", "DNS"], answer: 0, why: "Read journalctl -u ssh on the server.", tag: "debugging" },
            ],
          },
          basis: { taught: ["w4-04-b", "w4-05-c", "w4-02-c", "w6-03-a", "w6-05-a", "w5-06-b", "w3-06-a"] },
          tags: ["debugging"],
        },
      ],
    },
    {
      id: "w11-04",
      world: 11,
      title: "Drills",
      base: "chain",
      start: "laptop",
      steps: [
        {
          id: "w11-04-a",
          mission: "Drill on today's server. Outside in.",
          task: { kind: "incident", incidentId: "pfw-blocks-443", after: NOW },
          tags: ["debugging", "firewall"],
        },
        {
          id: "w11-04-b",
          mission: "After a deploy, one service is not well. Tap it.",
          task: {
            kind: "spot",
            prompt: "docker compose ps",
            mono: true,
            lines: [
              "NAME            SERVICE   STATUS",
              "crumb-caddy-1   caddy     Up 3 hours",
              "crumb-app-1     app       Restarting (1) 9 seconds ago",
              "crumb-db-1      db        Up 3 hours (healthy)",
            ],
            bugs: [2],
            why: "Restarting over and over means it crashes at start. Next: docker compose logs --tail 20 app.",
          },
          basis: { taught: ["w5-02-d", "w5-07-c"] },
          tags: ["debugging", "docker"],
        },
        {
          id: "w11-04-c",
          mission: "Drill: orders are failing.",
          task: { kind: "incident", incidentId: "db-localhost", after: NOW },
          tags: ["debugging", "docker"],
        },
        {
          id: "w11-04-d",
          mission: "dig gives the right IP. curl times out on 443. ufw on web-1 allows 443.",
          task: {
            kind: "predict",
            question: "Where do you look next?",
            options: ["The provider firewall", "Restart Caddy", "Change the DNS record"],
            answer: 0,
            why: "A timeout is a firewall, and ufw is fine. The other firewall is in the provider's dashboard.",
          },
          basis: { taught: ["w4-06-a", "w11-03-a"] },
          tags: ["debugging", "firewall"],
        },
        {
          id: "w11-04-e",
          mission: "Last drill: the database keeps falling over.",
          task: { kind: "incident", incidentId: "disk-full-logs", after: NOW },
          tags: ["debugging", "logs"],
        },
      ],
    },
  ],
};
