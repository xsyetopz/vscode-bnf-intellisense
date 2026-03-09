import { type Diagnostic, DiagnosticSeverity, Range } from "vscode";
import type { Token } from "./tokenizer";
import { TokenKind, tokenize } from "./tokenizer";
import type { EbnfDocument, IdentifierReference, Rule, SymbolTable } from "./types";

export const DIAGNOSTIC_SOURCE = "ebnf";

export function parse(text: string): EbnfDocument {
	const tokens = tokenize(text);
	const rules: Rule[] = [];
	const diagnostics: Diagnostic[] = [];

	let tokenIndex = 0;
	const tokenCount = tokens.length;
	let precedingComment: Token | undefined;

	function nextNonWhitespace(): Token | undefined {
		while (tokenIndex < tokenCount) {
			const t = tokens[tokenIndex]!;
			if (t.kind !== TokenKind.Whitespace) {
				return t;
			}
			tokenIndex++;
		}
		return undefined;
	}

	let token = nextNonWhitespace();
	while (token) {
		if (token.kind === TokenKind.Comment) {
			precedingComment = token;
			tokenIndex++;
			token = nextNonWhitespace();
			continue;
		}

		const savedIdx = tokenIndex;
		tokenIndex++;
		const nextToken = nextNonWhitespace();
		tokenIndex = savedIdx;

		if (
			token.kind === TokenKind.Identifier &&
			nextToken !== undefined &&
			nextToken.kind === TokenKind.Equals
		) {
			const nameToken = token;
			const equalsToken = nextToken;
			const references: IdentifierReference[] = [];
			const bodyTokens: Token[] = [];

			tokenIndex++;
			nextNonWhitespace(); // skip to equals
			tokenIndex++;

			let bodyToken = nextNonWhitespace();
			while (bodyToken && bodyToken.kind !== TokenKind.Semicolon) {
				if (bodyToken.kind !== TokenKind.Comment) {
					bodyTokens.push(bodyToken);
				}
				if (bodyToken.kind === TokenKind.Identifier) {
					references.push({ name: bodyToken.text, range: bodyToken.range });
				}
				tokenIndex++;
				bodyToken = nextNonWhitespace();
			}

			const semicolonToken = bodyToken?.kind === TokenKind.Semicolon ? bodyToken : undefined;
			if (semicolonToken) {
				tokenIndex++;
			} else {
				diagnostics.push({
					message: `Missing ";" at end of rule "${nameToken.text}"`,
					range: nameToken.range,
					severity: DiagnosticSeverity.Error,
					source: DIAGNOSTIC_SOURCE,
				});
			}

			const lastBodyToken = bodyTokens.length > 0 ? bodyTokens[bodyTokens.length - 1] : undefined;
			const endRange = semicolonToken?.range ?? lastBodyToken?.range ?? equalsToken.range;
			const definitionText = bodyTokens.map((t) => t.text).join(" ");

			const isPseudoRule =
				bodyTokens.length === 1 &&
				bodyTokens[0]!.kind === TokenKind.SpecialSequence;

			let commentText: string | undefined;
			if (precedingComment) {
				commentText = precedingComment.text.slice(2, -2).trim();
			}

			rules.push({
				name: nameToken.text,
				nameRange: nameToken.range,
				definitionRange: new Range(nameToken.range.start, endRange.end),
				definitionText,
				isPseudoRule,
				precedingComment: commentText,
				references,
			});

			precedingComment = undefined;
			token = nextNonWhitespace();
			continue;
		}

		precedingComment = undefined;
		tokenIndex++;
		token = nextNonWhitespace();
	}

	return { rules, diagnostics };
}

export function buildSymbolTable(doc: EbnfDocument): SymbolTable {
	const definitions = new Map<string, Rule[]>();
	const references = new Map<string, IdentifierReference[]>();

	for (const rule of doc.rules) {
		const existing = definitions.get(rule.name);
		if (existing) {
			existing.push(rule);
		} else {
			definitions.set(rule.name, [rule]);
		}

		for (const ref of rule.references) {
			const existingRefs = references.get(ref.name);
			if (existingRefs) {
				existingRefs.push(ref);
			} else {
				references.set(ref.name, [ref]);
			}
		}
	}

	return { definitions, references };
}
