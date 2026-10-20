import { beforeAll, describe, expect, test } from "bun:test";
import type { GrammarDialect } from "../../grammar/dialects.ts";
import { PositionMock } from "../vscode-mock.ts";
import {
  asTextDocument,
  createDocument,
  createWorkspace,
  loadGrammarTestCore,
  textOfRange,
} from "./provider-test-utils.ts";

let GrammarLinkedEditingRangeProvider: typeof import("../../grammar/providers/linked-editing.ts").GrammarLinkedEditingRangeProvider;

beforeAll(async () => {
  await loadGrammarTestCore();
  ({ GrammarLinkedEditingRangeProvider } = await import(
    "../../grammar/providers/linked-editing.ts"
  ));
});

function link(
  text: string,
  dialect: GrammarDialect,
  line: number,
  character: number,
) {
  const doc = createDocument(`/workspace/g.${dialect}`, text, dialect);
  const result = new GrammarLinkedEditingRangeProvider(
    createWorkspace(),
  ).provideLinkedEditingRanges(
    asTextDocument(doc),
    new PositionMock(line, character) as never,
  );
  return result
    ? {
        texts: result.ranges.map((range) => textOfRange(text, range)),
        lines: result.ranges.map((range) => range.start.line),
        wordPattern: result.wordPattern as RegExp,
      }
    : undefined;
}

describe("linked editing range provider", () => {
  test("links the definition and every reference in the document", () => {
    const text = 'a = b b\nb = "x"\nc = b\n';
    const fromDefinition = link(text, "abnf", 1, 0);
    expect(fromDefinition?.texts).toEqual(["b", "b", "b", "b"]);
    expect(fromDefinition?.lines).toEqual([0, 0, 1, 2]);
    expect(link(text, "abnf", 0, 5)?.lines).toEqual([0, 0, 1, 2]);
    // Cursor right after the last letter still counts.
    expect(link(text, "abnf", 1, 1)?.texts).toHaveLength(4);
  });

  test("EBNF links only exact-case names and has an identifier pattern", () => {
    const text = "A ::= B a\nB ::= 'x'\na ::= 'y'\n";
    const result = link(text, "ebnf", 1, 0);
    expect(result?.texts).toEqual(["B", "B"]);
    expect(result?.wordPattern.source).toBe("[A-Za-z_][A-Za-z0-9_.:-]*");
    expect(result?.wordPattern.test("Rule_1.x")).toBe(true);
  });

  test("ABNF links exact-case occurrences only", () => {
    const text = 'Rule = rule RULE Rule\nrule = "x"\n';
    expect(link(text, "abnf", 0, 1)?.texts).toEqual(["Rule", "Rule"]);
    expect(link(text, "abnf", 1, 1)?.texts).toEqual(["rule", "rule"]);
  });

  test("ABNF uses the identifier word pattern", () => {
    const text = 'Rule = rule RULE Rule\nrule = "x"\n';
    expect(link(text, "abnf", 0, 1)?.wordPattern.source).toBe(
      "[A-Za-z][A-Za-z0-9-]*",
    );
  });

  test("BNF and RBNF link the name inside the angle brackets", () => {
    const text = "<expr> ::= <expr> '+' <term>\n<term> ::= 'x'\n";
    const result = link(text, "bnf", 0, 2);
    expect(result?.texts).toEqual(["expr", "expr"]);
    expect(result?.wordPattern.test("two words")).toBe(true);
    expect(result?.wordPattern.test("<")).toBe(false);
  });

  test("RBNF links names that contain spaces", () => {
    const rbnf = link("<a b> ::= <a b> ...\n", "rbnf", 0, 3);
    expect(rbnf?.texts).toEqual(["a b", "a b"]);
    expect(rbnf?.wordPattern.source).toBe("[^<>\\r\\n]+");
  });

  test("bare BNF names keep the identifier pattern", () => {
    expect(link("x ::= y\ny ::= 'a'\n", "bnf", 1, 0)?.wordPattern.source).toBe(
      "[A-Za-z_][A-Za-z0-9_.:-]*",
    );
  });

  test.each([
    [0, false],
    [1, true],
    [5, true],
    [6, false],
  ])(
    "a cursor at column %i of an angle-bracketed name is linked: %p",
    (column, linked) => {
      const text = "<expr> ::= <expr>\n";

      const result = link(text, "bnf", 0, column);

      expect(result !== undefined).toBe(linked);
    },
  );

  describe("nothing to link", () => {
    const abnf = 'a = ALPHA "a" ; a\n\nb = a\n';

    test.each([
      ["a core rule", abnf, "abnf", 0, 6],
      ["an ABNF string", abnf, "abnf", 0, 12],
      ["an ABNF comment", abnf, "abnf", 0, 17],
      ["the ABNF operator", abnf, "abnf", 0, 2],
      ["a blank line", abnf, "abnf", 1, 0],
      ["an EBNF string", "a ::= 'a'\n", "ebnf", 0, 7],
      ["an EBNF comment", "A ::= x /* A */\n", "ebnf", 0, 11],
      ["an empty document", "", "abnf", 0, 0],
    ] as const)("on %s", (_label, text, dialect, line, character) => {
      expect(link(text, dialect, line, character)).toBeUndefined();
    });
  });

  test("works with CRLF and returns ranges in document order", () => {
    const text = 'a = b\r\nb = "x"\r\nc = b\r\n';
    const result = link(text, "abnf", 2, 4);
    expect(result?.lines).toEqual([0, 1, 2]);
  });

  test("a rule used nowhere still links its own name", () => {
    expect(link('lonely = "x"\n', "abnf", 0, 2)?.texts).toEqual(["lonely"]);
  });
});
