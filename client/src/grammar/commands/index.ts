import type { Disposable, Position, TextEditor } from "vscode";
import * as vscode from "vscode";
import {
  GRAMMAR_DIALECTS,
  type GrammarDialect,
  isGrammarLanguage,
} from "../dialects.ts";
import { readFormattingConfig } from "../formatting-provider.ts";
import { grammarDialectFromLanguageId } from "../grammar.ts";
import { convertDialect } from "./convert-dialect.ts";
import { formatConverted } from "./format-converted.ts";
import { type SortMode, sortRules } from "./sort-rules.ts";

/**
 * Command IDs registered by `registerGrammarCommands`.
 */
export const GrammarCommand = {
  SortRules: "bnf.sortRules",
  SortRulesByDependency: "bnf.sortRulesByDependency",
  ConvertDialect: "bnf.convertDialect",
} as const;

/**
 * The part of a text editor the commands use.
 */
export interface CommandEditor {
  document: {
    languageId: string;
    uri: unknown;
    getText(): string;
    offsetAt(position: Position): number;
  };
  selections: ReadonlyArray<{ start: Position; end: Position }>;
}

/**
 * Entry of the target quick pick.
 */
export interface DialectPick {
  label: string;
  description: string;
  dialect: GrammarDialect;
}

/**
 * VS Code calls the commands need, kept behind one interface so a host can supply its own.
 */
export interface CommandHost {
  registerCommand(
    id: string,
    handler: (...args: unknown[]) => unknown,
  ): Disposable;
  activeEditor(): CommandEditor | undefined;
  /** Replaces `start..end` of the editor's document in one undoable edit. */
  replace(
    editor: CommandEditor,
    start: number,
    end: number,
    text: string,
  ): Promise<boolean>;
  showInformation(message: string): void;
  showWarning(message: string): void;
  pickDialect(picks: DialectPick[]): Promise<GrammarDialect | undefined>;
  openUntitled(language: GrammarDialect, content: string): Promise<void>;
  /** Formatter-aware text for the new document. */
  format(
    editor: CommandEditor,
    target: GrammarDialect,
  ): (text: string) => string;
}

const MAX_LISTED_WARNINGS = 3;

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function grammarEditor(host: CommandHost): CommandEditor | undefined {
  const editor = host.activeEditor();
  if (editor && isGrammarLanguage(editor.document.languageId)) {
    return editor;
  }
  host.showInformation(
    "Open an ABNF, BNF, EBNF, or RBNF file to use this command.",
  );
  return undefined;
}

async function runSort(host: CommandHost, mode: SortMode): Promise<void> {
  const editor = grammarEditor(host);
  if (!editor) {
    return;
  }
  const { document } = editor;
  const text = document.getText();
  const picked = editor.selections
    .map((s) => ({
      start: document.offsetAt(s.start),
      end: document.offsetAt(s.end),
    }))
    .filter((s) => s.start !== s.end);
  const result = sortRules(
    text,
    grammarDialectFromLanguageId(document.languageId),
    mode,
    picked.length > 0 ? picked : undefined,
  );
  if (!result.ok) {
    host.showWarning(`Rules were not sorted: ${result.reason}.`);
    return;
  }
  if (!result.changed) {
    host.showInformation("The rules are already in that order.");
    return;
  }
  const applied = await host.replace(
    editor,
    result.edit.start,
    result.edit.end,
    result.edit.newText,
  );
  if (!applied) {
    host.showWarning("Rules were not sorted: the editor rejected the edit.");
  }
}

async function runConvert(host: CommandHost, argument: unknown): Promise<void> {
  const editor = grammarEditor(host);
  if (!editor) {
    return;
  }
  const source = grammarDialectFromLanguageId(editor.document.languageId);
  let target: GrammarDialect | undefined = GRAMMAR_DIALECTS.find(
    (dialect) => dialect.id === argument && dialect.id !== source,
  )?.id;
  if (!target) {
    target = await host.pickDialect(
      GRAMMAR_DIALECTS.filter((dialect) => dialect.id !== source).map(
        (dialect) => ({
          label: dialect.displayName,
          description: dialect.standardName,
          dialect: dialect.id,
        }),
      ),
    );
  }
  if (!target) {
    return;
  }
  const result = convertDialect(editor.document.getText(), source, target, {
    format: (text) => host.format(editor, target as GrammarDialect)(text),
  });
  if (!result.ok) {
    host.showWarning(`Not converted: ${result.reason}.`);
    return;
  }
  await host.openUntitled(target, result.text);
  const label = GRAMMAR_DIALECTS.find(
    (dialect) => dialect.id === target,
  )?.displayName;
  if (result.warnings.length === 0) {
    host.showInformation(`Converted to ${label}.`);
    return;
  }
  const listed = result.warnings.slice(0, MAX_LISTED_WARNINGS).join("; ");
  const more = result.warnings.length - MAX_LISTED_WARNINGS;
  host.showWarning(
    `Converted to ${label} with ${plural(result.warnings.length, "warning")}: ${listed}${more > 0 ? `; and ${more} more` : ""}.`,
  );
}

/**
 * Registers the sort and convert commands. Returns the registrations.
 */
export function registerGrammarCommands(
  host: CommandHost = createVscodeHost(),
): Disposable[] {
  return [
    host.registerCommand(GrammarCommand.SortRules, () =>
      runSort(host, "alphabetical"),
    ),
    host.registerCommand(GrammarCommand.SortRulesByDependency, () =>
      runSort(host, "dependency"),
    ),
    host.registerCommand(GrammarCommand.ConvertDialect, (target) =>
      runConvert(host, target),
    ),
  ];
}

/**
 * The real VS Code implementation of `CommandHost`.
 */
export function createVscodeHost(): CommandHost {
  return {
    registerCommand: (id, handler) =>
      vscode.commands.registerCommand(id, handler),
    activeEditor: () =>
      vscode.window.activeTextEditor as unknown as CommandEditor | undefined,
    replace: (editor, start, end, text) => {
      const real = editor as unknown as TextEditor;
      const range = new vscode.Range(
        real.document.positionAt(start),
        real.document.positionAt(end),
      );
      return Promise.resolve(
        real.edit((builder) => builder.replace(range, text), {
          undoStopBefore: true,
          undoStopAfter: true,
        }),
      );
    },
    showInformation: (message) => {
      vscode.window.showInformationMessage(message);
    },
    showWarning: (message) => {
      vscode.window.showWarningMessage(message);
    },
    pickDialect: async (picks) =>
      (
        await vscode.window.showQuickPick(picks, {
          title: "Convert to dialect",
          placeHolder: "Choose the target grammar dialect",
        })
      )?.dialect,
    openUntitled: async (language, content) => {
      const document = await vscode.workspace.openTextDocument({
        language,
        content,
      });
      await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false,
      });
    },
    format: (editor, target) => {
      const config = readFormattingConfig({
        uri: editor.document.uri as vscode.Uri,
        languageId: target,
      });
      return (text) => formatConverted(text, target, config);
    },
  };
}
