/**
 * Stable `Diagnostic.code` values for the shared BNF, EBNF, and RBNF
 * diagnostics, and for the analysis diagnostics that run on all four
 * dialects. Quick fixes match on these instead of message text.
 * ABNF parser diagnostics keep their own codes in `abnf/diagnostic-codes.ts`.
 */
export const GrammarDiagnosticCode = {
  /** A reference to a rule that has no definition in the file. */
  UndefinedReference: "bnf.undefined-reference",
  /** A rule that no other rule references. */
  UnusedRule: "bnf.unused-rule",
  /** A rule defined more than once (outside ABNF `=/`). */
  DuplicateDefinition: "bnf.duplicate-definition",
  /** `=/` used before any `=` definition (ABNF). */
  IncrementalWithoutBase: "bnf.incremental-without-base",
  /** ISO/IEC 14977 syntax in an EBNF file. */
  IsoEbnf: "bnf.iso-ebnf",
  /** `(*` that starts an ISO comment which is not closed in time. */
  IsoCommentUnclosed: "bnf.iso-comment-unclosed",
  /** A rule that is directly or indirectly left-recursive. */
  LeftRecursion: "bnf.left-recursion",
  /** A rule that can never derive a terminal string. */
  UnproductiveRule: "bnf.unproductive-rule",
  /** A referenced rule that the start rule can never reach. */
  UnreachableRule: "bnf.unreachable-rule",
  /** Two identical alternatives inside one choice. */
  DuplicateAlternative: "bnf.duplicate-alternative",
  /** An ABNF `=/` extension whose alternatives all exist already. */
  DuplicateExtension: "bnf.duplicate-extension",
  /** An alternative that matches only the empty string. */
  EmptyAlternative: "bnf.empty-alternative",
  /** A rule with no expression. */
  EmptyRule: "bnf.empty-rule",
  /** Invalid hexadecimal character code. */
  InvalidCharCode: "bnf.invalid-char-code",
  /** Unbalanced `(`, `[`, `{` or their closers. */
  UnbalancedDelimiter: "bnf.unbalanced-delimiter",
  /** `()`, `[]` or `{}` with nothing inside. */
  EmptyGroup: "bnf.empty-group",
  /** `*`, `+`, `?` or RBNF `...` with no operand before it. */
  RepetitionNoOperand: "bnf.repetition-no-operand",
  /** RBNF rule name spanning lines. */
  InvalidRuleName: "bnf.invalid-rule-name",
  /** RBNF bare word instead of `<name>`. */
  BareReference: "bnf.bare-reference",
  /** Continuation text that starts in column 0. */
  UnindentedContinuation: "bnf.unindented-continuation",
  /** Text that is not part of a rule. */
  UnexpectedText: "bnf.unexpected-text",
  /** Unterminated comment. */
  UnterminatedComment: "bnf.unterminated-comment",
  /** Unterminated string literal. */
  UnterminatedString: "bnf.unterminated-string",
  /** `::=` that does not start a rule. */
  StrayAssignment: "bnf.stray-assignment",
  /** `A-B` written without spaces around the W3C exclusion operator. */
  ExclusionSpacing: "bnf.exclusion-spacing",
} as const;

export type GrammarDiagnosticCode =
  (typeof GrammarDiagnosticCode)[keyof typeof GrammarDiagnosticCode];
