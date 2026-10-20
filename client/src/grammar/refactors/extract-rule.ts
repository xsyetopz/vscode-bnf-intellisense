import {
  CodeAction,
  CodeActionKind,
  Position,
  type Range,
  WorkspaceEdit,
} from "vscode";
import { getGrammarDialectDescriptor } from "../dialects.ts";
import { normalizeSymbolName } from "../symbol-table.ts";
import type { GrammarWorkspace } from "../workspace.ts";
import type { RefactorContext } from "./context.ts";
import { isCompleteExpression } from "./structure.ts";

/**
 * Kind of the extract-rule code action.
 */
export const EXTRACT_KIND = CodeActionKind.Refactor.append("extract");

const NEW_RULE_NAME = "new-rule";
const ANGLE_RE = /^<(.*)>$/s;
const LINE_BREAK_RE = /\r\n?/g;
const BLANK_LINE_RE = /\n[ \t]*\n/;

function bareKey(name: string, ctx: RefactorContext): string {
  const inner = ANGLE_RE.exec(name)?.[1] ?? name;
  return normalizeSymbolName(inner, ctx.dialect);
}

/**
 * Picks `new-rule`, `new-rule-2`, ... in the style of the surrounding rule,
 * skipping every name that exists in the document or the workspace.
 */
function uniqueRuleName(
  ctx: RefactorContext,
  workspace: GrammarWorkspace,
  angle: boolean,
): string {
  const used = new Set<string>();
  for (const rule of ctx.document.rules) {
    used.add(bareKey(rule.name, ctx));
    for (const ref of rule.references) {
      used.add(bareKey(ref.name, ctx));
    }
  }
  for (const file of workspace.getAllFiles(ctx.dialect)) {
    for (const key of file.symbolTable.references.keys()) {
      used.add(bareKey(key, ctx));
    }
  }
  for (let n = 1; ; n++) {
    const base = n === 1 ? NEW_RULE_NAME : `${NEW_RULE_NAME}-${n}`;
    const name = angle ? `<${base}>` : base;
    if (
      !used.has(bareKey(name, ctx)) &&
      workspace.findDefinitions(name, ctx.dialect).length === 0 &&
      workspace.findDefinitions(base, ctx.dialect).length === 0
    ) {
      return name;
    }
  }
}

/**
 * The rule after which the new rule goes: the current one, or for ABNF the
 * last `=/` part of the same rule.
 */
function anchorIndex(ctx: RefactorContext, index: number): number {
  if (ctx.dialect !== "abnf") {
    return index;
  }
  const key = ctx.info(index).key;
  let anchor = index;
  for (let k = index + 1; k < ctx.ruleCount; k++) {
    const rule = ctx.document.rules[k];
    if (rule?.isIncremental && normalizeSymbolName(rule.name, "abnf") === key) {
      anchor = k;
    }
  }
  return anchor;
}

function separatedByBlankLines(ctx: RefactorContext, line: number): boolean {
  const next = line + 1;
  const atEnd =
    next >= ctx.lineCount - 1 &&
    (next >= ctx.lineCount || ctx.isBlankLine(next));
  if (!atEnd) {
    return ctx.isBlankLine(next);
  }
  // At the end of the file, follow the habit of the rest of the document.
  return BLANK_LINE_RE.test(ctx.text.trim().replace(LINE_BREAK_RE, "\n"));
}

/**
 * Offers "Extract rule" for a selection that is a complete expression inside
 * one rule: whole alternatives, or a run of whole sequence items.
 */
export function extractRuleAction(
  ctx: RefactorContext,
  workspace: GrammarWorkspace,
  range: Range,
): CodeAction | undefined {
  let selStart = ctx.offsetAt(range.start);
  let selEnd = ctx.offsetAt(range.end);
  let endLine = range.end.line;
  while (endLine > range.start.line && selEnd === ctx.lineStart(endLine)) {
    endLine--;
    selEnd = ctx.contentEnd(endLine);
  }
  if (selStart >= selEnd) {
    return undefined;
  }
  const index = ctx.ruleIndexAtLine(range.start.line);
  if (index < 0 || index !== ctx.ruleIndexAtLine(endLine)) {
    return undefined;
  }
  const info = ctx.info(index);
  if (info.errors || ctx.sharesLines(index)) {
    return undefined;
  }
  if (selStart < info.layout.assignToken.end) {
    return undefined;
  }
  let first = -1;
  let last = -1;
  for (let k = 0; k < info.body.length; k++) {
    const token = info.body[k];
    if (!token || token.start >= selEnd || token.end <= selStart) {
      continue;
    }
    if (token.start < selStart || token.end > selEnd) {
      return undefined;
    }
    if (first < 0) {
      first = k;
    }
    last = k;
  }
  if (first < 0) {
    return undefined;
  }
  for (let k = first; k <= last; k++) {
    if (info.structOf[k] === -1) {
      return undefined;
    }
  }
  // A selection of whole alternative lines includes the separator that starts
  // the first line or ends the last line; it is not part of the extracted
  // expression.
  const leading = info.body[first];
  if (
    leading?.kind === "alt" &&
    selStart <= ctx.lineStart(leading.line) &&
    ctx.isTrivia(selStart, leading.start)
  ) {
    selStart = leading.end;
    first++;
  }
  const trailing = info.body[last];
  if (
    last >= first &&
    trailing?.kind === "alt" &&
    selEnd >= ctx.contentEnd(trailing.line) &&
    ctx.isTrivia(trailing.end, selEnd)
  ) {
    selEnd = trailing.start;
    last--;
  }
  const firstToken = info.body[first];
  const lastToken = info.body[last];
  if (!(firstToken && lastToken) || first > last) {
    return undefined;
  }
  const from = info.structOf[first] as number;
  const to = (info.structOf[last] as number) + 1;
  if (
    !isCompleteExpression(info.structure, from, to) ||
    !ctx.isTrivia(selStart, firstToken.start) ||
    !ctx.isTrivia(lastToken.end, selEnd)
  ) {
    return undefined;
  }

  const anchor = anchorIndex(ctx, index);
  const anchorLayout = ctx.info(anchor).layout;
  if (anchor !== index && ctx.sharesLines(anchor)) {
    return undefined;
  }
  const angle =
    ctx.dialect === "rbnf" ||
    (ctx.dialect === "bnf" && info.rule.name.startsWith("<"));
  const name = uniqueRuleName(ctx, workspace, angle);
  const eol = ctx.eolAfter(anchorLayout.endLine);
  const operator = getGrammarDialectDescriptor(ctx.dialect).assignmentOperator;
  const bodyText = ctx.text.slice(firstToken.start, lastToken.end);
  const gap = separatedByBlankLines(ctx, anchorLayout.endLine) ? eol : "";
  const insertAt = ctx.contentEnd(anchorLayout.endLine);

  const edit = new WorkspaceEdit();
  const uri = ctx.doc.uri;
  edit.replace(uri, ctx.range(firstToken.start, lastToken.end), name);
  edit.insert(
    uri,
    ctx.range(insertAt, insertAt).start,
    `${eol}${gap}${name} ${operator} ${bodyText}`,
  );
  const action = new CodeAction(`Extract rule "${name}"`, EXTRACT_KIND);
  action.edit = edit;
  const reference = ctx.range(firstToken.start, firstToken.start).start;
  action.command = {
    title: "Rename extracted rule",
    command: "editor.action.rename",
    arguments: [
      [
        ctx.doc.uri,
        new Position(reference.line, reference.character + (angle ? 1 : 0)),
      ],
    ],
  };
  return action;
}
