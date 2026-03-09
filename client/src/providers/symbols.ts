import {
	type CancellationToken,
	DocumentSymbol,
	type DocumentSymbolProvider,
	SymbolKind,
	type TextDocument,
} from "vscode";
import type { DocumentManager } from "../document-manager";

export class EbnfDocumentSymbolProvider implements DocumentSymbolProvider {
	constructor(private readonly manager: DocumentManager) {}

	provideDocumentSymbols(
		doc: TextDocument,
		_token: CancellationToken,
	): DocumentSymbol[] {
		const { document } = this.manager.get(doc);

		return document.rules.map((rule) =>
			new DocumentSymbol(
				rule.name,
				rule.definitionText,
				rule.isPseudoRule ? SymbolKind.Constant : SymbolKind.Function,
				rule.definitionRange,
				rule.nameRange,
			),
		);
	}
}
