import { describe, expect, test } from "bun:test";
import "../vscode-mock.ts";
import { formatProductionGrammarDocument } from "../../grammar/format.ts";
import { lexProductionGrammar } from "../../grammar/scanner.ts";

const config = {
  alignEquals: true,
  alignProductionNumbers: true,
  alternativeIndent: "align" as const,
  blankLinesBetweenRules: 1,
  breakAlternatives: "always" as const,
  continuationIndent: 4,
  insertFinalNewline: true,
  maxLineLength: 80,
  preserveCommentSpacing: true,
  spaceBeforeInlineComment: 2,
  trimTrailingBlankLines: true,
};

function format(text: string): string {
  return formatProductionGrammarDocument(text, "ebnf", config);
}

function tokenTexts(text: string): string[] {
  return lexProductionGrammar(text, "ebnf").map((token) => token.text);
}

// Inputs where "(*" is, or looks like, an ISO comment opener.
const OPENER_CASES: ReadonlyArray<readonly [string, string]> = [
  ["inside a double-quoted string", `a ::= "(*" b\n`],
  ["inside a single-quoted string", `a ::= '(* x *)' b\n`],
  ["inside a character class", `a ::= [(*] b\n`],
  ["inside a block comment", `a ::= x /* (* */ y\n`],
  ["spaced group with star", `a ::= ( *x )\n`],
  ["group followed by repeat", `a ::= (x)* b\n`],
  ["stray opener and closer", `a ::= (*) b\nc ::= (d*)\n`],
  ["nested ISO comment", `a ::= x (* (* n *) *) y\n`],
  ["deeply nested ISO comment", `a ::= (*(*(* *) *) *) b\n`],
  ["unclosed ISO comment", `a ::= x (* open\nb ::= y\n`],
  ["unclosed ISO comment at the end", `a ::= x (* open\n`],
  ["multi-line ISO comment", `a ::= x (* one\n   two *) y\nb ::= z\n`],
  [
    "CRLF multi-line ISO comment",
    `a ::= x (* one\r\n   two *) y\r\nb ::= z\r\n`,
  ],
  ["comment glued between names", `a ::= x(*c*)y\n`],
  ["closer glued to the opener", `a ::= (*) y *) b\n`],
  ["back-to-back comments", `a ::= x (* a *)(* b *) y\n`],
  [
    "head-like line inside a comment",
    `a ::= x (* eg:\nfoo ::= bar *)\nc ::= d\n`,
  ],
  ["comment above a rule", `(* header *)\na ::= b\n`],
];

describe("formatting around ISO comment openers", () => {
  test.each(OPENER_CASES)("keeps every token: %s", (_name, input) => {
    const before = tokenTexts(input);

    const formatted = format(input);

    expect(tokenTexts(formatted)).toEqual(before);
  });

  test.each(OPENER_CASES)("is idempotent: %s", (_name, input) => {
    const once = format(input);

    const twice = format(once);

    expect(twice).toBe(once);
  });
});
