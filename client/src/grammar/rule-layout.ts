import {
  findRegionEnd,
  isRuleStart,
  isTriviaKind,
  trimRegionEnd,
} from "../abnf/regions.ts";
import { tokenizeDocument } from "../abnf/tokenizer.ts";
import { type AbnfToken, AbnfTokenKind } from "../abnf/types.ts";
import { RECENT_DOCUMENTS, RecentCache } from "../recent-cache.ts";
import type { GrammarDialect } from "./dialects.ts";
import { type ScanToken, scanProductionGrammar } from "./scanner.ts";

/**
 * Structural role of one rule-body token, shared by all dialects.
 * `prefix` is an ABNF repeat prefix (`1`, `*`) that binds to the next element;
 * `suffix` is a W3C/BNF repeat operator (`?`, `*`, `+`) that binds to the
 * previous element.
 */
export type LayoutTokenKind =
  | "term"
  | "open"
  | "close"
  | "alt"
  | "prefix"
  | "suffix";

/**
 * One token with absolute offsets and zero-based line and column positions.
 */
export interface LayoutToken {
  kind: LayoutTokenKind;
  text: string;
  start: number;
  end: number;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

/**
 * Token-level layout of one rule definition.
 */
export interface RuleLayout {
  /** Rule name exactly as written. */
  name: string;
  nameToken: LayoutToken;
  assignToken: LayoutToken;
  /** Production number such as `[12]` (EBNF/BNF only). */
  numberToken?: LayoutToken;
  /** Significant body tokens; comments and whitespace are excluded. */
  bodyTokens: LayoutToken[];
  /** First line of the rule head. */
  startLine: number;
  /** Last line of the rule, including trailing and inner comments. */
  endLine: number;
  /**
   * True when the rule cannot be complete yet: the body is empty, ends in an
   * alternation operator, or has an unclosed delimiter.
   */
  incomplete: boolean;
}

/**
 * Token-level layout of one document.
 */
export interface DocumentLayout {
  rules: RuleLayout[];
  /** Every comment token of the document. */
  comments: LayoutToken[];
  /** Every token that spans more than one line, such as block comments. */
  multiline: LayoutToken[];
  /** Strings, prose values, and comments that never close. */
  unterminated: LayoutToken[];
}

function fromScan(token: ScanToken, kind: LayoutTokenKind): LayoutToken {
  return {
    kind,
    text: token.text,
    start: token.start,
    end: token.end,
    line: token.line,
    column: token.column,
    endLine: token.endLine,
    endColumn: token.endColumn,
  };
}

function scanKind(token: ScanToken): LayoutTokenKind {
  switch (token.kind) {
    case "alternative":
      return "alt";
    case "repeat":
      return "suffix";
    case "group":
      return token.text === "(" || token.text === "[" || token.text === "{"
        ? "open"
        : "close";
    default:
      return "term";
  }
}

function isIncomplete(body: readonly LayoutToken[]): boolean {
  if (body.length === 0 || body[body.length - 1]?.kind === "alt") {
    return true;
  }
  let depth = 0;
  for (const token of body) {
    if (token.kind === "open") {
      depth++;
    } else if (token.kind === "close" && depth > 0) {
      depth--;
    }
  }
  return depth > 0;
}

function productionLayout(
  text: string,
  dialect: Exclude<GrammarDialect, "abnf">,
): DocumentLayout {
  const scan = scanProductionGrammar(text, dialect);
  const rules: RuleLayout[] = [];
  for (const production of scan.productions) {
    const bodyTokens = production.bodyTokens.map((token) =>
      fromScan(token, scanKind(token)),
    );
    const last = bodyTokens[bodyTokens.length - 1] ?? production.assignToken;
    let endLine = last.endLine;
    for (const comment of [
      ...production.trailingComments,
      ...production.innerComments,
    ]) {
      endLine = Math.max(endLine, comment.endLine);
    }
    const layout: RuleLayout = {
      name: production.nameToken.text,
      nameToken: fromScan(production.nameToken, "term"),
      assignToken: fromScan(production.assignToken, "term"),
      bodyTokens,
      startLine: (production.numberToken ?? production.nameToken).line,
      endLine,
      incomplete: isIncomplete(bodyTokens),
    };
    if (production.numberToken) {
      layout.numberToken = fromScan(production.numberToken, "term");
    }
    rules.push(layout);
  }
  const comments: LayoutToken[] = [];
  const multiline: LayoutToken[] = [];
  const unterminated: LayoutToken[] = [];
  for (const token of scan.tokens) {
    if (token.unterminated) {
      unterminated.push(fromScan(token, "term"));
    }
    if (token.kind === "comment") {
      comments.push(fromScan(token, "term"));
    }
    if (token.endLine > token.line) {
      multiline.push(fromScan(token, "term"));
    }
  }
  return { rules, comments, multiline, unterminated };
}

function abnfKind(kind: AbnfTokenKind): LayoutTokenKind {
  switch (kind) {
    case AbnfTokenKind.ParenOpen:
    case AbnfTokenKind.BracketOpen:
      return "open";
    case AbnfTokenKind.ParenClose:
    case AbnfTokenKind.BracketClose:
      return "close";
    case AbnfTokenKind.Alternation:
      return "alt";
    case AbnfTokenKind.Integer:
    case AbnfTokenKind.Asterisk:
      return "prefix";
    default:
      return "term";
  }
}

function fromAbnf(token: AbnfToken, kind: LayoutTokenKind): LayoutToken {
  return {
    kind,
    text: token.text,
    start: token.offset,
    end: token.offset + token.text.length,
    line: token.line,
    column: token.column,
    endLine: token.line,
    endColumn: token.column + token.text.length,
  };
}

function isUnterminatedAbnf(token: AbnfToken): boolean {
  switch (token.kind) {
    case AbnfTokenKind.String:
      return token.text.length < 2 || !token.text.endsWith('"');
    case AbnfTokenKind.CaseSensitiveString:
    case AbnfTokenKind.CaseInsensitiveString:
      return token.text.length < 4 || !token.text.endsWith('"');
    case AbnfTokenKind.ProseValue:
      return !token.text.endsWith(">");
    default:
      return false;
  }
}

/**
 * Mirrors the rule detection loop of `parseAbnf`, so rule `i` here is rule
 * `i` of the parsed document.
 */
function abnfLayout(text: string): DocumentLayout {
  const tokens = tokenizeDocument(text);
  const rules: RuleLayout[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (
      token === undefined ||
      token.kind === AbnfTokenKind.Newline ||
      token.kind === AbnfTokenKind.Comment
    ) {
      i++;
      continue;
    }
    let first = i;
    if (token.kind === AbnfTokenKind.Whitespace) {
      first = i + 1;
      const after = tokens[first];
      if (after === undefined || isTriviaKind(after.kind)) {
        i = first;
        continue;
      }
    }
    if (!(first === i && isRuleStart(tokens, i))) {
      i = findRegionEnd(tokens, first);
      continue;
    }
    const nameToken = tokens[i];
    let pos = i + 1;
    while (tokens[pos]?.kind === AbnfTokenKind.Whitespace) {
      pos++;
    }
    const assignToken = tokens[pos];
    pos++;
    if (nameToken === undefined || assignToken === undefined) {
      break;
    }
    const regionEnd = findRegionEnd(tokens, pos);
    const bodyEnd = trimRegionEnd(tokens, pos, regionEnd);
    const bodyTokens = tokens
      .slice(pos, bodyEnd)
      .filter((bt) => !isTriviaKind(bt.kind))
      .map((bt) => fromAbnf(bt, abnfKind(bt.kind)));
    let lastToken = bodyEnd > pos ? tokens[bodyEnd - 1] : assignToken;
    if (bodyEnd === pos) {
      // An empty body has no trailing-comment handling in trimRegionEnd:
      // a comment on the head line still belongs to the rule.
      const comment = tokens
        .slice(pos, regionEnd)
        .find(
          (bt) =>
            bt.kind === AbnfTokenKind.Comment && bt.line === assignToken.line,
        );
      lastToken = comment ?? assignToken;
    }
    rules.push({
      name: nameToken.text,
      nameToken: fromAbnf(nameToken, "term"),
      assignToken: fromAbnf(assignToken, "term"),
      bodyTokens,
      startLine: nameToken.line,
      endLine: lastToken?.line ?? assignToken.line,
      incomplete: isIncomplete(bodyTokens),
    });
    i = regionEnd;
  }
  const comments = tokens
    .filter((token) => token.kind === AbnfTokenKind.Comment)
    .map((token) => fromAbnf(token, "term"));
  const unterminated = tokens
    .filter((token) => isUnterminatedAbnf(token))
    .map((token) => fromAbnf(token, "term"));
  return { rules, comments, multiline: [], unterminated };
}

/**
 * Computes the token-level layout of a document for any dialect. The rule
 * order matches `parseGrammar(text, dialect).rules`.
 */
export function layoutGrammar(
  text: string,
  dialect: GrammarDialect,
): DocumentLayout {
  // Selection ranges, links, on-type formatting, and the formatter ask for the
  // same texts repeatedly, across documents. Layouts are never mutated.
  return recentLayouts.get(dialect, text, () =>
    dialect === "abnf" ? abnfLayout(text) : productionLayout(text, dialect),
  );
}

const recentLayouts = new RecentCache<DocumentLayout>(RECENT_DOCUMENTS);
