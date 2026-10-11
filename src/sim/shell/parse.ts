// Bash-lite parser: words, quotes, $VARS, $(...), ~, |, &&, ||, ;, <, >, >>, 2>/dev/null, VAR=x cmd.

export interface Word {
  text: string;
  /** True if any part was quoted. Quoted words skip glob and ~ expansion. */
  quoted: boolean;
}

export type Token = { t: "word"; w: Word } | { t: "op"; op: "|" | "&&" | "||" | ";" | ">" | ">>" | "<" | "2>" | "2>&1" };

export interface SimpleCommand {
  argv: Word[];
  redirect?: { op: ">" | ">>"; target: string };
  /** cmd < file */
  stdinFrom?: string;
  stderrNull?: boolean;
  /** VAR=x before the command name. With no command at all, these set shell variables. */
  env?: Record<string, string>;
}

/** Runs the inside of $(...) and returns its output. */
export type Subst = (inner: string) => string;

export interface Pipeline {
  cmds: SimpleCommand[];
}

export interface Sequence {
  items: { pipeline: Pipeline; next?: "&&" | "||" | ";" }[];
}

export class ParseError extends Error {}

export function tokenize(line: string, vars: Record<string, string>, subst?: Subst): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let cur = "";
  let quoted = false;
  let inWord = false;
  const flush = () => {
    if (inWord) tokens.push({ t: "word", w: { text: cur, quoted } });
    cur = "";
    quoted = false;
    inWord = false;
  };
  const expandVar = (): string => {
    // at line[i] === "$"
    let name = "";
    if (line[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      while (j < line.length && depth > 0) {
        if (line[j] === "(") depth++;
        else if (line[j] === ")") depth--;
        j++;
      }
      if (depth > 0) throw new ParseError("unexpected EOF while looking for matching `)'");
      const inner = line.slice(i + 2, j - 1);
      i = j;
      if (!subst) throw new ParseError("$(...) is not supported here");
      return subst(inner).replace(/\n+$/, "");
    }
    if (line[i + 1] === "{") {
      const end = line.indexOf("}", i + 2);
      if (end === -1) throw new ParseError("bad substitution");
      name = line.slice(i + 2, end);
      i = end + 1;
    } else {
      let j = i + 1;
      while (j < line.length && /[A-Za-z0-9_?]/.test(line[j])) j++;
      name = line.slice(i + 1, j);
      if (!name) {
        i++;
        return "$";
      }
      i = j;
    }
    return vars[name] ?? "";
  };
  while (i < line.length) {
    const c = line[i];
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end === -1) throw new ParseError("unexpected EOF while looking for matching `''");
      cur += line.slice(i + 1, end);
      quoted = true;
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i++;
      inWord = true;
      quoted = true;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === "\\" && i + 1 < line.length && '"\\$`'.includes(line[i + 1])) {
          cur += line[i + 1];
          i += 2;
        } else if (line[i] === "$") {
          cur += expandVar();
        } else {
          cur += line[i++];
        }
      }
      if (i >= line.length) throw new ParseError('unexpected EOF while looking for matching `"\'');
      i++;
      continue;
    }
    if (c === "\\" && i + 1 < line.length) {
      cur += line[i + 1];
      inWord = true;
      quoted = true;
      i += 2;
      continue;
    }
    if (c === "$") {
      cur += expandVar();
      inWord = true;
      continue;
    }
    if (c === " " || c === "\t") {
      flush();
      i++;
      continue;
    }
    if (c === "#" && !inWord) break;
    if (line.startsWith("2>&1", i)) {
      flush();
      tokens.push({ t: "op", op: "2>&1" });
      i += 4;
      continue;
    }
    if (line.startsWith("2>", i) && !inWord) {
      flush();
      tokens.push({ t: "op", op: "2>" });
      i += 2;
      continue;
    }
    if (line.startsWith("&&", i) || line.startsWith("||", i) || line.startsWith(">>", i)) {
      flush();
      tokens.push({ t: "op", op: line.slice(i, i + 2) as "&&" | "||" | ">>" });
      i += 2;
      continue;
    }
    if (c === "|" || c === ";" || c === ">" || c === "<") {
      flush();
      tokens.push({ t: "op", op: c });
      i++;
      continue;
    }
    if (c === "&") {
      throw new ParseError("running things in the background with & is not in this game yet");
    }
    cur += c;
    inWord = true;
    i++;
  }
  flush();
  return tokens;
}

export function parse(line: string, vars: Record<string, string>, subst?: Subst): Sequence {
  const tokens = tokenize(line, vars, subst);
  const seq: Sequence = { items: [] };
  let pipeline: Pipeline = { cmds: [] };
  let cmd: SimpleCommand = { argv: [] };
  const endCmd = () => {
    if (!cmd.argv.length && !cmd.env) throw new ParseError("syntax error near unexpected token");
    pipeline.cmds.push(cmd);
    cmd = { argv: [] };
  };
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.t === "word") {
      const m = !cmd.argv.length ? /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(tok.w.text) : null;
      if (m) (cmd.env ??= {})[m[1]] = m[2];
      else cmd.argv.push(tok.w);
      continue;
    }
    switch (tok.op) {
      case "|":
        endCmd();
        break;
      case ">":
      case ">>": {
        const target = tokens[i + 1];
        if (!target || target.t !== "word") throw new ParseError("syntax error near unexpected token `newline'");
        cmd.redirect = { op: tok.op, target: target.w.text };
        i++;
        break;
      }
      case "<": {
        const target = tokens[i + 1];
        if (!target || target.t !== "word") throw new ParseError("syntax error near unexpected token `newline'");
        cmd.stdinFrom = target.w.text;
        i++;
        break;
      }
      case "2>": {
        const target = tokens[i + 1];
        if (!target || target.t !== "word") throw new ParseError("syntax error near unexpected token `newline'");
        if (target.w.text === "/dev/null") cmd.stderrNull = true;
        i++;
        break;
      }
      case "2>&1":
        break;
      case "&&":
      case "||":
      case ";":
        endCmd();
        seq.items.push({ pipeline, next: tok.op });
        pipeline = { cmds: [] };
        break;
    }
  }
  if (cmd.argv.length || cmd.env) endCmd();
  if (pipeline.cmds.length) seq.items.push({ pipeline });
  else if (seq.items.length && seq.items[seq.items.length - 1].next !== ";") {
    throw new ParseError("syntax error: unexpected end of line");
  }
  return seq;
}
