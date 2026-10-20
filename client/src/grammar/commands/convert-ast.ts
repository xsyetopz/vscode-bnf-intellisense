import { appendAll } from "../../append-all.ts";

/**
 * Dialect-neutral grammar tree used by dialect conversion. Readers build it
 * from ABNF or production-grammar text; writers print it in a target dialect.
 */
export type CNode =
  | { kind: "alt"; items: CNode[] }
  | { kind: "seq"; items: CNode[] }
  | { kind: "rep"; min: number; max: number | null; item: CNode }
  | { kind: "ref"; name: string }
  /** `sensitive: false` is an ABNF string that ignores letter case. */
  | { kind: "str"; value: string; sensitive: boolean }
  /** A set of code points; `src` is the source text, for notes. */
  | { kind: "cls"; ranges: CharRange[]; negate: boolean; src: string }
  | { kind: "prose"; text: string }
  /** W3C `A - B`; `src` is the source text, for notes. */
  | { kind: "minus"; left: CNode; right: CNode; src: string }
  /** Source text with no structure the converter understands. */
  | { kind: "raw"; src: string };

/**
 * Inclusive range of code points.
 */
export type CharRange = readonly [number, number];

/**
 * Run of adjacent comment lines. `attached` means no blank line follows it,
 * so it documents the next rule.
 */
export interface Paragraph {
  lines: string[];
  attached: boolean;
}

/**
 * One rule as read from the source.
 */
export interface CRule {
  name: string;
  incremental: boolean;
  body: CNode;
  /** Comment paragraphs above the rule, as plain text lines. */
  leading: Paragraph[];
  /** Comment on the last line of the rule. */
  trailing: string | undefined;
}

/**
 * A whole document as read from the source.
 */
export interface CDoc {
  rules: CRule[];
  /** Comment paragraphs after the last rule. */
  tail: Paragraph[];
  /** Messages for things the reader could not carry over. */
  warnings: string[];
}

export const MAX_CODE_POINT = 0x10ffff;

export function mkSeq(items: CNode[]): CNode {
  const flat: CNode[] = [];
  for (const item of items) {
    if (item.kind === "seq") {
      appendAll(flat, item.items);
    } else {
      flat.push(item);
    }
  }
  return flat.length === 1 ? (flat[0] as CNode) : { kind: "seq", items: flat };
}

export function mkAlt(items: CNode[]): CNode {
  const flat: CNode[] = [];
  for (const item of items) {
    if (item.kind === "alt") {
      appendAll(flat, item.items);
    } else {
      flat.push(item);
    }
  }
  return flat.length === 1 ? (flat[0] as CNode) : { kind: "alt", items: flat };
}

/**
 * Sorts and merges overlapping or adjacent ranges.
 */
export function normalizeRanges(ranges: readonly CharRange[]): CharRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Array<[number, number]> = [];
  for (const [lo, hi] of sorted) {
    const last = out[out.length - 1];
    if (last && lo <= last[1] + 1) {
      last[1] = Math.max(last[1], hi);
    } else {
      out.push([lo, hi]);
    }
  }
  return out;
}

export function complementRanges(ranges: readonly CharRange[]): CharRange[] {
  const out: CharRange[] = [];
  let next = 0;
  for (const [lo, hi] of normalizeRanges(ranges)) {
    if (lo > next) {
      out.push([next, lo - 1]);
    }
    next = Math.max(next, hi + 1);
  }
  if (next <= MAX_CODE_POINT) {
    out.push([next, MAX_CODE_POINT]);
  }
  return out;
}

export function subtractRanges(
  from: readonly CharRange[],
  remove: readonly CharRange[],
): CharRange[] {
  const inverse = complementRanges(remove);
  const out: CharRange[] = [];
  for (const [aLo, aHi] of normalizeRanges(from)) {
    for (const [bLo, bHi] of inverse) {
      const lo = Math.max(aLo, bLo);
      const hi = Math.min(aHi, bHi);
      if (lo <= hi) {
        out.push([lo, hi]);
      }
    }
  }
  return normalizeRanges(out);
}

export function countCodePoints(ranges: readonly CharRange[]): number {
  let total = 0;
  for (const [lo, hi] of ranges) {
    total += hi - lo + 1;
  }
  return total;
}

/**
 * Code points of the W3C XML `Char` production.
 */
const W3C_CHARS: readonly CharRange[] = [
  [0x9, 0xa],
  [0xd, 0xd],
  [0x20, 0xd7ff],
  [0xe000, 0xfffd],
  [0x10000, MAX_CODE_POINT],
];

/**
 * The positive set of a class: the ranges themselves, or, for a negated
 * class, the complement within the W3C `Char` production (so control
 * characters and surrogates are not matched).
 */
export function classRanges(node: {
  ranges: CharRange[];
  negate: boolean;
}): CharRange[] {
  return node.negate
    ? subtractRanges(W3C_CHARS, node.ranges)
    : normalizeRanges(node.ranges);
}

/**
 * Code points matched by a node when it is a plain character set (a class, a
 * one-character string, or a choice of those); undefined otherwise. With
 * `lookup`, references to rules that are plain character sets are followed.
 */
export function charSetOf(
  node: CNode,
  lookup?: (name: string) => CNode | undefined,
  seen: ReadonlySet<string> = new Set(),
): CharRange[] | undefined {
  switch (node.kind) {
    case "ref": {
      const body = lookup?.(node.name);
      if (!body || seen.has(node.name)) {
        return undefined;
      }
      return charSetOf(body, lookup, new Set([...seen, node.name]));
    }
    case "cls":
      return classRanges(node);
    case "str": {
      const points = [...node.value];
      const only = points[0];
      if (points.length !== 1 || only === undefined) {
        return undefined;
      }
      const cp = only.codePointAt(0) as number;
      const cased = only.toLowerCase() !== only.toUpperCase();
      if (!(node.sensitive || !cased)) {
        const lower = only.toLowerCase().codePointAt(0) as number;
        const upper = only.toUpperCase().codePointAt(0) as number;
        return normalizeRanges([
          [lower, lower],
          [upper, upper],
        ]);
      }
      return [[cp, cp]];
    }
    case "alt": {
      const all: CharRange[] = [];
      for (const item of node.items) {
        const set = charSetOf(item, lookup, seen);
        if (!set) {
          return undefined;
        }
        appendAll(all, set);
      }
      return normalizeRanges(all);
    }
    case "seq":
      return node.items.length === 1
        ? charSetOf(node.items[0] as CNode, lookup, seen)
        : undefined;
    default:
      return undefined;
  }
}

/**
 * Names referenced by a node, in source order.
 */
export function collectRefs(node: CNode, into: string[] = []): string[] {
  switch (node.kind) {
    case "ref":
      into.push(node.name);
      break;
    case "alt":
    case "seq":
      for (const item of node.items) {
        collectRefs(item, into);
      }
      break;
    case "rep":
      collectRefs(node.item, into);
      break;
    case "minus":
      collectRefs(node.left, into);
      collectRefs(node.right, into);
      break;
    default:
      break;
  }
  return into;
}

/**
 * Applies `fn` to every node bottom-up and returns the rebuilt tree.
 */
export function mapRefs(node: CNode, fn: (name: string) => string): CNode {
  switch (node.kind) {
    case "ref":
      return { kind: "ref", name: fn(node.name) };
    case "alt":
      return { kind: "alt", items: node.items.map((i) => mapRefs(i, fn)) };
    case "seq":
      return { kind: "seq", items: node.items.map((i) => mapRefs(i, fn)) };
    case "rep":
      return { ...node, item: mapRefs(node.item, fn) };
    case "minus":
      return {
        ...node,
        left: mapRefs(node.left, fn),
        right: mapRefs(node.right, fn),
      };
    default:
      return node;
  }
}
