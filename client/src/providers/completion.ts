import {
	type CancellationToken,
	CompletionItem,
	CompletionItemKind,
	type CompletionItemProvider,
	type Position,
	type TextDocument,
} from "vscode";
import type { DocumentManager } from "../document-manager";

export class EbnfCompletionProvider implements CompletionItemProvider {
	constructor(private readonly manager: DocumentManager) {}

	provideCompletionItems(
		doc: TextDocument,
		_position: Position,
		_token: CancellationToken,
	): CompletionItem[] {
		const { symbolTable } = this.manager.get(doc);
		const items: CompletionItem[] = [];

		for (const [name, rules] of symbolTable.definitions) {
			const kind = rules[0]?.isPseudoRule ? CompletionItemKind.Constant : CompletionItemKind.Function;
			const item = new CompletionItem(name, kind);
			const rule = rules[0];
			if (rule) {
				item.detail = `${rule.name} = ${rule.definitionText} ;`;
				if (rule.precedingComment) {
					item.documentation = rule.precedingComment;
				}
			}
			items.push(item);
		}

		return items;
	}
}
