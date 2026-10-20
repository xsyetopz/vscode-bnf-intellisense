import { RangeMock, type WorkspaceEditMock } from "../vscode-mock.ts";
import {
  applyWorkspaceEdit,
  asTextDocument,
  createDocument,
  loadGrammarTestCore,
} from "./provider-test-utils.ts";

export type Dialect = "abnf" | "bnf" | "ebnf" | "rbnf";

export let grammar: typeof import("../../grammar/grammar.ts");
export let diagnostics: typeof import("../../grammar/diagnostics.ts");
let actions: typeof import("../../grammar/code-actions.ts");

export type DiagnosticOptions = Parameters<
  typeof import("../../grammar/diagnostics.ts").collectGrammarDiagnostics
>[2];

export async function loadCodeActionCore(): Promise<void> {
  await loadGrammarTestCore();
  grammar = await import("../../grammar/grammar.ts");
  diagnostics = await import("../../grammar/diagnostics.ts");
  actions = await import("../../grammar/code-actions.ts");
}

export const FILE_WIDE_TITLE = "Convert every";
export const ONE_PRODUCTION_TITLE = 'Use "::=" for this EBNF production';
export const REMOVE_DUPLICATE_TITLE = "Remove duplicate alternative";
export const REMOVE_EMPTY_TITLE = "Remove empty alternative";

/** Diagnostics the extension reports for `text`. */
export function diagnose(
  text: string,
  dialect: Dialect,
  options: DiagnosticOptions = {},
) {
  const document = grammar.parseGrammar(text, dialect);
  const symbolTable = grammar.buildGrammarSymbolTable(document, dialect);
  return diagnostics.collectGrammarDiagnostics(
    { dialect, document, symbolTable },
    text,
    options,
  );
}

/** Diagnostics with one code, ignoring unused-rule reports. */
export function diagnosticsWithCode(
  text: string,
  dialect: Dialect,
  code: string,
) {
  return diagnose(text, dialect, { unusedRules: false }).filter(
    (d) => d.code === code,
  );
}

export type QuickFix = {
  title: string;
  /** The document text after the fix is applied. */
  text: string;
  /** Why the action is disabled, when it is. */
  reason?: string | undefined;
};

/** Raw code actions for `text` and the given diagnostics. */
export function rawCodeActions(
  text: string,
  dialect: Dialect,
  found: unknown[],
) {
  const doc = createDocument(`/w/t.${dialect}`, text, dialect);
  return (new actions.GrammarCodeActionProvider().provideCodeActions(
    asTextDocument(doc),
    new RangeMock(0, 0, 0, 0) as never,
    { diagnostics: found } as never,
    {} as never,
  ) ?? []) as unknown as Array<{
    title: string;
    edit?: WorkspaceEditMock;
    disabled?: { reason: string };
  }>;
}

/** Quick fixes offered for `text`, or for the given diagnostics. */
export function quickFixes(
  text: string,
  dialect: Dialect,
  extra: { diagnostics?: unknown[] } = {},
): QuickFix[] {
  const found =
    extra.diagnostics ?? diagnose(text, dialect, { unusedRules: false });
  return rawCodeActions(text, dialect, found).map((a) => ({
    title: a.title,
    text: a.edit ? applyWorkspaceEdit(text, a.edit) : text,
    reason: a.disabled?.reason,
  }));
}

/** The text after applying the file-wide ISO to W3C conversion. */
export function convertEveryProduction(text: string): string | undefined {
  return quickFixes(text, "ebnf").find((f) =>
    f.title.startsWith(FILE_WIDE_TITLE),
  )?.text;
}

/** The text after applying the quick fix with exactly this title. */
export function applyQuickFix(
  text: string,
  dialect: Dialect,
  title: string,
): string | undefined {
  return quickFixes(text, dialect).find((f) => f.title === title)?.text;
}
