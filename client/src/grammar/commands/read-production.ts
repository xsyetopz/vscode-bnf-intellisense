import type { ProductionDialect, ScanToken } from "../scanner.ts";
import { scanProductionGrammar } from "../scanner.ts";
import {
  type CDoc,
  type CharRange,
  type CNode,
  type CRule,
  MAX_CODE_POINT,
  mkAlt,
  mkSeq,
  normalizeRanges,
} from "./convert-ast.ts";
import { collectComments } from "./convert-comments.ts";
import { ReadFailure } from "./read-abnf.ts";

const MAX_DEPTH = 200;
const HEX_RE = /^[0-9A-Fa-f]+$/;
const DIGITS_RE = /^[0-9]+$/;
const ANGLE_RE = /^<(.*)>$/s;

/**
 * Name without the angle brackets of BNF and RBNF references.
 */
export function stripAngle(name: string): string {
  return ANGLE_RE.exec(name)?.[1] ?? name;
}

function hexValue(digits: string): number | undefined {
  if (!HEX_RE.test(digits)) {
    return undefined;
  }
  const value = Number.parseInt(digits, 16);
  return Number.isSafeInteger(value) && value <= MAX_CODE_POINT
    ? value
    : undefined;
}

/**
 * Contents of a quoted string. BNF and RBNF strings use backslash escapes;
 * W3C EBNF strings have none.
 */
function unquote(token: ScanToken, escapes: boolean): string {
  const inner = token.text.slice(
    1,
    token.text.length > 1 && token.text.endsWith(token.text[0] ?? "")
      ? -1
      : undefined,
  );
  if (!escapes) {
    return inner;
  }
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i] as string;
    if (ch !== "\\" || i + 1 >= inner.length) {
      out += ch;
      continue;
    }
    const next = inner[i + 1] as string;
    const hex = /^x([0-9A-Fa-f]{2})/.exec(inner.slice(i + 1, i + 4));
    if (next === "n") {
      out += "\n";
    } else if (next === "r") {
      out += "\r";
    } else if (next === "t") {
      out += "\t";
    } else if (hex) {
      out += String.fromCodePoint(Number.parseInt(hex[1] as string, 16));
      i += 2;
    } else {
      out += next;
    }
    i++;
  }
  return out;
}

/**
 * Parses the body of a W3C character class `[a-z#x30-#x39]` or `[^...]`.
 */
function charClass(text: string): CNode {
  const closed = text.endsWith("]");
  const inner = text.slice(1, closed ? -1 : undefined);
  const negate = inner.startsWith("^");
  const body = negate ? inner.slice(1) : inner;
  const points: number[] = [];
  const ranges: CharRange[] = [];
  const pushPoint = (index: number): number | undefined => {
    if (body.startsWith("#x", index)) {
      const digits = /^[0-9A-Za-z]*/.exec(body.slice(index + 2))?.[0] ?? "";
      const value = hexValue(digits);
      if (value === undefined) {
        return undefined;
      }
      points.push(value);
      return index + 2 + digits.length;
    }
    const cp = body.codePointAt(index) as number;
    points.push(cp);
    return index + (cp > 0xffff ? 2 : 1);
  };
  let i = 0;
  while (i < body.length) {
    const after = pushPoint(i);
    if (after === undefined) {
      return { kind: "raw", src: text };
    }
    const lo = points.pop() as number;
    if (body[after] === "-" && after + 1 < body.length) {
      const end = pushPoint(after + 1);
      if (end === undefined) {
        return { kind: "raw", src: text };
      }
      const hi = points.pop() as number;
      if (hi < lo) {
        return { kind: "raw", src: text };
      }
      ranges.push([lo, hi]);
      i = end;
    } else {
      ranges.push([lo, lo]);
      i = after;
    }
  }
  return { kind: "cls", ranges: normalizeRanges(ranges), negate, src: text };
}

function isOperandStart(token: ScanToken | undefined): boolean {
  if (!token) {
    return false;
  }
  if (token.kind === "group") {
    return token.text === "(" || token.text === "[" || token.text === "{";
  }
  return (
    token.kind === "string" ||
    token.kind === "charClass" ||
    token.kind === "charCode" ||
    token.kind === "angleName" ||
    token.kind === "name"
  );
}

class BodyReader {
  readonly warnings: string[] = [];
  #pos = 0;

  readonly tokens: readonly ScanToken[];
  readonly dialect: ProductionDialect;
  readonly text: string;

  constructor(
    tokens: readonly ScanToken[],
    dialect: ProductionDialect,
    text: string,
  ) {
    this.tokens = tokens;
    this.dialect = dialect;
    this.text = text;
  }

  get done(): boolean {
    return this.#pos >= this.tokens.length;
  }

  parse(): CNode {
    const node = this.#alt(0);
    // unmatched closers are refused earlier; keep the rest as text
    const rest: CNode[] = [node];
    while (!this.done) {
      const token = this.tokens[this.#pos++] as ScanToken;
      this.warnings.push(`unexpected "${token.text}"`);
      rest.push({ kind: "raw", src: token.text });
    }
    return mkSeq(rest);
  }

  #peek(): ScanToken | undefined {
    return this.tokens[this.#pos];
  }

  #alt(depth: number): CNode {
    if (depth > MAX_DEPTH) {
      throw new ReadFailure("The grammar is nested too deeply to convert");
    }
    const branches: CNode[] = [this.#seq(depth)];
    while (this.#peek()?.kind === "alternative") {
      this.#pos++;
      branches.push(this.#seq(depth));
    }
    return mkAlt(branches);
  }

  #seq(depth: number): CNode {
    const items: CNode[] = [];
    for (;;) {
      const token = this.#peek();
      if (!token || token.kind === "alternative") {
        break;
      }
      if (
        token.kind === "group" &&
        (token.text === ")" || token.text === "]" || token.text === "}")
      ) {
        break;
      }
      if (token.kind === "annotation") {
        this.#pos++;
        this.warnings.push(`annotation ${token.text} was dropped`);
        continue;
      }
      items.push(this.#item(depth));
    }
    return mkSeq(items);
  }

  #item(depth: number): CNode {
    const startIndex = this.#pos;
    let node = this.#prefixed(depth);
    while (this.#peek()?.kind === "exclusion") {
      this.#pos++;
      const right = this.#prefixed(depth);
      const first = this.tokens[startIndex] as ScanToken;
      const last = this.tokens[this.#pos - 1] as ScanToken;
      node = {
        kind: "minus",
        left: node,
        right,
        src: this.text.slice(first.start, last.end).replace(/\s+/g, " "),
      };
    }
    return node;
  }

  /** RBNF `n*m` prefix, then the operand with its suffix operators. */
  #prefixed(depth: number): CNode {
    const token = this.#peek();
    if (this.dialect === "rbnf" && token) {
      const prefix = this.#repeatPrefix(token);
      if (prefix) {
        const operand = this.#suffixed(depth);
        return { kind: "rep", min: prefix.min, max: prefix.max, item: operand };
      }
    }
    return this.#suffixed(depth);
  }

  #repeatPrefix(
    token: ScanToken,
  ): { min: number; max: number | null } | undefined {
    const isCount = (t: ScanToken | undefined): t is ScanToken =>
      t?.kind === "punct" && DIGITS_RE.test(t.text);
    const isStar = (t: ScanToken | undefined): t is ScanToken =>
      t?.kind === "repeat" && t.text === "*";
    let at = this.#pos;
    let min: number | undefined;
    if (isCount(token)) {
      min = Number.parseInt(token.text, 10);
      at++;
    }
    const star = isStar(this.tokens[at]);
    if (star) {
      at++;
    }
    let max: number | null = null;
    if (star && isCount(this.tokens[at])) {
      max = Number.parseInt((this.tokens[at] as ScanToken).text, 10);
      at++;
    }
    if (!(star || min !== undefined) || !isOperandStart(this.tokens[at])) {
      return undefined;
    }
    this.#pos = at;
    if (!star) {
      return { min: min as number, max: min as number };
    }
    return { min: min ?? 0, max };
  }

  #suffixed(depth: number): CNode {
    let node = this.#primary(depth);
    for (;;) {
      const token = this.#peek();
      if (token?.kind !== "repeat") {
        return node;
      }
      if (
        this.dialect === "rbnf" &&
        token.text === "*" &&
        isOperandStart(this.tokens[this.#pos + 1])
      ) {
        return node;
      }
      this.#pos++;
      const [min, max] =
        token.text === "?"
          ? [0, 1]
          : token.text === "*"
            ? [0, null]
            : [1, null];
      node = { kind: "rep", min, max, item: node };
    }
  }

  #primary(depth: number): CNode {
    const token = this.tokens[this.#pos++] as ScanToken;
    switch (token.kind) {
      case "string":
        return {
          kind: "str",
          value: unquote(token, this.dialect !== "ebnf"),
          sensitive: true,
        };
      case "charClass":
        return charClass(token.text);
      case "charCode": {
        const value = hexValue(token.text.slice(2));
        return value === undefined
          ? { kind: "raw", src: token.text }
          : {
              kind: "cls",
              ranges: [[value, value]],
              negate: false,
              src: token.text,
            };
      }
      case "angleName":
        return { kind: "ref", name: stripAngle(token.text) };
      case "name":
        return { kind: "ref", name: token.text };
      case "group":
        return this.#group(token, depth);
      default:
        this.warnings.push(`unsupported "${token.text}"`);
        return { kind: "raw", src: token.text };
    }
  }

  #group(open: ScanToken, depth: number): CNode {
    const closer = { "(": ")", "[": "]", "{": "}" }[open.text];
    if (closer === undefined) {
      this.warnings.push(`unexpected "${open.text}"`);
      return { kind: "raw", src: open.text };
    }
    const inner = this.#alt(depth + 1);
    if (this.#peek()?.text === closer) {
      this.#pos++;
    }
    if (open.text === "[") {
      return { kind: "rep", min: 0, max: 1, item: inner };
    }
    if (open.text === "{") {
      return { kind: "rep", min: 0, max: null, item: inner };
    }
    return inner;
  }
}

/**
 * Reads BNF, EBNF, or RBNF text (without parse errors) into the neutral tree.
 */
export function readProduction(text: string, dialect: ProductionDialect): CDoc {
  const scan = scanProductionGrammar(text, dialect);
  const comments = collectComments(text, dialect);
  const warnings: string[] = [];
  const rules: CRule[] = scan.productions.map((production, index) => {
    const reader = new BodyReader(production.bodyTokens, dialect, text);
    const body = reader.parse();
    const name = stripAngle(production.nameToken.text);
    for (const message of reader.warnings) {
      warnings.push(`${name}: ${message}`);
    }
    return {
      name,
      incremental: false,
      body,
      leading: comments.leading[index] ?? [],
      trailing: comments.trailing[index],
    };
  });
  if (comments.dropped > 0) {
    warnings.push(
      `${comments.dropped} comment(s) inside rule bodies were not carried over`,
    );
  }
  return { rules, tail: comments.tail, warnings };
}
