import {
	type CancellationToken,
	InlayHint,
	InlayHintKind,
	type InlayHintsProvider,
	type Range,
	type TextDocument,
	workspace,
} from "vscode";
import type { DocumentManager } from "../document-manager";

export class EbnfInlayHintsProvider implements InlayHintsProvider {
	constructor(private readonly manager: DocumentManager) {}

	provideInlayHints(
		doc: TextDocument,
		range: Range,
		_token: CancellationToken,
	): InlayHint[] {
		const { document, symbolTable } = this.manager.get(doc);
		const hints: InlayHint[] = [];
		const config = workspace.getConfiguration("ebnf");

		const showRefCount = config.get<boolean>("inlayHints.referenceCount", false);
		const showRecursion = config.get<boolean>("inlayHints.recursion", false);
		const showUnused = config.get<boolean>("inlayHints.unusedMarker", false);

		if (!showRefCount && !showRecursion && !showUnused) {
			return hints;
		}

		for (const rule of document.rules) {
			// Skip rules outside requested range
			if (!range.intersection(rule.definitionRange)) {
				continue;
			}

			const refCount = symbolTable.references.get(rule.name)?.length ?? 0;
			const isRecursive = rule.references.some((r) => r.name === rule.name);
			const isUnused = refCount === 0;

			const parts: string[] = [];

			if (showRefCount) {
				parts.push(`${refCount} ref${refCount !== 1 ? "s" : ""}`);
			}

			if (showRecursion && isRecursive) {
				parts.push("recursive");
			}

			if (showUnused && isUnused) {
				parts.push("unused");
			}

			if (parts.length > 0) {
				const hint = new InlayHint(
					rule.nameRange.end,
					` ${parts.join(", ")}`,
					InlayHintKind.Parameter,
				);
				hint.paddingLeft = true;
				hints.push(hint);
			}
		}

		return hints;
	}
}
