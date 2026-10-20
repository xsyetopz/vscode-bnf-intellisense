import type { GrammarDialect } from "../dialects.ts";
import type { LayoutToken } from "../rule-layout.ts";

const ANNOTATION_RE = /^\[\s*(?:wfc|vc)\s*:/i;
const CLOSER_FOR: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/**
 * True for a W3C `[ wfc: ... ]` or `[ vc: ... ]` annotation. It is attached to
 * a rule, not part of its expression.
 */
export function isAnnotation(
  token: LayoutToken,
  dialect: GrammarDialect,
): boolean {
  return (
    dialect !== "abnf" &&
    token.kind === "term" &&
    ANNOTATION_RE.test(token.text)
  );
}

function isExclusion(token: LayoutToken, dialect: GrammarDialect): boolean {
  return dialect !== "abnf" && token.kind === "term" && token.text === "-";
}

/**
 * Item and group boundaries of one rule body. Items are the units of a
 * sequence: an element with its repeat operator, or `A - B` as one unit.
 */
export interface BodyStructure {
  tokens: readonly LayoutToken[];
  dialect: GrammarDialect;
  /** False when delimiters do not pair up. */
  balanced: boolean;
  /** Index of the partner delimiter for open and close tokens, else -1. */
  match: number[];
  itemStart: boolean[];
  itemEnd: boolean[];
}

/**
 * Computes group pairing and item boundaries for the tokens of a body.
 */
export function analyzeBody(
  tokens: readonly LayoutToken[],
  dialect: GrammarDialect,
): BodyStructure {
  const n = tokens.length;
  const match: number[] = new Array(n).fill(-1);
  const stack: number[] = [];
  let balanced = true;
  for (let k = 0; k < n; k++) {
    const token = tokens[k] as LayoutToken;
    if (token.kind === "open") {
      stack.push(k);
    } else if (token.kind === "close") {
      const open = stack.pop();
      const opener = open === undefined ? undefined : tokens[open];
      if (open === undefined || CLOSER_FOR[opener?.text ?? ""] !== token.text) {
        balanced = false;
      } else {
        match[open] = k;
        match[k] = open;
      }
    }
  }
  if (stack.length > 0) {
    balanced = false;
  }
  const abnf = dialect === "abnf";
  const itemStart: boolean[] = new Array(n).fill(false);
  const itemEnd: boolean[] = new Array(n).fill(false);
  for (let k = 0; k < n; k++) {
    const token = tokens[k] as LayoutToken;
    const prev = tokens[k - 1];
    const next = tokens[k + 1];
    if (abnf) {
      const begins =
        token.kind === "prefix" ||
        token.kind === "term" ||
        token.kind === "open";
      itemStart[k] = begins && prev?.kind !== "prefix";
      itemEnd[k] = token.kind === "term" || token.kind === "close";
    } else {
      const exclusion = isExclusion(token, dialect);
      const beginsUnit = token.kind === "term" || token.kind === "open";
      itemStart[k] =
        beginsUnit &&
        !exclusion &&
        !(prev !== undefined && isExclusion(prev, dialect));
      const endsUnit =
        (token.kind === "term" && !exclusion) ||
        token.kind === "close" ||
        token.kind === "suffix";
      itemEnd[k] =
        endsUnit &&
        next?.kind !== "suffix" &&
        !(next !== undefined && isExclusion(next, dialect));
    }
  }
  return { tokens, dialect, balanced, match, itemStart, itemEnd };
}

/**
 * Whether `[from, to)` is a complete expression of one frame: whole
 * alternatives, or a run of whole sequence items. Selecting part of a group,
 * an operand without its repeat operator, or half an exclusion is not.
 */
export function isCompleteExpression(
  s: BodyStructure,
  from: number,
  to: number,
): boolean {
  const { tokens } = s;
  if (!s.balanced || from < 0 || to > tokens.length || from >= to) {
    return false;
  }
  let depth = 0;
  let hasAlt = false;
  for (let k = from; k < to; k++) {
    const token = tokens[k] as LayoutToken;
    if (token.kind === "open") {
      depth++;
    } else if (token.kind === "close") {
      depth--;
      if (depth < 0) {
        return false;
      }
    } else if (token.kind === "alt" && depth === 0) {
      hasAlt = true;
      if (k === from || k === to - 1 || tokens[k - 1]?.kind === "alt") {
        return false;
      }
    }
  }
  if (depth !== 0) {
    return false;
  }
  if (!hasAlt) {
    return Boolean(s.itemStart[from] && s.itemEnd[to - 1]);
  }
  const before = tokens[from - 1];
  const after = tokens[to];
  const startsAlternative =
    before === undefined || before.kind === "open" || before.kind === "alt";
  const endsAlternative =
    after === undefined || after.kind === "close" || after.kind === "alt";
  return startsAlternative && endsAlternative;
}

/**
 * Shape of a whole rule body, which decides how it can be placed elsewhere.
 */
export type BodyKind =
  | "invalid"
  | "empty"
  /** One term or one fully delimited group. */
  | "atom"
  /** One element with a repeat operator. */
  | "op"
  /** Several items in sequence. */
  | "seq"
  /** Contains an exclusion `A - B`. */
  | "excl"
  /** Several alternatives. */
  | "alt";

/**
 * Classifies a body by its top-level shape.
 */
export function classifyBody(s: BodyStructure): BodyKind {
  const { tokens } = s;
  if (!s.balanced) {
    return "invalid";
  }
  if (tokens.length === 0) {
    return "empty";
  }
  let items = 0;
  let hasAlt = false;
  let hasExclusion = false;
  let k = 0;
  while (k < tokens.length) {
    const token = tokens[k] as LayoutToken;
    if (s.itemStart[k]) {
      items++;
    }
    if (token.kind === "open") {
      k = (s.match[k] as number) + 1;
      continue;
    }
    if (token.kind === "alt") {
      hasAlt = true;
    } else if (isExclusion(token, s.dialect)) {
      hasExclusion = true;
    }
    k++;
  }
  if (hasAlt) {
    return "alt";
  }
  if (hasExclusion) {
    return "excl";
  }
  if (items === 0) {
    return "invalid";
  }
  if (items > 1) {
    return "seq";
  }
  const operator =
    s.dialect === "abnf"
      ? tokens[0]?.kind === "prefix"
      : tokens[tokens.length - 1]?.kind === "suffix";
  return operator ? "op" : "atom";
}

/**
 * Where one reference sits inside its alternative.
 */
export interface HostContext {
  /** The reference, with its operator, is the entire alternative. */
  wholeAlternative: boolean;
  /** A repeat operator is attached to the reference. */
  hasOperator: boolean;
  /** The reference is an operand of `-`. */
  nextToExclusion: boolean;
}

/**
 * Describes the alternative around the token at `p`.
 */
export function hostContext(s: BodyStructure, p: number): HostContext {
  const { tokens, dialect } = s;
  let start = 0;
  for (let q = p - 1; q >= 0; q--) {
    const token = tokens[q] as LayoutToken;
    if (token.kind === "close" && (s.match[q] as number) >= 0) {
      q = s.match[q] as number;
      continue;
    }
    if (token.kind === "alt" || token.kind === "open") {
      start = q + 1;
      break;
    }
  }
  let end = tokens.length;
  for (let q = p + 1; q < tokens.length; q++) {
    const token = tokens[q] as LayoutToken;
    if (token.kind === "open" && (s.match[q] as number) >= 0) {
      q = s.match[q] as number;
      continue;
    }
    if (token.kind === "alt" || token.kind === "close") {
      end = q;
      break;
    }
  }
  const prev = tokens[p - 1];
  const next = tokens[p + 1];
  const abnf = dialect === "abnf";
  const hasOperator = abnf ? prev?.kind === "prefix" : next?.kind === "suffix";
  const nextToExclusion =
    !abnf &&
    ((prev !== undefined && isExclusion(prev, dialect)) ||
      (next !== undefined && isExclusion(next, dialect)));
  let wholeAlternative: boolean;
  if (abnf) {
    wholeAlternative = end === p + 1;
    for (let q = start; wholeAlternative && q < p; q++) {
      wholeAlternative = tokens[q]?.kind === "prefix";
    }
  } else {
    wholeAlternative = start === p && end === (hasOperator ? p + 2 : p + 1);
  }
  return { wholeAlternative, hasOperator, nextToExclusion };
}
