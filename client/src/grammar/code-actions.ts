import {
  type CancellationToken,
  CodeAction,
  type CodeActionContext,
  CodeActionKind,
  type CodeActionProvider,
  EndOfLine,
  Position,
  Range,
  SnippetString,
  SnippetTextEdit,
  type TextDocument,
  WorkspaceEdit,
} from "vscode";
import { provideAbnfCodeActions } from "../abnf/code-actions.ts";
import { appendAll } from "../append-all.ts";
import {
  alternativeRemovalSpans,
  createRemovalIndex,
  type RemovalIndex,
} from "./alternative-removal.ts";
import { readGrammarConfig } from "./config.ts";
import { GrammarDiagnosticCode } from "./diagnostic-codes.ts";
import { suggestionCandidates } from "./diagnostics.ts";
import {
  buildGrammarSymbolTable,
  type GrammarDialect,
  getGrammarDialectDescriptor,
  grammarDialectFromLanguageId,
  parseGrammar,
} from "./grammar.ts";
import {
  collectIsoRuns,
  type IsoRun,
  type OffsetEdit,
} from "./iso-conversion.ts";
import { LineIndex } from "./line-index.ts";
import { rangeFromLineIndex } from "./ranges.ts";
import { recalledSuggestion } from "./suggestion-store.ts";
import { bareName, NameSuggester } from "./suggestions.ts";

type DiagnosticLike = CodeActionContext["diagnostics"][number];

const NAME_RE = /^\w+/;
const ANGLE_STYLE_RE = /^[ \t]*<[^<>\n]+>[ \t]*::=/m;

/**
 * VS Code quick-fix provider for grammar diagnostics. Fixes are matched on
 * `Diagnostic.code` only.
 */
export class GrammarCodeActionProvider implements CodeActionProvider {
  static readonly metadata = {
    providedCodeActionKinds: [
      CodeActionKind.QuickFix,
      CodeActionKind.RefactorRewrite,
    ],
  };

  provideCodeActions(
    doc: TextDocument,
    range: Range,
    context: CodeActionContext,
    _token: CancellationToken,
  ): CodeAction[] | undefined {
    const dialect = grammarDialectFromLanguageId(doc.languageId);
    const wantsFixes =
      !context.only || context.only.contains(CodeActionKind.QuickFix);
    const diagnostics = wantsFixes ? context.diagnostics : [];
    const shared = new SharedState(doc, dialect);
    const actions = diagnostics.flatMap((diagnostic) =>
      fixesFor(shared, diagnostic),
    );
    const isoDiagnostics = diagnostics.filter(isIsoDiagnostic);
    if (dialect === "ebnf" && isoDiagnostics.length > 0) {
      const fileWide = convertWholeFileAction(shared, isoDiagnostics);
      if (fileWide) {
        actions.push(fileWide);
      }
    }
    if (dialect === "abnf") {
      appendAll(actions, provideAbnfCodeActions(doc, range, context));
    }
    return actions.length > 0 ? actions : undefined;
  }
}

/**
 * Work shared by all fixes of one request, computed on first use so that a
 * selection with thousands of diagnostics parses the document only once.
 */
class SharedState {
  readonly doc: TextDocument;
  readonly dialect: GrammarDialect;
  readonly #cache = new Map<string, unknown>();

  constructor(doc: TextDocument, dialect: GrammarDialect) {
    this.doc = doc;
    this.dialect = dialect;
  }

  #once<T>(key: string, make: () => T): T {
    if (!this.#cache.has(key)) {
      this.#cache.set(key, make());
    }
    return this.#cache.get(key) as T;
  }

  get text(): string {
    return this.#once("text", () => this.doc.getText());
  }

  get lines(): LineIndex {
    return this.#once("lines", () => new LineIndex(this.text));
  }

  get eol(): string {
    return lineBreak(this.doc);
  }

  get suggester(): NameSuggester {
    return this.#once("suggester", () => {
      const document = parseGrammar(this.text, this.dialect);
      const table = buildGrammarSymbolTable(document, this.dialect);
      return new NameSuggester(suggestionCandidates(table, this.dialect));
    });
  }

  get didYouMean(): boolean {
    return this.#once("didYouMean", () =>
      readGrammarConfig<boolean>("diagnostics.didYouMean", true, {
        uri: this.doc.uri,
        languageId: this.doc.languageId,
      }),
    );
  }

  get removal(): RemovalIndex {
    return this.#once("removal", () =>
      createRemovalIndex(this.text, this.dialect),
    );
  }

  /** ISO runs by the "line:column" where each starts. */
  get isoRuns(): {
    runs: IsoRun[];
    comments: IsoRun[];
    byStart: Map<string, IsoRun>;
  } {
    return this.#once("isoRuns", () => {
      const runs = collectIsoRuns(this.text, this.eol);
      const byStart = new Map<string, IsoRun>();
      for (const run of runs) {
        const start = rangeFromLineIndex(
          this.lines,
          run.start,
          run.start,
        ).start;
        byStart.set(`${start.line}:${start.character}`, run);
      }
      return { runs, comments: commentRunsByEnd(runs), byStart };
    });
  }
}

function isIsoDiagnostic(diagnostic: DiagnosticLike): boolean {
  return diagnostic.code === GrammarDiagnosticCode.IsoEbnf;
}

function fixesFor(
  shared: SharedState,
  diagnostic: DiagnosticLike,
): CodeAction[] {
  const { doc } = shared;
  switch (diagnostic.code) {
    case GrammarDiagnosticCode.UndefinedReference:
      return undefinedReferenceFixes(shared, diagnostic);
    case GrammarDiagnosticCode.IsoEbnf:
      return convertStatementActions(shared, diagnostic);
    case GrammarDiagnosticCode.DuplicateAlternative:
    case GrammarDiagnosticCode.EmptyAlternative: {
      const fix = removeAlternativeAction(shared, diagnostic);
      return fix ? [fix] : [];
    }
    case GrammarDiagnosticCode.DuplicateExtension:
      return [removeRuleAction(doc, diagnostic)];
    default:
      return [];
  }
}

function undefinedReferenceFixes(
  shared: SharedState,
  diagnostic: DiagnosticLike,
): CodeAction[] {
  const { doc, dialect } = shared;
  const name = doc.getText(diagnostic.range);
  // Reuse what the diagnostic run computed; only diagnostics from elsewhere
  // fall back to a fresh lookup, and that honours bnf.diagnostics.didYouMean.
  const recalled = recalledSuggestion(doc.uri.toString(), diagnostic, name);
  const suggestion =
    recalled ??
    (shared.didYouMean ? shared.suggester.suggest(name)?.name : undefined) ??
    "";
  const actions: CodeAction[] = [];
  if (suggestion) {
    actions.push(renameAction(doc, diagnostic, name, suggestion));
  }
  actions.push(createRuleAction(doc, dialect, diagnostic, name, !suggestion));
  return actions;
}

function renameAction(
  doc: TextDocument,
  diagnostic: DiagnosticLike,
  from: string,
  to: string,
): CodeAction {
  const caseOnly =
    bareName(from) !== bareName(to) &&
    bareName(from).toLowerCase() === bareName(to).toLowerCase();
  const action = new CodeAction(
    caseOnly
      ? `Rename "${from}" to "${to}" (names are case-sensitive)`
      : `Change "${from}" to "${to}"`,
    CodeActionKind.QuickFix,
  );
  const edit = new WorkspaceEdit();
  edit.replace(doc.uri, diagnostic.range, to);
  action.edit = edit;
  action.diagnostics = [diagnostic];
  action.isPreferred = true;
  return action;
}

function removeAlternativeAction(
  shared: SharedState,
  diagnostic: DiagnosticLike,
): CodeAction | undefined {
  const { doc } = shared;
  const spans = alternativeRemovalSpans(
    shared.removal,
    diagnostic.range,
    (line) => doc.lineAt(line).text,
    doc.lineCount,
  );
  if (!spans || spans.length === 0) {
    return undefined;
  }
  const empty = diagnostic.code === GrammarDiagnosticCode.EmptyAlternative;
  const action = new CodeAction(
    empty ? "Remove empty alternative" : "Remove duplicate alternative",
    CodeActionKind.QuickFix,
  );
  const edit = new WorkspaceEdit();
  for (const span of spans) {
    edit.delete(doc.uri, span);
  }
  action.edit = edit;
  action.diagnostics = [diagnostic];
  action.isPreferred = !empty;
  return action;
}

function removeRuleAction(
  doc: TextDocument,
  diagnostic: DiagnosticLike,
): CodeAction {
  const action = new CodeAction(
    'Remove this "=/" extension (every alternative already exists)',
    CodeActionKind.QuickFix,
  );
  const { start, end } = diagnostic.range;
  const edit = new WorkspaceEdit();
  const last = doc.lineCount - 1;
  edit.delete(
    doc.uri,
    end.line < last
      ? new Range(start.line, 0, end.line + 1, 0)
      : new Range(
          start.line > 0
            ? new Position(
                start.line - 1,
                doc.lineAt(start.line - 1).text.length,
              )
            : new Position(0, 0),
          new Position(end.line, doc.lineAt(end.line).text.length),
        ),
  );
  action.edit = edit;
  action.diagnostics = [diagnostic];
  action.isPreferred = true;
  return action;
}

function lineBreak(doc: TextDocument): string {
  return doc.eol === EndOfLine.CRLF ? "\r\n" : "\n";
}

function createRuleAction(
  doc: TextDocument,
  dialect: GrammarDialect,
  diagnostic: DiagnosticLike,
  reference: string,
  preferred: boolean,
): CodeAction {
  const name = ruleNameShape(doc, dialect, reference);
  const action = new CodeAction(
    `Create missing rule "${name}"`,
    CodeActionKind.QuickFix,
  );
  const edit = new WorkspaceEdit();
  const lastLine = doc.lineCount - 1;
  const lastLineText = doc.lineAt(lastLine).text;
  const insertPos = new Position(lastLine, lastLineText.length);
  const operator = getGrammarDialectDescriptor(dialect).assignmentOperator;
  const eol = lineBreak(doc);
  const prefix = lastLineText.length > 0 ? `${eol}${eol}` : eol;
  if (/^[ \t]/.test(lastLineText)) {
    // VS Code re-indents the lines of a snippet to match the line it is
    // inserted on, and SnippetTextEdit.keepWhitespace only exists in newer
    // API versions than our engine floor (1.91). After an indented last
    // line (an ABNF continuation, say) the new rule would become indented,
    // so insert plain text without a placeholder instead.
    edit.insert(
      doc.uri,
      insertPos,
      `${prefix}${name} ${operator} "TODO"${eol}`,
    );
  } else {
    const escaped = name.replace(/[\\$}]/g, "\\$&");
    edit.set(doc.uri, [
      SnippetTextEdit.insert(
        insertPos,
        new SnippetString(
          `${prefix}${escaped} ${operator} \${1:definition}${eol}`,
        ),
      ),
    ]);
  }
  action.edit = edit;
  action.diagnostics = [diagnostic];
  action.isPreferred = preferred;
  return action;
}

/**
 * RBNF rule names are always `<name>`; BNF follows the style of the file
 * (angle brackets when its rules use them); EBNF and ABNF names are bare.
 */
function ruleNameShape(
  doc: TextDocument,
  dialect: GrammarDialect,
  reference: string,
): string {
  const bare = bareName(reference);
  if (dialect === "rbnf") {
    return `<${bare}>`;
  }
  if (dialect === "bnf") {
    return reference.startsWith("<") || ANGLE_STYLE_RE.test(doc.getText())
      ? `<${bare}>`
      : bare;
  }
  return bare;
}

function applyOffsetEdits(
  edit: WorkspaceEdit,
  doc: TextDocument,
  lines: LineIndex,
  edits: readonly OffsetEdit[],
): void {
  for (const { start, end, text } of edits) {
    edit.replace(doc.uri, rangeFromLineIndex(lines, start, end), text);
  }
}

function runEdits(run: IsoRun): OffsetEdit[] {
  return [
    ...run.statements.flatMap((statement) => statement.edits),
    ...run.looseEdits,
  ];
}

/** Comment-only runs ordered by where they end. */
function commentRunsByEnd(runs: readonly IsoRun[]): IsoRun[] {
  return runs
    .filter((candidate) => candidate.statements.length === 0)
    .sort((a, b) => a.end - b.end);
}

/** Index of the first comment that ends after `offset`. */
function firstCommentEndingAfter(
  comments: readonly IsoRun[],
  offset: number,
): number {
  let low = 0;
  let high = comments.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((comments[mid] as IsoRun).end <= offset) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

/**
 * True when only spaces and at most one line break lie between `from` and
 * `to`. A blank line separates a comment from the code below it.
 */
function isAdjacent(text: string, from: number, to: number): boolean {
  let breaks = 0;
  for (let i = from; i < to; i++) {
    const ch = text.slice(i, i + 1);
    if (ch === "\n") {
      breaks++;
    } else if (ch.trim() !== "") {
      return false;
    }
  }
  return breaks <= 1;
}

/**
 * Edits of the comments that sit directly in front of a run (at most one line
 * break between them), so a single-production fix does not rewrite comments
 * that belong to other parts of the file.
 */
function adjacentCommentEdits(
  text: string,
  run: IsoRun,
  comments: readonly IsoRun[],
): OffsetEdit[] {
  const edits: OffsetEdit[] = [];
  let target = run.start;
  for (
    let index = firstCommentEndingAfter(comments, target) - 1;
    index >= 0;
    index--
  ) {
    const comment = comments[index] as IsoRun;
    if (comment.end > target) {
      continue;
    }
    if (!isAdjacent(text, comment.end, target)) {
      break;
    }
    if (comment.trailsCode) {
      // It trails another production's code, so it is not this one's header.
      break;
    }
    edits.push(...comment.looseEdits);
    target = comment.start;
  }
  return edits;
}

function convertStatementActions(
  shared: SharedState,
  diagnostic: DiagnosticLike,
): CodeAction[] {
  const { doc, text, lines } = shared;
  const { comments, byStart } = shared.isoRuns;
  const run = byStart.get(
    `${diagnostic.range.start.line}:${diagnostic.range.start.character}`,
  );
  if (!run) {
    return [];
  }
  const actions: CodeAction[] = [];
  const isComment = run.statements.length === 0;
  const edits = [
    ...runEdits(run),
    ...(isComment ? [] : adjacentCommentEdits(text, run, comments)),
  ];
  if (runEdits(run).length > 0) {
    const action = new CodeAction(
      isComment
        ? 'Use "/* ... */" for this EBNF comment'
        : 'Use "::=" for this EBNF production',
      CodeActionKind.QuickFix,
    );
    const edit = new WorkspaceEdit();
    applyOffsetEdits(edit, doc, lines, edits);
    action.edit = edit;
    action.diagnostics = [diagnostic];
    action.isPreferred = true;
    actions.push(action);
  }
  if (run.refusal) {
    const action = new CodeAction(
      'Cannot convert this comment to "/* ... */"',
      CodeActionKind.QuickFix,
    );
    action.disabled = { reason: run.refusal };
    action.diagnostics = [diagnostic];
    actions.push(action);
  }
  for (const statement of run.statements) {
    if (!statement.convertible) {
      const name = text.slice(statement.start, statement.end).match(NAME_RE);
      const action = new CodeAction(
        `Cannot convert "${name?.[0] ?? "this production"}" to W3C XML EBNF`,
        CodeActionKind.QuickFix,
      );
      action.disabled = {
        reason: statement.reason ?? "it uses ISO syntax W3C has no form for",
      };
      action.diagnostics = [diagnostic];
      actions.push(action);
    }
  }
  return actions;
}

function convertWholeFileAction(
  shared: SharedState,
  diagnostics: DiagnosticLike[],
): CodeAction | undefined {
  const { runs } = shared.isoRuns;
  const productions = runs.reduce((n, run) => n + run.statements.length, 0);
  const edits = runs.flatMap(runEdits);
  if (productions < 2 || edits.length === 0) {
    return undefined;
  }
  const action = new CodeAction(
    "Convert every ISO/IEC 14977 production in this file to W3C XML EBNF",
    CodeActionKind.QuickFix,
  );
  const edit = new WorkspaceEdit();
  applyOffsetEdits(edit, shared.doc, shared.lines, edits);
  action.edit = edit;
  action.diagnostics = diagnostics;
  return action;
}
