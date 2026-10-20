import { beforeAll, describe, expect, test } from "bun:test";
import "../vscode-mock.ts";
import type { GrammarDialect } from "../../grammar/dialects.ts";

let grammar: typeof import("../../grammar/grammar.ts");
let convert: typeof import("../../grammar/commands/convert-dialect.ts");
let sorting: typeof import("../../grammar/commands/sort-rules.ts");

beforeAll(async () => {
  grammar = await import("../../grammar/grammar.ts");
  convert = await import("../../grammar/commands/convert-dialect.ts");
  sorting = await import("../../grammar/commands/sort-rules.ts");
});

function codes(text: string, dialect: GrammarDialect): string[] {
  return grammar
    .parseGrammar(text, dialect)
    .diagnostics.map((d) => String(d.code));
}

describe("stray punctuation in production grammars", () => {
  test.each([
    ["bnf", "<a> ::= <x> 1 @ ~\n"],
    ["rbnf", "<a> ::= <x> 1 @ ~\n"],
    ["ebnf", "a ::= x 1 @ ~\n"],
  ] as const)(
    "%s reports each stray token as unexpected text",
    (dialect, text) => {
      const found = codes(text, dialect).filter(
        (code) => code === "bnf.unexpected-text",
      );

      expect(found).toHaveLength(3);
    },
  );

  test("a BNF digit after a reference is reported", () => {
    const found = codes("<a> ::= <x>{1}\n", "bnf");

    expect(found).toContain("bnf.unexpected-text");
  });

  test.each([
    ["rbnf", '<a> ::= 2*3<x> *("a") 1*("b") 2<x>\n'],
    ["rbnf", "<a> ::= <x> ... [<x> ...] 0*2<x>\n"],
  ] as const)("valid %s text is not reported: %s", (dialect, text) => {
    const found = codes(text, dialect);

    expect(found).not.toContain("bnf.unexpected-text");
  });

  test.each([
    ["bnf", "<a> ::= <b>, <c>\n", ","],
    ["rbnf", '<a> ::= <x>, "b"\n', ","],
    ["ebnf", 'a ::= x , "b"\n', ","],
    ["ebnf", 'a ::= x ; "b"\n', ";"],
  ] as const)(
    "%s reports one warning for the %s separator in %j",
    (dialect, text, separator) => {
      const found = grammar
        .parseGrammar(text, dialect)
        .diagnostics.filter((d) => d.code === "bnf.unexpected-text");

      expect(found).toHaveLength(1);
      expect(found[0]?.message).toContain(`"${separator}"`);
    },
  );

  test("an ISO-style document keeps only its ISO diagnostic", () => {
    const text = 'a = x , "b" ;\nb = a | "c" ;\n';

    const all = codes(text, "ebnf");

    expect(all.filter((code) => code === "bnf.unexpected-text")).toEqual([]);
    expect(all).toContain("bnf.iso-ebnf");
  });

  test("a comma stops BNF conversion", () => {
    const result = convert.convertDialect("<a> ::= <b>, <c>\n", "bnf", "ebnf");

    expect(result.ok).toBe(false);
  });

  test("a stray token stops the conversion", () => {
    const result = convert.convertDialect("<a> ::= <x> 1 @ ~\n", "bnf", "ebnf");

    expect(result.ok).toBe(false);
  });

  test("a stray token stops the sort", () => {
    const result = sorting.sortRules(
      '<b> ::= "x" @\n<a> ::= "y"\n',
      "bnf",
      "alphabetical",
    );

    expect(result.ok).toBe(false);
  });
});
