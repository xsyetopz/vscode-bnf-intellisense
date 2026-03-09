import {
	type CancellationToken,
	CodeAction,
	type CodeActionContext,
	CodeActionKind,
	type CodeActionProvider,
	Position,
	type Range,
	type TextDocument,
	WorkspaceEdit,
} from "vscode";

export class EbnfCodeActionProvider implements CodeActionProvider {
	static readonly metadata = {
		providedCodeActionKinds: [CodeActionKind.QuickFix],
	};

	provideCodeActions(
		doc: TextDocument,
		_range: Range,
		context: CodeActionContext,
		_token: CancellationToken,
	): CodeAction[] | undefined {
		const actions: CodeAction[] = [];

		for (const diag of context.diagnostics) {
			// Match: '"foo" is not defined as a rule in this file'
			const match = diag.message.match(/"([^"]+)" is not defined/);
			if (match) {
				const name = match[1];
				const action = new CodeAction(
					`Create rule '${name}'`,
					CodeActionKind.QuickFix,
				);

				// Insert at end of file with proper formatting
				const edit = new WorkspaceEdit();
				const lastLine = doc.lineCount - 1;
				const lastLineText = doc.lineAt(lastLine).text;
				const insertPos = new Position(lastLine, lastLineText.length);

				// Add newlines before the new rule if needed
				const prefix = lastLineText.length > 0 ? "\n\n" : "\n";
				edit.insert(doc.uri, insertPos, `${prefix}${name} = ;\n`);

				action.edit = edit;
				action.diagnostics = [diag];
				action.isPreferred = true;
				actions.push(action);
			}
		}

		return actions.length > 0 ? actions : undefined;
	}
}
