import { beforeAll, describe, expect, test } from "bun:test";
import { loadGrammarTestCore } from "./provider-test-utils.ts";
import { inlineResult, setupRefactor } from "./refactor-test-utils.ts";

let GrammarRefactorProvider: typeof import("../../grammar/refactors/index.ts").GrammarRefactorProvider;

beforeAll(async () => {
  await loadGrammarTestCore();
  ({ GrammarRefactorProvider } = await import(
    "../../grammar/refactors/index.ts"
  ));
});

type Dialect = "abnf" | "bnf" | "ebnf" | "rbnf";
type Inlining = [
  name: string,
  dialect: Dialect,
  text: string,
  cursorAt: string,
  resultText: string,
];

function inline(
  text: string,
  dialect: Dialect,
  cursorAt: string,
): string | undefined {
  const s = setupRefactor(GrammarRefactorProvider as never, text, dialect);
  return inlineResult(s, cursorAt);
}

describe("inline rule: removing the definition", () => {
  test.each<Inlining>([
    [
      "the ABNF comment directly above the rule is kept",
      "abnf",
      "a = b\n; the b rule\nb = x\n",
      "b = x",
      "a = x\n; the b rule\n",
    ],
    [
      "the EBNF comment directly above the rule is kept",
      "ebnf",
      "a ::= b\n/* the b rule */\nb ::= x\n",
      "b ::=",
      "a ::= x\n/* the b rule */\n",
    ],
    [
      "a header comment at the top of the file is kept",
      "abnf",
      "; head\nb = x a\n\ny = b\n",
      "b = x a",
      "; head\n\ny = x a\n",
    ],
    [
      "a comment separated by a blank line is kept",
      "abnf",
      "a = b\n\n; section\n\nb = x\n",
      "b = x",
      "a = x\n\n; section\n",
    ],
    [
      "the trailing comment of the previous rule is kept",
      "abnf",
      "a = b ; about a\nb = x\n",
      "b = x",
      "a = x ; about a\n",
    ],
    [
      "an indented comment of the previous rule is kept",
      "abnf",
      "a = b\n    ; continuation note\nb = x\n",
      "b = x",
      "a = x\n    ; continuation note\n",
    ],
    [
      "blank lines on both sides collapse to one",
      "abnf",
      "a = b\n\nb = x\n\nc = y\n",
      "b = x",
      "a = x\n\nc = y\n",
    ],
    [
      "a blank line before the rule is kept as a separator",
      "abnf",
      "a = b\nb = x\n\nc = y\n",
      "b = x",
      "a = x\n\nc = y\n",
    ],
    [
      "a blank line after the rule is kept as a separator",
      "abnf",
      "a = b\n\nb = x\nc = y\n",
      "b = x",
      "a = x\n\nc = y\n",
    ],
    [
      "a leading rule leaves no blank line",
      "abnf",
      "b = x\n\na = b\n",
      "b = x",
      "a = x\n",
    ],
    [
      "the last rule leaves no trailing blank line",
      "abnf",
      "a = b\n\nb = x\n",
      "b = x",
      "a = x\n",
    ],
    [
      "the last rule of a file without a trailing newline",
      "abnf",
      "a = b\nb = x",
      "b = x",
      "a = x",
    ],
    [
      "all lines of a multi-line rule with comments",
      "abnf",
      "a = b\n\nb = x ; one\n    y ; two\n    ; three\n\nc = z\n",
      "b = x",
      "a = x y\n\n; one\n; two\n; three\n\nc = z\n",
    ],
    [
      "a trailing comment of the definition stays as a comment line",
      "abnf",
      "a = b\nb = x ; why x\n",
      "b = x",
      "a = x\n; why x\n",
    ],
    [
      "a trailing block comment of the definition stays as a comment line",
      "ebnf",
      "a ::= b\nb ::= x /* why */\n",
      "b ::=",
      "a ::= x\n/* why */\n",
    ],
    [
      "a leftover comment is kept apart from the next rule by a blank line",
      "abnf",
      "a = b\n\n; doc b\nb = x ; why x\n; doc c\nc = y\n",
      "b = x",
      "a = x\n\n; doc b\n; why x\n\n; doc c\nc = y\n",
    ],
    [
      "an orphaned doc comment stays apart from the next rule",
      "abnf",
      "a = b\n\n; doc b\nb = x\n; doc c\nc = y\n",
      "b = x",
      "a = x\n\n; doc b\n; doc c\nc = y\n",
    ],
    [
      "CRLF line endings are preserved",
      "abnf",
      "a = b\r\n\r\nb = x ; one\r\n    y\r\n\r\nc = z\r\n",
      "b = x",
      "a = x y\r\n\r\n; one\r\n\r\nc = z\r\n",
    ],
    [
      "CRLF line endings are preserved in EBNF with a multi-line body",
      "ebnf",
      "a ::= b\r\nb ::= x\r\n  | y\r\n",
      "b ::=",
      "a ::= x\r\n  | y\r\n",
    ],
  ])(
    "when inlining from the definition, %s",
    (_name, dialect, text, cursorAt, resultText) => {
      const result = inline(text, dialect, cursorAt);

      expect(result).toBe(resultText);
    },
  );
});

describe("inline rule: comments and layout in the body", () => {
  test.each<Inlining>([
    [
      "comments inside a multi-line body stay with the definition",
      "abnf",
      "a = c b\nb = x ; one\n    y\n",
      "b\n",
      "a = c x y\nb = x ; one\n    y\n",
    ],
    [
      "comments before the first and after the last token stay as comment lines",
      "abnf",
      "a = b\nb = ; lead\n    x y ; tail\n",
      "b = ;",
      "a = x y\n; lead\n; tail\n",
    ],
    [
      "block comments inside the body stay with the definition",
      "ebnf",
      "a ::= b c\nb ::= x /* hi */ y\n",
      "b c",
      "a ::= x y c\nb ::= x /* hi */ y\n",
    ],
    [
      "a block comment between tokens never joins them",
      "ebnf",
      "a ::= b\nb ::= x/* hi */y\n",
      "b\n",
      "a ::= x y\nb ::= x/* hi */y\n",
    ],
    [
      "CRLF line endings are preserved when inlining a single reference",
      "abnf",
      "a = c b\r\nb = x\r\n",
      "b\r\nb =",
      "a = c x\r\nb = x\r\n",
    ],
  ])("%s", (_name, dialect, text, cursorAt, resultText) => {
    const result = inline(text, dialect, cursorAt);

    expect(result).toBe(resultText);
  });
});

describe("inline rule: inlined text carries no comments", () => {
  test.each<Inlining>([
    [
      "ABNF: both references lose the comment, one comment line stays",
      "abnf",
      "a = b c b\nb = x ; why\n    / y\nc = z\n",
      "b = x",
      "a = (x / y) c (x / y)\n; why\n\nc = z\n",
    ],
    [
      "BNF: a line comment between alternatives",
      "bnf",
      "<a> ::= <b>\n<b> ::= x ; why\n  | y\n",
      "<b> ::=",
      "<a> ::= x | y\n; why\n",
    ],
    [
      "EBNF: block comments inside the body",
      "ebnf",
      "a ::= b c b\nb ::= x /* one */ | y /* two */\nc ::= z\n",
      "b ::=",
      "a ::= (x | y) c (x | y)\n/* one */\n/* two */\n\nc ::= z\n",
    ],
    [
      "RBNF: a line comment inside the body",
      "rbnf",
      "<a> ::= <b> <c>\n<b> ::= x ; why\n  <d>\n<c> ::= z\n<d> ::= w\n",
      "<b> ::=",
      "<a> ::= x <d> <c>\n; why\n\n<c> ::= z\n<d> ::= w\n",
    ],
    [
      "ABNF: a comment on the last rule keeps the file without a final newline",
      "abnf",
      "a = b\nb = x ; why",
      "b = x",
      "a = x\n; why",
    ],
    [
      "ABNF: a comment on the last rule keeps the final newline",
      "abnf",
      "a = b\nb = x ; why\n",
      "b = x",
      "a = x\n; why\n",
    ],
  ])("%s", (_name, dialect, text, cursorAt, resultText) => {
    const result = inline(text, dialect, cursorAt);

    expect(result).toBe(resultText);
  });

  test("a single reference gets the body without its comments", () => {
    const text = "a = c b\nb = x ; why\n    / y\n";

    const result = inline(text, "abnf", "b\n");

    expect(result).toBe("a = c (x / y)\nb = x ; why\n    / y\n");
  });
});
