import { CORE_RULE_DEFINITIONS, CORE_RULES } from "../../abnf/core-rules.ts";
import { appendAll } from "../../append-all.ts";
import {
  type GrammarDialect,
  getGrammarDialectDescriptor,
} from "../dialects.ts";
import { parseGrammar } from "../grammar.ts";
import { normalizeSymbolName } from "../symbol-table.ts";
import {
  type CDoc,
  type CNode,
  type CRule,
  collectRefs,
  mkAlt,
  type Paragraph,
} from "./convert-ast.ts";
import { firstBlockingProblem } from "./parse-gate.ts";
import { ReadFailure, readAbnf } from "./read-abnf.ts";
import { readProduction } from "./read-production.ts";
import { GrammarWriter } from "./write-grammar.ts";

/**
 * Options of `convertDialect`.
 */
export interface ConvertOptions {
  /** Formats the converted text, for example with the user's settings. */
  format?: (text: string, target: GrammarDialect) => string;
}

/**
 * Outcome of a conversion. `warnings` lists everything that is not exact.
 */
export type ConvertResult =
  | { ok: true; text: string; warnings: string[] }
  | { ok: false; reason: string };

interface MergedRule {
  name: string;
  body: CNode;
  leading: Paragraph[];
  trailing: string | undefined;
}

const ABNF_BAD_RE = /[^A-Za-z0-9-]/g;
const EBNF_BAD_RE = /[^A-Za-z0-9_.:-]/g;
const BNF_BAD_RE = /[<>\r\n]/g;

function displayName(dialect: GrammarDialect): string {
  return getGrammarDialectDescriptor(dialect).displayName;
}

function sanitizeName(name: string, target: GrammarDialect): string {
  let out: string;
  switch (target) {
    case "abnf":
      out = name.replace(ABNF_BAD_RE, "-");
      return /^[A-Za-z]/.test(out) ? out : `r-${out}`;
    case "ebnf":
      out = name.replace(EBNF_BAD_RE, "-").replace(/[.:-]+$/, "");
      if (out === "") {
        return "rule";
      }
      return /^[A-Za-z_]/.test(out) ? out : `r-${out}`;
    default:
      out = name.replace(BNF_BAD_RE, "-").trim();
      return out === "" ? "rule" : out;
  }
}

/**
 * Merges `=/` parts and repeated definitions into the first definition of
 * their name, as alternatives.
 */
function mergeRules(
  doc: CDoc,
  source: GrammarDialect,
  warnings: string[],
): MergedRule[] {
  const merged: MergedRule[] = [];
  const byKey = new Map<string, MergedRule>();
  const bodies = new Map<MergedRule, CNode[]>();
  const repeated = new Set<string>();
  for (const rule of doc.rules) {
    const key = normalizeSymbolName(rule.name, source);
    const existing = byKey.get(key);
    if (!existing) {
      const entry: MergedRule = {
        name: rule.name,
        body: rule.body,
        leading: [...rule.leading],
        trailing: rule.trailing,
      };
      byKey.set(key, entry);
      bodies.set(entry, [rule.body]);
      merged.push(entry);
      continue;
    }
    bodies.get(existing)?.push(rule.body);
    appendAll(existing.leading, rule.leading);
    if (rule.trailing) {
      existing.trailing = existing.trailing
        ? `${existing.trailing} ${rule.trailing}`
        : rule.trailing;
    }
    if (!rule.incremental) {
      repeated.add(existing.name);
    }
  }
  for (const entry of merged) {
    const parts = bodies.get(entry) as CNode[];
    if (parts.length > 1) {
      entry.body = mkAlt(parts);
    }
  }
  for (const name of repeated) {
    warnings.push(
      `rule "${name}" is defined more than once; merged as alternatives`,
    );
  }
  return merged;
}

/**
 * ABNF core rules the document uses without defining them, in core order.
 */
function neededCoreRules(rules: readonly CRule[]): CRule[] {
  const defined = new Set(rules.map((rule) => rule.name.toLowerCase()));
  const core = readAbnf(
    `${CORE_RULE_DEFINITIONS.map((rule) => `${rule.name} = ${rule.definitionText}`).join("\n")}\n`,
  ).rules;
  const byName = new Map(core.map((rule) => [rule.name.toLowerCase(), rule]));
  const needed = new Set<string>();
  const queue = rules.flatMap((rule) => collectRefs(rule.body));
  while (queue.length > 0) {
    const key = (queue.pop() as string).toLowerCase();
    const rule = byName.get(key);
    if (defined.has(key) || needed.has(key) || !(rule && CORE_RULES.has(key))) {
      continue;
    }
    needed.add(key);
    appendAll(queue, collectRefs(rule.body));
  }
  const picked = core.filter((rule) => needed.has(rule.name.toLowerCase()));
  const first = picked[0];
  if (first) {
    first.leading = [
      {
        lines: ["ABNF core rules (RFC 5234, Appendix B) used above"],
        attached: true,
      },
    ];
  }
  return picked;
}

function commentLine(text: string, target: GrammarDialect): string {
  if (target === "ebnf") {
    return `/* ${text.replace(/\*\//g, "* /")} */`.replace("/*  */", "/* */");
  }
  return text === "" ? ";" : `; ${text}`;
}

function paragraphLines(
  paragraphs: readonly Paragraph[],
  target: GrammarDialect,
): string[] {
  const out: string[] = [];
  for (const paragraph of paragraphs) {
    for (const line of paragraph.lines) {
      out.push(commentLine(line, target));
    }
    if (!paragraph.attached) {
      out.push("");
    }
  }
  return out;
}

/**
 * Converts grammar text from one dialect to another through the neutral
 * tree. The source text is never changed. Constructs the target cannot
 * express are kept as text with a note above the rule, and each one is
 * listed in `warnings`.
 */
export function convertDialect(
  text: string,
  source: GrammarDialect,
  target: GrammarDialect,
  options: ConvertOptions = {},
): ConvertResult {
  if (source === target) {
    return {
      ok: false,
      reason: "The source is already written in that dialect",
    };
  }
  const problem = firstBlockingProblem(parseGrammar(text, source).diagnostics);
  if (problem) {
    return { ok: false, reason: `The document has parse errors (${problem})` };
  }
  let doc: CDoc;
  try {
    doc = source === "abnf" ? readAbnf(text) : readProduction(text, source);
  } catch (error) {
    if (error instanceof ReadFailure) {
      return { ok: false, reason: error.message };
    }
    throw error;
  }
  if (doc.rules.length === 0) {
    return { ok: false, reason: "The document has no rules to convert" };
  }
  const warnings = [...doc.warnings];
  const rules = mergeRules(doc, source, warnings);
  if (source === "abnf" && target !== "abnf") {
    for (const core of neededCoreRules(rules.map(asCRule))) {
      rules.push({
        name: core.name,
        body: core.body,
        leading: core.leading,
        trailing: undefined,
      });
    }
  }

  const names = new NameTable(source, target, warnings);
  names.defineAll(rules);
  const bodyByKey = new Map(
    rules.map((rule) => [normalizeSymbolName(rule.name, source), rule.body]),
  );
  const writer = new GrammarWriter({
    target,
    resolve: (name) => names.resolve(name),
    allocate: (base) => names.allocateHelper(base),
    lookup: (name) => bodyByKey.get(normalizeSymbolName(name, source)),
  });
  const operator = getGrammarDialectDescriptor(target).assignmentOperator;
  const blocks: string[] = [];
  for (const rule of rules) {
    const bare = names.resolve(rule.name);
    const written = writer.writeRule(bare, rule.body);
    const lines = paragraphLines(rule.leading, target);
    for (const note of written.notes) {
      lines.push(commentLine(`note: ${note}`, target));
      warnings.push(`${rule.name}: ${note}`);
    }
    const trailing = rule.trailing
      ? ` ${commentLine(rule.trailing, target)}`
      : "";
    lines.push(
      `${writer.refText(bare)} ${operator} ${written.body}${trailing}`,
    );
    for (const helper of written.helpers) {
      lines.push(`${writer.refText(helper.name)} ${operator} ${helper.body}`);
    }
    blocks.push(lines.join("\n"));
  }
  let out = blocks.join("\n\n");
  if (doc.tail.length > 0) {
    out += `\n\n${paragraphLines(doc.tail, target).join("\n").trimEnd()}`;
  }
  out += "\n";
  if (options.format) {
    out = options.format(out, target);
  }
  const outProblem = firstBlockingProblem(
    parseGrammar(out, target).diagnostics,
  );
  if (outProblem) {
    warnings.push(`the converted text has a parse problem (${outProblem})`);
  }
  return { ok: true, text: out, warnings };
}

function asCRule(rule: MergedRule): CRule {
  return {
    name: rule.name,
    incremental: false,
    body: rule.body,
    leading: rule.leading,
    trailing: rule.trailing,
  };
}

/**
 * Maps source rule names to unique names in the target dialect.
 */
class NameTable {
  readonly #source: GrammarDialect;
  readonly #target: GrammarDialect;
  readonly #warnings: string[];
  readonly #map = new Map<string, string>();
  readonly #used = new Set<string>();

  constructor(
    source: GrammarDialect,
    target: GrammarDialect,
    warnings: string[],
  ) {
    this.#source = source;
    this.#target = target;
    this.#warnings = warnings;
  }

  #key(name: string): string {
    return normalizeSymbolName(name, this.#source);
  }

  #targetKey(name: string): string {
    return normalizeSymbolName(name, this.#target);
  }

  #unique(wanted: string): string {
    let candidate = wanted;
    for (let n = 2; this.#used.has(this.#targetKey(candidate)); n++) {
      candidate = `${wanted}-${n}`;
    }
    this.#used.add(this.#targetKey(candidate));
    return candidate;
  }

  /** Names every rule, then every reference to an undefined rule. */
  defineAll(rules: readonly MergedRule[]): void {
    for (const rule of rules) {
      this.#define(rule.name);
    }
    for (const rule of rules) {
      for (const name of collectRefs(rule.body)) {
        if (!this.#map.has(this.#key(name))) {
          this.#define(name);
        }
      }
    }
    this.#reportCaseClashes(rules);
  }

  #define(name: string): void {
    const wanted = sanitizeName(name, this.#target);
    const unique = this.#unique(wanted);
    this.#map.set(this.#key(name), unique);
    if (unique !== name) {
      const why =
        wanted !== name
          ? `is not a valid ${displayName(this.#target)} name`
          : "clashes with another name";
      this.#warnings.push(`"${name}" ${why}; written as "${unique}"`);
    }
  }

  /** ABNF names that differ only by case become one name in other dialects. */
  #reportCaseClashes(rules: readonly MergedRule[]): void {
    if (this.#source !== "abnf" || this.#target === "abnf") {
      return;
    }
    const spellings = new Map<string, Set<string>>();
    const add = (name: string): void => {
      const key = this.#key(name);
      const set = spellings.get(key);
      if (set) {
        set.add(name);
      } else {
        spellings.set(key, new Set([name]));
      }
    };
    for (const rule of rules) {
      add(rule.name);
      for (const name of collectRefs(rule.body)) {
        add(name);
      }
    }
    for (const [key, set] of spellings) {
      if (set.size > 1) {
        const list = [...set].map((name) => `"${name}"`).join(", ");
        this.#warnings.push(
          `names ${list} differ only by case; ABNF treats them as one name, written as "${this.#map.get(key)}"`,
        );
      }
    }
  }

  resolve(name: string): string {
    return this.#map.get(this.#key(name)) ?? sanitizeName(name, this.#target);
  }

  allocateHelper(base: string): string {
    return this.#unique(sanitizeName(base, this.#target));
  }
}
