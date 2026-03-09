import type { Diagnostic, Range } from "vscode";

export interface IdentifierReference {
	name: string;
	range: Range;
}

export interface Rule {
	name: string;
	nameRange: Range;
	definitionRange: Range;
	definitionText: string;
	isPseudoRule: boolean;
	precedingComment?: string | undefined;
	references: IdentifierReference[];
}

export interface EbnfDocument {
	rules: Rule[];
	diagnostics: Diagnostic[];
}

export interface SymbolTable {
	definitions: Map<string, Rule[]>;
	references: Map<string, IdentifierReference[]>;
}
