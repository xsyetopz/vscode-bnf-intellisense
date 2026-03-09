import {
	type CancellationToken,
	FoldingRange,
	FoldingRangeKind,
	type FoldingRangeProvider,
	type TextDocument,
} from "vscode";
import type { DocumentManager } from "../document-manager";
import { TokenKind, tokenize } from "../tokenizer";

export class EbnfFoldingRangeProvider implements FoldingRangeProvider {
	constructor(private readonly manager: DocumentManager) {}

	provideFoldingRanges(
		doc: TextDocument,
		_context: unknown,
		_token: CancellationToken,
	): FoldingRange[] {
		const { document } = this.manager.get(doc);
		const ranges: FoldingRange[] = [];

		for (const rule of document.rules) {
			const startLine = rule.definitionRange.start.line;
			const endLine = rule.definitionRange.end.line;
			if (endLine > startLine) {
				ranges.push(new FoldingRange(startLine, endLine));
			}
		}

		const { tokens } = tokenize(doc.getText());
		for (const token of tokens) {
			if (token.kind === TokenKind.Comment) {
				const startLine = token.range.start.line;
				const endLine = token.range.end.line;
				if (endLine > startLine) {
					ranges.push(
						new FoldingRange(startLine, endLine, FoldingRangeKind.Comment),
					);
				}
			}
		}

		return ranges;
	}
}
