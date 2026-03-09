import {
	type Diagnostic,
	DiagnosticSeverity,
	type DiagnosticCollection,
	type TextDocument,
	workspace,
} from "vscode";
import type { DocumentManager } from "../document-manager";
import { DIAGNOSTIC_SOURCE } from "../parser";

export function updateDiagnostics(
	doc: TextDocument,
	manager: DocumentManager,
	collection: DiagnosticCollection,
): void {
	const { document, symbolTable } = manager.get(doc);
	const diagnostics: Diagnostic[] = [...document.diagnostics];
	const config = workspace.getConfiguration("ebnf");

	if (config.get<boolean>("diagnostics.undefinedReferences", true)) {
		for (const rule of document.rules) {
			for (const ref of rule.references) {
				if (!symbolTable.definitions.has(ref.name)) {
					diagnostics.push({
						message: `"${ref.name}" is not defined as a rule in this file`,
						range: ref.range,
						severity: DiagnosticSeverity.Warning,
						source: DIAGNOSTIC_SOURCE,
					});
				}
			}
		}
	}

	if (config.get<boolean>("diagnostics.duplicateDefinitions", true)) {
		for (const [name, rules] of symbolTable.definitions) {
			if (rules.length > 1) {
				for (const rule of rules) {
					diagnostics.push({
						message: `Duplicate definition of rule "${name}"`,
						range: rule.nameRange,
						severity: DiagnosticSeverity.Information,
						source: DIAGNOSTIC_SOURCE,
					});
				}
			}
		}
	}

	const unusedEnabled = config.get<boolean>("diagnostics.unusedRules", true);
	if (unusedEnabled) {
		for (const [name, rules] of symbolTable.definitions) {
			if (!symbolTable.references.get(name)?.length) {
				for (const rule of rules) {
					diagnostics.push({
						message: `Rule '${name}' is defined but never referenced`,
						range: rule.nameRange,
						severity: DiagnosticSeverity.Hint,
						source: DIAGNOSTIC_SOURCE,
					});
				}
			}
		}
	}

	collection.set(doc.uri, diagnostics);
}
