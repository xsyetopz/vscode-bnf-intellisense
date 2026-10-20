/**
 * Stable `Diagnostic.code` values for ABNF diagnostics. Quick fixes match
 * on these instead of message text.
 */
export const AbnfDiagnosticCode = {
  /** A second `=` definition of an already defined rule. */
  DuplicateDefinition: "abnf.duplicate-definition",
  /** `=/` for a rule that has no `=` definition. */
  IncrementalWithoutBase: "abnf.incremental-without-base",
  /** A column-0 line that continues the previous rule. */
  ContinuationIndent: "abnf.continuation-indent",
  /** A line that does not start a rule definition. */
  UnexpectedLine: "abnf.unexpected-line",
  /** A rule name that starts with a digit. */
  InvalidRuleName: "abnf.invalid-rule-name",
  /** A rule definition that does not start at column 0. */
  RuleColumn: "abnf.rule-column",
  /** A rule with nothing after `=` / `=/`. */
  EmptyRule: "abnf.empty-rule",
  /** `(` without a closing `)`. */
  UnclosedGroup: "abnf.unclosed-group",
  /** `[` without a closing `]`. */
  UnclosedOption: "abnf.unclosed-option",
  /** `()` or `[]` with nothing inside. */
  EmptyGroup: "abnf.empty-group",
  /** A token that cannot continue the rule body. */
  UnexpectedToken: "abnf.unexpected-token",
  /** Elements that touch without whitespace between them. */
  MissingSeparator: "abnf.missing-separator",
  /** A malformed num-val (`%x`, `%xG1`, `%x41..42`, ...). */
  InvalidNumeric: "abnf.invalid-numeric",
  /** A num-val range such as `%x5A-41` whose lower bound exceeds the upper. */
  RangeOrder: "abnf.range-order",
  /** A num-val range with no upper bound. */
  RangeIncomplete: "abnf.range-incomplete",
  /** Repetition `5*3`. */
  RepetitionBounds: "abnf.repetition-bounds",
  /** Repetition `1*1` / `*0`. */
  RepetitionRedundant: "abnf.repetition-redundant",
  /** Repetition prefix with nothing to repeat. */
  RepetitionNoElement: "abnf.repetition-no-element",
  /** Whitespace between a repetition prefix and its element. */
  RepetitionWhitespace: "abnf.repetition-whitespace",
  /** A char-val without its closing quote. */
  UnterminatedString: "abnf.unterminated-string",
  /** A prose-val without its closing `>`. */
  UnterminatedProse: "abnf.unterminated-prose",
  /** A char-val outside printable ASCII. */
  NonAsciiString: "abnf.non-ascii-string",
  /** A prose-val outside printable ASCII. */
  NonAsciiProse: "abnf.non-ascii-prose",
  /** Opt-in hint: a case-insensitive string with uppercase letters. */
  CaseInsensitiveString: "abnf.case-insensitive-string",
} as const;

export type AbnfDiagnosticCode =
  (typeof AbnfDiagnosticCode)[keyof typeof AbnfDiagnosticCode];
