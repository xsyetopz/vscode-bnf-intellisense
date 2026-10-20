import { type Diagnostic, DiagnosticSeverity, Range } from "vscode";
import type {
  GrammarDocument,
  IdentifierReference,
  Rule,
  SymbolTable,
} from "../types.ts";
import { type BodyIssue, parseRuleBody } from "./body-parser.ts";
import { AbnfDiagnosticCode } from "./diagnostic-codes.ts";
import {
  findRegionEnd,
  isRuleStart,
  isTriviaKind,
  trimRegionEnd,
} from "./regions.ts";
import { tokenizeDocument } from "./tokenizer.ts";
import type { AbnfExpression, AbnfToken } from "./types.ts";
import { AbnfTokenKind } from "./types.ts";

/**
 * Expression AST side table keyed by parsed ABNF rules.
 */
export const ruleExpressions = new WeakMap<Rule, AbnfExpression>();

const DIAGNOSTIC_SOURCE = "abnf";

function tokenRange(token: AbnfToken): Range {
  return new Range(
    token.line,
    token.column,
    token.line,
    token.column + token.text.length,
  );
}

function pushIssue(diagnostics: Diagnostic[], issue: BodyIssue): void {
  diagnostics.push({
    message: issue.message,
    range: new Range(
      issue.start.line,
      issue.start.column,
      issue.end.line,
      issue.end.column + issue.end.text.length,
    ),
    severity: SEVERITIES[issue.severity],
    ...(issue.code === undefined ? {} : { code: issue.code }),
    source: DIAGNOSTIC_SOURCE,
  });
}

const SEVERITIES = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  hint: DiagnosticSeverity.Hint,
} as const;

/**
 * Doc comment: a comment at column 0 on its own line directly above the rule
 * (blank lines in between are allowed).
 */
function collectPrecedingComment(
  tokens: readonly AbnfToken[],
  ruleIndex: number,
): string | undefined {
  let j = ruleIndex - 1;
  while (j >= 0 && tokens[j]?.kind === AbnfTokenKind.Newline) {
    j--;
  }
  const comment = tokens[j];
  if (comment?.kind === AbnfTokenKind.Comment && comment.column === 0) {
    return comment.text.slice(1).trim();
  }
  return undefined;
}

function buildRule(
  nameToken: AbnfToken,
  assignToken: AbnfToken,
  bodyTokens: readonly AbnfToken[],
  precedingComment: string | undefined,
  diagnostics: Diagnostic[],
): Rule {
  const definitionText = bodyTokens
    .filter(
      (bt) =>
        bt.kind !== AbnfTokenKind.Comment && bt.kind !== AbnfTokenKind.Newline,
    )
    .map((bt) => bt.text)
    .join("")
    .trim()
    .replace(/\s+/g, " ");

  const lastContent = [...bodyTokens]
    .reverse()
    .find((bt) => !isTriviaKind(bt.kind));
  if (!lastContent) {
    diagnostics.push({
      message: `Rule "${nameToken.text}" has no expression after "="`,
      range: tokenRange(nameToken),
      severity: DiagnosticSeverity.Warning,
      code: AbnfDiagnosticCode.EmptyRule,
      source: DIAGNOSTIC_SOURCE,
    });
  }

  const body = parseRuleBody(bodyTokens);
  for (const issue of body.issues) {
    pushIssue(diagnostics, issue);
  }

  const nameRange = tokenRange(nameToken);
  const endToken = lastContent ?? assignToken;
  const rule: Rule = {
    name: nameToken.text,
    nameRange,
    definitionRange: new Range(nameRange.start, tokenRange(endToken).end),
    definitionText,
    isIncremental: assignToken.kind === AbnfTokenKind.IncrementalAs,
    precedingComment,
    references: body.references.map((ref) => ({
      name: ref.name,
      range: tokenRange(ref.token),
    })),
  };

  ruleExpressions.set(rule, body.expression);
  return rule;
}

function parseRuleAt(
  tokens: readonly AbnfToken[],
  i: number,
  diagnostics: Diagnostic[],
): { rule: Rule; nextIndex: number } {
  const nameToken = tokens[i] as AbnfToken;
  let pos = i + 1;
  while (tokens[pos]?.kind === AbnfTokenKind.Whitespace) {
    pos++;
  }
  const assignToken = tokens[pos] as AbnfToken;
  pos++;

  const regionEnd = findRegionEnd(tokens, pos);
  const bodyEnd = trimRegionEnd(tokens, pos, regionEnd);
  const rule = buildRule(
    nameToken,
    assignToken,
    tokens.slice(pos, bodyEnd),
    collectPrecedingComment(tokens, i),
    diagnostics,
  );
  return { rule, nextIndex: regionEnd };
}

/**
 * Token kinds that can start an element or alternative, so a column-0 line
 * beginning with one is most likely a continuation that lost its indent.
 */
function isContinuationStart(kind: AbnfTokenKind): boolean {
  switch (kind) {
    case AbnfTokenKind.Rulename:
    case AbnfTokenKind.Alternation:
    case AbnfTokenKind.String:
    case AbnfTokenKind.CaseSensitiveString:
    case AbnfTokenKind.CaseInsensitiveString:
    case AbnfTokenKind.NumericValue:
    case AbnfTokenKind.ProseValue:
    case AbnfTokenKind.ParenOpen:
    case AbnfTokenKind.ParenClose:
    case AbnfTokenKind.BracketOpen:
    case AbnfTokenKind.BracketClose:
    case AbnfTokenKind.Asterisk:
      return true;
    default:
      return false;
  }
}

function unexpectedLine(
  tokens: readonly AbnfToken[],
  i: number,
  hasPreviousRule: boolean,
): { message: string; code: string } {
  const token = tokens[i] as AbnfToken;
  const next = tokens[i + 1];
  if (
    token.column === 0 &&
    token.kind === AbnfTokenKind.Integer &&
    next?.kind === AbnfTokenKind.Rulename &&
    next.offset === token.offset + token.text.length
  ) {
    return {
      message: `Invalid rule name "${token.text}${next.text}": rule names must start with a letter`,
      code: AbnfDiagnosticCode.InvalidRuleName,
    };
  }
  if (token.column !== 0) {
    return {
      message: "Rule definitions must start at column 0",
      code: AbnfDiagnosticCode.RuleColumn,
    };
  }
  if (token.kind === AbnfTokenKind.Rulename) {
    return {
      message: `"${token.text}" is not a rule definition: expected "=" or "=/" after the rule name (continuation lines must be indented)`,
      code: hasPreviousRule
        ? AbnfDiagnosticCode.ContinuationIndent
        : AbnfDiagnosticCode.UnexpectedLine,
    };
  }
  return {
    message: `Unexpected "${token.text}": expected a rule definition`,
    code:
      hasPreviousRule && isContinuationStart(token.kind)
        ? AbnfDiagnosticCode.ContinuationIndent
        : AbnfDiagnosticCode.UnexpectedLine,
  };
}

/**
 * Parses RFC ABNF text into the shared grammar document model.
 */
export function parseAbnf(text: string): GrammarDocument {
  const tokens = tokenizeDocument(text);
  const rules: Rule[] = [];
  const diagnostics: Diagnostic[] = [];

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i] as AbnfToken;
    if (
      token.kind === AbnfTokenKind.Newline ||
      token.kind === AbnfTokenKind.Comment
    ) {
      i++;
      continue;
    }
    // A whitespace token at top level is always the indentation of a line.
    let first = i;
    if (token.kind === AbnfTokenKind.Whitespace) {
      first = i + 1;
      const after = tokens[first];
      if (after === undefined || isTriviaKind(after.kind)) {
        i = first;
        continue;
      }
    }
    if (first === i && isRuleStart(tokens, i)) {
      const result = parseRuleAt(tokens, i, diagnostics);
      rules.push(result.rule);
      i = result.nextIndex;
      continue;
    }
    // Not a rule: report once, then skip the line and its indented lines.
    const unexpected = unexpectedLine(tokens, first, rules.length > 0);
    pushIssue(diagnostics, {
      message: unexpected.message,
      code: unexpected.code,
      severity: "error",
      start: tokens[first] as AbnfToken,
      end: tokens[first] as AbnfToken,
    });
    const skippedEnd = findRegionEnd(tokens, first);
    // Keep the references on the skipped lines (credited to the rule above),
    // so a name used there is not reported as unused.
    const owner = rules.at(-1);
    if (owner) {
      for (const ref of parseRuleBody(tokens.slice(first, skippedEnd))
        .references) {
        owner.references.push({
          name: ref.name,
          range: tokenRange(ref.token),
        });
      }
    }
    i = skippedEnd;
  }

  return { rules, diagnostics };
}

/**
 * Builds definition and reference indexes for a parsed ABNF document.
 */
export function buildAbnfSymbolTable(doc: GrammarDocument): SymbolTable {
  const definitions = new Map<string, Rule[]>();
  const references = new Map<string, IdentifierReference[]>();

  for (const rule of doc.rules) {
    const key = rule.name.toLowerCase();
    const existing = definitions.get(key);
    if (existing) {
      existing.push(rule);
    } else {
      definitions.set(key, [rule]);
    }

    for (const ref of rule.references) {
      const refKey = ref.name.toLowerCase();
      const existingRefs = references.get(refKey);
      if (existingRefs) {
        existingRefs.push(ref);
      } else {
        references.set(refKey, [ref]);
      }
    }
  }

  return { definitions, references };
}
