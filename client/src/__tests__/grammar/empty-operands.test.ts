import { beforeAll, describe, expect, test } from "bun:test";
import { grammar, loadCodeActionCore } from "./code-action-test-utils.ts";

const EMPTY_GROUP = "bnf.empty-group";
const NO_OPERAND = "bnf.repetition-no-operand";
const UNCLOSED = "bnf.iso-comment-unclosed";

beforeAll(async () => {
  await loadCodeActionCore();
});

type Dialect = "bnf" | "ebnf" | "rbnf";

function codes(text: string, dialect: Dialect): string[] {
  return grammar
    .parseGrammar(text, dialect)
    .diagnostics.map((d) => String(d.code));
}

describe("empty groups", () => {
  test.each([
    ["ebnf", "a ::= ()\n", "Empty group"],
    ["ebnf", "a ::= x ( ) y\n", "Empty group"],
    ["ebnf", "a ::= {}\n", "Empty repetition"],
    ["bnf", "<a> ::= ()\n", "Empty group"],
    ["bnf", "<a> ::= [ ]\n", "Empty option"],
    ["bnf", "<a> ::= { }\n", "Empty repetition"],
    ["rbnf", "<a> ::= ()\n", "Empty group"],
    ["rbnf", "<a> ::= []\n", "Empty option"],
  ] as const)("%s: %j is reported", (dialect, text, label) => {
    const found = grammar
      .parseGrammar(text, dialect)
      .diagnostics.filter((d) => d.code === EMPTY_GROUP);

    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain(label);
    expect(found[0]?.severity).toBe(0);
  });

  test("the range covers both delimiters", () => {
    const found = grammar
      .parseGrammar("a ::= x ()\n", "ebnf")
      .diagnostics.filter((d) => d.code === EMPTY_GROUP);

    expect(found[0]?.range.start.character).toBe(8);
    expect(found[0]?.range.end.character).toBe(10);
  });

  test.each([
    ["ebnf", "a ::= x |\n"],
    ["ebnf", "a ::= | x\n"],
    ["ebnf", "a ::= ( x | )\n"],
    ["ebnf", "a ::= ( x ) [ y ] { z }\n"],
    ["ebnf", "a ::= ( /* note */ x )\n"],
    ["bnf", "<a> ::= <b> |\n"],
  ] as const)("%s: %j has no empty-group finding", (dialect, text) => {
    expect(codes(text, dialect)).not.toContain(EMPTY_GROUP);
  });
});

describe("empty character classes", () => {
  test.each([
    ["a ::= []\n", "[]"],
    ["a ::= [^]\n", "[^]"],
    ["a ::= x [] y\n", "[]"],
  ])("EBNF %j is reported", (text, shown) => {
    const found = grammar
      .parseGrammar(text, "ebnf")
      .diagnostics.filter((d) => d.code === EMPTY_GROUP);

    expect(found).toHaveLength(1);
    expect(found[0]?.message).toBe(
      `Empty character class: "${shown}" matches no character`,
    );
    expect(found[0]?.severity).toBe(0);
  });

  test.each([
    "a ::= [a]\n",
    "a ::= [^a]\n",
    "a ::= [ ]\n",
    "a ::= [^ ]\n",
    "a ::= [a-z]\n",
    "a ::= [#x20-#x7E]\n",
    "a ::= [\\]]\n",
  ])("EBNF %j is not reported as empty", (text) => {
    expect(codes(text, "ebnf")).not.toContain(EMPTY_GROUP);
  });
});

describe("a stray repeat count", () => {
  test.each([
    ["ebnf", "a ::= *3 x\n"],
    ["bnf", "<a> ::= *3 <x>\n"],
  ] as const)(
    "%s: %j is reported once, as unexpected text",
    (dialect, text) => {
      const all = codes(text, dialect);

      expect(all).toEqual(["bnf.unexpected-text"]);
    },
  );
});

describe("repetition operators with nothing to repeat", () => {
  test.each([
    ["ebnf", "a ::= *\n", "*"],
    ["ebnf", "a ::= ( * )\n", "*"],
    ["ebnf", "a ::= (*)\n", "*"],
    ["ebnf", "a ::= x | +\n", "+"],
    ["ebnf", "a ::= ( ? x )\n", "?"],
    ["bnf", "<a> ::= *\n", "*"],
    ["bnf", "<a> ::= (*)\n", "*"],
    ["rbnf", "<a> ::= ...\n", "..."],
    ["rbnf", "<a> ::= <b> | ...\n", "..."],
    ["rbnf", "<a> ::= *\n", "*"],
    ["rbnf", "<a> ::= (*)\n", "*"],
    ["rbnf", "<a> ::= <b> | *3\n", "*"],
    ["rbnf", "<b> ::= *3\n", "*"],
    ["rbnf", "<a> ::= <b> ( 2* )\n", "*"],
    ["rbnf", "<a> ::= * 3\n", "*"],
    ["rbnf", "<a> ::= <b> 2*\n", "*"],
  ] as const)("%s: %j reports %s", (dialect, text, operator) => {
    const found = grammar
      .parseGrammar(text, dialect)
      .diagnostics.filter((d) => d.code === NO_OPERAND);

    expect(found).toHaveLength(1);
    expect(found[0]?.message).toBe(
      `Repetition operator "${operator}" has nothing to repeat`,
    );
    expect(found[0]?.severity).toBe(0);
  });

  test("(*) is reported as a missing operand, not as an unclosed comment", () => {
    const all = codes("a ::= (*)\n", "ebnf");

    expect(all).toContain(NO_OPERAND);
    expect(all).not.toContain(UNCLOSED);
  });

  test.each([
    ["ebnf", "a ::= x* y+ z?\n"],
    ["ebnf", "a ::= ( x )* ( y )+\n"],
    ["ebnf", "a ::= [ x ]* { y }+\n"],
    ["ebnf", "a ::= x?+\n"],
    ["ebnf", "a ::= x*?\n"],
    ["rbnf", "<a> ::= <b>... <c>\n"],
    ["rbnf", "<a> ::= 2*3 <b>\n"],
    ["rbnf", "<a> ::= *3 <b>\n"],
    ["rbnf", "<a> ::= 2* <b>\n"],
    ["rbnf", "<a> ::= * <b>\n"],
  ] as const)("%s: %j has no missing-operand finding", (dialect, text) => {
    expect(codes(text, dialect)).not.toContain(NO_OPERAND);
  });
});

describe("mismatched closers", () => {
  test.each([
    ["bnf", "<a> ::= x ( ]\n", "(", "]"],
    ["ebnf", "a ::= x ( ]\n", "(", "]"],
    ["rbnf", "<a> ::= <x> ( ]\n", "(", "]"],
    ["ebnf", "a ::= x { )\n", "{", ")"],
  ] as const)(
    "%s: %j reports the opener and the closer",
    (dialect, text, opener, closer) => {
      const messages = grammar
        .parseGrammar(text, dialect)
        .diagnostics.filter((d) => d.code === "bnf.unbalanced-delimiter")
        .map((d) => d.message);

      expect(messages).toEqual([
        `Closing delimiter "${closer}" has no matching opener`,
        `Opening delimiter "${opener}" has no matching closer`,
      ]);
    },
  );

  test("a balanced nest reports nothing", () => {
    expect(codes("a ::= ( [ { x } ] )\n", "ebnf")).toEqual([]);
  });

  test.each([
    ["a = x ( ]\n", "abnf.unclosed-group"],
    ["a = x [ )\n", "abnf.unclosed-option"],
  ])("abnf: %j reports the unclosed opener", (text, code) => {
    expect(
      grammar.parseGrammar(text, "abnf").diagnostics.map((d) => d.code),
    ).toContain(code);
  });
});

describe("empty character class hint", () => {
  test("[]] suggests #x5D for the literal bracket", () => {
    const found = grammar
      .parseGrammar("a ::= []]\n", "ebnf")
      .diagnostics.filter((d) => d.code === EMPTY_GROUP);

    expect(found).toHaveLength(1);
    expect(found[0]?.message).toBe(
      'Empty character class: "[]" matches no character; write "]" as #x5D',
    );
  });

  test("a plain [] has no hint", () => {
    const found = grammar
      .parseGrammar("a ::= []\n", "ebnf")
      .diagnostics.filter((d) => d.code === EMPTY_GROUP);

    expect(found[0]?.message).toBe(
      'Empty character class: "[]" matches no character',
    );
  });
});

describe("unclosed ISO openers are reported once", () => {
  test("a (* in column 0 gets only the unclosed-comment finding", () => {
    const all = codes("(* top\n", "ebnf");

    expect(all).toEqual([UNCLOSED]);
  });

  test("a (* in column 0 after a production does not suggest adding ::=", () => {
    const diagnostics = grammar.parseGrammar(
      "a ::= x\n(* c\n",
      "ebnf",
    ).diagnostics;

    expect(diagnostics.map((d) => d.code)).toEqual([UNCLOSED]);
    expect(diagnostics.some((d) => d.message.includes('add "::="'))).toBe(
      false,
    );
  });

  test("other column 0 text is still reported", () => {
    const all = codes("a ::= x\nfoo\n", "ebnf");

    expect(all).toContain("bnf.unindented-continuation");
  });
});
