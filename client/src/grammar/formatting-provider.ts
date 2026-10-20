import {
  type CancellationToken,
  type ConfigurationScope,
  type DocumentFormattingEditProvider,
  type DocumentRangeFormattingEditProvider,
  type FormattingOptions,
  Range,
  type TextDocument,
  TextEdit,
} from "vscode";
import {
  type AbnfAlternativeIndent,
  type AbnfBreakAlternatives,
  type AbnfFormatterConfig,
  formatAbnfDocument,
} from "../abnf/format.ts";
import { readGrammarConfig as readScoped } from "./config.ts";
import {
  formatProductionGrammarDocument,
  type GenericGrammarFormatterConfig,
} from "./format.ts";
import { grammarDialectFromLanguageId } from "./grammar.ts";
import { layoutGrammar } from "./rule-layout.ts";

const WHITESPACE_RE = /\s+/g;
const EOL_RE = /\r\n|\n|\r/;

/**
 * Formats a whole document with the settings that apply to it.
 */
function formatDocumentText(document: TextDocument, text: string): string {
  const config = readFormattingConfig({
    uri: document.uri,
    languageId: document.languageId,
  });
  const dialect = grammarDialectFromLanguageId(document.languageId);
  return dialect === "abnf"
    ? formatAbnfDocument(text, config)
    : formatProductionGrammarDocument(text, dialect, config);
}

/**
 * VS Code document formatter for ABNF and production grammar dialects.
 */
export class GrammarFormattingProvider
  implements DocumentFormattingEditProvider
{
  provideDocumentFormattingEdits(
    document: TextDocument,
    _options: FormattingOptions,
    _token: CancellationToken,
  ): TextEdit[] {
    const text = document.getText();
    if (text.trim().length === 0) {
      return [];
    }
    const result = formatDocumentText(document, text);
    if (result === text) {
      return [];
    }
    const fullRange = new Range(
      document.positionAt(0),
      document.positionAt(text.length),
    );
    return [TextEdit.replace(fullRange, result)];
  }
}

/**
 * VS Code range formatter. Rules that overlap the range are formatted as a
 * whole and nothing outside them is touched. Each rule gets exactly the text
 * that full-document formatting produces for it, including the alignment
 * shared with the neighbouring rules. Blank lines between rules, comments
 * between rules, and the final newline are outside every rule, so only
 * full-document formatting normalizes them.
 */
export class GrammarRangeFormattingProvider
  implements DocumentRangeFormattingEditProvider
{
  provideDocumentRangeFormattingEdits(
    document: TextDocument,
    range: Range,
    _options: FormattingOptions,
    token?: CancellationToken,
  ): TextEdit[] {
    const text = document.getText();
    if (text.trim().length === 0 || token?.isCancellationRequested) {
      return [];
    }
    const formatted = formatDocumentText(document, text);
    if (formatted === text) {
      return [];
    }
    const dialect = grammarDialectFromLanguageId(document.languageId);
    const before = layoutGrammar(text, dialect).rules;
    const after = layoutGrammar(formatted, dialect).rules;
    // The formatter never adds, drops, or renames rules. If the two layouts
    // disagree, the mapping is unreliable and nothing is edited.
    if (
      before.length !== after.length ||
      before.some((rule, index) => rule.name !== after[index]?.name)
    ) {
      return [];
    }
    const lines = text.split(EOL_RE);
    const formattedLines = formatted.split(EOL_RE);
    const eol = /\r\n|\n|\r/.exec(formatted)?.[0] ?? "\n";
    // A selection that ends at column 0 does not include that last line.
    const lastLine =
      range.end.character === 0 && range.end.line > range.start.line
        ? range.end.line - 1
        : range.end.line;
    const edits: TextEdit[] = [];
    for (let i = 0; i < before.length; i++) {
      const rule = before[i];
      const result = after[i];
      if (
        !(rule && result) ||
        rule.endLine < range.start.line ||
        rule.startLine > lastLine
      ) {
        continue;
      }
      const original = lines.slice(rule.startLine, rule.endLine + 1);
      const replacement = formattedLines.slice(
        result.startLine,
        result.endLine + 1,
      );
      if (original.join(eol) === replacement.join(eol)) {
        continue;
      }
      // Safety net: formatting only moves whitespace. If the two slices
      // differ in anything else, the layouts did not line up (for example a
      // comment moved outside the rule's lines): skip rather than lose text.
      if (
        original.join("").replace(WHITESPACE_RE, "") !==
        replacement.join("").replace(WHITESPACE_RE, "")
      ) {
        continue;
      }
      edits.push(
        TextEdit.replace(
          new Range(
            rule.startLine,
            0,
            rule.endLine,
            lines[rule.endLine]?.length ?? 0,
          ),
          replacement.join(eol),
        ),
      );
    }
    return edits;
  }
}

/**
 * Reads the formatter settings that apply to one document.
 */
export function readFormattingConfig(
  scope: ConfigurationScope,
): AbnfFormatterConfig & GenericGrammarFormatterConfig {
  const readGrammarConfig = <T>(key: string, fallback: T): T =>
    readScoped<T>(key, fallback, scope);
  return {
    alignEquals: readGrammarConfig<boolean>("formatting.alignEquals", true),
    // An indent below 1 would put continuation lines in column 0.
    continuationIndent: Math.max(
      1,
      Math.floor(
        readGrammarConfig<number>("formatting.continuationIndent", 4) || 1,
      ),
    ),
    alternativeIndent: readGrammarConfig<AbnfAlternativeIndent>(
      "formatting.alternativeIndent",
      "align",
    ),
    insertFinalNewline: readGrammarConfig<boolean>(
      "formatting.insertFinalNewline",
      true,
    ),
    blankLinesBetweenRules: readGrammarConfig<number>(
      "formatting.blankLinesBetweenRules",
      1,
    ),
    breakAlternatives: readGrammarConfig<AbnfBreakAlternatives>(
      "formatting.breakAlternatives",
      "always",
    ),
    maxLineLength: readGrammarConfig<number>("formatting.maxLineLength", 80),
    preserveContinuationLineBreaks: readGrammarConfig<boolean>(
      "formatting.preserveContinuationLineBreaks",
      false,
    ),
    spaceBeforeInlineComment: readGrammarConfig<number>(
      "formatting.spaceBeforeInlineComment",
      2,
    ),
    alignProductionNumbers: readGrammarConfig<boolean>(
      "formatting.alignProductionNumbers",
      true,
    ),
    preserveCommentSpacing: readGrammarConfig<boolean>(
      "formatting.preserveCommentSpacing",
      true,
    ),
    trimTrailingBlankLines: readGrammarConfig<boolean>(
      "formatting.trimTrailingBlankLines",
      true,
    ),
  };
}
