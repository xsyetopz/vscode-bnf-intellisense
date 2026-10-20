import { mock } from "bun:test";
import { configurationValues, settingScopes } from "./vscode-mock/config.ts";
import {
  CodeActionKindMock,
  CodeActionMock,
  CompletionItemMock,
  DocumentHighlightMock,
  HoverMock,
  InlayHintMock,
  LocationMock,
  MarkdownStringMock,
  PositionMock,
  RangeMock,
  SemanticTokensBuilderMock,
  SemanticTokensLegendMock,
  SnippetStringMock,
  SnippetTextEditMock,
  UriMock,
  WorkspaceEditMock,
} from "./vscode-mock/core.ts";
import {
  configurationListeners,
  EventEmitterMock,
  textDocumentListeners,
} from "./vscode-mock/events.ts";
import {
  commandsHostMock,
  languagesHostMock,
  RelativePatternMock,
  windowHostMock,
  workspaceFolders,
  workspaceHostMock,
} from "./vscode-mock/extension-host.ts";
import {
  CallHierarchyIncomingCallMock,
  CallHierarchyItemMock,
  CallHierarchyOutgoingCallMock,
  CodeLensMock,
  DocumentLinkMock,
  DocumentSymbolMock,
  FoldingRangeMock,
  LinkedEditingRangesMock,
  openTextDocuments,
  registration,
  SelectionRangeMock,
  SymbolInformationMock,
} from "./vscode-mock/providers.ts";

/**
 * Test doubles for the `vscode` module, split by topic under `vscode-mock/`.
 * Importing this file installs the module mock; it also re-exports every
 * double and test helper, so tests keep one import path.
 */
export * from "./vscode-mock/config.ts";
export * from "./vscode-mock/core.ts";
export * from "./vscode-mock/events.ts";
export * from "./vscode-mock/extension-host.ts";
export * from "./vscode-mock/providers.ts";

mock.module("vscode", () => ({
  EventEmitter: EventEmitterMock,
  EndOfLine: { LF: 1, CRLF: 2 },
  SnippetTextEdit: SnippetTextEditMock,
  CodeAction: CodeActionMock,
  CodeActionKind: CodeActionKindMock,
  CompletionItem: CompletionItemMock,
  CompletionItemKind: {
    Constant: 1,
    Function: 2,
    Snippet: 3,
  },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  DocumentHighlight: DocumentHighlightMock,
  DocumentHighlightKind: { Text: 0, Read: 1, Write: 2 },
  Hover: HoverMock,
  InlayHint: InlayHintMock,
  InlayHintKind: { Type: 1, Parameter: 2 },
  Location: LocationMock,
  MarkdownString: MarkdownStringMock,
  Position: PositionMock,
  Range: RangeMock,
  RelativePattern: RelativePatternMock,
  Uri: UriMock,
  SemanticTokensBuilder: SemanticTokensBuilderMock,
  SemanticTokensLegend: SemanticTokensLegendMock,
  SnippetString: SnippetStringMock,
  FoldingRange: FoldingRangeMock,
  SymbolInformation: SymbolInformationMock,
  SelectionRange: SelectionRangeMock,
  CodeLens: CodeLensMock,
  CallHierarchyItem: CallHierarchyItemMock,
  CallHierarchyIncomingCall: CallHierarchyIncomingCallMock,
  CallHierarchyOutgoingCall: CallHierarchyOutgoingCallMock,
  LinkedEditingRanges: LinkedEditingRangesMock,
  DocumentLink: DocumentLinkMock,
  SymbolKind: { Function: 11, Class: 4, Variable: 12 },
  DocumentSymbol: DocumentSymbolMock,
  ViewColumn: { One: 1, Two: 2, Beside: -2 },
  commands: commandsHostMock,
  window: windowHostMock,
  languages: {
    ...languagesHostMock,
    registerSelectionRangeProvider: registration("selectionRange"),
    registerCodeLensProvider: registration("codeLens"),
    registerCallHierarchyProvider: registration("callHierarchy"),
    registerDocumentRangeFormattingEditProvider:
      registration("rangeFormatting"),
    registerOnTypeFormattingEditProvider: registration("onTypeFormatting"),
    registerLinkedEditingRangeProvider: registration("linkedEditing"),
    registerDocumentLinkProvider: registration("documentLinks"),
    registerDeclarationProvider: registration("declaration"),
    registerDocumentRangeSemanticTokensProvider: registration(
      "rangeSemanticTokens",
    ),
    registerDocumentSemanticTokensProvider: registration("semanticTokens"),
    registerDocumentSymbolProvider: registration("documentSymbol"),
    registerDefinitionProvider: registration("definition"),
    registerReferenceProvider: registration("references"),
    registerHoverProvider: registration("hover"),
    registerRenameProvider: registration("rename"),
    registerDocumentHighlightProvider: registration("highlight"),
    registerFoldingRangeProvider: registration("folding"),
    registerInlayHintsProvider: registration("inlayHints"),
    registerCompletionItemProvider: registration("completion"),
    registerCodeActionsProvider: registration("codeActions"),
    registerDocumentFormattingEditProvider: registration("formatting"),
    registerWorkspaceSymbolProvider: (provider: unknown) =>
      registration("workspaceSymbol")(undefined, provider),
  },
  TextEdit: {
    replace: (range: unknown, newText: string) => ({ range, newText }),
  },
  WorkspaceEdit: WorkspaceEditMock,
  workspace: {
    ...workspaceHostMock,
    get textDocuments() {
      return openTextDocuments;
    },
    get workspaceFolders() {
      return workspaceFolders;
    },
    onDidChangeTextDocument: (
      listener: (event: {
        document: { languageId: string };
        contentChanges: unknown[];
      }) => void,
    ) => {
      textDocumentListeners.add(listener);
      return { dispose: () => textDocumentListeners.delete(listener) };
    },
    onDidChangeConfiguration: (
      listener: (event: {
        affectsConfiguration: (section: string) => boolean;
      }) => void,
    ) => {
      configurationListeners.add(listener);
      return { dispose: () => configurationListeners.delete(listener) };
    },
    getConfiguration: (
      section = "",
      scope?: { languageId?: string; path?: string; toString?: () => string },
    ) => ({
      get: <T>(key: string, fallback?: T) => {
        const full = section.length > 0 ? `${section}.${key}` : key;
        const folderValue =
          scope?.path === undefined
            ? undefined
            : configurationValues.get(`folder:${scope.toString?.()}:${full}`);
        if (folderValue !== undefined) {
          return folderValue as T;
        }
        const scoped =
          scope?.languageId &&
          settingScopes.get(full) === "language-overridable"
            ? configurationValues.get(`[${scope.languageId}]${full}`)
            : undefined;
        return (
          ((scoped ?? configurationValues.get(full)) as T | undefined) ??
          fallback
        );
      },
    }),
  },
}));
