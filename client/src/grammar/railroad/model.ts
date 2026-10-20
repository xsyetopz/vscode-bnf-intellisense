import { appendAll } from "../../append-all.ts";

/**
 * Dialect-neutral railroad node tree. It keeps the source text of terminals
 * and names, unlike the derivation-only `Expr` of `../expression.ts`.
 */

export type TerminalKind =
  | "string"
  | "string-sensitive"
  | "numeric"
  | "range"
  | "class"
  | "prose"
  | "charcode"
  | "word"
  | "punct"
  | "note";

export type RailNode =
  | { kind: "empty" }
  | { kind: "seq"; items: RailNode[] }
  | { kind: "choice"; branches: RailNode[] }
  | { kind: "optional"; item: RailNode }
  /** `min` 0 or 1 or more repetitions of `item`; `max` null is unbounded. */
  | { kind: "loop"; item: RailNode; min: number; max: number | null }
  | { kind: "terminal"; text: string; terminal: TerminalKind; title?: string }
  | { kind: "nonterminal"; name: string }
  | { kind: "except"; base: RailNode; excluded: RailNode }
  | { kind: "error"; text: string };

export const EMPTY_NODE: RailNode = { kind: "empty" };

/**
 * Sequence of nodes; flattens nested sequences and drops empty items.
 */
export function seqOf(items: readonly RailNode[]): RailNode {
  const flat: RailNode[] = [];
  for (const item of items) {
    if (item.kind === "empty") {
      continue;
    }
    if (item.kind === "seq") {
      appendAll(flat, item.items);
    } else {
      flat.push(item);
    }
  }
  if (flat.length === 0) {
    return EMPTY_NODE;
  }
  return flat.length === 1
    ? (flat[0] as RailNode)
    : { kind: "seq", items: flat };
}

/**
 * Choice of nodes; flattens nested choices.
 */
export function choiceOf(branches: readonly RailNode[]): RailNode {
  const flat: RailNode[] = [];
  for (const branch of branches) {
    if (branch.kind === "choice") {
      appendAll(flat, branch.branches);
    } else {
      flat.push(branch);
    }
  }
  return flat.length === 1
    ? (flat[0] as RailNode)
    : { kind: "choice", branches: flat };
}

/**
 * Optional node; `[[x]]` and `[empty]` collapse.
 */
export function optionalOf(item: RailNode): RailNode {
  if (item.kind === "empty" || item.kind === "optional") {
    return item;
  }
  if (item.kind === "loop" && item.min === 0) {
    return item;
  }
  if (item.kind === "loop" && item.max === null) {
    return { kind: "loop", item: item.item, min: 0, max: null };
  }
  return { kind: "optional", item };
}

/**
 * Repetition of `item` between `min` and `max` (null is unbounded) times.
 * Stacked unbounded repeats such as `(a*)+` or `a?*` merge so a long run of
 * suffixes cannot build a deep tree.
 */
export function repeatOf(
  item: RailNode,
  min: number,
  max: number | null,
): RailNode {
  if (item.kind === "empty") {
    return item;
  }
  if (max !== null && max < min) {
    // Invalid bounds (already reported as a diagnostic); keep the written min.
    return { kind: "loop", item, min, max };
  }
  if (max === 0) {
    return {
      kind: "terminal",
      terminal: "note",
      text: "0×",
      title: "Repeated zero times: matches nothing",
    };
  }
  if (min === 1 && max === 1) {
    return item;
  }
  if (min === 0 && max === 1) {
    return optionalOf(item);
  }
  if (item.kind === "optional") {
    return repeatOf(item.item, 0, max);
  }
  if (item.kind === "loop" && item.max === null && max === null) {
    return {
      kind: "loop",
      item: item.item,
      min: item.min === 0 || min === 0 ? 0 : item.min * min,
      max: null,
    };
  }
  return { kind: "loop", item, min, max };
}
