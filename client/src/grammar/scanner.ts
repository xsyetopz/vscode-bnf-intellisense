import { appendAll } from "../append-all.ts";
import { RECENT_DOCUMENTS, RecentCache } from "../recent-cache.ts";
import type { GrammarDialect } from "./dialects.ts";
import { LineIndex } from "./line-index.ts";

/**
 * Grammar dialects handled by the production-grammar scanner.
 */
export type ProductionDialect = Exclude<GrammarDialect, "abnf">;

/**
 * Lexical categories produced by the production-grammar scanner.
 */
export type ScanKind =
  | "comment"
  | "string"
  | "charClass"
  | "annotation"
  | "charCode"
  | "angleName"
  | "name"
  | "assignment"
  | "alternative"
  | "repeat"
  | "group"
  | "productionNumber"
  | "exclusion"
  | "punct";

/**
 * One lexical token with offsets and zero-based line and column positions.
 */
export interface ScanToken {
  kind: ScanKind;
  text: string;
  start: number;
  end: number;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  /** True for a string or block comment that never closes. */
  unterminated?: true;
  /** True for a `#x` character code without valid hexadecimal digits. */
  invalid?: true;
  /** True for an ISO/IEC 14977 `(* ... *)` comment, which W3C EBNF lacks. */
  iso?: true;
}

/**
 * One `name ::= body` production.
 */
export interface Production {
  nameToken: ScanToken;
  assignToken: ScanToken;
  numberToken?: ScanToken;
  /** Significant (non-comment) tokens after the assignment. */
  bodyTokens: ScanToken[];
  /** Comments between significant tokens of this production. */
  innerComments: ScanToken[];
  /** Comments that follow the last token on its own line. */
  trailingComments: ScanToken[];
  /** Own-line comment directly above the production. */
  precedingComment?: ScanToken;
  /** Body tokens that start in column 0 without being a continuation. */
  unindentedTokens: ScanToken[];
  startOffset: number;
  /** End of the last significant token. */
  endOffset: number;
}

/**
 * A statement that looks like a rule but is not valid for the dialect.
 */
export interface StrayStatement {
  kind: "iso" | "invalidName" | "unexpected";
  tokens: ScanToken[];
}

/**
 * Result of scanning one production-grammar document.
 */
export interface ScanResult {
  text: string;
  dialect: ProductionDialect;
  lineIndex: LineIndex;
  tokens: readonly ScanToken[];
  productions: readonly Production[];
  strays: readonly StrayStatement[];
  /**
   * Offsets of `(*` that open an ISO comment which never closes in time, with
   * what stopped it: the next production head or the end of the text.
   */
  unclosedIsoOpeners: ReadonlyMap<number, "production" | "end">;
}

const NAME_RE = /[A-Za-z_][A-Za-z0-9_.:-]*/y;
const ANGLE_RE = /<[^<>\r\n]+>/y;
const ANNOTATION_HEAD_RE = /\[[ \t]*(?:wfc|vc)[ \t]*:/iy;
const NUMBER_TAIL_RE = /[ \t]*[A-Za-z_][A-Za-z0-9_.:-]*[ \t]*::=/y;
const EOL_CHAR_RE = /[\r\n]/g;
const PRODUCTION_HEAD_RE =
  /^[ \t]*(?:\[[^\]\r\n]*\][ \t]*)?(?:<[^<>\r\n]+>|[A-Za-z_][A-Za-z0-9_.:-]*)[ \t]*::=/gm;
const CHAR_CODE_RE = /#x[A-Za-z0-9]*/y;
const HEX_CODE_RE = /^#x[0-9A-Fa-f]+$/;
const DIGITS_RE = /[0-9][A-Za-z0-9_]*/y;
const NAME_TAIL_RE = /[.:-]$/;
const WHITESPACE_RE = /\s/;

function matchAt(re: RegExp, text: string, index: number): string | undefined {
  re.lastIndex = index;
  const match = re.exec(text);
  return match ? match[0] : undefined;
}

interface ScanStop {
  end: number;
  unterminated?: true;
}

function scanString(text: string, start: number, escapes: boolean): ScanStop {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\n" || ch === "\r") {
      return { end: i, unterminated: true };
    }
    if (escapes && ch === "\\") {
      i++;
      if (text[i] !== "\n" && text[i] !== "\r" && i < text.length) {
        i++;
      }
      continue;
    }
    i++;
    if (ch === quote) {
      return { end: i };
    }
  }
  return { end: i, unterminated: true };
}

function scanLineComment(text: string, start: number): ScanStop {
  let i = start;
  while (i < text.length && text[i] !== "\n" && text[i] !== "\r") {
    i++;
  }
  return { end: i };
}

function scanBlockComment(text: string, start: number): ScanStop {
  const close = text.indexOf("*/", start + 2);
  return close < 0
    ? { end: text.length, unterminated: true }
    : { end: close + 2 };
}

class Scanner {
  readonly tokens: ScanToken[] = [];
  readonly unclosedIsoOpeners = new Map<number, "production" | "end">();
  readonly #text: string;
  readonly #dialect: ProductionDialect;
  readonly #lines: LineIndex;
  #lastSignificantLine = -1;
  #headAt = -1;
  // Matches of "(*" openers from #isoFrom up to the head at #isoLimit.
  #isoEnds = new Map<number, number>();
  #isoLimit = -1;
  #isoFrom = 0;
  // Cached look-ahead so that many unclosed "[" do not each rescan the line.
  #closeAt = -1;
  #eolAt = -1;

  constructor(text: string, dialect: ProductionDialect, lines: LineIndex) {
    this.#text = text;
    this.#dialect = dialect;
    this.#lines = lines;
  }

  scan(): ScanToken[] {
    const text = this.#text;
    let i = 0;
    while (i < text.length) {
      const ch = text[i] ?? "";
      if (WHITESPACE_RE.test(ch)) {
        i++;
        continue;
      }
      i = this.#scanAt(i, ch);
    }
    return this.tokens;
  }

  #push(
    kind: ScanKind,
    start: number,
    end: number,
    flags: Partial<Pick<ScanToken, "unterminated" | "invalid" | "iso">> = {},
  ): number {
    const startLine = this.#lines.lineAt(start);
    const endLine = this.#lines.lineAt(end);
    const token: ScanToken = {
      kind,
      text: this.#text.slice(start, end),
      start,
      end,
      line: startLine,
      column: start - (this.#lines.starts[startLine] ?? 0),
      endLine,
      endColumn: end - (this.#lines.starts[endLine] ?? 0),
      ...flags,
    };
    this.tokens.push(token);
    if (kind !== "comment") {
      this.#lastSignificantLine = endLine;
    }
    return end;
  }

  #isFirstSignificantOnLine(offset: number): boolean {
    return this.#lines.lineAt(offset) > this.#lastSignificantLine;
  }

  #scanAt(i: number, ch: string): number {
    const text = this.#text;
    const dialect = this.#dialect;
    // Order matters: comment, then character class, then string, then the rest.
    if (dialect === "ebnf" && ch === "/" && text[i + 1] === "*") {
      const stop = scanBlockComment(text, i);
      return this.#push("comment", i, stop.end, flagsOf(stop));
    }
    if (dialect === "ebnf" && ch === "(" && text[i + 1] === "*") {
      // "(*" can never open a W3C group ("*" cannot start an expression), so
      // it is read as an ISO comment. Without a matching "*)" before the next
      // production head it is not one.
      const end = this.#isoCommentEnd(i);
      if (end >= 0) {
        return this.#push("comment", i, end, { iso: true });
      }
      if (text[i + 2] !== ")") {
        // "(*)" is a stray group and repeat; any other "(*" was meant as a comment.
        this.unclosedIsoOpeners.set(
          i,
          this.#headAfter(i) < text.length ? "production" : "end",
        );
      }
    }
    if (dialect !== "ebnf" && ch === ";") {
      return this.#push("comment", i, scanLineComment(text, i).end);
    }
    if (dialect === "ebnf" && ch === "[") {
      return this.#scanBracket(i);
    }
    if (ch === '"' || ch === "'") {
      const stop = scanString(text, i, dialect !== "ebnf");
      return this.#push("string", i, stop.end, flagsOf(stop));
    }
    return this.#scanToken(i, ch);
  }

  /** Start of the first production head after `i`, or the text length. */
  #headAfter(i: number): number {
    if (this.#headAt <= i) {
      PRODUCTION_HEAD_RE.lastIndex = i + 1;
      const head = PRODUCTION_HEAD_RE.exec(this.#text);
      this.#headAt = head ? head.index : this.#text.length;
    }
    return this.#headAt;
  }

  /**
   * End offset of the ISO `(* ... *)` comment opened at `i`, or -1. ISO
   * comments nest, and one cannot run into a later production head. One
   * stack pass per head segment matches every opener in it, so a run of
   * unclosed openers costs O(n) in total.
   */
  #isoCommentEnd(i: number): number {
    const limit = this.#headAfter(i);
    if (this.#isoLimit !== limit || i < this.#isoFrom) {
      this.#matchIsoComments(i, limit);
    }
    return this.#isoEnds.get(i) ?? -1;
  }

  /** Matches `(*` with `*)` in `[from, limit)`, counting depth like a stack. */
  #matchIsoComments(from: number, limit: number): void {
    const text = this.#text;
    const ends = new Map<number, number>();
    const open: number[] = [];
    let j = from;
    while (j < limit) {
      if (text[j] === "(" && text[j + 1] === "*") {
        open.push(j);
        j += 2;
      } else if (text[j] === "*" && text[j + 1] === ")") {
        const start = open.pop();
        if (start !== undefined) {
          ends.set(start, j + 2);
        }
        j += 2;
      } else {
        j++;
      }
    }
    this.#isoEnds = ends;
    this.#isoLimit = limit;
    this.#isoFrom = from;
  }

  /**
   * Index of the "]" that closes the "[" at `i` on the same line, or -1.
   * Both look-ups are monotonic, so a run of unclosed "[" costs O(n) in total.
   */
  #bracketClose(i: number): number {
    const text = this.#text;
    if (this.#eolAt < i) {
      EOL_CHAR_RE.lastIndex = i;
      const eol = EOL_CHAR_RE.exec(text);
      this.#eolAt = eol ? eol.index : text.length;
    }
    if (this.#closeAt <= i) {
      const close = text.indexOf("]", i + 1);
      this.#closeAt = close < 0 ? Number.POSITIVE_INFINITY : close;
    }
    return this.#closeAt < this.#eolAt ? this.#closeAt : -1;
  }

  #scanBracket(i: number): number {
    const text = this.#text;
    const close = this.#bracketClose(i);
    if (close < 0) {
      return this.#push("group", i, i + 1);
    }
    if (
      close > i + 1 &&
      this.#isFirstSignificantOnLine(i) &&
      matchAt(NUMBER_TAIL_RE, text, close + 1) !== undefined
    ) {
      return this.#push("productionNumber", i, close + 1);
    }
    if (matchAt(ANNOTATION_HEAD_RE, text, i) !== undefined) {
      return this.#push("annotation", i, close + 1);
    }
    return this.#push("charClass", i, close + 1);
  }

  #scanToken(i: number, ch: string): number {
    const text = this.#text;
    if (ch === ":" && text.startsWith("::=", i)) {
      return this.#push("assignment", i, i + 3);
    }
    if (ch === "<") {
      const angle = matchAt(ANGLE_RE, text, i);
      if (angle) {
        return this.#push("angleName", i, i + angle.length);
      }
    }
    if (this.#dialect === "ebnf" && ch === "#" && text[i + 1] === "x") {
      const code = matchAt(CHAR_CODE_RE, text, i) ?? "#x";
      return this.#push(
        "charCode",
        i,
        i + code.length,
        HEX_CODE_RE.test(code) ? {} : { invalid: true },
      );
    }
    if (/[A-Za-z_]/.test(ch)) {
      return this.#scanName(i);
    }
    if (/[0-9]/.test(ch)) {
      const digits = matchAt(DIGITS_RE, text, i) ?? ch;
      return this.#push("punct", i, i + digits.length);
    }
    return this.#scanOperator(i, ch);
  }

  #scanName(i: number): number {
    let name = matchAt(NAME_RE, this.#text, i) ?? "";
    while (name.length > 1 && NAME_TAIL_RE.test(name)) {
      name = name.slice(0, -1);
    }
    return this.#push("name", i, i + name.length);
  }

  #scanOperator(i: number, ch: string): number {
    if (this.#dialect === "rbnf" && this.#text.startsWith("...", i)) {
      return this.#push("repeat", i, i + 3);
    }
    switch (ch) {
      case "|":
        return this.#push("alternative", i, i + 1);
      case "?":
      case "+":
      case "*":
        return this.#push("repeat", i, i + 1);
      case "(":
      case ")":
      case "[":
      case "]":
      case "{":
      case "}":
        return this.#push("group", i, i + 1);
      case "-":
        return this.#push(
          this.#dialect === "ebnf" ? "exclusion" : "punct",
          i,
          i + 1,
        );
      default:
        return this.#push("punct", i, i + 1);
    }
  }
}

function flagsOf(stop: ScanStop): { unterminated?: true } {
  return stop.unterminated ? { unterminated: true } : {};
}

function isValidRuleName(
  token: ScanToken,
  dialect: ProductionDialect,
): boolean {
  switch (dialect) {
    case "bnf":
      return token.kind === "name" || token.kind === "angleName";
    case "ebnf":
      return token.kind === "name";
    default:
      return token.kind === "angleName";
  }
}

interface StartMatch {
  kind: "production" | "iso" | "invalidName";
  /** Number of significant tokens that form the statement head. */
  length: number;
}

function matchStart(
  sig: readonly ScanToken[],
  index: number,
  dialect: ProductionDialect,
): StartMatch | undefined {
  const first = sig[index];
  if (!first) {
    return undefined;
  }
  let offset = 0;
  if (dialect === "ebnf" && first.kind === "productionNumber") {
    offset = 1;
  }
  const name = sig[index + offset];
  const next = sig[index + offset + 1];
  if (!(name && next && name.endLine === next.line)) {
    return undefined;
  }
  if (next.kind === "assignment") {
    return {
      kind: isValidRuleName(name, dialect) ? "production" : "invalidName",
      length: offset + 2,
    };
  }
  if (
    dialect === "ebnf" &&
    offset === 0 &&
    name.kind === "name" &&
    next.kind === "punct" &&
    next.text === "="
  ) {
    return { kind: "iso", length: 2 };
  }
  return undefined;
}

function isContinuationStart(token: ScanToken): boolean {
  return (
    token.kind === "alternative" ||
    (token.kind === "group" &&
      (token.text === ")" || token.text === "]" || token.text === "}"))
  );
}

class Grouper {
  readonly productions: Production[] = [];
  readonly strays: StrayStatement[] = [];
  #production: Production | undefined;
  #stray: StrayStatement | undefined;
  #pending: ScanToken[] = [];
  #lastSignificant: ScanToken | undefined;

  startProduction(head: ScanToken[]): void {
    this.#finish();
    const numberToken = head.length === 3 ? head[0] : undefined;
    const nameToken = head[head.length - 2] as ScanToken;
    const assignToken = head[head.length - 1] as ScanToken;
    const preceding = this.#precedingComment();
    const production: Production = {
      nameToken,
      assignToken,
      bodyTokens: [],
      innerComments: [],
      trailingComments: [],
      unindentedTokens: [],
      startOffset: (numberToken ?? nameToken).start,
      endOffset: assignToken.end,
    };
    if (numberToken) {
      production.numberToken = numberToken;
    }
    if (preceding) {
      production.precedingComment = preceding;
    }
    this.productions.push(production);
    this.#production = production;
    this.#pending = [];
    this.#lastSignificant = assignToken;
  }

  startStray(kind: StrayStatement["kind"], head: ScanToken[]): void {
    this.#finish();
    this.#stray = { kind, tokens: [...head] };
    this.strays.push(this.#stray);
    this.#pending = [];
    this.#lastSignificant = head[head.length - 1];
  }

  addComment(token: ScanToken): void {
    if (token.iso && this.#stray?.kind === "iso") {
      // ISO comments belong to the ISO statement they sit in.
      this.#stray.tokens.push(token);
      return;
    }
    this.#pending.push(token);
  }

  addToken(token: ScanToken): void {
    if (!(this.#stray || this.#production)) {
      // Tokens before the first rule have no owner; report them.
      this.startStray("unexpected", [token]);
    } else if (this.#stray) {
      this.#stray.tokens.push(token);
    } else if (this.#production) {
      const production = this.#production;
      appendAll(production.innerComments, this.#pending);
      if (token.column === 0 && !isContinuationStart(token)) {
        production.unindentedTokens.push(token);
      }
      production.bodyTokens.push(token);
      production.endOffset = token.end;
    }
    this.#pending = [];
    this.#lastSignificant = token;
  }

  finish(): void {
    this.#finish();
  }

  #precedingComment(): ScanToken | undefined {
    const last = this.#pending[this.#pending.length - 1];
    if (!last) {
      return undefined;
    }
    const previous = this.#lastSignificant;
    return previous && previous.endLine >= last.line ? undefined : last;
  }

  #finish(): void {
    const production = this.#production;
    const previous = this.#lastSignificant;
    if (production && previous) {
      production.trailingComments = this.#pending.filter(
        (comment) => comment.line === previous.endLine,
      );
    }
    this.#production = undefined;
    this.#stray = undefined;
  }
}

function group(tokens: readonly ScanToken[], dialect: ProductionDialect) {
  const sig = tokens.filter((token) => token.kind !== "comment");
  const sigIndex = new Map(sig.map((token, index) => [token, index]));
  const grouper = new Grouper();
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k] as ScanToken;
    if (token.kind === "comment") {
      grouper.addComment(token);
      continue;
    }
    const index = sigIndex.get(token) ?? 0;
    const previous = sig[index - 1];
    const firstOnLine = !previous || previous.endLine < token.line;
    const start = firstOnLine ? matchStart(sig, index, dialect) : undefined;
    if (!start) {
      grouper.addToken(token);
      continue;
    }
    const head = sig.slice(index, index + start.length);
    const lastHead = head[head.length - 1];
    while (k < tokens.length && tokens[k] !== lastHead) {
      k++;
    }
    if (start.kind === "production") {
      grouper.startProduction(head);
    } else {
      grouper.startStray(start.kind, head);
    }
  }
  grouper.finish();
  return grouper;
}

const recentScans = new RecentCache<ScanResult>(RECENT_DOCUMENTS);

/**
 * Lexes text into tokens without grouping or memoizing. Use it for sub-texts
 * so the memoized document scan is not evicted.
 */
export function lexProductionGrammar(
  text: string,
  dialect: ProductionDialect,
): ScanToken[] {
  return new Scanner(text, dialect, new LineIndex(text)).scan();
}

/**
 * Scans a BNF, EBNF, or RBNF document in one pass. Parser, semantic tokens,
 * and formatter all consume this result. Recent results are memoized per
 * text, so parse, tokenize, and format share one scan even when several
 * documents are active.
 */
export function scanProductionGrammar(
  text: string,
  dialect: ProductionDialect,
): ScanResult {
  return recentScans.get(dialect, text, () => {
    const lineIndex = new LineIndex(text);
    const scanner = new Scanner(text, dialect, lineIndex);
    const tokens = scanner.scan();
    const grouper = group(tokens, dialect);
    return {
      text,
      dialect,
      lineIndex,
      tokens,
      productions: grouper.productions,
      strays: grouper.strays,
      unclosedIsoOpeners: scanner.unclosedIsoOpeners,
    };
  });
}

/**
 * Checks whether a production has unbalanced delimiters or an unterminated
 * token. The formatter emits such productions unchanged.
 */
export function productionHasErrors(production: Production): boolean {
  if (production.unindentedTokens.length > 0) {
    return true;
  }
  const stack: string[] = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (const token of production.bodyTokens) {
    if (token.unterminated) {
      return true;
    }
    if (token.kind !== "group") {
      continue;
    }
    if (token.text === "(" || token.text === "[" || token.text === "{") {
      stack.push(token.text);
    } else if (stack.pop() !== pairs[token.text]) {
      return true;
    }
  }
  const trailing = production.trailingComments.concat(production.innerComments);
  return stack.length > 0 || trailing.some((comment) => comment.unterminated);
}
