/**
 * Token categories emitted by the ABNF lexer.
 */
export const AbnfTokenKind = {
  Rulename: 0,
  DefinedAs: 1,
  IncrementalAs: 2,
  Alternation: 3,
  String: 4,
  CaseSensitiveString: 5,
  CaseInsensitiveString: 6,
  NumericValue: 7,
  ProseValue: 8,
  Comment: 9,
  ParenOpen: 10,
  ParenClose: 11,
  BracketOpen: 12,
  BracketClose: 13,
  Integer: 14,
  Asterisk: 15,
  Whitespace: 16,
  Newline: 17,
  Unknown: 18,
} as const;

export type AbnfTokenKind = (typeof AbnfTokenKind)[keyof typeof AbnfTokenKind];

/**
 * Source token with text and single-line position metadata.
 */
export interface AbnfToken {
  kind: AbnfTokenKind;
  text: string;
  offset: number;
  line: number;
  column: number;
}

/**
 * Parsed ABNF expression node accepted by rule bodies.
 */
export type AbnfExpression =
  | AbnfAlternation
  | AbnfConcatenation
  | AbnfRepetition
  | AbnfGroup
  | AbnfOptional
  | AbnfRulename
  | AbnfString
  | AbnfNumeric
  | AbnfProse;

/**
 * ABNF expression node for slash-separated alternatives.
 */
export interface AbnfAlternation {
  kind: "alternation";
  alternatives: AbnfExpression[];
}

/**
 * ABNF expression node for whitespace-separated elements.
 */
export interface AbnfConcatenation {
  kind: "concatenation";
  elements: AbnfExpression[];
}

/**
 * ABNF expression node for min/max repetition prefixes.
 */
export interface AbnfRepetition {
  kind: "repetition";
  min: number;
  max: number | null;
  element: AbnfExpression;
}

/**
 * ABNF expression node for parenthesized subexpressions.
 */
export interface AbnfGroup {
  kind: "group";
  expression: AbnfExpression;
}

/**
 * ABNF expression node for bracketed optional subexpressions.
 */
export interface AbnfOptional {
  kind: "optional";
  expression: AbnfExpression;
}

/**
 * ABNF expression node that references another rule.
 */
export interface AbnfRulename {
  kind: "rulename";
  name: string;
  token: AbnfToken;
}

/**
 * ABNF expression node for quoted terminal text.
 */
export interface AbnfString {
  kind: "string";
  value: string;
  caseSensitive: boolean;
}

/**
 * ABNF expression node for numeric terminal values.
 */
export interface AbnfNumeric {
  kind: "numeric";
  base: "d" | "x" | "b";
  text: string;
}

/**
 * ABNF expression node for prose-val terminals.
 */
export interface AbnfProse {
  kind: "prose";
  text: string;
}
