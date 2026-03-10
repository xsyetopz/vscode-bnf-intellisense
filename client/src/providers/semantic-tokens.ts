import {
	type CancellationToken,
	type DocumentSemanticTokensProvider,
	type Range,
	SemanticTokens,
	SemanticTokensBuilder,
	SemanticTokensLegend,
	type TextDocument,
} from "vscode";
import type { DocumentManager } from "../document-manager";
import { TokenKind, tokenize } from "../tokenizer";

const TOKEN_TYPES = [
	"type",
	"parameter",
	"string",
	"comment",
	"number",
	"operator",
	"regexp",
] as const;

const TOKEN_MODIFIERS = ["declaration", "definition", "readonly"] as const;

export const SEMANTIC_TOKENS_LEGEND = new SemanticTokensLegend(
	[...TOKEN_TYPES],
	[...TOKEN_MODIFIERS],
);

const TOKEN_TYPE_INDEX = {
	type: 0,
	parameter: 1,
	string: 2,
	comment: 3,
	number: 4,
	operator: 5,
	regexp: 6,
} as const;

const TOKEN_MODIFIER_INDEX = {
	declaration: 0,
	definition: 1,
	readonly: 2,
} as const;

function rangesEqual(a: Range, b: Range): boolean {
	return (
		a.start.line === b.start.line &&
		a.start.character === b.start.character &&
		a.end.line === b.end.line &&
		a.end.character === b.end.character
	);
}

function isOperatorKind(kind: TokenKind): boolean {
	return (
		kind === TokenKind.Equals ||
		kind === TokenKind.Semicolon ||
		kind === TokenKind.Pipe ||
		kind === TokenKind.Comma ||
		kind === TokenKind.Minus ||
		kind === TokenKind.Asterisk ||
		kind === TokenKind.DotDot ||
		kind === TokenKind.ParenOpen ||
		kind === TokenKind.ParenClose ||
		kind === TokenKind.BracketOpen ||
		kind === TokenKind.BracketClose ||
		kind === TokenKind.BraceOpen ||
		kind === TokenKind.BraceClose
	);
}

export class EbnfSemanticTokensProvider implements DocumentSemanticTokensProvider {
	constructor(private readonly manager: DocumentManager) {}

	provideDocumentSemanticTokens(
		doc: TextDocument,
		_token: CancellationToken,
	): SemanticTokens {
		const { document, symbolTable } = this.manager.get(doc);
		const builder = new SemanticTokensBuilder(SEMANTIC_TOKENS_LEGEND);

		const definitionRanges = new Set<Range>();
		for (const rule of document.rules) {
			definitionRanges.add(rule.nameRange);
		}

		const { tokens } = tokenize(doc.getText());

		for (const token of tokens) {
			if (token.kind === TokenKind.Whitespace) {
				continue;
			}

			const range = token.range;
			let typeIndex: number;
			let modifiers = 0;

			switch (token.kind) {
				case TokenKind.Identifier: {
					let isDefinition = false;
					for (const defRange of definitionRanges) {
						if (rangesEqual(range, defRange)) {
							isDefinition = true;
							break;
						}
					}

					if (isDefinition) {
						typeIndex = TOKEN_TYPE_INDEX.type;
						modifiers =
							(1 << TOKEN_MODIFIER_INDEX.declaration) |
							(1 << TOKEN_MODIFIER_INDEX.definition);
					} else if (symbolTable.definitions.has(token.text)) {
						typeIndex = TOKEN_TYPE_INDEX.parameter;
					} else {
						typeIndex = TOKEN_TYPE_INDEX.type;
					}
					break;
				}

				case TokenKind.StringSingle:
				case TokenKind.StringDouble:
					typeIndex = TOKEN_TYPE_INDEX.string;
					break;

				case TokenKind.Comment:
					typeIndex = TOKEN_TYPE_INDEX.comment;
					break;

				case TokenKind.Integer:
					typeIndex = TOKEN_TYPE_INDEX.number;
					break;

				case TokenKind.SpecialSequence:
					typeIndex = TOKEN_TYPE_INDEX.regexp;
					modifiers = 1 << TOKEN_MODIFIER_INDEX.readonly;
					break;

				default:
					if (isOperatorKind(token.kind)) {
						typeIndex = TOKEN_TYPE_INDEX.operator;
					} else {
						continue;
					}
			}

			builder.push(range, TOKEN_TYPES[typeIndex], [
				...TOKEN_MODIFIERS.filter((_, i) => (modifiers & (1 << i)) !== 0),
			]);
		}

		return builder.build();
	}
}
