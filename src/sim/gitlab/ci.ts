// .gitlab-ci.yml: parse it, check it the way GitLab does (same error wording), and decide
// which jobs a pipeline gets for a ref (rules, only/except, when).
import { parseDocument } from "yaml";
import type { CiJobSpec, CiRule, CiService, JobWhen } from "./types";

export interface CiConfig {
  /** Every stage including .pre and .post. */
  stages: string[];
  variables: Record<string, string>;
  jobs: CiJobSpec[];
  workflowRules?: CiRule[];
}

export interface CiParse {
  ok: boolean;
  errors: string[];
  config?: CiConfig;
}

const GLOBAL_KEYS = ["default", "include", "stages", "variables", "workflow", "image", "services", "before_script", "after_script", "cache"];
const DEFAULT_KEYS = ["image", "services", "before_script", "after_script", "cache", "artifacts", "tags", "retry", "timeout", "interruptible", "hooks", "id_tokens"];
const JOB_KEYS = [
  "script",
  "run",
  "before_script",
  "after_script",
  "image",
  "services",
  "stage",
  "variables",
  "rules",
  "when",
  "needs",
  "artifacts",
  "tags",
  "extends",
  "allow_failure",
  "cache",
  "dependencies",
  "environment",
  "only",
  "except",
  "timeout",
  "retry",
  "interruptible",
  "coverage",
  "parallel",
  "resource_group",
  "release",
  "trigger",
  "inherit",
  "id_tokens",
  "secrets",
  "pages",
  "hooks",
  "start_in",
  "manual_confirmation",
  "identity",
];
const WHENS: JobWhen[] = ["on_success", "on_failure", "always", "manual", "never", "delayed"];
const ARTIFACT_KEYS = ["paths", "expire_in", "when", "name", "untracked", "reports", "exclude", "expose_as", "public", "access"];
const RULE_KEYS = ["if", "when", "allow_failure", "variables", "changes", "exists", "needs", "start_in", "interruptible"];
const DEFAULT_STAGES = ["build", "test", "deploy"];

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

/** script: a string, or a list of strings (nested lists flatten, like GitLab). */
function scriptList(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [String(v)];
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const x of v) {
    if (Array.isArray(x)) {
      const inner = scriptList(x);
      if (!inner) return undefined;
      out.push(...inner);
    } else if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") out.push(String(x));
    else return undefined;
  }
  return out;
}

function varsOf(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObj(v)) return out;
  for (const [k, x] of Object.entries(v)) out[k] = isObj(x) ? str(x.value) : str(x);
  return out;
}

function servicesOf(v: unknown): CiService[] {
  if (!Array.isArray(v)) return [];
  return v.map((s) => (isObj(s) ? { name: str(s.name), ...(s.alias ? { alias: str(s.alias) } : {}) } : { name: str(s) }));
}

function imageOf(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return isObj(v) ? str(v.name) : str(v);
}

function listOf(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.map((x) => (isObj(x) ? str(x.job ?? x.name ?? "") : str(x)));
  return [str(v)];
}

function rulesOf(v: unknown, where: string, errors: string[]): CiRule[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    errors.push(`${where}:rules config should be an array of hashes`);
    return [];
  }
  const out: CiRule[] = [];
  for (const r of v) {
    if (!isObj(r)) {
      errors.push(`${where}:rules:rule config should be a hash`);
      continue;
    }
    const unknown = Object.keys(r).filter((k) => !RULE_KEYS.includes(k));
    if (unknown.length) errors.push(`${where}:rules:rule config contains unknown keys: ${unknown.join(", ")}`);
    const rule: CiRule = {};
    if (r.if !== undefined) {
      rule.if = str(r.if);
      if (!exprValid(rule.if)) errors.push(`${where}:rules:rule if invalid expression syntax`);
    }
    if (r.when !== undefined) {
      if (!WHENS.includes(str(r.when) as JobWhen)) errors.push(`${where}:rules:rule when unknown value: ${str(r.when)}`);
      rule.when = str(r.when) as JobWhen;
    }
    if (r.allow_failure !== undefined) rule.allowFailure = !!r.allow_failure;
    if (r.variables !== undefined) rule.variables = varsOf(r.variables);
    if (r.changes !== undefined) rule.changes = true;
    if (r.exists !== undefined) rule.exists = true;
    out.push(rule);
  }
  return out;
}

function deepMerge(base: Obj, over: Obj): Obj {
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k] as Obj, v) : v;
  return out;
}

/** GitLab passes YAML errors through Psych, so they read like Ruby's. */
function yamlError(text: string, e: { message: string; code?: string; pos?: [number, number]; linePos?: [{ line: number; col: number }, ...unknown[]] }): string {
  let pos = e.linePos?.[0];
  if (!pos && e.pos) {
    const before = text.slice(0, Math.min(e.pos[0], text.length)).split("\n");
    pos = { line: before.length, col: before[before.length - 1].length + 1 };
  }
  const where = pos ? ` at line ${pos.line} column ${pos.col}` : "";
  let what = "did not find expected key while parsing a block mapping";
  if (e.code === "BLOCK_AS_IMPLICIT_KEY" || /mapping values|Nested mappings/i.test(e.message)) what = "mapping values are not allowed in this context";
  else if (e.code === "TAB_AS_INDENT") what = "found character that cannot start any token while scanning for the next token";
  else if (e.code === "DUPLICATE_KEY") what = "found duplicate key while parsing a block mapping";
  else if (/flow|unexpected end|missing/i.test(e.message)) what = "did not find expected node content while parsing a flow node";
  return `(<unknown>): ${what}${where}`;
}

/** Parse and validate .gitlab-ci.yml. Errors use GitLab's wording. */
export function parseCi(text: string): CiParse {
  const errors: string[] = [];
  const doc = parseDocument(text, { prettyErrors: false, uniqueKeys: true });
  if (doc.errors.length) return { ok: false, errors: [yamlError(text, doc.errors[0] as never)] };
  const data = doc.toJS({ maxAliasCount: 100 }) as unknown;
  if (!isObj(data)) return { ok: false, errors: ["Invalid configuration format"] };

  const def: Obj = isObj(data.default) ? { ...data.default } : {};
  if (data.default !== undefined) {
    if (!isObj(data.default)) errors.push("default config should be a hash");
    else {
      const unknown = Object.keys(data.default).filter((k) => !DEFAULT_KEYS.includes(k));
      if (unknown.length) errors.push(`default config contains unknown keys: ${unknown.join(", ")}`);
    }
  }
  // Old style globals (image:, services:, before_script: at the top) still work as defaults.
  for (const k of ["image", "services", "before_script", "after_script", "cache"]) if (data[k] !== undefined && def[k] === undefined) def[k] = data[k];

  let stages = DEFAULT_STAGES;
  if (data.stages !== undefined) {
    if (!Array.isArray(data.stages)) errors.push("stages config should be an array of strings");
    else stages = data.stages.map(str);
  }
  const allStages = [".pre", ...stages.filter((s) => s !== ".pre" && s !== ".post"), ".post"];
  const variables = varsOf(data.variables);
  let workflowRules: CiRule[] | undefined;
  if (isObj(data.workflow)) workflowRules = rulesOf(data.workflow.rules, "workflow", errors);

  const raw: Record<string, Obj> = {};
  for (const [name, v] of Object.entries(data)) {
    if (GLOBAL_KEYS.includes(name)) continue;
    if (!isObj(v)) {
      errors.push(`jobs:${name} config should be a hash`);
      continue;
    }
    raw[name] = v;
  }

  const resolve = (name: string, seen: string[]): Obj | undefined => {
    const v = raw[name];
    if (!v) return undefined;
    const ext = listOf(v.extends);
    let merged: Obj = {};
    for (const e of ext) {
      if (seen.includes(e)) {
        errors.push(`${name}: circular dependency detected in \`extends\``);
        return v;
      }
      const base = resolve(e, [...seen, e]);
      if (!base) {
        errors.push(`${name}: unknown keys in \`extends\` (${e})`);
        continue;
      }
      merged = deepMerge(merged, base);
    }
    const own = { ...v };
    delete own.extends;
    return deepMerge(merged, own);
  };

  const jobs: CiJobSpec[] = [];
  for (const name of Object.keys(raw)) {
    if (name.startsWith(".")) continue;
    const j = resolve(name, [name]) ?? {};
    const where = `jobs:${name}`;
    const unknown = Object.keys(raw[name]).filter((k) => !JOB_KEYS.includes(k));
    if (unknown.length) {
      errors.push(`${where} config contains unknown keys: ${unknown.join(", ")}`);
      continue;
    }
    if (j.script === undefined && j.run === undefined && j.trigger === undefined) {
      errors.push(`${where} config should implement the script:, run:, or trigger: keyword`);
      continue;
    }
    const script = scriptList(j.script);
    if (j.script !== undefined && !script) {
      errors.push(`${where}:script config should be a string or a nested array of strings up to 10 levels deep`);
      continue;
    }
    const before = scriptList(j.before_script ?? def.before_script) ?? [];
    const after = scriptList(j.after_script ?? def.after_script) ?? [];
    const stage = j.stage === undefined ? "test" : str(j.stage);
    if (!allStages.includes(stage)) {
      errors.push(`${name} job: chosen stage ${stage} does not exist; available stages are ${allStages.join(", ")}`);
      continue;
    }
    const when = (j.when === undefined ? "on_success" : str(j.when)) as JobWhen;
    if (!WHENS.includes(when)) {
      errors.push(`${where} when unknown value: ${str(j.when)}`);
      continue;
    }
    let artifacts: CiJobSpec["artifacts"];
    const art = j.artifacts ?? def.artifacts;
    if (art !== undefined) {
      if (!isObj(art)) errors.push(`${where}:artifacts config should be a hash`);
      else {
        const bad = Object.keys(art).filter((k) => !ARTIFACT_KEYS.includes(k));
        if (bad.length) errors.push(`${where}:artifacts config contains unknown keys: ${bad.join(", ")}`);
        artifacts = { paths: listOf(art.paths), ...(art.when ? { when: str(art.when) as "on_success" } : {}) };
      }
    }
    const rules = rulesOf(j.rules, where, errors);
    if (rules && (j.only !== undefined || j.except !== undefined)) errors.push(`${where} may not use rules with only, except`);
    const onlyRaw = isObj(j.only) ? j.only.refs : j.only;
    const exceptRaw = isObj(j.except) ? j.except.refs : j.except;
    const manualDefault = when === "manual";
    jobs.push({
      name,
      stage,
      image: imageOf(j.image ?? def.image),
      services: servicesOf(j.services ?? def.services),
      variables: varsOf(j.variables),
      beforeScript: before,
      script: script ?? [],
      afterScript: after,
      ...(rules ? { rules } : {}),
      ...(onlyRaw !== undefined ? { only: listOf(onlyRaw) } : {}),
      ...(exceptRaw !== undefined ? { except: listOf(exceptRaw) } : {}),
      when,
      ...(j.needs !== undefined ? { needs: listOf(j.needs) } : {}),
      ...(artifacts ? { artifacts } : {}),
      tags: listOf(j.tags ?? def.tags),
      // A job-level when: manual is allowed to fail by default; everything else is not.
      allowFailure: j.allow_failure === undefined ? manualDefault : isObj(j.allow_failure) ? true : !!j.allow_failure,
      ...(j.environment !== undefined ? { environment: isObj(j.environment) ? str(j.environment.name) : str(j.environment) } : {}),
    });
  }
  if (!errors.length && !jobs.length) errors.push("jobs config should contain at least one visible job");
  if (errors.length) return { ok: false, errors };
  return { ok: true, errors: [], config: { stages: allStages, variables, jobs, ...(workflowRules ? { workflowRules } : {}) } };
}

// ---------- rules:if expressions ----------

type Tok = { t: "var"; v: string } | { t: "str"; v: string } | { t: "re"; v: RegExp } | { t: "null" } | { t: "op"; v: string };

function lex(src: string): Tok[] | undefined {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "$") {
      const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/.exec(src.slice(i));
      if (!m) return undefined;
      out.push({ t: "var", v: m[1] });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1);
      if (end < 0) return undefined;
      out.push({ t: "str", v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (c === "/") {
      const m = /^\/((?:\\.|[^/\\])*)\/([a-z]*)/.exec(src.slice(i));
      if (!m) return undefined;
      try {
        out.push({ t: "re", v: new RegExp(m[1], m[2].replace(/[^imsu]/g, "")) });
      } catch {
        return undefined;
      }
      i += m[0].length;
      continue;
    }
    const op = ["==", "!=", "=~", "!~", "&&", "||", "(", ")"].find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ t: "op", v: op });
      i += op.length;
      continue;
    }
    if (src.startsWith("null", i)) {
      out.push({ t: "null" });
      i += 4;
      continue;
    }
    return undefined;
  }
  return out;
}

type Val = string | null | RegExp;

/** Evaluate a rules:if expression. Undefined variables are null; a bare $VAR is true when set and not empty. */
export function evalExpr(src: string, vars: Record<string, string>): boolean {
  const toks = lex(src);
  if (!toks) return false;
  let i = 0;
  const peek = () => toks[i];
  const value = (): Val => {
    const t = toks[i++];
    if (!t) throw new Error("eof");
    if (t.t === "var") return t.v in vars ? vars[t.v] : null;
    if (t.t === "str") return t.v;
    if (t.t === "re") return t.v;
    if (t.t === "null") return null;
    throw new Error("unexpected");
  };
  const truthy = (v: Val) => v !== null && v !== "";
  const cmp = (): boolean => {
    const t = peek();
    if (t?.t === "op" && t.v === "(") {
      i++;
      const r = or();
      const close = toks[i++];
      if (!close || close.t !== "op" || close.v !== ")") throw new Error("paren");
      return r;
    }
    const a = value();
    const o = peek();
    if (o?.t === "op" && ["==", "!=", "=~", "!~"].includes(o.v)) {
      i++;
      const b = value();
      if (o.v === "==") return a === b;
      if (o.v === "!=") return a !== b;
      const re = b instanceof RegExp ? b : a instanceof RegExp ? a : null;
      const s = b instanceof RegExp ? a : b;
      const hit = !!re && typeof s === "string" && re.test(s);
      return o.v === "=~" ? hit : !hit;
    }
    return truthy(a);
  };
  const and = (): boolean => {
    let r = cmp();
    while (peek()?.t === "op" && (peek() as { v: string }).v === "&&") {
      i++;
      const b = cmp();
      r = r && b;
    }
    return r;
  };
  const or = (): boolean => {
    let r = and();
    while (peek()?.t === "op" && (peek() as { v: string }).v === "||") {
      i++;
      const b = and();
      r = r || b;
    }
    return r;
  };
  try {
    const r = or();
    return i === toks.length ? r : false;
  } catch {
    return false;
  }
}

function exprValid(src: string): boolean {
  const toks = lex(src);
  if (!toks || !toks.length) return false;
  let depth = 0;
  let expectValue = true;
  for (const t of toks) {
    if (t.t === "op" && t.v === "(") {
      if (!expectValue) return false;
      depth++;
    } else if (t.t === "op" && t.v === ")") {
      if (expectValue) return false;
      depth--;
    } else if (t.t === "op") {
      if (expectValue) return false;
      expectValue = true;
    } else {
      if (!expectValue) return false;
      expectValue = false;
    }
    if (depth < 0) return false;
  }
  return depth === 0 && !expectValue;
}

// ---------- which jobs a pipeline gets ----------

export interface PlannedJob {
  spec: CiJobSpec;
  when: JobWhen;
  allowFailure: boolean;
}

export interface Plan {
  /** No pipeline at all (workflow:rules or every job filtered out). */
  none?: string;
  errors?: string[];
  jobs: PlannedJob[];
}

function refMatches(list: string[], ref: string, source: string): boolean {
  return list.some((p) => {
    if (p === "branches") return source !== "merge_request_event";
    if (p === "merge_requests") return source === "merge_request_event";
    if (p === "pushes") return source === "push";
    if (p === "web") return source === "web";
    if (p === "tags") return false;
    const re = /^\/(.*)\/([a-z]*)$/.exec(p);
    if (re) {
      try {
        return new RegExp(re[1], re[2]).test(ref);
      } catch {
        return false;
      }
    }
    return p === ref;
  });
}

/**
 * Decide the jobs for one pipeline. Rules see predefined variables, then the file's own
 * variables, then the project's CI/CD settings variables (those win, like in GitLab).
 */
export function planPipeline(cfg: CiConfig, predefined: Record<string, string>, project: Record<string, string>, ref: string, source: string): Plan {
  if (cfg.workflowRules) {
    const hit = cfg.workflowRules.find((r) => !r.if || evalExpr(r.if, { ...predefined, ...cfg.variables, ...project }));
    if (!hit || hit.when === "never") return { none: "Pipeline filtered out by workflow rules.", jobs: [] };
  }
  const jobs: PlannedJob[] = [];
  for (const spec of cfg.jobs) {
    let when = spec.when;
    let allowFailure = spec.allowFailure;
    let extraVars: Record<string, string> = {};
    if (spec.rules) {
      const hit = spec.rules.find((r) => !r.if || evalExpr(r.if, { ...predefined, ...cfg.variables, ...spec.variables, ...project }));
      if (!hit) continue;
      if (hit.when) when = hit.when;
      // A rule that says when: manual blocks the pipeline unless it also says allow_failure.
      allowFailure = hit.allowFailure ?? (hit.when === "manual" ? false : spec.allowFailure);
      extraVars = hit.variables ?? {};
    } else {
      const only = spec.only ?? ["branches", "tags"];
      if (!refMatches(only, ref, source)) continue;
      if (spec.except && refMatches(spec.except, ref, source)) continue;
    }
    if (when === "never") continue;
    jobs.push({ spec: { ...spec, variables: { ...spec.variables, ...extraVars } }, when, allowFailure });
  }
  if (!jobs.length) return { none: "The rules configuration prevented any jobs from being added to the pipeline.", jobs: [] };
  const names = new Set(jobs.map((j) => j.spec.name));
  const errors: string[] = [];
  for (const j of jobs) {
    for (const n of j.spec.needs ?? []) {
      if (!names.has(n)) {
        errors.push(
          `'${j.spec.name}' job needs '${n}' job, but '${n}' does not exist in the pipeline. This might be because of the only, except, or rules keywords. To need a job that sometimes does not exist in the pipeline, use needs:optional.`,
        );
      }
    }
  }
  if (errors.length) return { errors, jobs: [] };
  return { jobs };
}
