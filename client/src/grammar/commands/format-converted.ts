import {
  type AbnfFormatterConfig,
  formatAbnfDocument,
} from "../../abnf/format.ts";
import type { GrammarDialect } from "../dialects.ts";
import {
  formatProductionGrammarDocument,
  type GenericGrammarFormatterConfig,
} from "../format.ts";

/**
 * Formatter settings for converted text; the extension's defaults.
 */
export type ConvertedFormatConfig = AbnfFormatterConfig &
  GenericGrammarFormatterConfig;

export const DEFAULT_CONVERTED_FORMAT: ConvertedFormatConfig = {
  alignEquals: true,
  alignProductionNumbers: true,
  alternativeIndent: "align",
  blankLinesBetweenRules: 1,
  breakAlternatives: "always",
  continuationIndent: 4,
  insertFinalNewline: true,
  maxLineLength: 80,
  preserveCommentSpacing: true,
  preserveContinuationLineBreaks: false,
  spaceBeforeInlineComment: 2,
  trimTrailingBlankLines: true,
};

/**
 * Formats converted text in the target dialect with the existing formatters.
 */
export function formatConverted(
  text: string,
  target: GrammarDialect,
  config: ConvertedFormatConfig = DEFAULT_CONVERTED_FORMAT,
): string {
  return target === "abnf"
    ? formatAbnfDocument(text, config)
    : formatProductionGrammarDocument(text, target, config);
}
