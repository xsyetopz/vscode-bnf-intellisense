import { CodeAction, CodeActionKind, type Range, WorkspaceEdit } from "vscode";
import { CORE_RULE_NAMES } from "../../abnf/core-rules.ts";
import type { IdentifierReference } from "../../types.ts";
import type { LayoutToken } from "../rule-layout.ts";
import { normalizeSymbolName } from "../symbol-table.ts";
import type { GrammarWorkspace } from "../workspace.ts";
import type { RefactorContext, RuleInfo } from "./context.ts";
import { type BodyKind, classifyBody, hostContext } from "./structure.ts";

/**
 * Kind of the inline-rule code action.
 */
export const INLINE_KIND = CodeActionKind.Refactor.append("inline");

interface InlineTarget {
  /** Rule that gets inlined. */
  definition: RuleInfo;
  kind: BodyKind;
  /** Source text of the body, from its first to its last token, no comments. */
  bodyText: string;
}

interface Occurrence {
  start: number;
  end: number;
  text: string;
}

const LINE_BREAK_END_RE = /[\r\n]$/;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Source text of a body from its first to its last token, without comments.
 * A gap that held a comment becomes one space, so the text stays on one line
 * and its tokens do not run together. Other gaps are kept as written.
 */
function bodyTextWithoutComments(
  ctx: RefactorContext,
  body: readonly LayoutToken[],
): string {
  let text = "";
  body.forEach((token, index) => {
    const previous = body[index - 1];
    if (previous) {
      const gap = ctx.text.slice(previous.end, token.start);
      text += ctx.layout.comments.some(
        (comment) =>
          comment.start >= previous.end && comment.end <= token.start,
      )
        ? " "
        : gap;
    }
    text += token.text;
  });
  return text;
}

/**
 * True when the rule can reach itself through references, so inlining would
 * not terminate or would change the shape of the grammar.
 */
function isRecursive(ctx: RefactorContext, definition: RuleInfo): boolean {
  const seen = new Set<string>();
  const pending = definition.rule.references.map((ref) =>
    normalizeSymbolName(ref.name, ctx.dialect),
  );
  while (pending.length > 0) {
    const key = pending.pop() as string;
    if (key === definition.key) {
      return true;
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    for (const rule of ctx.symbolTable.definitions.get(key) ?? []) {
      for (const ref of rule.references) {
        pending.push(normalizeSymbolName(ref.name, ctx.dialect));
      }
    }
  }
  return false;
}

/**
 * Finds the rule named `key` and checks that it can be inlined: exactly one
 * definition, no `=/` parts, not a core rule, no errors, not recursive.
 */
function inlineTarget(
  ctx: RefactorContext,
  key: string,
): InlineTarget | undefined {
  if (ctx.dialect === "abnf" && CORE_RULE_NAMES.has(key)) {
    return undefined;
  }
  const definitions = ctx.symbolTable.definitions.get(key);
  const only = definitions?.length === 1 ? definitions[0] : undefined;
  const index = only ? ctx.document.rules.indexOf(only) : -1;
  if (!only || index < 0 || only.isIncremental || only.isCoreRule) {
    return undefined;
  }
  const definition = ctx.info(index);
  if (definition.errors || definition.hasAnnotation) {
    return undefined;
  }
  const kind = classifyBody(definition.structure);
  const first = definition.body[0];
  const last = definition.body[definition.body.length - 1];
  if (kind === "invalid" || kind === "empty" || !(first && last)) {
    return undefined;
  }
  if (isRecursive(ctx, definition)) {
    return undefined;
  }
  return {
    definition,
    kind,
    bodyText: bodyTextWithoutComments(ctx, definition.body),
  };
}

/**
 * Text that replaces one reference, with grouping where precedence needs it.
 * Returns undefined when grouping is needed but the dialect has none.
 */
function replacementFor(
  ctx: RefactorContext,
  target: InlineTarget,
  reference: IdentifierReference,
): Occurrence | undefined {
  const index = ctx.ruleIndexAtLine(reference.range.start.line);
  if (index < 0) {
    return undefined;
  }
  const host = ctx.info(index);
  if (host.errors) {
    return undefined;
  }
  const at = host.body.findIndex(
    (token) =>
      token.line === reference.range.start.line &&
      token.column === reference.range.start.character,
  );
  const token = host.body[at];
  const structIndex = host.structOf[at];
  if (!token || structIndex === undefined || structIndex < 0) {
    return undefined;
  }
  const context = hostContext(host.structure, structIndex);
  const alone = context.wholeAlternative && !context.hasOperator;
  let wrap: boolean;
  switch (target.kind) {
    case "atom":
      wrap = false;
      break;
    case "op":
    case "seq":
      wrap = context.hasOperator || context.nextToExclusion;
      break;
    default:
      wrap = !alone;
  }
  if (wrap && ctx.dialect === "bnf") {
    return undefined;
  }
  return {
    start: token.start,
    end: token.end,
    text: wrap ? `(${target.bodyText})` : target.bodyText,
  };
}

/**
 * What replaces the definition: whole lines of the rule (comments above it
 * stay) so that no gap is left behind. Comments inside the definition stay as
 * standalone comment lines, kept apart from the next rule by a blank line.
 */
function definitionRemoval(
  ctx: RefactorContext,
  definition: RuleInfo,
): { start: number; end: number; text: string } {
  const first = definition.layout.startLine;
  const last = definition.layout.endLine;
  const lastLine = ctx.lineCount - 1;
  const trailingEmpty = last + 1 === lastLine && ctx.isBlankLine(lastLine);
  const reachesEnd = last >= lastLine || trailingEmpty;
  // Inlined text never carries comments, so every comment of the definition
  // stays behind, inner ones included.
  const kept = ctx.layout.comments
    .filter((comment) => comment.line >= first && comment.endLine <= last)
    .map((comment) => ctx.text.slice(comment.start, comment.end));
  // The file's final line break stays as it was.
  const endsWithBreak = LINE_BREAK_END_RE.test(ctx.text);
  if (kept.length > 0) {
    const eol = ctx.eolAfter(first);
    const nextLine = last + 1;
    const needsGap = !reachesEnd && !ctx.isBlankLine(nextLine);
    const finalBreak = !reachesEnd || endsWithBreak ? eol : "";
    return {
      start: ctx.lineStart(first),
      end: reachesEnd ? ctx.text.length : ctx.lineStart(nextLine),
      text: kept.join(eol) + finalBreak + (needsGap ? eol : ""),
    };
  }
  let startLine = first;
  if (reachesEnd) {
    while (startLine > 0 && ctx.isBlankLine(startLine - 1)) {
      startLine--;
    }
    return {
      start:
        endsWithBreak || startLine === 0
          ? ctx.lineStart(startLine)
          : ctx.contentEnd(startLine - 1),
      end: ctx.text.length,
      text: "",
    };
  }
  let endLine = last + 1;
  const previousBlank = first === 0 || ctx.isBlankLine(first - 1);
  if (previousBlank && ctx.isBlankLine(endLine)) {
    endLine++;
  }
  return {
    start: ctx.lineStart(first),
    end: ctx.lineStart(endLine),
    text: "",
  };
}

function referencesInOtherFiles(
  ctx: RefactorContext,
  workspace: GrammarWorkspace,
  key: string,
): boolean {
  const self = ctx.doc.uri.toString();
  return workspace
    .getAllFiles(ctx.dialect)
    .some(
      (file) =>
        file.uri.toString() !== self &&
        file.symbolTable.references.has(key) &&
        !file.symbolTable.definitions.has(key),
    );
}

function buildAction(
  ctx: RefactorContext,
  title: string,
  occurrences: readonly Occurrence[],
  removal?: { start: number; end: number; text: string },
): CodeAction {
  const edit = new WorkspaceEdit();
  for (const occurrence of occurrences) {
    edit.replace(
      ctx.doc.uri,
      ctx.range(occurrence.start, occurrence.end),
      occurrence.text,
    );
  }
  if (removal) {
    edit.replace(
      ctx.doc.uri,
      ctx.range(removal.start, removal.end),
      removal.text,
    );
  }
  const action = new CodeAction(title, INLINE_KIND);
  action.edit = edit;
  return action;
}

function inlineReference(
  ctx: RefactorContext,
  reference: IdentifierReference,
): CodeAction | undefined {
  const key = normalizeSymbolName(reference.name, ctx.dialect);
  const target = inlineTarget(ctx, key);
  if (!target) {
    return undefined;
  }
  const occurrence = replacementFor(ctx, target, reference);
  if (!occurrence) {
    return undefined;
  }
  return buildAction(ctx, `Inline rule "${target.definition.rule.name}" here`, [
    occurrence,
  ]);
}

function inlineDefinition(
  ctx: RefactorContext,
  workspace: GrammarWorkspace,
  definition: RuleInfo,
): CodeAction | undefined {
  const target = inlineTarget(ctx, definition.key);
  if (!target || ctx.sharesLines(definition.index)) {
    return undefined;
  }
  const references = ctx.symbolTable.references.get(definition.key) ?? [];
  if (references.length === 0) {
    return undefined;
  }
  const occurrences: Occurrence[] = [];
  for (const reference of references) {
    const occurrence = replacementFor(ctx, target, reference);
    if (!occurrence) {
      return undefined;
    }
    occurrences.push(occurrence);
  }
  const others = referencesInOtherFiles(ctx, workspace, definition.key);
  const count = plural(references.length, "reference");
  const note = others ? "; references in other files are left alone" : "";
  return buildAction(
    ctx,
    `Inline rule "${definition.rule.name}" (${count}${note})`,
    occurrences,
    definitionRemoval(ctx, definition),
  );
}

/**
 * Offers "Inline rule": on a reference it inlines that reference; on a
 * definition name it inlines every reference in the document and removes the
 * definition.
 */
export function inlineRuleAction(
  ctx: RefactorContext,
  workspace: GrammarWorkspace,
  range: Range,
): CodeAction | undefined {
  const index = ctx.ruleIndexAtLine(range.start.line);
  if (index < 0 || index !== ctx.ruleIndexAtLine(range.end.line)) {
    return undefined;
  }
  const start = ctx.offsetAt(range.start);
  const end = ctx.offsetAt(range.end);
  const info = ctx.info(index);
  const name = info.layout.nameToken;
  if (start >= name.start && end <= name.end) {
    return inlineDefinition(ctx, workspace, info);
  }
  for (const reference of info.rule.references) {
    const from = ctx.offsetAt(reference.range.start);
    const to = ctx.offsetAt(reference.range.end);
    if (start >= from && end <= to) {
      return inlineReference(ctx, reference);
    }
  }
  return undefined;
}
