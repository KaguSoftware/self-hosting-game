# Writing levels

The player is a Next.js developer who has only used Vercel and Supabase, with weak terminal and Linux basics. Assume nothing beyond that.

## The rule

**Never ask something the game has not taught, and never show a word it has not explained.**

Two tests in `src/content/basis.test.ts` enforce this. A level that breaks it does not pass `npm test`.

### 1. Every question says where its answer comes from

Question-style steps (`predict`, `spot`, `order`, `match`, `rapid`, `budget`, map `route` and `match`) need a `basis`:

| basis | use it when | what the player sees |
|---|---|---|
| `{ taught: ["self"] }` | the step's own intel card gives what you need | a normal question |
| `{ taught: ["w2-04-b", ...] }` | an earlier step taught it (the test checks it really comes earlier) | a normal question |
| `{ guess: true }` | it is new, and the answer is the lesson | "This one is new. Take a guess." A wrong guess shows a neutral "Now you know", costs no XP and is not added to review |
| `{ known: "why" }` | a Vercel + Supabase developer already knows it | a normal question |

Before writing `taught`, open the cited step and check it really says it. Prefer `taught` or a better interaction over `guess`. A question nobody can answer without the lesson should be rebuilt so the player works it out. The RAM `budget` puzzle in World 1 replaced a "guess the plan" question this way.

### 2. Jargon is explained before it appears

`src/content/jargon.ts` lists technical words (IP address, IPv4, port, vCPU, firewall, SSH, root, 502, and more). If one appears in a mission, question, option, prompt, spot line, quiz item, goal or review card, it must already be explained in one of:

- this step's intel card, or
- an earlier step's intel, `after` line or `why` line, or
- this step's `teaches` list. For a guess step, the term must appear in its `why`. For anything else it must appear in its intel, or the step must be a map whose boxes label it. The test checks this, so `teaches` cannot be used to dodge the rule.

When a new world brings new words, add them to `jargon.ts` first. The test then shows every place that needs an explanation.

### 3. Flags are explained too

Flags are the `-h`, `-la`, `--now` bits after a command. Every flag the game uses must be in `src/content/flags.ts` with a plain meaning (`src/content/flags.test.ts` fails otherwise). Combined one-letter flags are split automatically: `ls -la` is explained as `-l` and `-a`.

- The first three times a player sees a flag, a note explains it under the intel card, under the "Type this" buttons, or in the terminal when they run it. Progress tracks this in `flagSeen`.
- A flag inside a question, answer or quiz item must have been shown in an earlier "Type this" box or intel card (or in the same step's), so its note was seen first.
- The dictionary has a Flags tab built from the same list.

When a new world uses a new flag, add it to `flags.ts`.

### 4. Other checks already in place

- Intel cards: at most 3 short lines. Under about 60 words of reading before any action.
- No more than two steps of the same kind in a row.
- No em or en dashes in any copy.
- Multiple-choice answers are mixed automatically. A test makes sure right answers are not bunched in one position.
- The first time a command is used, show it with `guide` (a tap-to-type button). Explain what happened with `after`.

### 4. Every part of every command is explained

Under every "Type this" command, the player sees what each part means: the command, its sub-command, each flag and flag value, paths, `user:group`, permission numbers, URLs, and symbols like `|`, `&&`, `>` and `~`. The explanations live in `src/content/explain.ts`. `src/content/explain.test.ts` fails if any part of any guide, chip, show me line, incident fix or cheat sheet command has no explanation. When a world brings a new command, sub-command, flag that takes a value, or argument shape, add it to `explain.ts` (and the flag to `flags.ts`). Explain the reason, not just the name: "-R = recursive: the folder and everything inside it".
