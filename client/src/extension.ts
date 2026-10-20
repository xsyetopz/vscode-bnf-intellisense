import {
  type ExtensionContext,
  languages,
  type TextDocument,
  type TextDocumentContentProvider,
  workspace,
} from "vscode";
import { registerGrammarCommands } from "./grammar/commands/index.ts";
import {
  BNF_CORE_RULES_SCHEME,
  renderCoreRulesDocument,
} from "./grammar/core-rules-document.ts";
import {
  refreshGrammarDiagnostics,
  updateGrammarDiagnostics,
} from "./grammar/diagnostics.ts";
import { isGrammarLanguage, languageIdsSelector } from "./grammar/grammar.ts";
import { registerGrammarProviders } from "./grammar/providers/index.ts";
import { registerRailroadPreview } from "./grammar/railroad/index.ts";
import { forgetDocumentSuggestions } from "./grammar/suggestion-store.ts";
import { GrammarWorkspace } from "./grammar/workspace.ts";

const SELECTOR = languageIdsSelector();

/**
 * Activates the BNF extension runtime and registers VS Code integrations.
 */
export async function activateGrammarExtension(
  context: ExtensionContext,
): Promise<void> {
  const grammarWorkspace = new GrammarWorkspace();
  // Indexing runs in the background: providers answer from what is indexed so
  // far and results fill in as files are read.
  void grammarWorkspace.initialize().catch((error: unknown) => {
    console.error("BNF workspace indexing failed:", error);
  });
  const diagnosticCollection = languages.createDiagnosticCollection("bnf");

  context.subscriptions.push(
    grammarWorkspace,
    workspace.registerTextDocumentContentProvider(
      BNF_CORE_RULES_SCHEME,
      CORE_RULES_DOCUMENT_PROVIDER,
    ),
    ...registerGrammarProviders(
      SELECTOR,
      grammarWorkspace,
      diagnosticCollection,
    ),
    ...registerGrammarCommands(),
    ...registerRailroadPreview(grammarWorkspace),
  );

  function updateDocumentDiagnostics(doc: TextDocument): void {
    if (isGrammarLanguage(doc.languageId)) {
      grammarWorkspace.syncOpenDocument(doc);
      updateGrammarDiagnostics(doc, grammarWorkspace, diagnosticCollection);
    }
  }

  context.subscriptions.push(
    workspace.onDidOpenTextDocument((doc) => {
      updateDocumentDiagnostics(doc);
    }),
    workspace.onDidChangeTextDocument((event) => {
      if (
        event.contentChanges.length === 0 ||
        !isGrammarLanguage(event.document.languageId)
      ) {
        return;
      }
      grammarWorkspace.scheduleReparse(
        event.document,
        updateDocumentDiagnostics,
      );
    }),
    workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("bnf")) {
        refreshGrammarDiagnostics(
          workspace.textDocuments,
          grammarWorkspace,
          diagnosticCollection,
        );
      }
      if (event.affectsConfiguration("files.exclude")) {
        grammarWorkspace.refreshExclusions().catch((error: unknown) => {
          console.error("BNF workspace indexing failed:", error);
        });
      }
    }),
    workspace.onDidCloseTextDocument((doc) => {
      const uri = doc.uri.toString();
      forgetDocumentSuggestions(uri);
      diagnosticCollection.delete(doc.uri);
    }),
  );

  for (const doc of workspace.textDocuments) {
    updateDocumentDiagnostics(doc);
  }
}

/**
 * Releases resources not tracked by the extension subscriptions.
 */
export function deactivateGrammarExtension(): void {
  // Nothing to release: VS Code disposes the subscriptions.
}

const CORE_RULES_DOCUMENT_PROVIDER: TextDocumentContentProvider = {
  provideTextDocumentContent: () => renderCoreRulesDocument(),
};
