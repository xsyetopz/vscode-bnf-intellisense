import {
	type ExtensionContext,
	type TextDocument,
	languages,
	workspace,
} from "vscode";
import { DocumentManager } from "./document-manager";
import { WorkspaceIndex } from "./workspace-index";
import { EbnfCodeActionProvider } from "./providers/code-actions";
import { EbnfCompletionProvider } from "./providers/completion";
import { EbnfDefinitionProvider } from "./providers/definition";
import { updateDiagnostics } from "./providers/diagnostics";
import { EbnfFoldingRangeProvider } from "./providers/folding";
import { EbnfDocumentHighlightProvider } from "./providers/highlighting";
import { EbnfHoverProvider } from "./providers/hover";
import { EbnfInlayHintsProvider } from "./providers/inlay-hints";
import { EbnfReferenceProvider } from "./providers/references";
import { EbnfRenameProvider } from "./providers/rename";
import { EbnfSemanticTokensProvider, SEMANTIC_TOKENS_LEGEND } from "./providers/semantic-tokens";
import { EbnfDocumentSymbolProvider } from "./providers/symbols";
import { EbnfWorkspaceSymbolProvider } from "./providers/workspace-symbols";

const SELECTOR = { language: "ebnf" };

export async function activate(context: ExtensionContext): Promise<void> {
	const manager = new DocumentManager();
	const workspaceIndex = new WorkspaceIndex();
	await workspaceIndex.initialize();

	const diagnosticCollection = languages.createDiagnosticCollection("ebnf");

	context.subscriptions.push(
		manager,
		workspaceIndex,
		languages.registerDocumentSymbolProvider(SELECTOR, new EbnfDocumentSymbolProvider(manager)),
		languages.registerDefinitionProvider(SELECTOR, new EbnfDefinitionProvider(manager, workspaceIndex)),
		languages.registerReferenceProvider(SELECTOR, new EbnfReferenceProvider(manager, workspaceIndex)),
		languages.registerHoverProvider(SELECTOR, new EbnfHoverProvider(manager)),
		languages.registerCompletionItemProvider(SELECTOR, new EbnfCompletionProvider(manager)),
		languages.registerRenameProvider(SELECTOR, new EbnfRenameProvider(manager)),
		languages.registerDocumentHighlightProvider(SELECTOR, new EbnfDocumentHighlightProvider(manager)),
		languages.registerFoldingRangeProvider(SELECTOR, new EbnfFoldingRangeProvider(manager)),
		languages.registerCodeActionsProvider(SELECTOR, new EbnfCodeActionProvider(), EbnfCodeActionProvider.metadata),
		languages.registerDocumentSemanticTokensProvider(SELECTOR, new EbnfSemanticTokensProvider(manager), SEMANTIC_TOKENS_LEGEND),
		languages.registerWorkspaceSymbolProvider(new EbnfWorkspaceSymbolProvider(workspaceIndex)),
		languages.registerInlayHintsProvider(SELECTOR, new EbnfInlayHintsProvider(manager)),
		diagnosticCollection,
	);

	function updateDocumentDiagnostics(doc: TextDocument): void {
		if (doc.languageId !== "ebnf") {
			return;
		}
		const config = workspace.getConfiguration("ebnf");
		if (config.get<boolean>("diagnostics.enable", true)) {
			updateDiagnostics(doc, manager, diagnosticCollection);
		} else {
			diagnosticCollection.delete(doc.uri);
		}
	}

	context.subscriptions.push(
		workspace.onDidOpenTextDocument((doc) => {
			updateDocumentDiagnostics(doc);
		}),
		workspace.onDidChangeTextDocument((event) => {
			manager.scheduleReparse(event.document, updateDocumentDiagnostics);
		}),
		workspace.onDidCloseTextDocument((doc) => {
			const uri = doc.uri.toString();
			manager.remove(uri);
			diagnosticCollection.delete(doc.uri);
		}),
	);

	for (const doc of workspace.textDocuments) {
		updateDocumentDiagnostics(doc);
	}
}

export function deactivate(): void {}
