import { type Position, Range } from "vscode";

export const enum TokenKind {
	Identifier,
	Integer,
	StringSingle,
	StringDouble,
	SpecialSequence,
	Comment,
	Equals,
	Semicolon,
	Pipe,
	Comma,
	Minus,
	Asterisk,
	ParenOpen,
	ParenClose,
	BracketOpen,
	BracketClose,
	BraceOpen,
	BraceClose,
	DotDot,
	Whitespace,
	Unknown,
}

export interface Token {
	kind: TokenKind;
	text: string;
	range: Range;
}

export interface TokenDiagnostic {
	message: string;
	range: Range;
}

export interface TokenizeResult {
	tokens: Token[];
	diagnostics: TokenDiagnostic[];
}

function pos(line: number, character: number): Position {
	return { line, character } as Position;
}

function isWhitespace(ch: string): boolean {
	return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function isAlpha(ch: string): boolean {
	return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
}

function isDigit(ch: string): boolean {
	return ch >= "0" && ch <= "9";
}

function isAlphaNumOrHyphen(ch: string): boolean {
	return isAlpha(ch) || isDigit(ch) || ch === "-";
}

const OPERATOR_KINDS: Record<string, TokenKind> = {
	"=": TokenKind.Equals,
	";": TokenKind.Semicolon,
	"|": TokenKind.Pipe,
	"!": TokenKind.Pipe,
	"/": TokenKind.Pipe,
	",": TokenKind.Comma,
	"-": TokenKind.Minus,
	"*": TokenKind.Asterisk,
	"(": TokenKind.ParenOpen,
	")": TokenKind.ParenClose,
	"[": TokenKind.BracketOpen,
	"]": TokenKind.BracketClose,
	"{": TokenKind.BraceOpen,
	"}": TokenKind.BraceClose,
};

export function tokenize(text: string): TokenizeResult {
	const tokens: Token[] = [];
	const diagnostics: TokenDiagnostic[] = [];
	let line = 0;
	let column = 0;
	let i = 0;

	function advance(): void {
		if (text.charAt(i) === "\n") {
			line++;
			column = 0;
		} else {
			column++;
		}
		i++;
	}

	function currentPos(): Position {
		return pos(line, column);
	}

	function currentChar(): string {
		return text.charAt(i);
	}

	function peekChar(): string {
		return text.charAt(i + 1);
	}

	while (i < text.length) {
		const start = currentPos();
		const tokenStart = i;

		if (currentChar() === "(") {
			if (peekChar() === "*") {
				let depth = 1;
				advance();
				advance();
				while (i < text.length && depth > 0) {
					if (currentChar() === "(" && peekChar() === "*") {
						depth++;
						advance();
						advance();
					} else if (currentChar() === "*" && peekChar() === ")") {
						depth--;
						advance();
						advance();
					} else {
						advance();
					}
				}
				const commentRange = new Range(start, currentPos());
				tokens.push({
					kind: TokenKind.Comment,
					text: text.slice(tokenStart, i),
					range: commentRange,
				});
				if (depth > 0) {
					diagnostics.push({
						message: "Unterminated comment \u2014 missing closing \"*)\"",
						range: commentRange,
					});
				}
				continue;
			} else if (peekChar() === "/") {
				advance();
				advance();
				tokens.push({
					kind: TokenKind.BracketOpen,
					text: "(/",
					range: new Range(start, currentPos()),
				});
				continue;
			} else if (peekChar() === ":") {
				advance();
				advance();
				tokens.push({
					kind: TokenKind.BraceOpen,
					text: "(:",
					range: new Range(start, currentPos()),
				});
				continue;
			}
		}

		if (currentChar() === "/" && peekChar() === ")") {
			advance();
			advance();
			tokens.push({
				kind: TokenKind.BracketClose,
				text: "/)",
				range: new Range(start, currentPos()),
			});
			continue;
		}

		if (currentChar() === ":" && peekChar() === ")") {
			advance();
			advance();
			tokens.push({
				kind: TokenKind.BraceClose,
				text: ":)",
				range: new Range(start, currentPos()),
			});
			continue;
		}

		if (currentChar() === "'") {
			advance();
			while (i < text.length && currentChar() !== "'") {
				if (currentChar() === "\n") {
					break;
				}
				advance();
			}
			const closed = i < text.length && currentChar() === "'";
			if (closed) {
				advance();
			}
			const stringRange = new Range(start, currentPos());
			tokens.push({
				kind: TokenKind.StringSingle,
				text: text.slice(tokenStart, i),
				range: stringRange,
			});
			if (!closed) {
				diagnostics.push({
					message: "Unterminated string \u2014 missing closing \"'\"",
					range: stringRange,
				});
			}
			continue;
		}

		if (currentChar() === '"') {
			advance();
			while (i < text.length && currentChar() !== '"') {
				if (currentChar() === "\n") {
					break;
				}
				advance();
			}
			const closed = i < text.length && currentChar() === '"';
			if (closed) {
				advance();
			}
			const stringRange = new Range(start, currentPos());
			tokens.push({
				kind: TokenKind.StringDouble,
				text: text.slice(tokenStart, i),
				range: stringRange,
			});
			if (!closed) {
				diagnostics.push({
					message: "Unterminated string \u2014 missing closing '\"'",
					range: stringRange,
				});
			}
			continue;
		}

		if (currentChar() === "?") {
			advance();
			while (i < text.length && currentChar() !== "?") {
				advance();
			}
			if (i < text.length && currentChar() === "?") {
				advance();
			}
			tokens.push({
				kind: TokenKind.SpecialSequence,
				text: text.slice(tokenStart, i),
				range: new Range(start, currentPos()),
			});
			continue;
		}

		if (isWhitespace(currentChar())) {
			while (i < text.length && isWhitespace(currentChar())) {
				advance();
			}
			tokens.push({
				kind: TokenKind.Whitespace,
				text: text.slice(tokenStart, i),
				range: new Range(start, currentPos()),
			});
			continue;
		}

		if (isAlpha(currentChar())) {
			while (i < text.length && isAlphaNumOrHyphen(currentChar())) {
				advance();
			}
			tokens.push({
				kind: TokenKind.Identifier,
				text: text.slice(tokenStart, i),
				range: new Range(start, currentPos()),
			});
			continue;
		}

		if (isDigit(currentChar())) {
			while (i < text.length && isDigit(currentChar())) {
				advance();
			}
			tokens.push({
				kind: TokenKind.Integer,
				text: text.slice(tokenStart, i),
				range: new Range(start, currentPos()),
			});
			continue;
		}

		if (currentChar() === ".") {
			if (peekChar() === ".") {
				advance();
				advance();
				tokens.push({
					kind: TokenKind.DotDot,
					text: "..",
					range: new Range(start, currentPos()),
				});
			} else {
				advance();
				tokens.push({
					kind: TokenKind.Semicolon,
					text: ".",
					range: new Range(start, currentPos()),
				});
			}
			continue;
		}

		const c = currentChar();
		const kind = OPERATOR_KINDS[c] ?? TokenKind.Unknown;
		advance();
		tokens.push({
			kind,
			text: c,
			range: new Range(start, currentPos()),
		});
	}

	return { tokens, diagnostics };
}
