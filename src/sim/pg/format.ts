// psql's "aligned" output: centered title and headers, | between columns,
// + at the end of a cell that continues on the next line, then "(N rows)".

export interface TableOpts {
  title?: string;
  /** Columns whose values are right-aligned (numbers). */
  right?: number[];
  /** psql -t: rows only, no header and no footer. */
  tuplesOnly?: boolean;
  /** psql -A: no padding, cells joined with |. */
  unaligned?: boolean;
}

const rep = (ch: string, n: number) => (n > 0 ? ch.repeat(n) : "");

export function pgTable(headers: string[], rows: string[][], opts: TableOpts = {}): string[] {
  if (opts.unaligned) {
    const out: string[] = [];
    if (!opts.tuplesOnly) out.push(headers.join("|"));
    for (const r of rows) out.push(r.join("|"));
    if (!opts.tuplesOnly) out.push(`(${rows.length} ${rows.length === 1 ? "row" : "rows"})`);
    return out;
  }
  const split = rows.map((r) => r.map((cell) => cell.split("\n")));
  const widths = headers.map((h, i) => Math.max(h.length, ...split.map((r) => Math.max(...r[i].map((l) => l.length)))));
  const total = widths.reduce((a, w) => a + w + 2, 0) + widths.length - 1;
  const out: string[] = [];
  if (!opts.tuplesOnly) {
    if (opts.title) out.push(rep(" ", Math.floor((total - opts.title.length) / 2)) + opts.title);
    out.push(
      headers
        .map((h, i) => {
          const left = Math.floor((widths[i] - h.length) / 2);
          return " " + rep(" ", left) + h + rep(" ", widths[i] - h.length - left) + " ";
        })
        .join("|"),
    );
    out.push(widths.map((w) => rep("-", w + 2)).join("+"));
  }
  const last = headers.length - 1;
  for (const r of split) {
    const height = Math.max(...r.map((c) => c.length));
    for (let line = 0; line < height; line++) {
      let s = "";
      r.forEach((cell, i) => {
        const text = cell[line] ?? "";
        const more = line < cell.length - 1;
        const padded = opts.right?.includes(i) ? rep(" ", widths[i] - text.length) + text : text + rep(" ", widths[i] - text.length);
        if (i === last) s += " " + (more ? padded + "+" : padded.replace(/\s+$/, ""));
        else s += " " + padded + (more ? "+" : " ") + "|";
      });
      out.push(s);
    }
  }
  if (!opts.tuplesOnly) out.push(`(${rows.length} ${rows.length === 1 ? "row" : "rows"})`, "");
  return out;
}

/** An error with LINE 1 and a caret under the bad word, the way psql shows it. */
export function pgError(msg: string, opts: { sql?: string; pos?: number; detail?: string; hint?: string } = {}): string[] {
  const out = [`ERROR:  ${msg}`];
  if (opts.sql !== undefined && opts.pos !== undefined && opts.pos >= 0) {
    const line = opts.sql.split("\n")[0];
    out.push(`LINE 1: ${line}`, rep(" ", 8 + opts.pos) + "^");
  }
  if (opts.detail) out.push(`DETAIL:  ${opts.detail}`);
  if (opts.hint) out.push(`HINT:  ${opts.hint}`);
  return out;
}
