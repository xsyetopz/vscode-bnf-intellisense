import {
  type GrammarDialect,
  getGrammarDialectDescriptor,
} from "../dialects.ts";
import {
  type CharRange,
  type CNode,
  charSetOf,
  classRanges,
  countCodePoints,
  subtractRanges,
} from "./convert-ast.ts";

/** Result of printing a node, with how tightly the text binds. */
interface Res {
  text: string;
  prec: number;
}

const ALT = 0;
const SEQ = 1;
const POST = 2;
const ATOM = 3;

const MAX_COPIES = 256;
const MAX_EXPANDED_CLASS = 128;
const LETTER_RE = /[A-Za-z]/;
const WHITESPACE_RE = /\s+/g;

/**
 * Names the writer needs from the converter.
 */
export interface WriteContext {
  target: GrammarDialect;
  /** Bare target name for a source rule name. */
  resolve(name: string): string;
  /** Reserves a unique bare name for a helper rule. */
  allocate(base: string): string;
  /** Body of the rule a source name refers to, when it is defined. */
  lookup?(name: string): CNode | undefined;
}

/**
 * A rule printed in the target dialect.
 */
export interface WrittenRule {
  body: string;
  helpers: Array<{ name: string; body: string }>;
  notes: string[];
}

function hex(cp: number, pad = 0): string {
  return cp.toString(16).toUpperCase().padStart(pad, "0");
}

function atom(text: string): Res {
  return { text, prec: ATOM };
}

/**
 * Prints neutral trees in one target dialect. BNF has no groups, optional
 * parts, or repetition, so those become helper rules there.
 */
export class GrammarWriter {
  readonly #ctx: WriteContext;
  readonly #helpers = new Map<string, string>();
  #pending: Array<{ name: string; body: string }> = [];
  #notes: string[] = [];
  #base = "rule";

  constructor(ctx: WriteContext) {
    this.#ctx = ctx;
  }

  get #target(): GrammarDialect {
    return this.#ctx.target;
  }

  /**
   * Prints one rule body. `name` is the bare target name, used to name helpers.
   */
  writeRule(name: string, body: CNode): WrittenRule {
    this.#base = name;
    this.#pending = [];
    this.#notes = [];
    const text = this.#emit(body).text;
    return { body: text, helpers: this.#pending, notes: this.#notes };
  }

  refText(name: string): string {
    return this.#target === "bnf" || this.#target === "rbnf"
      ? `<${name}>`
      : name;
  }

  #emit(node: CNode): Res {
    switch (node.kind) {
      case "ref":
        return atom(this.refText(this.#ctx.resolve(node.name)));
      case "alt":
        return this.#alt(node.items);
      case "seq":
        return this.#seq(node.items);
      case "str":
        return this.#string(node.value, node.sensitive);
      case "cls":
        return this.#class(node);
      case "prose":
        return this.#placeholder(`<${node.text}>`);
      case "raw":
        return this.#placeholder(node.src);
      case "minus":
        return this.#minus(node);
      case "rep":
        return this.#rep(node.min, node.max, node.item);
    }
  }

  #alt(items: readonly CNode[]): Res {
    const parts = items.map((item) => this.#emit(item));
    if (parts.length === 1) {
      return parts[0] as Res;
    }
    const separator = this.#target === "abnf" ? " / " : " | ";
    return {
      text: parts.map((part) => part.text).join(separator),
      prec: ALT,
    };
  }

  #seq(items: readonly CNode[]): Res {
    if (items.length === 0) {
      return atom('""');
    }
    const parts = items.map((item) => this.#wrap(this.#emit(item), SEQ));
    if (parts.length === 1) {
      return parts[0] as Res;
    }
    return { text: parts.map((part) => part.text).join(" "), prec: SEQ };
  }

  #wrap(res: Res, min: number): Res {
    if (res.prec >= min) {
      return res;
    }
    return this.#target === "bnf"
      ? this.#hoist(res, "group")
      : atom(`(${res.text})`);
  }

  /** Creates (or reuses) a helper rule; `build` gets the helper's own name. */
  #helper(kind: string, key: string, build: (self: string) => string): Res {
    const id = `${kind}\u0000${key}`;
    let name = this.#helpers.get(id);
    if (name === undefined) {
      name = this.#ctx.allocate(`${this.#base}-${kind}`);
      this.#helpers.set(id, name);
      this.#pending.push({ name, body: build(name) });
    }
    return atom(this.refText(name));
  }

  #hoist(res: Res, kind: string): Res {
    return this.#helper(kind, res.text, () => res.text);
  }

  /**
   * Stands in for something the target cannot express: a note keeps the
   * source text, and the body refers to a rule that is never defined, so the
   * grammar cannot match different text by accident.
   */
  #placeholder(src: string): Res {
    const name = getGrammarDialectDescriptor(this.#target).displayName;
    const text = src.replace(WHITESPACE_RE, " ").trim();
    if (this.#target === "abnf") {
      this.#notes.push(`no exact ${name} form for ${text}; kept as prose`);
      const safe = [...text]
        .map((ch) => {
          const cp = ch.codePointAt(0) as number;
          if (ch === ">") {
            return ")";
          }
          return cp >= 0x20 && cp <= 0x7e ? ch : "?";
        })
        .join("");
      return atom(`<${safe}>`);
    }
    const placeholder = this.refText(this.#ctx.allocate("unsupported"));
    this.#notes.push(
      `no exact ${name} form for ${text}; ${placeholder} stands in for it and is not defined`,
    );
    return atom(placeholder);
  }

  #string(value: string, sensitive: boolean): Res {
    const cased = [...value].some((ch) => LETTER_RE.test(ch));
    if (!(sensitive || this.#target === "abnf") && cased) {
      return this.#caseInsensitive(value);
    }
    return this.#pieces(this.#stringPieces(value, sensitive));
  }

  #pieces(pieces: readonly string[]): Res {
    if (pieces.length === 0) {
      return atom('""');
    }
    if (pieces.length === 1) {
      return atom(pieces[0] as string);
    }
    return { text: pieces.join(" "), prec: SEQ };
  }

  /** Letters become a choice of both cases; other characters stay as text. */
  #caseInsensitive(value: string): Res {
    const parts: Res[] = [];
    let run = "";
    const flush = (): void => {
      if (run.length > 0) {
        parts.push(this.#pieces(this.#stringPieces(run, true)));
        run = "";
      }
    };
    for (const ch of value) {
      if (LETTER_RE.test(ch)) {
        flush();
        const lower = this.#pieces(this.#stringPieces(ch.toLowerCase(), true));
        const upper = this.#pieces(this.#stringPieces(ch.toUpperCase(), true));
        const choice: Res = {
          text: `${lower.text} | ${upper.text}`,
          prec: ALT,
        };
        parts.push(choice);
      } else {
        run += ch;
      }
    }
    flush();
    if (parts.length === 1) {
      return parts[0] as Res;
    }
    const wrapped = parts.map((part) => this.#wrap(part, SEQ));
    return { text: wrapped.map((part) => part.text).join(" "), prec: SEQ };
  }

  #stringPieces(value: string, sensitive: boolean): string[] {
    switch (this.#target) {
      case "abnf":
        return abnfPieces(value, sensitive);
      case "ebnf":
        return ebnfPieces(value);
      default:
        return [escapedLiteral(value)];
    }
  }

  #class(node: Extract<CNode, { kind: "cls" }>): Res {
    const positive = classRanges(node);
    if (positive.length === 0) {
      return this.#placeholder(node.src);
    }
    switch (this.#target) {
      case "abnf": {
        const items = positive.map(([lo, hi]) =>
          lo === hi ? `%x${hex(lo, 2)}` : `%x${hex(lo, 2)}-${hex(hi, 2)}`,
        );
        return items.length === 1
          ? atom(items[0] as string)
          : { text: items.join(" / "), prec: ALT };
      }
      case "ebnf": {
        const only = positive[0] as CharRange;
        if (!node.negate && positive.length === 1 && only[0] === only[1]) {
          return this.#string(String.fromCodePoint(only[0]), true);
        }
        const shown = node.negate ? node.ranges : positive;
        const body = shown
          .map(([lo, hi]) =>
            lo === hi ? classChar(lo) : `${classChar(lo)}-${classChar(hi)}`,
          )
          .join("");
        return atom(`[${node.negate ? "^" : ""}${body}]`);
      }
      default: {
        if (countCodePoints(positive) > MAX_EXPANDED_CLASS) {
          return this.#placeholder(node.src);
        }
        const items: Res[] = [];
        for (const [lo, hi] of positive) {
          for (let cp = lo; cp <= hi; cp++) {
            items.push(this.#string(String.fromCodePoint(cp), true));
          }
        }
        return items.length === 1
          ? (items[0] as Res)
          : { text: items.map((item) => item.text).join(" | "), prec: ALT };
      }
    }
  }

  #minus(node: Extract<CNode, { kind: "minus" }>): Res {
    if (this.#target === "ebnf") {
      const left = this.#wrap(this.#emit(node.left), ATOM);
      const right = this.#wrap(this.#emit(node.right), ATOM);
      return { text: `${left.text} - ${right.text}`, prec: POST };
    }
    const lookup = this.#ctx.lookup?.bind(this.#ctx);
    const left = charSetOf(node.left, lookup);
    const right = charSetOf(node.right, lookup);
    if (left && right) {
      const ranges = subtractRanges(left, right);
      if (ranges.length > 0) {
        return this.#class({
          kind: "cls",
          ranges,
          negate: false,
          src: node.src,
        });
      }
    }
    return this.#placeholder(node.src);
  }

  #rep(min: number, max: number | null, item: CNode): Res {
    if (max === 0) {
      return atom('""');
    }
    if (min === 1 && max === 1) {
      return this.#emit(item);
    }
    const operand = this.#emit(item);
    if (this.#target === "abnf") {
      if (min === 0 && max === 1) {
        return atom(`[${operand.text}]`);
      }
      let prefix: string;
      if (max === min) {
        prefix = `${min}`;
      } else if (max === null) {
        prefix = min === 0 ? "*" : `${min}*`;
      } else {
        prefix = min === 0 ? `*${max}` : `${min}*${max}`;
      }
      return {
        text: `${prefix}${this.#wrap(operand, ATOM).text}`,
        prec: POST,
      };
    }
    const plan = repetitionPlan(min, max);
    if (!plan) {
      return this.#placeholder(`${min}*${max ?? ""} repetition`);
    }
    const parts = plan.map((mode) => this.#repPart(mode, operand));
    return parts.length === 1
      ? (parts[0] as Res)
      : { text: parts.map((part) => part.text).join(" "), prec: SEQ };
  }

  #repPart(mode: "one" | "opt" | "star" | "plus", operand: Res): Res {
    if (mode === "one") {
      return this.#wrap(operand, SEQ);
    }
    switch (this.#target) {
      case "ebnf": {
        const suffix = { opt: "?", star: "*", plus: "+" }[mode];
        return { text: this.#wrap(operand, ATOM).text + suffix, prec: POST };
      }
      case "rbnf": {
        if (mode === "opt") {
          return atom(`[${operand.text}]`);
        }
        const inner = `${this.#wrap(operand, ATOM).text} ...`;
        return mode === "plus"
          ? { text: inner, prec: POST }
          : atom(`[${inner}]`);
      }
      default:
        return this.#bnfRepetition(mode, operand);
    }
  }

  #bnfRepetition(mode: "opt" | "star" | "plus", operand: Res): Res {
    if (mode === "opt") {
      return this.#helper("opt", operand.text, () => `${operand.text} | ""`);
    }
    // a choice cannot be followed by the recursive reference without a group
    const body = operand.prec === ALT ? this.#hoist(operand, "group") : operand;
    if (mode === "star") {
      return this.#helper(
        "star",
        body.text,
        (self) => `${body.text} ${this.refText(self)} | ""`,
      );
    }
    return this.#helper(
      "plus",
      body.text,
      (self) => `${body.text} | ${body.text} ${this.refText(self)}`,
    );
  }
}

function repetitionPlan(
  min: number,
  max: number | null,
): Array<"one" | "opt" | "star" | "plus"> | undefined {
  const plan: Array<"one" | "opt" | "star" | "plus"> = [];
  if (max === null) {
    if (min > MAX_COPIES) {
      return undefined;
    }
    if (min === 0) {
      return ["star"];
    }
    for (let i = 1; i < min; i++) {
      plan.push("one");
    }
    plan.push("plus");
    return plan;
  }
  if (max < min || max > MAX_COPIES) {
    return undefined;
  }
  for (let i = 0; i < min; i++) {
    plan.push("one");
  }
  for (let i = min; i < max; i++) {
    plan.push("opt");
  }
  return plan;
}

function isAbnfPlain(cp: number): boolean {
  return cp >= 0x20 && cp <= 0x7e && cp !== 0x22;
}

function abnfPieces(value: string, sensitive: boolean): string[] {
  const pieces: string[] = [];
  let run = "";
  let codes: number[] = [];
  const flushRun = (): void => {
    if (run.length > 0) {
      const prefix = sensitive && LETTER_RE.test(run) ? "%s" : "";
      pieces.push(`${prefix}"${run}"`);
      run = "";
    }
  };
  const flushCodes = (): void => {
    if (codes.length > 0) {
      pieces.push(`%x${codes.map((cp) => hex(cp, 2)).join(".")}`);
      codes = [];
    }
  };
  for (const ch of value) {
    const cp = ch.codePointAt(0) as number;
    if (isAbnfPlain(cp)) {
      flushCodes();
      run += ch;
    } else {
      flushRun();
      codes.push(cp);
    }
  }
  flushRun();
  flushCodes();
  return pieces;
}

function isEbnfControl(cp: number): boolean {
  return cp < 0x20 || (cp >= 0x7f && cp <= 0x9f);
}

function ebnfQuoted(run: string): string[] {
  if (!run.includes('"')) {
    return [`"${run}"`];
  }
  if (!run.includes("'")) {
    return [`'${run}'`];
  }
  const pieces: string[] = [];
  let segment = "";
  for (const ch of run) {
    if (ch === '"') {
      if (segment.length > 0) {
        pieces.push(`"${segment}"`);
        segment = "";
      }
      pieces.push(`'"'`);
    } else {
      segment += ch;
    }
  }
  if (segment.length > 0) {
    pieces.push(`"${segment}"`);
  }
  return pieces;
}

function ebnfPieces(value: string): string[] {
  const pieces: string[] = [];
  let run = "";
  for (const ch of value) {
    const cp = ch.codePointAt(0) as number;
    if (isEbnfControl(cp)) {
      if (run.length > 0) {
        pieces.push(...ebnfQuoted(run));
        run = "";
      }
      pieces.push(`#x${hex(cp)}`);
    } else {
      run += ch;
    }
  }
  if (run.length > 0) {
    pieces.push(...ebnfQuoted(run));
  }
  return pieces;
}

/**
 * Quoted BNF/RBNF string. A value with `"` and no `'` is single-quoted;
 * otherwise double-quoted. Escapes: `\\ \" \' \n \r \t \xHH`.
 */
function escapedLiteral(value: string): string {
  const quote = value.includes('"') && !value.includes("'") ? "'" : '"';
  let out = quote;
  for (const ch of value) {
    const cp = ch.codePointAt(0) as number;
    if (ch === "\\") {
      out += "\\\\";
    } else if (ch === quote) {
      out += `\\${quote}`;
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\r") {
      out += "\\r";
    } else if (ch === "\t") {
      out += "\\t";
    } else if (cp < 0x20 || cp === 0x7f) {
      out += `\\x${hex(cp, 2)}`;
    } else {
      out += ch;
    }
  }
  return `${out}${quote}`;
}

function classChar(cp: number): string {
  const ch = String.fromCodePoint(cp);
  return /^[A-Za-z0-9_]$/.test(ch) ? ch : `#x${hex(cp)}`;
}
