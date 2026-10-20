import { beforeAll, describe, expect, test } from "bun:test";
import type { GrammarDialect } from "../../grammar/dialects.ts";
import { PositionMock } from "../vscode-mock.ts";
import {
  asTextDocument,
  createDocument,
  loadGrammarTestCore,
  textOfRange,
} from "./provider-test-utils.ts";

let GrammarSelectionRangeProvider: typeof import("../../grammar/providers/selection-range.ts").GrammarSelectionRangeProvider;

beforeAll(async () => {
  await loadGrammarTestCore();
  ({ GrammarSelectionRangeProvider } = await import(
    "../../grammar/providers/selection-range.ts"
  ));
});

interface Chained {
  range: Parameters<typeof textOfRange>[1];
  parent?: Chained | undefined;
}

function chain(
  text: string,
  dialect: GrammarDialect,
  line: number,
  character: number,
  path = "/workspace/g.txt",
): string[] {
  const doc = createDocument(path, text, dialect);
  const [result] = new GrammarSelectionRangeProvider().provideSelectionRanges(
    asTextDocument(doc),
    [new PositionMock(line, character) as never],
  );
  const texts: string[] = [];
  for (let r = result as Chained | undefined; r; r = r.parent) {
    texts.push(textOfRange(text, r.range));
  }
  return texts;
}

function expectStrictlyNested(texts: string[]): void {
  for (let i = 1; i < texts.length; i++) {
    const inner = texts[i - 1] as string;
    const outer = texts[i] as string;
    expect(outer.length).toBeGreaterThan(inner.length);
    expect(outer).toContain(inner);
  }
}

describe("selection range provider", () => {
  test("ABNF expands name, group, alternative, body, rule, document", () => {
    const text = 'rule = a / (b *c) d\nother = "x"\n';
    const texts = chain(text, "abnf", 0, 15);
    expect(texts).toEqual([
      "c",
      "*c",
      "b *c",
      "(b *c)",
      "(b *c) d",
      "a / (b *c) d",
      "rule = a / (b *c) d",
      text,
    ]);
    expectStrictlyNested(texts);
  });

  test("ABNF repeat prefix is part of the element, optional is a group", () => {
    const text = "r = 1*3DIGIT [x]\n";
    expect(chain(text, "abnf", 0, 9)).toEqual([
      "DIGIT",
      "1*3DIGIT",
      "1*3DIGIT [x]",
      "r = 1*3DIGIT [x]",
      text,
    ]);
    expect(chain(text, "abnf", 0, 14)).toEqual([
      "x",
      "[x]",
      "1*3DIGIT [x]",
      "r = 1*3DIGIT [x]",
      text,
    ]);
  });

  test("ABNF multi-line rule selects continuation lines as one rule", () => {
    const text = "rule = a\n     / b\n     / c\nnext = d\n";
    const texts = chain(text, "abnf", 1, 7);
    expect(texts[0]).toBe("b");
    expect(texts.at(-2)).toBe("rule = a\n     / b\n     / c");
    expect(texts.at(-1)).toBe(text);
    expectStrictlyNested(texts);
  });

  test("EBNF handles braces, repeat suffix and strings", () => {
    const text = "Rule ::= ( 'a' | B )* | #x41\n";
    const texts = chain(text, "ebnf", 0, 14);
    expect(texts[0]).toBe("'a'");
    expect(texts).toContain("( 'a' | B )*");
    expect(texts).toContain("'a' | B");
    expect(texts).toContain("( 'a' | B )* | #x41");
    expect(texts.at(-2)).toBe("Rule ::= ( 'a' | B )* | #x41");
    expectStrictlyNested(texts);
  });

  test("BNF angle names select the whole name including brackets", () => {
    const text = "<expr> ::= <term> | <expr> '+' <term>\n";
    const texts = chain(text, "bnf", 0, 20);
    expect(texts[0]).toBe("<expr>");
    expect(texts).toContain("<expr> '+' <term>");
    expect(texts).toContain("<term> | <expr> '+' <term>");
    expect(texts.at(-2)).toBe("<expr> ::= <term> | <expr> '+' <term>");
    expectStrictlyNested(texts);
  });

  test("RBNF optional and repeat", () => {
    const text = "<a> ::= [ <b> ] <c> ...\n";
    const texts = chain(text, "rbnf", 0, 12);
    expect(texts[0]).toBe("<b>");
    expect(texts).toContain("[ <b> ]");
    expectStrictlyNested(texts);
  });

  test("cursor on the rule name or assignment skips to the definition", () => {
    const text = "[12] Name ::= 'a'\n";
    expect(chain(text, "ebnf", 0, 6)).toEqual([
      "Name",
      "[12] Name ::= 'a'",
      text,
    ]);
    expect(chain(text, "ebnf", 0, 11)).toEqual([
      "::=",
      "[12] Name ::= 'a'",
      text,
    ]);
  });

  test("comments, blank lines and stray text fall back to the document", () => {
    const text = "; note\n\nrule = a\n";
    expect(chain(text, "abnf", 0, 3)).toEqual(["; note", text]);
    expect(chain(text, "abnf", 1, 0)).toEqual([text]);
    expect(chain("/* c */\nA ::= 'x'\n", "ebnf", 0, 3)).toEqual([
      "/* c */",
      "/* c */\nA ::= 'x'\n",
    ]);
  });

  test("whitespace inside a group selects the group content", () => {
    const text = "r = ( a   b )\n";
    const texts = chain(text, "abnf", 0, 8);
    expect(texts[0]).toBe("a   b");
    expect(texts).toContain("( a   b )");
    expectStrictlyNested(texts);
  });

  test("returns one chain per requested position, with CRLF line endings", () => {
    const crlf = "a = b\r\n  / ( c\r\nz = y\r\n";
    const doc = createDocument("/workspace/g.abnf", crlf, "abnf");
    const results = new GrammarSelectionRangeProvider().provideSelectionRanges(
      asTextDocument(doc),
      [new PositionMock(0, 4) as never, new PositionMock(2, 4) as never],
    );
    expect(results).toHaveLength(2);
    const firstTexts: string[] = [];
    for (let r = results[0] as Chained | undefined; r; r = r.parent) {
      firstTexts.push(textOfRange(crlf, r.range));
    }
    expect(firstTexts[0]).toBe("b");
    expect(firstTexts).toContain("a = b\r\n  / ( c");
  });

  test("an unbalanced group still selects outward to the whole rule", () => {
    expect(chain("a = ( b\n", "abnf", 0, 6)).toEqual([
      "b",
      "( b",
      "a = ( b",
      "a = ( b\n",
    ]);
  });

  test("an empty document selects the empty range", () => {
    expect(chain("", "abnf", 0, 0)).toEqual([""]);
    expect(chain("", "ebnf", 5, 9)).toEqual([""]);
  });

  test("a position past the end clamps to the whole document", () => {
    expect(chain("a = b\n", "abnf", 99, 99).at(-1)).toBe("a = b\n");
  });

  test("honours cancellation", () => {
    const doc = createDocument("/workspace/g.abnf", "a = b\n", "abnf");
    const results = new GrammarSelectionRangeProvider().provideSelectionRanges(
      asTextDocument(doc),
      [new PositionMock(0, 4) as never],
      { isCancellationRequested: true } as never,
    );
    expect(results).toEqual([]);
  });
});
