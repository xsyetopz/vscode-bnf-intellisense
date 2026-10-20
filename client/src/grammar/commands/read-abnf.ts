import { parseAbnf, ruleExpressions } from "../../abnf/parser.ts";
import type { AbnfExpression } from "../../abnf/types.ts";
import {
  type CDoc,
  type CNode,
  type CRule,
  MAX_CODE_POINT,
  mkAlt,
  mkSeq,
} from "./convert-ast.ts";
import { collectComments } from "./convert-comments.ts";

const MAX_DEPTH = 200;
const RADIX = { x: 16, d: 10, b: 2 } as const;
const DIGITS = {
  x: /^[0-9A-Fa-f]+$/,
  d: /^[0-9]+$/,
  b: /^[01]+$/,
} as const;

/**
 * Thrown when a document cannot be read (for example, nested too deeply).
 */
export class ReadFailure extends Error {}

function codePoint(base: "x" | "d" | "b", digits: string): number | undefined {
  if (!DIGITS[base].test(digits)) {
    return undefined;
  }
  const value = Number.parseInt(digits, RADIX[base]);
  return Number.isSafeInteger(value) && value <= MAX_CODE_POINT
    ? value
    : undefined;
}

function numeric(base: "x" | "d" | "b", text: string): CNode {
  const src = `%${base}${text}`;
  const dash = text.indexOf("-");
  if (dash >= 0) {
    const lo = codePoint(base, text.slice(0, dash));
    const hi = codePoint(base, text.slice(dash + 1));
    return lo !== undefined && hi !== undefined && lo <= hi
      ? { kind: "cls", ranges: [[lo, hi]], negate: false, src }
      : { kind: "raw", src };
  }
  const points = text.split(".").map((part) => codePoint(base, part));
  if (points.some((point) => point === undefined)) {
    return { kind: "raw", src };
  }
  return {
    kind: "str",
    value: String.fromCodePoint(...(points as number[])),
    sensitive: true,
  };
}

function convert(expr: AbnfExpression, depth: number): CNode {
  if (depth > MAX_DEPTH) {
    throw new ReadFailure("The grammar is nested too deeply to convert");
  }
  switch (expr.kind) {
    case "alternation":
      return mkAlt(expr.alternatives.map((item) => convert(item, depth + 1)));
    case "concatenation":
      return mkSeq(expr.elements.map((item) => convert(item, depth + 1)));
    case "repetition": {
      const item = convert(expr.element, depth + 1);
      return expr.min === 1 && expr.max === 1
        ? item
        : { kind: "rep", min: expr.min, max: expr.max, item };
    }
    case "group":
      return convert(expr.expression, depth + 1);
    case "optional":
      return {
        kind: "rep",
        min: 0,
        max: 1,
        item: convert(expr.expression, depth + 1),
      };
    case "rulename":
      return { kind: "ref", name: expr.name };
    case "string":
      return { kind: "str", value: expr.value, sensitive: expr.caseSensitive };
    case "numeric":
      return numeric(expr.base, expr.text);
    case "prose":
      return { kind: "prose", text: expr.text };
  }
}

/**
 * Reads ABNF text (without parse errors) into the neutral tree.
 */
export function readAbnf(text: string): CDoc {
  const document = parseAbnf(text);
  const comments = collectComments(text, "abnf");
  const rules: CRule[] = document.rules.map((rule, index) => {
    const expression = ruleExpressions.get(rule);
    return {
      name: rule.name,
      incremental: rule.isIncremental === true,
      body: expression ? convert(expression, 0) : mkSeq([]),
      leading: comments.leading[index] ?? [],
      trailing: comments.trailing[index],
    };
  });
  const warnings =
    comments.dropped > 0
      ? [
          `${comments.dropped} comment(s) inside rule bodies were not carried over`,
        ]
      : [];
  return { rules, tail: comments.tail, warnings };
}
