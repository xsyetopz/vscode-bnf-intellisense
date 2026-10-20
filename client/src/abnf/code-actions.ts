import {
  CodeAction,
  type CodeActionContext,
  CodeActionKind,
  type Diagnostic,
  Position,
  Range,
  type Selection,
  type TextDocument,
  WorkspaceEdit,
} from "vscode";
import { AbnfDiagnosticCode } from "./diagnostic-codes.ts";
import { findRegionEnd, isRuleStart, isTriviaKind } from "./regions.ts";
import { tokenizeDocument } from "./tokenizer.ts";
import type { AbnfToken } from "./types.ts";
import { AbnfTokenKind } from "./types.ts";

const CONTINUATION_INDENT = "    ";
const LETTER_RE = /[A-Za-z]/;
const RANGE_RE = /^%([xXdDbB])([0-9A-Fa-f]+)-([0-9A-Fa-f]+)$/;
const DIGITS: Record<string, RegExp> = {
  x: /^[0-9A-Fa-f]+$/,
  d: /^[0-9]+$/,
  b: /^[01]+$/,
};
const RADIX: Record<string, number> = { x: 16, d: 10, b: 2 };

interface RuleHead {
  name: AbnfToken;
  assign: AbnfToken;
}

interface Context {
  document: TextDocument;
  tokens: readonly AbnfToken[];
  heads: RuleHead[];
}

function ruleHeads(tokens: readonly AbnfToken[]): RuleHead[] {
  const heads: RuleHead[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!isRuleStart(tokens, i)) {
      continue;
    }
    let j = i + 1;
    while (tokens[j]?.kind === AbnfTokenKind.Whitespace) {
      j++;
    }
    heads.push({
      name: tokens[i] as AbnfToken,
      assign: tokens[j] as AbnfToken,
    });
  }
  return heads;
}

function tokenRange(token: AbnfToken): Range {
  return new Range(
    token.line,
    token.column,
    token.line,
    token.column + token.text.length,
  );
}

function diagnosticCode(diagnostic: Diagnostic): string | undefined {
  const code = diagnostic.code;
  if (typeof code === "object" && code !== null) {
    return String(code.value);
  }
  if (code !== undefined) {
    return String(code);
  }
  return undefined;
}

function tokenAt(
  tokens: readonly AbnfToken[],
  position: Position,
  kinds: AbnfTokenKind[],
): { token: AbnfToken; index: number } | undefined {
  const index = tokens.findIndex(
    (t) =>
      t.line === position.line &&
      t.column === position.character &&
      kinds.includes(t.kind),
  );
  const token = tokens[index];
  return token ? { token, index } : undefined;
}

function makeAction(
  title: string,
  kind: CodeActionKind,
  build: (edit: WorkspaceEdit) => void,
  diagnostic?: Diagnostic,
): CodeAction {
  const action = new CodeAction(title, kind);
  const edit = new WorkspaceEdit();
  build(edit);
  action.edit = edit;
  if (diagnostic) {
    action.diagnostics = [diagnostic];
  }
  return action;
}

function replaceAction(
  ctx: Context,
  title: string,
  token: AbnfToken,
  text: string,
  diagnostic: Diagnostic,
  preferred = true,
): CodeAction {
  const action = makeAction(
    title,
    CodeActionKind.QuickFix,
    (edit) => edit.replace(ctx.document.uri, tokenRange(token), text),
    diagnostic,
  );
  action.isPreferred = preferred;
  return action;
}

function headAt(ctx: Context, diagnostic: Diagnostic): RuleHead | undefined {
  const start = diagnostic.range.start;
  return ctx.heads.find(
    (h) => h.name.line === start.line && h.name.column === start.character,
  );
}

function duplicateFix(ctx: Context, diagnostic: Diagnostic): CodeAction[] {
  const head = headAt(ctx, diagnostic);
  if (!head || head.assign.kind !== AbnfTokenKind.DefinedAs) {
    return [];
  }
  // The first "=" definition stays; only a later one becomes an alternative.
  const key = head.name.text.toLowerCase();
  const earlier = ctx.heads.some(
    (h) =>
      h.assign.kind === AbnfTokenKind.DefinedAs &&
      h.name.text.toLowerCase() === key &&
      h.name.offset < head.name.offset,
  );
  if (!earlier) {
    return [];
  }
  return [
    replaceAction(
      ctx,
      `Change to "=/" (add an alternative to "${head.name.text}")`,
      head.assign,
      "=/",
      diagnostic,
    ),
  ];
}

function incrementalFix(ctx: Context, diagnostic: Diagnostic): CodeAction[] {
  const head = headAt(ctx, diagnostic);
  if (!head || head.assign.kind !== AbnfTokenKind.IncrementalAs) {
    return [];
  }
  const key = head.name.text.toLowerCase();
  // Only the first "=/" may become the base; the rest stay alternatives.
  const hasBaseOrEarlier = ctx.heads.some(
    (h) =>
      h.name.text.toLowerCase() === key &&
      (h.assign.kind === AbnfTokenKind.DefinedAs ||
        h.name.offset < head.name.offset),
  );
  if (hasBaseOrEarlier) {
    return [];
  }
  return [
    replaceAction(
      ctx,
      `Change to "=" (define "${head.name.text}")`,
      head.assign,
      "=",
      diagnostic,
    ),
  ];
}

function indentFix(ctx: Context, diagnostic: Diagnostic): CodeAction[] {
  const start = diagnostic.range.start;
  if (start.character !== 0) {
    return [];
  }
  // After a blank line RFC 5234 ends the rule (a line break must be followed
  // by whitespace), so indenting would only hide the problem.
  if (
    start.line > 0 &&
    ctx.document.lineAt(start.line - 1).text.trim() === ""
  ) {
    return [];
  }
  const action = makeAction(
    "Indent continuation line",
    CodeActionKind.QuickFix,
    (edit) =>
      edit.insert(
        ctx.document.uri,
        new Position(start.line, 0),
        CONTINUATION_INDENT,
      ),
    diagnostic,
  );
  action.isPreferred = true;
  return [action];
}

interface CloserPlan {
  /** Where to insert the missing closer, when nothing wrong closes the group. */
  position: Position;
  /** A closer of the wrong kind that ends the group, if any. */
  mismatch?: AbnfToken;
}

function isOpener(kind: AbnfTokenKind): boolean {
  return kind === AbnfTokenKind.ParenOpen || kind === AbnfTokenKind.BracketOpen;
}

function isCloser(kind: AbnfTokenKind): boolean {
  return (
    kind === AbnfTokenKind.ParenClose || kind === AbnfTokenKind.BracketClose
  );
}

function closes(open: AbnfTokenKind, close: AbnfTokenKind): boolean {
  return (
    (open === AbnfTokenKind.ParenOpen && close === AbnfTokenKind.ParenClose) ||
    (open === AbnfTokenKind.BracketOpen && close === AbnfTokenKind.BracketClose)
  );
}

/**
 * True when an enclosing opener before `openIndex` (in the same rule) expects
 * a closer of kind `close`, so that closer is legitimate and not a typo.
 */
function outerExpects(
  tokens: readonly AbnfToken[],
  openIndex: number,
  close: AbnfTokenKind,
): boolean {
  let start = openIndex;
  while (start > 0 && !isRuleStart(tokens, start)) {
    start--;
  }
  const stack: AbnfToken[] = [];
  for (let i = start; i < openIndex; i++) {
    const t = tokens[i] as AbnfToken;
    if (isOpener(t.kind)) {
      stack.push(t);
    } else if (isCloser(t.kind)) {
      stack.pop();
    }
  }
  return stack.some((o) => closes(o.kind, close));
}

/**
 * Plans the fix for the opener at `openIndex`: insert the closer after the
 * last token of the body (or before a closer that belongs to an outer group),
 * or replace a wrong-kind closer that ends the group. Returns undefined when
 * nothing follows the opener, since the result would be an empty group.
 */
function planCloser(
  tokens: readonly AbnfToken[],
  openIndex: number,
): CloserPlan | undefined {
  const end = findRegionEnd(tokens, openIndex);
  const stack: AbnfToken[] = [];
  const opener = tokens[openIndex] as AbnfToken;
  let lastContent = opener;
  let mismatch: AbnfToken | undefined;
  for (let i = openIndex; i < end; i++) {
    const t = tokens[i] as AbnfToken;
    if (isTriviaKind(t.kind)) {
      continue;
    }
    if (isOpener(t.kind)) {
      stack.push(t);
    } else if (isCloser(t.kind)) {
      const top = stack.at(-1);
      if (!(top && closes(top.kind, t.kind)) && stack.length === 1) {
        mismatch = t;
        break;
      }
      stack.pop();
    }
    lastContent = t;
  }
  if (lastContent === opener) {
    return undefined;
  }
  const position = new Position(
    lastContent.line,
    lastContent.column + lastContent.text.length,
  );
  return mismatch ? { position, mismatch } : { position };
}

function closerFix(
  ctx: Context,
  diagnostic: Diagnostic,
  opener: AbnfTokenKind,
  closer: string,
): CodeAction[] {
  const found = tokenAt(ctx.tokens, diagnostic.range.start, [opener]);
  if (!found) {
    return [];
  }
  const plan = planCloser(ctx.tokens, found.index);
  if (!plan) {
    return [];
  }
  const { mismatch } = plan;
  const wrongKindTypo =
    mismatch !== undefined &&
    !outerExpects(ctx.tokens, found.index, mismatch.kind as AbnfTokenKind);
  const action = wrongKindTypo
    ? makeAction(
        `Replace "${mismatch.text}" with "${closer}"`,
        CodeActionKind.QuickFix,
        (edit) => edit.replace(ctx.document.uri, tokenRange(mismatch), closer),
        diagnostic,
      )
    : makeAction(
        `Insert missing "${closer}"`,
        CodeActionKind.QuickFix,
        (edit) => edit.insert(ctx.document.uri, plan.position, closer),
        diagnostic,
      );
  action.isPreferred = true;
  return [action];
}

function swapBoundsFix(ctx: Context, diagnostic: Diagnostic): CodeAction[] {
  const found = tokenAt(ctx.tokens, diagnostic.range.start, [
    AbnfTokenKind.NumericValue,
  ]);
  const match = found ? RANGE_RE.exec(found.token.text) : null;
  if (!(found && match)) {
    return [];
  }
  const swapped = `%${match[1]}${match[3]}-${match[2]}`;
  return [
    replaceAction(
      ctx,
      `Swap range bounds: ${swapped}`,
      found.token,
      swapped,
      diagnostic,
    ),
  ];
}

function fixesFor(ctx: Context, diagnostic: Diagnostic): CodeAction[] {
  switch (diagnosticCode(diagnostic)) {
    case AbnfDiagnosticCode.DuplicateDefinition:
      return duplicateFix(ctx, diagnostic);
    case AbnfDiagnosticCode.IncrementalWithoutBase:
      return incrementalFix(ctx, diagnostic);
    case AbnfDiagnosticCode.ContinuationIndent:
      return indentFix(ctx, diagnostic);
    case AbnfDiagnosticCode.UnclosedGroup:
      return closerFix(ctx, diagnostic, AbnfTokenKind.ParenOpen, ")");
    case AbnfDiagnosticCode.UnclosedOption:
      return closerFix(ctx, diagnostic, AbnfTokenKind.BracketOpen, "]");
    case AbnfDiagnosticCode.RangeOrder:
      return swapBoundsFix(ctx, diagnostic);
    case AbnfDiagnosticCode.CaseInsensitiveString: {
      const found = tokenAt(ctx.tokens, diagnostic.range.start, [
        AbnfTokenKind.String,
      ]);
      return found && stringValue(found.token) !== undefined
        ? [toCaseSensitive(ctx, found.token, diagnostic)]
        : [];
    }
    default:
      return [];
  }
}

function toCaseSensitive(
  ctx: Context,
  token: AbnfToken,
  diagnostic?: Diagnostic,
): CodeAction {
  const text = `%s${token.text}`;
  return makeAction(
    `Make case-sensitive: ${text} (RFC 7405)`,
    diagnostic ? CodeActionKind.QuickFix : CodeActionKind.RefactorRewrite,
    (edit) => edit.replace(ctx.document.uri, tokenRange(token), text),
    diagnostic,
  );
}

function stringValue(token: AbnfToken): string | undefined {
  const open = token.kind === AbnfTokenKind.String ? 1 : 3;
  if (token.text.length <= open || !token.text.endsWith('"')) {
    return undefined;
  }
  return token.text.slice(open, -1);
}

function isPrintable(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0x20 && code <= 0x7e;
}

function hexAction(ctx: Context, token: AbnfToken, value: string): CodeAction {
  const hex = [...value]
    .map((ch) =>
      (ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(2, "0"),
    )
    .join(".");
  const text = `%x${hex}`;
  const caseNote =
    token.kind !== AbnfTokenKind.CaseSensitiveString && LETTER_RE.test(value)
      ? " (makes it case-sensitive)"
      : "";
  return makeAction(
    `Convert ${token.text} to ${text}${caseNote}`,
    CodeActionKind.RefactorRewrite,
    (edit) => edit.replace(ctx.document.uri, tokenRange(token), text),
  );
}

function stringRefactors(
  ctx: Context,
  token: AbnfToken,
  covered: Set<AbnfToken>,
): CodeAction[] {
  const value = stringValue(token);
  if (value === undefined || value.length === 0) {
    return [];
  }
  const actions: CodeAction[] = [];
  if (
    token.kind === AbnfTokenKind.String &&
    LETTER_RE.test(value) &&
    !covered.has(token)
  ) {
    actions.push(toCaseSensitive(ctx, token));
  }
  if (token.kind === AbnfTokenKind.CaseInsensitiveString) {
    actions.push(
      makeAction(
        `Remove redundant %i: ${token.text.slice(2)}`,
        CodeActionKind.RefactorRewrite,
        (edit) =>
          edit.replace(
            ctx.document.uri,
            tokenRange(token),
            token.text.slice(2),
          ),
      ),
    );
  }
  if ([...value].every(isPrintable)) {
    actions.push(hexAction(ctx, token, value));
  }
  return actions;
}

/**
 * Decodes `%x61.62` style values into text, or undefined when the token is a
 * range, malformed, or holds characters that cannot sit inside a quoted string.
 */
function decodeNumeric(text: string): string | undefined {
  const base = text.charAt(1).toLowerCase();
  const digits = DIGITS[base];
  const radix = RADIX[base];
  if (!(digits && radix)) {
    return undefined;
  }
  const parts = text.slice(2).split(".");
  let value = "";
  for (const part of parts) {
    if (!digits.test(part)) {
      return undefined;
    }
    const code = Number.parseInt(part, radix);
    if (code < 0x20 || code > 0x7e || code === 0x22) {
      return undefined;
    }
    value += String.fromCharCode(code);
  }
  return value;
}

function numericRefactors(ctx: Context, token: AbnfToken): CodeAction[] {
  const value = decodeNumeric(token.text);
  if (value === undefined || value.length === 0) {
    return [];
  }
  const text = LETTER_RE.test(value) ? `%s"${value}"` : `"${value}"`;
  return [
    makeAction(
      `Convert ${token.text} to ${text}`,
      CodeActionKind.RefactorRewrite,
      (edit) => edit.replace(ctx.document.uri, tokenRange(token), text),
    ),
  ];
}

function touches(token: AbnfToken, range: Range): boolean {
  const { start, end } = range;
  if (token.line < start.line || token.line > end.line) {
    return false;
  }
  const tokenStart = token.column;
  const tokenEnd = token.column + token.text.length;
  const from = token.line === start.line ? start.character : 0;
  const to = token.line === end.line ? end.character : Number.MAX_SAFE_INTEGER;
  return from <= tokenEnd && to >= tokenStart;
}

function refactors(
  ctx: Context,
  range: Range,
  covered: Set<AbnfToken>,
): CodeAction[] {
  const touched = ctx.tokens.filter(
    (t) => !isTriviaKind(t.kind) && touches(t, range),
  );
  // A real selection must pick out one literal; a cursor may sit between two.
  const empty =
    range.start.line === range.end.line &&
    range.start.character === range.end.character;
  if (!empty && touched.length > 1) {
    return [];
  }
  const actions: CodeAction[] = [];
  for (const token of touched) {
    switch (token.kind) {
      case AbnfTokenKind.String:
      case AbnfTokenKind.CaseSensitiveString:
      case AbnfTokenKind.CaseInsensitiveString:
        actions.push(...stringRefactors(ctx, token, covered));
        break;
      case AbnfTokenKind.NumericValue:
        actions.push(...numericRefactors(ctx, token));
        break;
      default:
        break;
    }
  }
  return actions;
}

/**
 * Quick fixes for ABNF diagnostics (matched by their stable `code`) plus
 * char-val / num-val refactors for the strings and numbers under `range`.
 */
export function provideAbnfCodeActions(
  document: TextDocument,
  range: Range | Selection,
  context: CodeActionContext,
): CodeAction[] {
  const tokens = tokenizeDocument(document.getText());
  const ctx: Context = { document, tokens, heads: ruleHeads(tokens) };
  const only = context.only;
  const fixes: CodeAction[] = [];
  const covered = new Set<AbnfToken>();
  if (!only || only.contains(CodeActionKind.QuickFix)) {
    for (const d of context.diagnostics) {
      fixes.push(...fixesFor(ctx, d));
      if (diagnosticCode(d) === AbnfDiagnosticCode.CaseInsensitiveString) {
        const hit = tokenAt(tokens, d.range.start, [AbnfTokenKind.String]);
        if (hit) {
          covered.add(hit.token);
        }
      }
    }
  }
  if (only && !only.contains(CodeActionKind.RefactorRewrite)) {
    return fixes;
  }
  return [...fixes, ...refactors(ctx, range, covered)];
}
