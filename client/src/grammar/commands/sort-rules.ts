import type { Rule } from "../../types.ts";
import type { GrammarDialect } from "../dialects.ts";
import { parseGrammar } from "../grammar.ts";
import { LineIndex } from "../line-index.ts";
import { layoutGrammar } from "../rule-layout.ts";
import { normalizeSymbolName } from "../symbol-table.ts";
import { firstBlockingProblem } from "./parse-gate.ts";
import { computeRuleBlocks } from "./rule-blocks.ts";

/**
 * How `sortRules` orders rules.
 */
export type SortMode = "alphabetical" | "dependency";

/**
 * Offset range of the user's selection.
 */
export interface SortSelection {
  start: number;
  end: number;
}

/**
 * One replacement of `text.slice(start, end)`.
 */
export interface SortEdit {
  start: number;
  end: number;
  newText: string;
}

/**
 * Outcome of sorting. `changed: false` carries no edit.
 */
export type SortResult =
  | { ok: true; changed: false; text: string }
  | { ok: true; changed: true; text: string; edit: SortEdit }
  | { ok: false; reason: string };

const ANGLE_NAME_RE = /^<(.*)>$/s;

function sortKey(name: string, dialect: GrammarDialect): string {
  const inner = ANGLE_NAME_RE.exec(name)?.[1] ?? name;
  return normalizeSymbolName(inner, dialect);
}

function compareText(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/** Case-insensitive first; names that differ only by case then compare by code unit. */
function compareKeys(a: string, b: string): number {
  return compareText(a.toLowerCase(), b.toLowerCase()) || compareText(a, b);
}

/**
 * Selected rules: those with a line inside the selection. A selection that
 * ends at the start of a line does not include that line.
 */
function selectedRuleIndexes(
  text: string,
  selection: SortSelection,
  rules: ReadonlyArray<{ startLine: number; endLine: number }>,
): number[] {
  const lines = new LineIndex(text);
  const first = lines.lineAt(selection.start);
  let last = lines.lineAt(selection.end);
  if (
    selection.end > selection.start &&
    selection.end === (lines.starts[last] ?? 0)
  ) {
    last = Math.max(first, last - 1);
  }
  const picked: number[] = [];
  for (const [index, rule] of rules.entries()) {
    if (rule.startLine <= last && rule.endLine >= first) {
      picked.push(index);
    }
  }
  return picked;
}

/**
 * Sorts the rules of a document and returns the new text and one edit.
 *
 * - A rule moves together with the comment lines directly above it.
 * - `=/` parts stay right after their base rule.
 * - With a selection, only the rules it touches are reordered; they trade
 *   places among their own positions and everything else stays put. With
 *   several selections, each one is sorted on its own; selections that touch
 *   the same rule count as one.
 * - Rules defined twice (with `=`) are refused.
 * - Text between blocks (blank lines, free-standing comments) stays where it
 *   is, so the layout of the file does not change.
 * - Documents with parse problems are refused.
 */
export function sortRules(
  text: string,
  dialect: GrammarDialect,
  mode: SortMode,
  selection?: SortSelection | readonly SortSelection[],
): SortResult {
  const document = parseGrammar(text, dialect);
  const problem = firstBlockingProblem(document.diagnostics);
  if (problem) {
    return { ok: false, reason: `The document has parse errors (${problem})` };
  }
  const layout = layoutGrammar(text, dialect);
  const rules = document.rules;
  if (layout.rules.length !== rules.length) {
    return { ok: false, reason: "The rules could not be located" };
  }
  const blocks = computeRuleBlocks(text, layout);
  if (!blocks) {
    return { ok: false, reason: "Two rules share a line" };
  }
  if (rules.length === 0) {
    return { ok: true, changed: false, text };
  }

  const keys = rules.map((rule) => normalizeSymbolName(rule.name, dialect));
  const defined = new Set<string>();
  for (const [index, rule] of rules.entries()) {
    const key = keys[index] as string;
    if (!rule.isIncremental && defined.has(key)) {
      return {
        ok: false,
        reason: `Rule "${rule.name}" has more than one definition`,
      };
    }
    if (!rule.isIncremental) {
      defined.add(key);
    }
  }
  const baseOf = new Map<string, number>();
  for (const [index, rule] of rules.entries()) {
    const key = keys[index] as string;
    if (!(rule.isIncremental || baseOf.has(key))) {
      baseOf.set(key, index);
    }
  }
  // group id = index of the base rule; `=/` parts join the base of their name
  const groupOf = rules.map((rule, index) => {
    const base = baseOf.get(keys[index] as string);
    return rule.isIncremental && base !== undefined ? base : index;
  });
  const members = new Map<number, number[]>();
  for (const [index, group] of groupOf.entries()) {
    const list = members.get(group);
    if (list) {
      list.push(index);
    } else {
      members.set(group, [index]);
    }
  }
  for (const [group, list] of members) {
    members.set(group, [group, ...list.filter((i) => i !== group)]);
  }

  let sets: number[][];
  if (selection) {
    const list = Array.isArray(selection) ? selection : [selection];
    const touched = list.map((one) =>
      selectedRuleIndexes(text, one, layout.rules).map(
        (i) => groupOf[i] as number,
      ),
    );
    if (touched.every((groups) => groups.length === 0)) {
      return { ok: false, reason: "The selection contains no rule" };
    }
    sets = mergeOverlapping(touched.filter((groups) => groups.length > 0));
  } else {
    sets = [[...members.keys()]];
  }

  const assigned = blocks.map((_, i) => i);
  for (const set of sets) {
    const selectedGroups = [...set].sort((a, b) => a - b);
    const ordered =
      mode === "alphabetical"
        ? alphabetical(selectedGroups, rules, dialect)
        : dependencyOrder(selectedGroups, members, rules, dialect);
    const slots = selectedGroups
      .flatMap((group) => members.get(group) as number[])
      .sort((a, b) => a - b);
    const sequence = ordered.flatMap((group) => members.get(group) as number[]);
    for (const [k, slot] of slots.entries()) {
      assigned[slot] = sequence[k] as number;
    }
  }

  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  if (!(first && last)) {
    return { ok: true, changed: false, text };
  }
  let out = text.slice(0, first.start);
  for (const [i, block] of blocks.entries()) {
    const source = blocks[assigned[i] as number] ?? block;
    out += text.slice(source.start, source.end);
    const next = blocks[i + 1];
    out += text.slice(block.end, next ? next.start : text.length);
  }
  return finish(text, out);
}

/** Joins lists of groups that share a group, so each rule is sorted once. */
function mergeOverlapping(lists: readonly number[][]): number[][] {
  const sets: Array<Set<number>> = [];
  for (const list of lists) {
    const joined = new Set(list);
    for (let i = sets.length - 1; i >= 0; i--) {
      const other = sets[i] as Set<number>;
      if (list.some((group) => other.has(group))) {
        for (const group of other) {
          joined.add(group);
        }
        sets.splice(i, 1);
      }
    }
    sets.push(joined);
  }
  return sets.map((set) => [...set]);
}

function alphabetical(
  groups: readonly number[],
  rules: readonly Rule[],
  dialect: GrammarDialect,
): number[] {
  const keyed = groups.map((group, position) => ({
    group,
    position,
    key: sortKey((rules[group] as Rule).name, dialect),
  }));
  keyed.sort((a, b) => compareKeys(a.key, b.key) || a.position - b.position);
  return keyed.map((entry) => entry.group);
}

/**
 * Breadth-first from the first selected rule through references; rules the
 * search does not reach keep their source order at the end.
 */
function dependencyOrder(
  groups: readonly number[],
  members: ReadonlyMap<number, number[]>,
  rules: readonly Rule[],
  dialect: GrammarDialect,
): number[] {
  const groupByKey = new Map<string, number>();
  for (const group of groups) {
    for (const index of members.get(group) as number[]) {
      const name = (rules[index] as Rule).name;
      const key = normalizeSymbolName(name, dialect);
      if (!groupByKey.has(key)) {
        groupByKey.set(key, group);
      }
    }
  }
  const seen = new Set<number>();
  const order: number[] = [];
  const start = groups[0];
  if (start === undefined) {
    return order;
  }
  seen.add(start);
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const group = queue[head] as number;
    order.push(group);
    for (const index of members.get(group) as number[]) {
      for (const ref of (rules[index] as Rule).references) {
        const target = groupByKey.get(normalizeSymbolName(ref.name, dialect));
        if (target !== undefined && !seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
      }
    }
  }
  return order.concat(groups.filter((group) => !seen.has(group)));
}

function finish(text: string, out: string): SortResult {
  if (out === text) {
    return { ok: true, changed: false, text };
  }
  let prefix = 0;
  const limit = Math.min(text.length, out.length);
  while (prefix < limit && text[prefix] === out[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    text[text.length - 1 - suffix] === out[out.length - 1 - suffix]
  ) {
    suffix++;
  }
  return {
    ok: true,
    changed: true,
    text: out,
    edit: {
      start: prefix,
      end: text.length - suffix,
      newText: out.slice(prefix, out.length - suffix),
    },
  };
}
