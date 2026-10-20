import type { Disposable, Range, TextDocument, Uri, ViewColumn } from "vscode";
import * as vscode from "vscode";
import { isGrammarLanguage } from "../dialects.ts";

/**
 * The part of a VS Code webview panel the preview uses.
 */
export interface PanelLike {
  title: string;
  readonly webview: {
    html: string;
    postMessage(message: unknown): PromiseLike<boolean>;
    onDidReceiveMessage(listener: (message: unknown) => void): Disposable;
  };
  reveal(column?: undefined, preserveFocus?: boolean): void;
  dispose(): void;
  onDidDispose(listener: () => void): Disposable;
}

/**
 * Active grammar editor state the preview follows.
 */
export interface ActiveGrammarEditor {
  document: TextDocument;
  /** Zero-based line of the cursor. */
  line: number;
  viewColumn: ViewColumn | undefined;
}

/**
 * Everything the preview needs from the editor host. The default
 * implementation wraps the `vscode` API; any object with these members works.
 */
export interface RailroadHost {
  activeGrammarEditor(): ActiveGrammarEditor | undefined;
  onDidChangeActiveEditor(listener: () => void): Disposable;
  onDidChangeSelection(
    listener: (document: TextDocument, line: number) => void,
  ): Disposable;
  onDidChangeDocument(listener: (document: TextDocument) => void): Disposable;
  onDidCloseDocument(listener: (document: TextDocument) => void): Disposable;
  registerCommand(id: string, callback: () => void): Disposable;
  createPanel(title: string): PanelLike;
  revealRange(
    uri: Uri,
    range: Range,
    column: ViewColumn | undefined,
  ): PromiseLike<void>;
  showMessage(message: string): void;
  createNonce(): string;
}

/**
 * Random nonce (hex) for the webview Content-Security-Policy.
 */
export function createNonce(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Host backed by the real `vscode` API. The API is read lazily, so importing
 * this file never touches missing members.
 */
export function createVscodeHost(): RailroadHost {
  return {
    activeGrammarEditor: () => {
      const editor = vscode.window.activeTextEditor;
      if (!(editor && isGrammarLanguage(editor.document.languageId))) {
        return undefined;
      }
      return {
        document: editor.document,
        line: editor.selection.active.line,
        viewColumn: editor.viewColumn,
      };
    },
    onDidChangeActiveEditor: (listener) =>
      vscode.window.onDidChangeActiveTextEditor(() => listener()),
    onDidChangeSelection: (listener) =>
      vscode.window.onDidChangeTextEditorSelection((event) =>
        listener(
          event.textEditor.document,
          event.selections[0]?.active.line ?? 0,
        ),
      ),
    onDidChangeDocument: (listener) =>
      vscode.workspace.onDidChangeTextDocument((event) =>
        listener(event.document),
      ),
    onDidCloseDocument: (listener) =>
      vscode.workspace.onDidCloseTextDocument(listener),
    registerCommand: (id, callback) =>
      vscode.commands.registerCommand(id, callback),
    createPanel: (title) =>
      vscode.window.createWebviewPanel(
        "bnf.railroad",
        title,
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        {
          enableScripts: true,
          enableFindWidget: true,
          retainContextWhenHidden: true,
          localResourceRoots: [],
        },
      ),
    revealRange: async (uri, range, column) => {
      await vscode.window.showTextDocument(uri, {
        selection: range,
        viewColumn: column ?? vscode.ViewColumn.One,
        preserveFocus: false,
      });
    },
    showMessage: (message) => {
      vscode.window.showInformationMessage(message);
    },
    createNonce,
  };
}
