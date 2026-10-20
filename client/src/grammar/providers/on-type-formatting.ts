import {
  type CancellationToken,
  type FormattingOptions,
  type OnTypeFormattingEditProvider,
  type Position,
  Range,
  type TextDocument,
  TextEdit,
} from "vscode";
import { readGrammarConfig } from "../config.ts";
import type { GrammarDialect } from "../dialects.ts";
import { grammarDialectFromLanguageId } from "../grammar.ts";
import {
  type DocumentLayout,
  layoutGrammar,
  type RuleLayout,
} from "../rule-layout.ts";

/** Characters that trigger on-type formatting. */
export const ON_TYPE_FORMATTING_TRIGGERS = ["\n"] as const;

/** Width of the alternation operator and its space: `| ` or `/ `. */
const OPERATOR_WIDTH = 2;
const DEFAULT_TAB_SIZE = 4;
const LEADING_SPACE_RE = /^[ \t]*/;
/** `name =`, `<name> ::=`, `[12] name ::=`: the start of a new rule. */
const RULE_HEAD_RE =
  /^(?:\[[^\]\r\n]*\]\s*)?(?:<[^<>\r\n]+>|[A-Za-z_][\w.:-]*)\s*(?:::=|=\/?)/;

function alternationOperator(dialect: GrammarDialect): string {
  return dialect === "abnf" ? "/" : "|";
}

/**
 * True when the last significant token on `line` is an alternation operator
 * or an opening delimiter, or the head `name =` has nothing after it yet.
 */
function opensContinuation(rule: RuleLayout, line: number): boolean {
  const last = rule.bodyTokens.filter((token) => token.endLine === line).pop();
  if (last) {
    return last.kind === "alt" || last.kind === "open";
  }
  return line === rule.startLine && rule.assignToken.endLine === line;
}

/**
 * True when a string, prose value, or comment starting on or before `line`
 * is still open at its end. The scanners decide what is a string, so quotes
 * in comments, character classes, prose, or ABNF `"\"` are not misread.
 */
function endsInsideToken(layout: DocumentLayout, line: number): boolean {
  return layout.unterminated.some((t) => t.line <= line && line <= t.endLine);
}

/** Visual width of text, with tabs advancing to the next tab stop. */
function visualWidth(text: string, tabSize: number): number {
  let width = 0;
  for (const ch of text) {
    width += ch === "\t" ? tabSize - (width % tabSize) : 1;
  }
  return width;
}

function indentOf(line: string, tabSize: number): number {
  return visualWidth(LEADING_SPACE_RE.exec(line)?.[0] ?? "", tabSize);
}

/** Indentation text for `columns` visual columns. */
function indentText(
  columns: number,
  insertSpaces: boolean,
  tabSize: number,
): string {
  return insertSpaces
    ? " ".repeat(columns)
    : "\t".repeat(Math.floor(columns / tabSize)) +
        " ".repeat(columns % tabSize);
}

/**
 * Column where the first body token starts on the rule's first line, or
 * undefined when the body starts on a later line.
 */
function bodyColumn(
  rule: RuleLayout,
  firstLine: string,
  tabSize: number,
): number | undefined {
  const first = rule.bodyTokens[0];
  return first && first.line === rule.startLine
    ? visualWidth(firstLine.slice(0, first.column), tabSize)
    : undefined;
}

/** True when the first non-blank character of the line begins a comment. */
function startsWithComment(
  layout: DocumentLayout,
  line: number,
  text: string,
): boolean {
  const column = text.length - text.trimStart().length;
  return layout.comments.some((c) => c.line === line && c.column === column);
}

/**
 * True when the line starts inside a comment, which can hold `|` and `/`.
 */
function startsInComment(layout: DocumentLayout, line: number): boolean {
  return layout.comments.some((c) => c.line < line && line <= c.endLine);
}

/**
 * VS Code on-type formatter. After Enter it fixes the indentation of the new
 * line, but only when the line certainly continues a rule. In a comment, on a
 * blank line after a finished rule, or outside a rule, it edits nothing.
 */
export class GrammarOnTypeFormattingProvider
  implements OnTypeFormattingEditProvider
{
  provideOnTypeFormattingEdits(
    doc: TextDocument,
    position: Position,
    ch: string,
    options: FormattingOptions,
    token?: CancellationToken,
  ): TextEdit[] {
    if (ch !== "\n" || position.line < 1 || token?.isCancellationRequested) {
      return [];
    }
    const dialect = grammarDialectFromLanguageId(doc.languageId);
    const layout = layoutGrammar(doc.getText(), dialect);
    const line = position.line;
    if (layout.multiline.some((t) => t.line < line && line <= t.endLine)) {
      return [];
    }
    const rule = layout.rules.find(
      (candidate) =>
        candidate.startLine <= line - 1 && line - 1 <= candidate.endLine,
    );
    if (!rule) {
      return [];
    }
    const text = doc.lineAt(line).text;
    const content = text.trim();
    const previous = doc.lineAt(line - 1).text;
    // Enter inside a trailing comment moves comment text to the new line, and
    // a comment on its own line is not part of the rule body: leave both.
    if (
      content.length > 0 &&
      (layout.comments.some((comment) => comment.line === line - 1) ||
        startsWithComment(layout, line, text))
    ) {
      return [];
    }
    const startsWithOperator = content.startsWith(alternationOperator(dialect));
    const incompleteTail = line - 1 === rule.endLine && rule.incomplete;
    const intact = !endsInsideToken(layout, line - 1);
    // A line that ends inside a string was cut through it: leave it alone.
    const continues =
      intact &&
      (content.length === 0
        ? // A blank line is only certain to be a continuation when the line
          // above cannot end the rule. If the rule goes on below, the next
          // thing typed could be an operator or an operand: leave it.
          opensContinuation(rule, line - 1) || incompleteTail
        : line <= rule.endLine ||
          incompleteTail ||
          // A rule cannot start with an operator, so `| x` after a rule line
          // is a split alternative.
          startsWithOperator ||
          // The same holds for any text that does not start a new rule and
          // sits right below the rule: the rule body was cut in the middle.
          // In ABNF that tail at column 0 would otherwise be a stray line.
          (line - 1 === rule.endLine && !RULE_HEAD_RE.test(content)));
    if (!continues) {
      return [];
    }
    const tabSize = Math.max(1, options?.tabSize ?? DEFAULT_TAB_SIZE);
    const insertSpaces = options?.insertSpaces ?? true;
    const indent = this.#indentFor(
      doc,
      layout,
      dialect,
      rule,
      { line, content, previous },
      tabSize,
    );
    if (indent === undefined) {
      return [];
    }
    const leading = LEADING_SPACE_RE.exec(text)?.[0] ?? "";
    const wanted = indentText(indent, insertSpaces, tabSize);
    if (leading === wanted) {
      return [];
    }
    // Replace only the leading whitespace, never the text after it.
    return [TextEdit.replace(new Range(line, 0, line, leading.length), wanted)];
  }

  #indentFor(
    doc: TextDocument,
    layout: DocumentLayout,
    dialect: GrammarDialect,
    rule: RuleLayout,
    target: { line: number; content: string; previous: string },
    tabSize: number,
  ): number | undefined {
    const { line, content, previous } = target;
    const scope = { uri: doc.uri, languageId: doc.languageId };
    const continuation = Math.max(
      1,
      Math.floor(
        readGrammarConfig<number>("formatting.continuationIndent", 4, scope) ||
          1,
      ),
    );
    const mode = readGrammarConfig<string>(
      "formatting.alternativeIndent",
      "align",
      scope,
    );
    const operator = alternationOperator(dialect);
    const body = bodyColumn(rule, doc.lineAt(rule.startLine).text, tabSize);
    const firstLineIndent =
      mode === "indent" ? continuation : (body ?? continuation);
    let alternativeIndent = firstLineIndent;
    // Mirror an alternative line already in this rule.
    for (let l = rule.startLine + 1; l <= rule.endLine; l++) {
      if (l === line || startsInComment(layout, l)) {
        continue;
      }
      const other = doc.lineAt(l).text;
      if (other.trim().startsWith(operator)) {
        alternativeIndent = indentOf(other, tabSize);
        break;
      }
    }
    if (content.startsWith(operator)) {
      return alternativeIndent;
    }
    if (line - 1 === rule.startLine) {
      return firstLineIndent;
    }
    if (previous.trim().startsWith(operator)) {
      return indentOf(previous, tabSize) + OPERATOR_WIDTH;
    }
    return previous.trim().length === 0
      ? undefined
      : indentOf(previous, tabSize);
  }
}
