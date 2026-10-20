import {
  DiagnosticSeverity,
  type Position,
  type Range,
  type TextDocument,
} from "vscode";
import { AbnfDiagnosticCode } from "../../abnf/diagnostic-codes.ts";
import type { GrammarDocument, Rule, SymbolTable } from "../../types.ts";
import { GrammarDiagnosticCode } from "../diagnostic-codes.ts";
import type { GrammarDialect } from "../dialects.ts";
import { LineIndex } from "../line-index.ts";
import { rangeFromLineIndex } from "../ranges.ts";
import {
  type DocumentLayout,
  type LayoutToken,
  layoutGrammar,
  type RuleLayout,
} from "../rule-layout.ts";
import { normalizeSymbolName } from "../symbol-table.ts";
import type { GrammarWorkspace } from "../workspace.ts";
import { analyzeBody, type BodyStructure, isAnnotation } from "./structure.ts";

/**
 * Diagnostics that do not change how a rule body tokenizes, so they never
 * block a refactor.
 */
const NON_STRUCTURAL_CODES: ReadonlySet<string> = new Set([
  AbnfDiagnosticCode.DuplicateDefinition,
  AbnfDiagnosticCode.IncrementalWithoutBase,
  AbnfDiagnosticCode.CaseInsensitiveString,
  AbnfDiagnosticCode.NonAsciiString,
  AbnfDiagnosticCode.NonAsciiProse,
  AbnfDiagnosticCode.RepetitionRedundant,
  AbnfDiagnosticCode.RangeOrder,
  GrammarDiagnosticCode.DuplicateDefinition,
  GrammarDiagnosticCode.IncrementalWithoutBase,
  GrammarDiagnosticCode.DuplicateExtension,
  GrammarDiagnosticCode.InvalidCharCode,
  GrammarDiagnosticCode.BareReference,
  GrammarDiagnosticCode.ExclusionSpacing,
]);

/**
 * One rule with the data refactors need.
 */
export interface RuleInfo {
  index: number;
  rule: Rule;
  layout: RuleLayout;
  /** Normalized name, the symbol table key. */
  key: string;
  /** Every body token, annotations included. */
  body: readonly LayoutToken[];
  /** Maps a `body` index to its index in `structure`, or -1 for annotations. */
  structOf: readonly number[];
  hasAnnotation: boolean;
  /** Body tokens without annotations. */
  structure: BodyStructure;
  /** The rule cannot be edited safely: syntax errors or broken delimiters. */
  errors: boolean;
}

const LINE_BREAK_RE = /^(?:\r\n|\n|\r)/;
const BLANK_RE = /^\s*$/;

/**
 * Parse results and text helpers shared by the refactors of one request.
 */
export class RefactorContext {
  readonly doc: TextDocument;
  readonly text: string;
  readonly dialect: GrammarDialect;
  readonly document: GrammarDocument;
  readonly symbolTable: SymbolTable;
  readonly layout: DocumentLayout;
  readonly lines: LineIndex;
  readonly #infos = new Map<number, RuleInfo>();
  #blockedLines: Set<number> | undefined;

  private constructor(
    doc: TextDocument,
    dialect: GrammarDialect,
    document: GrammarDocument,
    symbolTable: SymbolTable,
    layout: DocumentLayout,
  ) {
    this.doc = doc;
    this.text = doc.getText();
    this.dialect = dialect;
    this.document = document;
    this.symbolTable = symbolTable;
    this.layout = layout;
    this.lines = new LineIndex(this.text);
  }

  /**
   * Builds a context from the cached parse of `workspace`. Returns undefined
   * when the token layout and the parsed rules disagree.
   */
  static create(
    doc: TextDocument,
    workspace: GrammarWorkspace,
  ): RefactorContext | undefined {
    const { dialect, document, symbolTable } = workspace.get(doc);
    const layout = layoutGrammar(doc.getText(), dialect);
    if (layout.rules.length !== document.rules.length) {
      return undefined;
    }
    return new RefactorContext(doc, dialect, document, symbolTable, layout);
  }

  get ruleCount(): number {
    return this.layout.rules.length;
  }

  offsetAt(position: Position): number {
    const start = this.lines.starts[position.line];
    if (start === undefined) {
      return this.text.length;
    }
    return Math.min(start + position.character, this.contentEnd(position.line));
  }

  range(start: number, end: number): Range {
    return rangeFromLineIndex(this.lines, start, end);
  }

  /** Index of the rule whose lines contain `line`, or -1. */
  ruleIndexAtLine(line: number): number {
    const rules = this.layout.rules;
    let low = 0;
    let high = rules.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if ((rules[mid] as RuleLayout).startLine <= line) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (found >= 0 && line <= (rules[found] as RuleLayout).endLine) {
      return found;
    }
    return -1;
  }

  info(index: number): RuleInfo {
    const cached = this.#infos.get(index);
    if (cached) {
      return cached;
    }
    const layout = this.layout.rules[index] as RuleLayout;
    const rule = this.document.rules[index] as Rule;
    const body = layout.bodyTokens;
    const structOf: number[] = [];
    const structural: LayoutToken[] = [];
    let hasAnnotation = false;
    for (const token of body) {
      if (isAnnotation(token, this.dialect)) {
        hasAnnotation = true;
        structOf.push(-1);
      } else {
        structOf.push(structural.length);
        structural.push(token);
      }
    }
    const structure = analyzeBody(structural, this.dialect);
    const info: RuleInfo = {
      index,
      rule,
      layout,
      key: normalizeSymbolName(rule.name, this.dialect),
      body,
      structOf,
      hasAnnotation,
      structure,
      errors:
        layout.incomplete || !structure.balanced || this.#hasErrors(layout),
    };
    this.#infos.set(index, info);
    return info;
  }

  /** True when another rule starts or ends on a line of rule `index`. */
  sharesLines(index: number): boolean {
    const layout = this.layout.rules[index] as RuleLayout;
    const before = this.layout.rules[index - 1];
    const after = this.layout.rules[index + 1];
    return (
      (before !== undefined && before.endLine >= layout.startLine) ||
      (after !== undefined && after.startLine <= layout.endLine)
    );
  }

  /** End offset of the content of `line`, before its line break. */
  contentEnd(line: number): number {
    const next = this.lines.starts[line + 1];
    if (next === undefined) {
      return this.text.length;
    }
    const crlf = this.text.slice(next - 2, next) === "\r\n";
    return next - (crlf ? 2 : 1);
  }

  lineStart(line: number): number {
    return this.lines.starts[line] ?? this.text.length;
  }

  get lineCount(): number {
    return this.lines.starts.length;
  }

  isBlankLine(line: number): boolean {
    return BLANK_RE.test(
      this.text.slice(this.lineStart(line), this.contentEnd(line)),
    );
  }

  /** Line break used at the end of `line`, else the document's first one. */
  eolAfter(line: number): string {
    const end = this.contentEnd(line);
    const here = LINE_BREAK_RE.exec(this.text.slice(end, end + 2));
    if (here) {
      return here[0];
    }
    const first = /\r\n|\n|\r/.exec(this.text);
    if (first) {
      return first[0];
    }
    return this.doc.eol === 2 ? "\r\n" : "\n";
  }

  /**
   * Whether `[from, to)` holds only whitespace and whole comments.
   */
  isTrivia(from: number, to: number): boolean {
    if (from >= to) {
      return true;
    }
    const comments = this.layout.comments;
    let low = 0;
    let high = comments.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((comments[mid] as LayoutToken).end > from) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }
    let rest = "";
    let cursor = from;
    for (let k = low; k < comments.length; k++) {
      const comment = comments[k] as LayoutToken;
      if (comment.start >= to) {
        break;
      }
      if (comment.start < from || comment.end > to) {
        return false;
      }
      rest += this.text.slice(cursor, comment.start);
      cursor = comment.end;
    }
    rest += this.text.slice(cursor, to);
    return BLANK_RE.test(rest);
  }

  #hasErrors(layout: RuleLayout): boolean {
    if (!this.#blockedLines) {
      this.#blockedLines = this.#collectBlockedLines();
    }
    const blocked = this.#blockedLines;
    for (let line = layout.startLine; line <= layout.endLine; line++) {
      if (blocked.has(line)) {
        return true;
      }
    }
    return false;
  }

  #collectBlockedLines(): Set<number> {
    const blocked = new Set<number>();
    const add = (from: number, to: number): void => {
      for (let line = from; line <= to; line++) {
        blocked.add(line);
      }
    };
    for (const diagnostic of this.document.diagnostics) {
      const severity = diagnostic.severity;
      const serious =
        severity === DiagnosticSeverity.Error ||
        severity === DiagnosticSeverity.Warning;
      const code =
        typeof diagnostic.code === "object"
          ? diagnostic.code.value
          : diagnostic.code;
      if (
        serious &&
        !(typeof code === "string" && NON_STRUCTURAL_CODES.has(code))
      ) {
        add(diagnostic.range.start.line, diagnostic.range.end.line);
      }
    }
    for (const token of this.layout.unterminated) {
      add(token.line, token.endLine);
    }
    return blocked;
  }
}
