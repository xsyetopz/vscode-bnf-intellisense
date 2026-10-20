import { type Diagnostic, DiagnosticSeverity } from "vscode";
import { AbnfDiagnosticCode } from "../../abnf/diagnostic-codes.ts";
import { GrammarDiagnosticCode } from "../diagnostic-codes.ts";

/**
 * Warning codes that mean the text is not a clean sequence of rules: the
 * scanner or parser could not tell where a rule starts or ends. Commands that
 * move or rewrite text refuse such documents, like they refuse errors.
 */
const STRUCTURAL_CODES: ReadonlySet<string> = new Set([
  GrammarDiagnosticCode.IsoEbnf,
  GrammarDiagnosticCode.IsoCommentUnclosed,
  GrammarDiagnosticCode.UnbalancedDelimiter,
  GrammarDiagnosticCode.InvalidRuleName,
  GrammarDiagnosticCode.UnindentedContinuation,
  GrammarDiagnosticCode.UnexpectedText,
  GrammarDiagnosticCode.UnterminatedComment,
  GrammarDiagnosticCode.UnterminatedString,
  GrammarDiagnosticCode.StrayAssignment,
  GrammarDiagnosticCode.InvalidCharCode,
  GrammarDiagnosticCode.EmptyGroup,
  GrammarDiagnosticCode.RepetitionNoOperand,
  AbnfDiagnosticCode.ContinuationIndent,
  AbnfDiagnosticCode.UnexpectedLine,
  AbnfDiagnosticCode.InvalidRuleName,
  AbnfDiagnosticCode.RuleColumn,
  AbnfDiagnosticCode.EmptyGroup,
  AbnfDiagnosticCode.UnclosedGroup,
  AbnfDiagnosticCode.UnclosedOption,
  AbnfDiagnosticCode.UnexpectedToken,
  AbnfDiagnosticCode.UnterminatedString,
  AbnfDiagnosticCode.UnterminatedProse,
]);

/**
 * Describes the first parse problem of a document ("line 3: ..."), or
 * returns undefined when the parser found nothing that blocks the command.
 * Pass only the diagnostics of `parseGrammar`, not the analysis diagnostics.
 */
export function firstBlockingProblem(
  diagnostics: readonly Diagnostic[],
): string | undefined {
  for (const diagnostic of diagnostics) {
    const code = typeof diagnostic.code === "string" ? diagnostic.code : "";
    if (
      diagnostic.severity === DiagnosticSeverity.Error ||
      STRUCTURAL_CODES.has(code)
    ) {
      return `line ${diagnostic.range.start.line + 1}: ${diagnostic.message}`;
    }
  }
  return undefined;
}
