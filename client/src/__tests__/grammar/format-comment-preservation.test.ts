import { beforeAll, describe, expect, test } from "bun:test";

let formatProductionGrammarDocument: typeof import("../../grammar/format.ts").formatProductionGrammarDocument;

beforeAll(async () => {
  ({ formatProductionGrammarDocument } = await import(
    "../../grammar/format.ts"
  ));
});

const config = {
  alignEquals: true,
  alternativeIndent: "align",
  blankLinesBetweenRules: 1,
  breakAlternatives: "always",
  continuationIndent: 4,
  insertFinalNewline: true,
  maxLineLength: 80,
  preserveCommentSpacing: true,
  trimTrailingBlankLines: true,
  alignProductionNumbers: true,
  spaceBeforeInlineComment: 2,
} as const;

describe("formatting keeps comments that span lines", () => {
  test("EBNF block comments are kept verbatim", () => {
    const text = "a ::= b /* x\n y */ c\n\nd ::= e\n";

    const out = formatProductionGrammarDocument(text, "ebnf", config);

    expect(out).toContain("/* x\n y */");
  });

  test("RBNF treats /* */ as plain tokens, in order", () => {
    const text = "<a> ::=   <b> /* x\n y */ <c> ::=   <d>\n";

    const out = formatProductionGrammarDocument(text, "rbnf", config);

    expect(out.replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
  });

  test("a real RBNF comment keeps its line", () => {
    const text = "<a> ::=   <b> ; x\n  <c>\n";

    const out = formatProductionGrammarDocument(text, "rbnf", config);

    expect(out).toContain("; x\n");
  });
});
