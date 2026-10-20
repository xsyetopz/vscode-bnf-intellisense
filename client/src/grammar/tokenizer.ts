import { tokenizeDocument as tokenizeAbnf } from "../abnf/tokenizer.ts";
import { AbnfTokenKind } from "../abnf/types.ts";
import type { GrammarDialect } from "./dialects.ts";
import {
  type ProductionDialect,
  type ScanToken,
  scanProductionGrammar,
} from "./scanner.ts";

/**
 * Token categories used by cross-dialect grammar services.
 */
export type GrammarTokenKind =
  | "ruleName"
  | "reference"
  | "assignment"
  | "alternative"
  | "literal"
  | "number"
  | "comment"
  | "group"
  | "repeat"
  | "charCode"
  | "charClass"
  | "operator"
  | "unknown";

/**
 * Cross-dialect token with source text and range metadata.
 */
export interface GrammarToken {
  kind: GrammarTokenKind;
  text: string;
  line: number;
  column: number;
}

const LINE_SPLIT_RE = /\r\n|\n|\r/;

/**
 * Tokenizes a document according to its grammar dialect.
 */
export function tokenizeGrammar(
  text: string,
  dialect: GrammarDialect,
): GrammarToken[] {
  return dialect === "abnf"
    ? tokenizeAbnfGrammar(text)
    : tokenizeProductionGrammar(text, dialect);
}

function tokenizeAbnfGrammar(text: string): GrammarToken[] {
  return tokenizeAbnf(text).flatMap((token) => {
    const kind = abnfKind(token.kind);
    return kind
      ? [{ kind, text: token.text, line: token.line, column: token.column }]
      : [];
  });
}

function abnfKind(kind: AbnfTokenKind): GrammarTokenKind | undefined {
  switch (kind) {
    case AbnfTokenKind.Rulename:
      return "reference";
    case AbnfTokenKind.DefinedAs:
    case AbnfTokenKind.IncrementalAs:
      return "assignment";
    case AbnfTokenKind.Alternation:
      return "alternative";
    case AbnfTokenKind.String:
    case AbnfTokenKind.CaseSensitiveString:
    case AbnfTokenKind.CaseInsensitiveString:
    case AbnfTokenKind.ProseValue:
      return "literal";
    case AbnfTokenKind.NumericValue:
      return "charCode";
    case AbnfTokenKind.Integer:
      return "number";
    case AbnfTokenKind.Comment:
      return "comment";
    case AbnfTokenKind.ParenOpen:
    case AbnfTokenKind.ParenClose:
    case AbnfTokenKind.BracketOpen:
    case AbnfTokenKind.BracketClose:
      return "group";
    case AbnfTokenKind.Asterisk:
      return "repeat";
    case AbnfTokenKind.Unknown:
      return "unknown";
    default:
      return undefined;
  }
}

function tokenizeProductionGrammar(
  text: string,
  dialect: ProductionDialect,
): GrammarToken[] {
  const scan = scanProductionGrammar(text, dialect);
  const headNames = new Set<ScanToken>();
  for (const production of scan.productions) {
    headNames.add(production.nameToken);
  }
  const tokens: GrammarToken[] = [];
  for (const token of scan.tokens) {
    const kind = grammarKind(token, dialect, headNames);
    if (kind) {
      pushPerLine(tokens, kind, token);
    }
  }
  return tokens;
}

function grammarKind(
  token: ScanToken,
  dialect: ProductionDialect,
  headNames: ReadonlySet<ScanToken>,
): GrammarTokenKind | undefined {
  switch (token.kind) {
    case "comment":
    case "annotation":
      return "comment";
    case "string":
      return "literal";
    case "charClass":
    case "charCode":
    case "assignment":
    case "alternative":
    case "repeat":
    case "group":
      return token.kind;
    case "productionNumber":
      return "number";
    case "exclusion":
      return "operator";
    case "angleName":
      return headNames.has(token) ? "ruleName" : "reference";
    case "name":
      if (headNames.has(token)) {
        return "ruleName";
      }
      return dialect === "rbnf" ? undefined : "reference";
    default:
      return undefined;
  }
}

/**
 * Pushes a token, splitting multi-line tokens (block comments) per line.
 */
function pushPerLine(
  out: GrammarToken[],
  kind: GrammarTokenKind,
  token: ScanToken,
): void {
  if (token.line === token.endLine) {
    out.push({
      kind,
      text: token.text,
      line: token.line,
      column: token.column,
    });
    return;
  }
  const lines = token.text.split(LINE_SPLIT_RE);
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] ?? "";
    if (text.length > 0) {
      out.push({
        kind,
        text,
        line: token.line + i,
        column: i === 0 ? token.column : 0,
      });
    }
  }
}
