import { type Diagnostic, DiagnosticSeverity, Range } from "vscode";
import { appendAll } from "../append-all.ts";
import type { GrammarDocument, IdentifierReference, Rule } from "../types.ts";
import { GrammarDiagnosticCode } from "./diagnostic-codes.ts";
import { rangeFromLineIndex } from "./ranges.ts";
import {
  type Production,
  type ProductionDialect,
  type ScanResult,
  type ScanToken,
  type StrayStatement,
  scanProductionGrammar,
} from "./scanner.ts";
import { ISO_14977_NON_SUPPORT } from "./standards.ts";

export type { ProductionDialect } from "./scanner.ts";

const INVALID_CHAR_CODE_RE = /#x(?![0-9A-Fa-f]+\b)[A-Za-z0-9]*/g;
const RBNF_ILLEGAL_NAME_RE = /[\t\r\n]/;
const WHITESPACE_RE = /\s+/g;
const COMMENT_LINE_PREFIX_RE = /^\s*\*?\s?/;

function tokenRange(scan: ScanResult, token: ScanToken): Range {
  return rangeFromLineIndex(scan.lineIndex, token.start, token.end);
}

function offsetDiagnostic(
  scan: ScanResult,
  start: number,
  end: number,
  message: string,
  severity: DiagnosticSeverity,
  code?: string,
): Diagnostic {
  return {
    ...(code === undefined ? {} : { code }),
    message,
    range: rangeFromLineIndex(scan.lineIndex, start, end),
    severity,
    source: scan.dialect,
  };
}

function commentText(token: ScanToken): string {
  const raw = token.text;
  if (raw.startsWith("/*") || token.iso) {
    const inner = raw.slice(2, token.unterminated ? undefined : -2);
    return inner
      .split(/\r\n|\n|\r/)
      .map((line) => line.replace(COMMENT_LINE_PREFIX_RE, "").trimEnd())
      .join("\n")
      .trim();
  }
  return raw.slice(1).trim();
}

function definitionText(scan: ScanResult, production: Production): string {
  const first = production.bodyTokens[0];
  if (!first) {
    return "";
  }
  let text = "";
  let cursor = first.start;
  for (const comment of production.innerComments) {
    text += `${scan.text.slice(cursor, comment.start)} `;
    cursor = comment.end;
  }
  text += scan.text.slice(cursor, production.endOffset);
  return text.trim().replace(WHITESPACE_RE, " ");
}

function referencesOf(
  scan: ScanResult,
  production: Production,
): IdentifierReference[] {
  const refs: IdentifierReference[] = [];
  for (const token of production.bodyTokens) {
    const isReference =
      token.kind === "angleName" ||
      (token.kind === "name" && scan.dialect !== "rbnf");
    if (isReference) {
      refs.push({ name: token.text, range: tokenRange(scan, token) });
    }
  }
  return refs;
}

function ruleFromProduction(scan: ScanResult, production: Production): Rule {
  const { nameToken } = production;
  const nameRange = tokenRange(scan, nameToken);
  const rule: Rule = {
    name: nameToken.text,
    nameRange,
    definitionRange: new Range(
      nameRange.start,
      rangeFromLineIndex(
        scan.lineIndex,
        production.endOffset,
        production.endOffset,
      ).end,
    ),
    definitionText: definitionText(scan, production),
    references: referencesOf(scan, production),
  };
  if (production.precedingComment) {
    rule.precedingComment = commentText(production.precedingComment);
  }
  return rule;
}

function invalidCharCodeDiagnostics(
  scan: ScanResult,
  production: Production,
): Diagnostic[] {
  if (scan.dialect !== "ebnf") {
    return [];
  }
  const message =
    "W3C XML EBNF character codes must use hexadecimal digits after #x";
  const diagnostics: Diagnostic[] = [];
  for (const token of production.bodyTokens) {
    if (token.kind === "charCode" && token.invalid) {
      diagnostics.push(
        offsetDiagnostic(
          scan,
          token.start,
          token.end,
          message,
          DiagnosticSeverity.Warning,
          GrammarDiagnosticCode.InvalidCharCode,
        ),
      );
    } else if (token.kind === "charClass") {
      for (const match of token.text.matchAll(INVALID_CHAR_CODE_RE)) {
        const start = token.start + (match.index ?? 0);
        diagnostics.push(
          offsetDiagnostic(
            scan,
            start,
            start + match[0].length,
            message,
            DiagnosticSeverity.Warning,
            GrammarDiagnosticCode.InvalidCharCode,
          ),
        );
      }
    }
  }
  return diagnostics;
}

function delimiterDiagnostics(
  scan: ScanResult,
  production: Production,
): Diagnostic[] {
  const stack: ScanToken[] = [];
  const diagnostics: Diagnostic[] = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (const token of production.bodyTokens) {
    if (token.kind !== "group") {
      continue;
    }
    if (token.text === "(" || token.text === "[" || token.text === "{") {
      stack.push(token);
      continue;
    }
    const open = stack.at(-1);
    if (open && open.text === pairs[token.text]) {
      stack.pop();
    } else {
      // Leave a mismatched opener on the stack so it is reported as unclosed.
      diagnostics.push(
        offsetDiagnostic(
          scan,
          token.start,
          token.end,
          `Closing delimiter "${token.text}" has no matching opener`,
          DiagnosticSeverity.Warning,
          GrammarDiagnosticCode.UnbalancedDelimiter,
        ),
      );
    }
  }
  for (const open of stack) {
    if (scan.unclosedIsoOpeners.has(open.start)) {
      continue; // reported once by isoUnclosedDiagnostics
    }
    diagnostics.push(
      offsetDiagnostic(
        scan,
        open.start,
        open.end,
        `Opening delimiter "${open.text}" has no matching closer`,
        DiagnosticSeverity.Warning,
        GrammarDiagnosticCode.UnbalancedDelimiter,
      ),
    );
  }
  return diagnostics;
}

const DIGITS_RE = /^[0-9]+$/;
const COUNT_OPERAND_KINDS: ReadonlySet<string> = new Set([
  "string",
  "charClass",
  "charCode",
  "angleName",
  "name",
]);

function startsOperand(token: ScanToken | undefined): boolean {
  if (!token) {
    return false;
  }
  if (token.kind === "group") {
    return token.text === "(" || token.text === "[" || token.text === "{";
  }
  return COUNT_OPERAND_KINDS.has(token.kind);
}

/** RBNF repeat counts: `n*m`, `n*`, `*m`, and `n` before an operand. */
function isRepeatCount(tokens: readonly ScanToken[], index: number): boolean {
  const token = tokens[index] as ScanToken;
  if (!DIGITS_RE.test(token.text)) {
    return false;
  }
  const next = tokens[index + 1];
  const previous = tokens[index - 1];
  const isStar = (t: ScanToken | undefined): boolean =>
    t?.kind === "repeat" && t.text === "*";
  return startsOperand(next) || isStar(next) || isStar(previous);
}

function strayPunctDiagnostics(
  scan: ScanResult,
  production: Production,
): Diagnostic[] {
  const tokens = production.bodyTokens;
  const diagnostics: Diagnostic[] = [];
  for (const [index, token] of tokens.entries()) {
    if (
      token.kind !== "punct" ||
      (scan.dialect === "rbnf" && isRepeatCount(tokens, index))
    ) {
      continue;
    }
    diagnostics.push(
      offsetDiagnostic(
        scan,
        token.start,
        token.end,
        `Unexpected "${token.text}": it is not part of ${scan.dialect.toUpperCase()} expression syntax`,
        DiagnosticSeverity.Warning,
        GrammarDiagnosticCode.UnexpectedText,
      ),
    );
  }
  return diagnostics;
}

const EMPTY_CHAR_CLASS_RE = /^\[\^?\]$/;
const GROUP_NAMES: Record<string, string> = {
  "(": "group",
  "[": "option",
  "{": "repetition",
};
const OPENER_FOR: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function isOpener(token: ScanToken | undefined): boolean {
  return token?.kind === "group" && token.text in GROUP_NAMES;
}

/** True when a repeat token has no operand before it (RBNF prefix counts aside). */
function lacksOperand(
  scan: ScanResult,
  tokens: readonly ScanToken[],
  index: number,
  previous: ScanToken | undefined,
): boolean {
  const token = tokens[index] as ScanToken;
  if (
    previous &&
    isOpener(previous) &&
    scan.unclosedIsoOpeners.has(previous.start)
  ) {
    return false; // the `*` of an unclosed `(*`, reported by isoUnclosedDiagnostics
  }
  const afterCount =
    scan.dialect === "rbnf" &&
    token.text === "*" &&
    previous !== undefined &&
    DIGITS_RE.test(previous.text); // the `*` of `m*`
  const atStart =
    afterCount ||
    previous === undefined ||
    previous.kind === "alternative" ||
    previous.kind === "exclusion" ||
    isOpener(previous);
  if (!atStart) {
    return false;
  }
  if (token.text === "*") {
    const isSkipped = (t: ScanToken): boolean =>
      t.kind === "comment" || t.kind === "annotation";
    const following = tokens.slice(index + 1).filter((t) => !isSkipped(t));
    const next = following[0];
    const countFollows = next !== undefined && DIGITS_RE.test(next.text);
    if (scan.dialect === "rbnf") {
      // RBNF allows the prefix forms `*m x`, `*x`, `m* x` and `m*n x`;
      // the count must be followed by something to repeat.
      return !startsOperand(countFollows ? following[1] : next);
    }
    // `*3 x` is a prefix count other dialects lack; the stray count is
    // reported as unexpected text, so say it only once.
    return !countFollows;
  }
  return true;
}

/**
 * Empty groups (`()`, `[]`, `{}`) and repetition operators with nothing to
 * repeat. Neither is valid in any supported grammar. Empty alternatives are
 * a different thing and stay allowed.
 */
function operandDiagnostics(
  scan: ScanResult,
  production: Production,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const stack: ScanToken[] = [];
  const tokens = production.bodyTokens;
  let previous: ScanToken | undefined;
  for (const [index, token] of tokens.entries()) {
    if (token.kind === "comment" || token.kind === "annotation") {
      continue;
    }
    if (
      token.kind === "charClass" &&
      scan.dialect === "ebnf" &&
      EMPTY_CHAR_CLASS_RE.test(token.text)
    ) {
      diagnostics.push(
        offsetDiagnostic(
          scan,
          token.start,
          token.end,
          `Empty character class: "${token.text}" matches no character${
            tokens[index + 1]?.text === "]" ? '; write "]" as #x5D' : ""
          }`,
          DiagnosticSeverity.Error,
          GrammarDiagnosticCode.EmptyGroup,
        ),
      );
    }
    if (
      token.kind === "repeat" &&
      lacksOperand(scan, tokens, index, previous)
    ) {
      diagnostics.push(
        offsetDiagnostic(
          scan,
          token.start,
          token.end,
          `Repetition operator "${token.text}" has nothing to repeat`,
          DiagnosticSeverity.Error,
          GrammarDiagnosticCode.RepetitionNoOperand,
        ),
      );
    } else if (isOpener(token)) {
      stack.push(token);
    } else if (token.kind === "group") {
      const open = stack.pop();
      if (open && previous === open && open.text === OPENER_FOR[token.text]) {
        diagnostics.push(
          offsetDiagnostic(
            scan,
            open.start,
            token.end,
            `Empty ${GROUP_NAMES[open.text]}: "${open.text}${token.text}" has nothing inside`,
            DiagnosticSeverity.Error,
            GrammarDiagnosticCode.EmptyGroup,
          ),
        );
      }
    }
    previous = token;
  }
  return diagnostics;
}

function productionDiagnostics(
  scan: ScanResult,
  production: Production,
  rule: Rule,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (production.bodyTokens.length === 0) {
    diagnostics.push(
      offsetDiagnostic(
        scan,
        production.nameToken.start,
        production.nameToken.end,
        `Rule "${rule.name}" has no expression after "::="`,
        DiagnosticSeverity.Warning,
        GrammarDiagnosticCode.EmptyRule,
      ),
    );
  }
  diagnostics.push(
    ...invalidCharCodeDiagnostics(scan, production),
    ...strayPunctDiagnostics(scan, production),
    ...delimiterDiagnostics(scan, production),
    ...operandDiagnostics(scan, production),
  );
  if (
    scan.dialect === "rbnf" &&
    RBNF_ILLEGAL_NAME_RE.test(production.nameToken.text)
  ) {
    diagnostics.push(
      offsetDiagnostic(
        scan,
        production.nameToken.start,
        production.nameToken.end,
        'RBNF rule names must stay inside one "<...>" pair on one line',
        DiagnosticSeverity.Error,
        GrammarDiagnosticCode.InvalidRuleName,
      ),
    );
  }
  if (scan.dialect === "rbnf") {
    for (const token of production.bodyTokens) {
      if (token.kind === "name") {
        diagnostics.push(
          offsetDiagnostic(
            scan,
            token.start,
            token.end,
            `RBNF references must be written as "<${token.text}>"; a bare word is neither a reference nor a literal (quote it to match text)`,
            DiagnosticSeverity.Warning,
            GrammarDiagnosticCode.BareReference,
          ),
        );
      }
    }
  }
  for (const token of production.unindentedTokens.slice(0, 1)) {
    if (scan.unclosedIsoOpeners.has(token.start)) {
      break; // reported once by isoUnclosedDiagnostics
    }
    diagnostics.push(
      offsetDiagnostic(
        scan,
        token.start,
        token.end,
        `"${token.text}" starts in column 0 but is not a rule; indent continuation lines of "${rule.name}" or add "::=" to start a new rule`,
        DiagnosticSeverity.Warning,
        GrammarDiagnosticCode.UnindentedContinuation,
      ),
    );
  }
  return diagnostics;
}

function strayDiagnostic(
  scan: ScanResult,
  stray: StrayStatement,
): Diagnostic | undefined {
  const first = stray.tokens[0];
  const last = stray.tokens[stray.tokens.length - 1];
  if (!(first && last)) {
    return undefined;
  }
  if (stray.kind === "unexpected") {
    if (scan.unclosedIsoOpeners.has(first.start)) {
      return undefined; // reported once by isoUnclosedDiagnostics
    }
    return offsetDiagnostic(
      scan,
      first.start,
      first.end,
      `Unexpected "${first.text}": expected a rule definition ("name ::= ...") before this text`,
      DiagnosticSeverity.Warning,
      GrammarDiagnosticCode.UnexpectedText,
    );
  }
  if (stray.kind === "iso") {
    return offsetDiagnostic(
      scan,
      first.start,
      last.end,
      `Use "::=" for W3C XML EBNF productions. ${ISO_14977_NON_SUPPORT}`,
      DiagnosticSeverity.Warning,
      GrammarDiagnosticCode.IsoEbnf,
    );
  }
  const message =
    scan.dialect === "rbnf"
      ? `RBNF rule names must be written as "<name>"; "${first.text}" is not a valid rule name`
      : `W3C XML EBNF rule names are plain identifiers; "${first.text}" is not a valid rule name`;
  return offsetDiagnostic(
    scan,
    first.start,
    first.end,
    message,
    DiagnosticSeverity.Warning,
    GrammarDiagnosticCode.InvalidRuleName,
  );
}

/**
 * ISO `(* ... *)` comments. Those inside an ISO production are covered by
 * that production's own diagnostic.
 */
function isoCommentDiagnostics(scan: ScanResult): Diagnostic[] {
  const covered = scan.strays
    .filter((stray) => stray.kind === "iso")
    .map((stray) => ({
      start: stray.tokens[0]?.start ?? 0,
      end: stray.tokens[stray.tokens.length - 1]?.end ?? 0,
    }));
  return scan.tokens
    .filter(
      (token) =>
        token.iso &&
        !covered.some((c) => token.start >= c.start && token.end <= c.end),
    )
    .map((token) =>
      offsetDiagnostic(
        scan,
        token.start,
        token.end,
        `Use "/* ... */" for W3C XML EBNF comments; "(* ... *)" is ISO/IEC 14977. ${ISO_14977_NON_SUPPORT}`,
        DiagnosticSeverity.Warning,
        GrammarDiagnosticCode.IsoEbnf,
      ),
    );
}

/**
 * A `(*` with no `*)` before the next production head (or the end of the
 * text) is read as a stray group. Say what was probably meant.
 */
function isoUnclosedDiagnostics(scan: ScanResult): Diagnostic[] {
  return scan.tokens.flatMap((token) => {
    const stop = scan.unclosedIsoOpeners.get(token.start);
    if (!stop) {
      return [];
    }
    const before =
      stop === "production" ? "the next production" : "the end of the file";
    return [
      offsetDiagnostic(
        scan,
        token.start,
        token.end + 1,
        `ISO comment is not closed before ${before}`,
        DiagnosticSeverity.Warning,
        GrammarDiagnosticCode.IsoCommentUnclosed,
      ),
    ];
  });
}

function lexicalDiagnostics(scan: ScanResult): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const startOfHeads = new Set<ScanToken>();
  for (const production of scan.productions) {
    startOfHeads.add(production.assignToken);
  }
  for (const stray of scan.strays) {
    const assign = stray.tokens.find((token) => token.kind === "assignment");
    if (assign && stray.kind !== "unexpected") {
      startOfHeads.add(assign);
    }
  }
  for (const token of scan.tokens) {
    if (token.kind === "comment" && token.unterminated) {
      diagnostics.push(
        offsetDiagnostic(
          scan,
          token.start,
          token.start + 2,
          'Unterminated comment: missing closing "*/"',
          DiagnosticSeverity.Error,
          GrammarDiagnosticCode.UnterminatedComment,
        ),
      );
    } else if (token.kind === "string" && token.unterminated) {
      diagnostics.push(
        offsetDiagnostic(
          scan,
          token.start,
          token.end,
          "Unterminated string literal",
          DiagnosticSeverity.Warning,
          GrammarDiagnosticCode.UnterminatedString,
        ),
      );
    } else if (token.kind === "assignment" && !startOfHeads.has(token)) {
      diagnostics.push(
        offsetDiagnostic(
          scan,
          token.start,
          token.end,
          'Unexpected "::=": a rule must start on its own line with a valid name',
          DiagnosticSeverity.Warning,
          GrammarDiagnosticCode.StrayAssignment,
        ),
      );
    }
  }
  return diagnostics;
}

/**
 * W3C exclusion is written `A - B`. `A-B` lexes as one name, so hint at it
 * when the dashed name is undefined but every part is a defined rule.
 */
function exclusionHints(scan: ScanResult, rules: Rule[]): Diagnostic[] {
  if (scan.dialect !== "ebnf") {
    return [];
  }
  const defined = new Set(rules.map((rule) => rule.name));
  const hints: Diagnostic[] = [];
  for (const rule of rules) {
    for (const ref of rule.references) {
      const parts = ref.name.split("-");
      if (
        parts.length > 1 &&
        !defined.has(ref.name) &&
        parts.every((part) => part.length > 0 && defined.has(part))
      ) {
        hints.push({
          message: `"${ref.name}" is a single name. For W3C exclusion write "${parts.join(" - ")}" with spaces around "-"`,
          range: ref.range,
          severity: DiagnosticSeverity.Hint,
          code: GrammarDiagnosticCode.ExclusionSpacing,
          source: scan.dialect,
        });
      }
    }
  }
  return hints;
}

/**
 * Parses BNF, EBNF, or RBNF text into the shared grammar document model.
 */
export function parseProductionGrammar(
  text: string,
  dialect: ProductionDialect,
): GrammarDocument {
  const scan = scanProductionGrammar(text, dialect);
  const rules: Rule[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const production of scan.productions) {
    const rule = ruleFromProduction(scan, production);
    rules.push(rule);
    appendAll(diagnostics, productionDiagnostics(scan, production, rule));
  }
  for (const stray of scan.strays) {
    const diagnostic = strayDiagnostic(scan, stray);
    if (diagnostic) {
      diagnostics.push(diagnostic);
    }
  }
  appendAll(diagnostics, isoCommentDiagnostics(scan));
  appendAll(diagnostics, isoUnclosedDiagnostics(scan));
  appendAll(diagnostics, lexicalDiagnostics(scan));
  appendAll(diagnostics, exclusionHints(scan, rules));
  return { rules, diagnostics };
}
