import { beforeAll, describe, expect, test } from "bun:test";
import { CodeActionKindMock } from "../vscode-mock.ts";
import { loadGrammarTestCore } from "./provider-test-utils.ts";
import {
  inlineResult,
  type RefactorSetup,
  setupRefactor,
} from "./refactor-test-utils.ts";

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
type Refusal = [name: string, dialect: Dialect, text: string, cursorAt: string];

function setup(
  text: string,
  dialect: Dialect,
  extra: Array<{ path: string; text: string; dialect: Dialect }> = [],
): RefactorSetup {
  return setupRefactor(GrammarRefactorProvider as never, text, dialect, extra);
}

function inline(
  text: string,
  dialect: Dialect,
  cursorAt: string,
  nth = 0,
  offset = 0,
): string | undefined {
  return inlineResult(setup(text, dialect), cursorAt, nth, offset);
}

function inlineActions(s: RefactorSetup, from: number, to = from) {
  return s.provide(from, to, new CodeActionKindMock("refactor.inline"));
}

describe("inline rule: one reference", () => {
  test.each<Inlining>([
    [
      "a sequence into a sequence, keeping the definition",
      "abnf",
      "a = b c\nb = x y\n",
      "b c",
      "a = x y c\nb = x y\n",
    ],
    ["a single term", "abnf", "a = b c\nb = x\n", "b c", "a = x c\nb = x\n"],
    [
      "the text after the reference on the same line",
      "abnf",
      "a = b ; keep\nb = x\n",
      "b ;",
      "a = x ; keep\nb = x\n",
    ],
  ])("inlines %s", (_name, dialect, text, cursorAt, resultText) => {
    const result = inline(text, dialect, cursorAt);

    expect(result).toBe(resultText);
  });

  test.each([0, 1, 3])(
    "inlines with the cursor %p characters into the reference",
    (offset) => {
      const result = inline(
        "a = long c\nlong = x\n",
        "abnf",
        "long c",
        0,
        offset,
      );

      expect(result).toBe("a = x c\nlong = x\n");
    },
  );

  test.each([
    ["a selection inside the reference", 1, 3, 1],
    ["a selection covering the reference", 0, 4, 1],
    ["a selection extending past the reference", 0, 6, 0],
  ])("%s offers %p inline action(s)", (_name, start, end, count) => {
    const s = setup("a = long c\nlong = x\n", "abnf");
    const from = s.at("long c");

    const actions = inlineActions(s, from + start, from + end);

    expect(actions).toHaveLength(count);
  });

  test.each([
    ["first", 0, "a = x b\nb = x\n"],
    ["second", 1, "a = b x\nb = x\n"],
  ])("inlines only the %s of two references", (_name, nth, resultText) => {
    const result = inline("a = b b\nb = x\n", "abnf", "b", nth);

    expect(result).toBe(resultText);
  });

  test.each([
    ["another reference", "c", 0],
    ["the operator", "=", 0],
    ["the body of the definition", "x", 0],
  ])("is not offered on %s", (_name, cursorAt, nth) => {
    const result = inline("a = b c\nb = x\n", "abnf", cursorAt, nth);

    expect(result).toBeUndefined();
  });

  test("is not offered for an undefined reference", () => {
    const result = inline("a = nope\n", "abnf", "nope");

    expect(result).toBeUndefined();
  });

  test("titles the action with the rule name", () => {
    const s = setup("a = b\nb = x\n", "abnf");

    const [action] = inlineActions(s, s.at("b\n"));

    expect(action?.title).toBe('Inline rule "b" here');
    expect(action?.kind.value).toBe("refactor.inline");
  });
});

describe("inline rule: precedence", () => {
  test.each<Inlining>([
    [
      "an alternation before a sequence item, which is grouped",
      "abnf",
      "a = b c\nb = x / y\n",
      "b c",
      "a = (x / y) c\nb = x / y\n",
    ],
    [
      "an alternation after a sequence item, which is grouped",
      "abnf",
      "a = c b\nb = x / y\n",
      "b\n",
      "a = c (x / y)\nb = x / y\n",
    ],
    [
      "an alternation as the first alternative, which is not grouped",
      "abnf",
      "a = b / c\nb = x / y\n",
      "b /",
      "a = x / y / c\nb = x / y\n",
    ],
    [
      "an alternation as the last alternative, which is not grouped",
      "abnf",
      "a = c / b\nb = x / y\n",
      "b\n",
      "a = c / x / y\nb = x / y\n",
    ],
    [
      "an alternation as the whole body, which is not grouped",
      "abnf",
      "a = b\nb = x / y\n",
      "b\n",
      "a = x / y\nb = x / y\n",
    ],
    [
      "an alternation inside parentheses, which is not grouped again",
      "abnf",
      "a = (b) c\nb = x / y\n",
      "b)",
      "a = (x / y) c\nb = x / y\n",
    ],
    [
      "an alternation inside brackets, which is not grouped again",
      "abnf",
      "a = [b]\nb = x / y\n",
      "b]",
      "a = [x / y]\nb = x / y\n",
    ],
    [
      "a sequence inside a sequence, which is not grouped",
      "abnf",
      "a = c b d\nb = x y\n",
      "b d",
      "a = c x y d\nb = x y\n",
    ],
    [
      "a sequence inside an alternation, which is not grouped",
      "abnf",
      "a = c / b / d\nb = x y\n",
      "b /",
      "a = c / x y / d\nb = x y\n",
    ],
  ])("inlines %s", (_name, dialect, text, cursorAt, resultText) => {
    const result = inline(text, dialect, cursorAt);

    expect(result).toBe(resultText);
  });

  test.each<Inlining>([
    [
      "a sequence under an ABNF repeat",
      "abnf",
      "a = 2*b\nb = x y\n",
      "b\n",
      "a = 2*(x y)\nb = x y\n",
    ],
    [
      "an alternation under an ABNF star",
      "abnf",
      "a = *b\nb = x / y\n",
      "b\n",
      "a = *(x / y)\nb = x / y\n",
    ],
    [
      "a sequence under an EBNF star",
      "ebnf",
      "a ::= b*\nb ::= x y\n",
      "b*",
      "a ::= (x y)*\nb ::= x y\n",
    ],
    [
      "an alternation under an EBNF question mark",
      "ebnf",
      "a ::= b? c\nb ::= x | y\n",
      "b?",
      "a ::= (x | y)? c\nb ::= x | y\n",
    ],
    [
      "an already repeated body under an ABNF repeat",
      "abnf",
      "a = 2*b\nb = 3x\n",
      "b\n",
      "a = 2*(3x)\nb = 3x\n",
    ],
    [
      "an already repeated body under an EBNF star",
      "ebnf",
      "a ::= b*\nb ::= x+\n",
      "b*",
      "a ::= (x+)*\nb ::= x+\n",
    ],
  ])("groups %s", (_name, dialect, text, cursorAt, resultText) => {
    const result = inline(text, dialect, cursorAt);

    expect(result).toBe(resultText);
  });

  test.each<Inlining>([
    [
      "a single term under a repeat",
      "abnf",
      "a = 2*b\nb = x\n",
      "b\n",
      "a = 2*x\nb = x\n",
    ],
    [
      "a parenthesised body under a repeat",
      "abnf",
      "a = 2*b\nb = (x y)\n",
      "b\n",
      "a = 2*(x y)\nb = (x y)\n",
    ],
    [
      "a character class under a plus",
      "ebnf",
      "a ::= b+\nb ::= [x-z]\n",
      "b+",
      "a ::= [x-z]+\nb ::= [x-z]\n",
    ],
    [
      "a term as an exclusion operand",
      "ebnf",
      "a ::= b - c\nb ::= x\n",
      "b -",
      "a ::= x - c\nb ::= x\n",
    ],
    [
      "a repeated body next to another item",
      "ebnf",
      "a ::= b c\nb ::= x+\n",
      "b c",
      "a ::= x+ c\nb ::= x+\n",
    ],
    [
      "an exclusion as the whole body",
      "ebnf",
      "a ::= b\nb ::= x - y\n",
      "b\n",
      "a ::= x - y\nb ::= x - y\n",
    ],
  ])("does not group %s", (_name, dialect, text, cursorAt, resultText) => {
    const result = inline(text, dialect, cursorAt);

    expect(result).toBe(resultText);
  });

  test.each<Inlining>([
    [
      "a sequence on the left of an exclusion",
      "ebnf",
      "a ::= b - c\nb ::= x y\n",
      "b -",
      "a ::= (x y) - c\nb ::= x y\n",
    ],
    [
      "an alternation on the right of an exclusion",
      "ebnf",
      "a ::= c - b\nb ::= x | y\n",
      "b\n",
      "a ::= c - (x | y)\nb ::= x | y\n",
    ],
    [
      "an exclusion next to another item",
      "ebnf",
      "a ::= b c\nb ::= x - y\n",
      "b c",
      "a ::= (x - y) c\nb ::= x - y\n",
    ],
    [
      "an alternation in RBNF",
      "rbnf",
      "<a> ::= <b> <c>\n<b> ::= 'x' | 'y'\n",
      "<b>",
      "<a> ::= ('x' | 'y') <c>\n<b> ::= 'x' | 'y'\n",
    ],
  ])(
    "groups %s with parentheses",
    (_name, dialect, text, cursorAt, resultText) => {
      const result = inline(text, dialect, cursorAt);

      expect(result).toBe(resultText);
    },
  );
});

describe("inline rule: BNF has no grouping", () => {
  test.each<Inlining>([
    [
      "a multi-alternative body as the first alternative",
      "bnf",
      "<a> ::= <b> | <c>\n<b> ::= x | y\n",
      "<b>",
      "<a> ::= x | y | <c>\n<b> ::= x | y\n",
    ],
    [
      "a multi-alternative body as the last alternative",
      "bnf",
      "<a> ::= <c> | <b>\n<b> ::= x | y\n",
      "<b>",
      "<a> ::= <c> | x | y\n<b> ::= x | y\n",
    ],
    [
      "a multi-alternative body as the whole rule",
      "bnf",
      "<a> ::= <b>\n<b> ::= x | y\n",
      "<b>",
      "<a> ::= x | y\n<b> ::= x | y\n",
    ],
    [
      "a sequence into a sequence",
      "bnf",
      "<a> ::= <c> <b> <d>\n<b> ::= x y\n",
      "<b>",
      "<a> ::= <c> x y <d>\n<b> ::= x y\n",
    ],
  ])("inlines %s", (_name, dialect, text, cursorAt, resultText) => {
    const result = inline(text, dialect, cursorAt);

    expect(result).toBe(resultText);
  });

  test("is not offered for a multi-alternative body inside a sequence", () => {
    const result = inline("<a> ::= <b> <c>\n<b> ::= x | y\n", "bnf", "<b>");

    expect(result).toBeUndefined();
  });

  test("does not offer inline-all when one reference needs grouping", () => {
    const text = "<a> ::= <b> | <c>\n<d> ::= <b> <c>\n<b> ::= x | y\n";
    const s = setup(text, "bnf");

    const actions = s.provide(s.at("<b> ::="), s.at("<b> ::=") + 1);

    expect(actions).toEqual([]);
  });
});

describe("inline rule: from the definition", () => {
  test.each<Inlining>([
    [
      "every reference and removes the definition",
      "abnf",
      "a = b c\nd = b\nb = x y\n",
      "b = x",
      "a = x y c\nd = x y\n",
    ],
    [
      "each reference with the grouping its own context requires",
      "abnf",
      "a = b c\nd = b / c\ne = 2*b\nb = x / y\n",
      "b = x",
      "a = (x / y) c\nd = x / y / c\ne = 2*(x / y)\n",
    ],
    [
      "references written in a different case in ABNF",
      "abnf",
      "Rule = B c\nother = b\nb = x\n",
      "b = x",
      "Rule = x c\nother = x\n",
    ],
    [
      "a definition written in a different case in ABNF",
      "abnf",
      "Rule = x\nb = RULE y\n",
      "Rule =",
      "b = x y\n",
    ],
    [
      "several references within one rule",
      "abnf",
      "a = b b b\nb = x\n",
      "b = x",
      "a = x x x\n",
    ],
    [
      "into a rule with =/ parts",
      "abnf",
      "a = x\na =/ b\nb = y z\n",
      "b = y",
      "a = x\na =/ y z\n",
    ],
    ["in EBNF", "ebnf", "a ::= b c\nb ::= x\n", "b ::=", "a ::= x c\n"],
    ["in BNF", "bnf", "<a> ::= <b>\n<b> ::= x\n", "<b> ::=", "<a> ::= x\n"],
    [
      "in RBNF",
      "rbnf",
      "<a> ::= <b> y\n<b> ::= 'x'\n",
      "<b> ::=",
      "<a> ::= 'x' y\n",
    ],
    [
      "only references of the same case in EBNF",
      "ebnf",
      "a ::= B b\nb ::= x\nB ::= y\n",
      "b ::=",
      "a ::= B x\nB ::= y\n",
    ],
    [
      "only angle-bracket references of the same name in BNF",
      "bnf",
      "<a> ::= <b> b\n<b> ::= x\nb ::= y\n",
      "<b> ::=",
      "<a> ::= x b\nb ::= y\n",
    ],
  ])("inlines %s", (_name, dialect, text, cursorAt, resultText) => {
    const result = inline(text, dialect, cursorAt);

    expect(result).toBe(resultText);
  });

  test.each([
    ["a rule without references", "a = x\nb = y\n", "b = y"],
    ["the cursor on the operator side", "a = b\nb = x\n", "= x"],
    ["the cursor in the body", "a = b\nb = x y\n", "y"],
  ])("is not offered for %s", (_name, text, cursorAt) => {
    const result = inline(text, "abnf", cursorAt);

    expect(result).toBeUndefined();
  });

  test("is not offered when the rule shares its line with another rule", () => {
    const result = inline("a ::= b b ::= x\n", "ebnf", "b ::=");

    expect(result).toBeUndefined();
  });

  test.each([
    [
      "two references",
      "a = b c\nd = b\nb = x y\n",
      'Inline rule "b" (2 references)',
    ],
    ["one reference", "a = b\nb = x\n", 'Inline rule "b" (1 reference)'],
  ])("titles the action with the count for %s", (_name, text, title) => {
    const s = setup(text, "abnf");
    const from = s.at("b = x");

    const [action] = s.provide(from, from);

    expect(action?.title).toBe(title);
  });

  test("offers no inline action for a non-empty selection starting at the definition", () => {
    const s = setup("a = b c\nd = b\nb = x y\n", "abnf");

    const actions = s.select("b = x");

    expect(actions[0]).toBeUndefined();
  });
});

describe("inline rule: refused targets", () => {
  test.each<Refusal>([
    ["a self-recursive reference", "abnf", "a = b\nb = x b\n", "b\n"],
    ["a self-recursive definition", "abnf", "a = b\nb = x b\n", "b = x"],
    [
      "a self-recursive EBNF definition",
      "ebnf",
      "b ::= x b?\na ::= b\n",
      "b ::=",
    ],
    [
      "a mutually recursive reference",
      "abnf",
      "a = b\nb = c\nc = b x\n",
      "b\n",
    ],
    [
      "a mutually recursive definition",
      "abnf",
      "a = b\nb = c\nc = b x\n",
      "b = c",
    ],
    [
      "the other definition in a cycle",
      "abnf",
      "a = b\nb = c\nc = b x\n",
      "c = b",
    ],
    ["a reference inside a cycle", "abnf", "a = b\nb = c\nc = b x\n", "c\n"],
    [
      "a reference to a rule with =/ parts",
      "abnf",
      "a = b\nb = x\nb =/ y\n",
      "b\n",
    ],
    [
      "a base definition with =/ parts",
      "abnf",
      "a = b\nb = x\nb =/ y\n",
      "b = x",
    ],
    ["an =/ part itself", "abnf", "a = b\nb = x\nb =/ y\n", "b =/"],
    [
      "a reference to a rule with several definitions",
      "ebnf",
      "a ::= b\nb ::= x\nb ::= y\n",
      "b\n",
    ],
    [
      "a definition that has duplicates",
      "ebnf",
      "a ::= b\nb ::= x\nb ::= y\n",
      "b ::= x",
    ],
    ["a core rule reference", "abnf", "a = DIGIT b\nb = x\n", "DIGIT"],
    ["a lowercase core rule reference", "abnf", "a = digit\n", "digit"],
    [
      "a redefined core rule",
      "abnf",
      "a = DIGIT\nDIGIT = %x30-39\n",
      "DIGIT =",
    ],
    ["a target with an unclosed group", "abnf", "a = b\nb = (x\n", "b\n"],
    ["a target with a dangling alternative", "abnf", "a = b\nb = x /\n", "b\n"],
    ["a target with an unterminated string", "abnf", 'a = b\nb = "x\n', "b\n"],
    [
      "a target with an unmatched closer",
      "ebnf",
      "a ::= b\nb ::= x )\n",
      "b\n",
    ],
    ["a target with no body", "ebnf", "a ::= b\nb ::=\n", "b\n"],
    ["a host with an unclosed group", "abnf", "a = (b\nb = x\n", "b\n"],
    ["a host with an unmatched closer", "ebnf", "a ::= b )\nb ::= x\n", "b )"],
    [
      "a definition whose only reference is in a rule with errors",
      "ebnf",
      "a ::= b )\nd ::= b\nb ::= x\n",
      "b ::=",
    ],
    [
      "a target with an annotation",
      "ebnf",
      "a ::= b\nb ::= x [ wfc: No ]\n",
      "b\n",
    ],
    [
      "a target with a validity constraint annotation",
      "ebnf",
      "a ::= b\nb ::= x [ vc: No ]\n",
      "b\n",
    ],
  ])("is not offered for %s", (_name, dialect, text, cursorAt) => {
    const result = inline(text, dialect, cursorAt);

    expect(result).toBeUndefined();
  });

  test("still inlines a rule that only calls into a cycle", () => {
    const result = inline("a = b\nb = c\nc = c x\n", "abnf", "b\n");

    expect(result).toBe("a = c\nb = c\nc = c x\n");
  });

  test("is not blocked by an error in an unrelated rule", () => {
    const result = inline("bad = (\na = b\nb = x\n", "abnf", "b\n");

    expect(result).toBe("bad = (\na = x\nb = x\n");
  });

  test.each([
    ["refactor.extract", 0],
    ["quickfix", 0],
    ["refactor.inline", 1],
    ["refactor", 1],
  ])("offers %s actions: %p", (kind, count) => {
    const s = setup("a = b\nb = x\n", "abnf");
    const from = s.at("b\n");

    const actions = s.provide(from, from, new CodeActionKindMock(kind));

    expect(actions).toHaveLength(count);
  });
});

describe("inline rule: references in other files", () => {
  test("says in the title that other files keep their references", () => {
    const s = setup("a = b\nb = x\n", "abnf", [
      { path: "/workspace/other.abnf", text: "z = b\n", dialect: "abnf" },
    ]);
    const from = s.at("b = x");

    const [action] = s.provide(from, from);

    expect(action?.title).toBe(
      'Inline rule "b" (1 reference; references in other files are left alone)',
    );
  });

  test("leaves references in other files untouched", () => {
    const s = setup("a = b\nb = x\n", "abnf", [
      { path: "/workspace/other.abnf", text: "z = b\n", dialect: "abnf" },
    ]);
    const from = s.at("b = x");
    const [action] = s.provide(from, from);

    const result = s.apply(action as never);

    expect(result).toBe("a = x\n");
  });

  test("does not mention files that reference their own definition of the name", () => {
    const s = setup("a = b\nb = x\n", "abnf", [
      {
        path: "/workspace/other.abnf",
        text: "q = b\nb = z\n",
        dialect: "abnf",
      },
    ]);
    const from = s.at("b = x");

    const [action] = s.provide(from, from);

    expect(action?.title).toBe('Inline rule "b" (1 reference)');
  });

  test("ignores references in files of other dialects", () => {
    const s = setup("a = b\nb = x\n", "abnf", [
      { path: "/workspace/other.ebnf", text: "z ::= b\n", dialect: "ebnf" },
    ]);
    const from = s.at("b = x");

    const [action] = s.provide(from, from);

    expect(action?.title).toBe('Inline rule "b" (1 reference)');
  });
});
