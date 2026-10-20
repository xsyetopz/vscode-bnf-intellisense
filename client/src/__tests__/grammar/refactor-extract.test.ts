import { beforeAll, describe, expect, test } from "bun:test";
import { CodeActionKindMock, type PositionMock } from "../vscode-mock.ts";
import { loadGrammarTestCore } from "./provider-test-utils.ts";
import { type RefactorSetup, setupRefactor } from "./refactor-test-utils.ts";

let GrammarRefactorProvider: typeof import("../../grammar/refactors/index.ts").GrammarRefactorProvider;

beforeAll(async () => {
  await loadGrammarTestCore();
  ({ GrammarRefactorProvider } = await import(
    "../../grammar/refactors/index.ts"
  ));
});

type Dialect = "abnf" | "bnf" | "ebnf" | "rbnf";
type Extraction = [
  name: string,
  dialect: Dialect,
  text: string,
  selection: string,
  resultText: string,
];
type Refusal = [
  name: string,
  dialect: Dialect,
  text: string,
  selection: string,
];

function setup(text: string, dialect: Dialect): RefactorSetup {
  return setupRefactor(GrammarRefactorProvider as never, text, dialect);
}

function extract(
  text: string,
  dialect: Dialect,
  selection: string,
): string | undefined {
  const s = setup(text, dialect);
  const action = s
    .select(selection)
    .find((entry) => entry.kind.value === "refactor.extract");
  return action ? s.apply(action) : undefined;
}

describe("extract rule: what gets extracted", () => {
  test.each<Extraction>([
    [
      "a run of sequence items",
      "abnf",
      "r = a b c d\n",
      "b c",
      "r = a new-rule d\nnew-rule = b c\n",
    ],
    [
      "a single item",
      "abnf",
      "r = a b c\n",
      "b",
      "r = a new-rule c\nnew-rule = b\n",
    ],
    [
      "leading alternatives",
      "abnf",
      "r = a / b / c\n",
      "a / b",
      "r = new-rule / c\nnew-rule = a / b\n",
    ],
    [
      "trailing alternatives",
      "abnf",
      "r = a / b c / d\n",
      "b c / d",
      "r = a / new-rule\nnew-rule = b c / d\n",
    ],
    [
      "one alternative that is a sequence",
      "abnf",
      "r = a / b c / d\n",
      "b c",
      "r = a / new-rule / d\nnew-rule = b c\n",
    ],
    [
      "the whole body",
      "abnf",
      "r = a / b\n",
      "a / b",
      "r = new-rule\nnew-rule = a / b\n",
    ],
    [
      "the content of a group",
      "abnf",
      "r = (a b) c\n",
      "a b",
      "r = (new-rule) c\nnew-rule = a b\n",
    ],
    [
      "a whole group",
      "abnf",
      "r = (a b) c\n",
      "(a b)",
      "r = new-rule c\nnew-rule = (a b)\n",
    ],
    [
      "the content of an optional",
      "abnf",
      "r = [a / b] c\n",
      "a / b",
      "r = [new-rule] c\nnew-rule = a / b\n",
    ],
    [
      "a selection padded with whitespace, which is trimmed",
      "abnf",
      "r = a  b  c\n",
      "  b  ",
      "r = a  new-rule  c\nnew-rule = b\n",
    ],
    [
      "a sequence in EBNF",
      "ebnf",
      "r ::= a b c\n",
      "a b",
      "r ::= new-rule c\nnew-rule ::= a b\n",
    ],
    [
      "alternatives in EBNF",
      "ebnf",
      "r ::= a | b\n",
      "a | b",
      "r ::= new-rule\nnew-rule ::= a | b\n",
    ],
    [
      "a sequence in BNF",
      "bnf",
      "<r> ::= <a> <b> <c>\n",
      "<b> <c>",
      "<r> ::= <a> <new-rule>\n<new-rule> ::= <b> <c>\n",
    ],
    [
      "alternatives in RBNF",
      "rbnf",
      "<r> ::= <a> | <b>\n",
      "<a> | <b>",
      "<r> ::= <new-rule>\n<new-rule> ::= <a> | <b>\n",
    ],
    [
      "bare BNF names, which get a bare new name",
      "bnf",
      "r ::= a b\n",
      "a b",
      "r ::= new-rule\nnew-rule ::= a b\n",
    ],
    [
      "a terminal in RBNF, which gets an angle-bracket name",
      "rbnf",
      "<r> ::= <a> <b> 'x'\n",
      "'x'",
      "<r> ::= <a> <b> <new-rule>\n<new-rule> ::= 'x'\n",
    ],
    [
      "an operand together with its repeat count",
      "abnf",
      "r = 2*DIGIT x\n",
      "2*DIGIT",
      "r = new-rule x\nnew-rule = 2*DIGIT\n",
    ],
    [
      "an operand together with its star",
      "ebnf",
      "r ::= a* b\n",
      "a*",
      "r ::= new-rule b\nnew-rule ::= a*\n",
    ],
    [
      "a group together with its plus",
      "ebnf",
      "r ::= (a b)+ c\n",
      "(a b)+",
      "r ::= new-rule c\nnew-rule ::= (a b)+\n",
    ],
    [
      "a complete exclusion",
      "ebnf",
      "r ::= a - b c\n",
      "a - b",
      "r ::= new-rule c\nnew-rule ::= a - b\n",
    ],
    [
      "text before an annotation",
      "ebnf",
      "r ::= a b [ wfc: Nope ]\n",
      "a b",
      "r ::= new-rule [ wfc: Nope ]\nnew-rule ::= a b\n",
    ],
    [
      "a rule next to a rule with errors",
      "abnf",
      "bad = (a\ngood = x y\n",
      "x y",
      "bad = (a\ngood = new-rule\nnew-rule = x y\n",
    ],
  ])("extracts %s", (_name, dialect, text, selection, resultText) => {
    const result = extract(text, dialect, selection);

    expect(result).toBe(resultText);
  });
});

describe("extract rule: selecting whole alternative lines", () => {
  const dialects: [Dialect, string, string, string][] = [
    ["abnf", "/", "r", "="],
    ["bnf", "|", "<r>", "::="],
    ["ebnf", "|", "r", "::="],
    ["rbnf", "|", "<r>", "::="],
  ];
  const wrap = (dialect: Dialect, name: string): string =>
    dialect === "bnf" || dialect === "rbnf" ? `<${name}>` : name;

  test.each(dialects)(
    "a line starting with the separator extracts its alternative in %s",
    (dialect, sep, rule, op) => {
      const [a, b, c, d] = ["a", "b", "c", "d"].map((n) => wrap(dialect, n));
      const text = `${rule} ${op} ${a}\n    ${sep} ${b} ${c}\n    ${sep} ${d}\n`;
      const added = wrap(dialect, "new-rule");

      const result = extract(text, dialect, `    ${sep} ${b} ${c}\n`);

      expect(result).toBe(
        `${rule} ${op} ${a}\n    ${sep} ${added}\n    ${sep} ${d}\n${added} ${op} ${b} ${c}\n`,
      );
    },
  );

  test.each(dialects)(
    "a line ending with the separator extracts its alternative in %s",
    (dialect, sep, rule, op) => {
      const [a, b, c, d] = ["a", "b", "c", "d"].map((n) => wrap(dialect, n));
      const text = `${rule} ${op} ${a} ${sep}\n    ${b} ${c} ${sep}\n    ${d}\n`;
      const added = wrap(dialect, "new-rule");

      const result = extract(text, dialect, `    ${b} ${c} ${sep}\n`);

      expect(result).toBe(
        `${rule} ${op} ${a} ${sep}\n    ${added} ${sep}\n    ${d}\n${added} ${op} ${b} ${c}\n`,
      );
    },
  );
});

describe("extract rule: selections that are not offered", () => {
  test.each<Refusal>([
    ["an empty selection", "abnf", "r = a b\n", ""],
    ["a whitespace-only selection", "abnf", "r = a  b\n", "  "],
    ["a selection starting inside a token", "abnf", "r = foo bar\n", "oo ba"],
    ["a selection ending inside a token", "abnf", "r = foo bar\n", "foo b"],
    [
      "a selection starting inside a string literal",
      "abnf",
      'r = "abc" x\n',
      'bc"',
    ],
    ["a selection inside a comment", "abnf", "r = a ; note here\n", "note"],
    ["a selection cutting a comment", "abnf", "r = a ; note\n", "a ; no"],
    [
      "a selection cutting a block comment",
      "ebnf",
      "r ::= a /* note */ b\n",
      "ote */ b",
    ],
    [
      "a selection crossing rules over a blank line",
      "abnf",
      "a = x\n\nb = y\n",
      "x\n\nb = y",
    ],
    ["a selection including the rule name", "abnf", "r = a b\n", "r = a"],
    ["a selection including the ABNF operator", "abnf", "r = a b\n", "= a"],
    ["a selection including the EBNF operator", "ebnf", "r ::= a b\n", "::= a"],
    ["a selection ending past a group", "abnf", "r = (a b) c\n", "a b) c"],
    [
      "a selection with an unclosed group opener",
      "abnf",
      "r = (a b) c\n",
      "(a",
    ],
    [
      "a selection with an unopened group closer",
      "abnf",
      "r = (a b) c\n",
      "b) ",
    ],
    ["a selection splitting nested groups", "abnf", "r = ((a) b)\n", "(a) b)"],
    [
      "a selection splitting a sequence alternative",
      "abnf",
      "r = a b / c\n",
      "b / c",
    ],
    ["a selection ending mid-alternative", "abnf", "r = a / b c\n", "a / b"],
    ["a selection starting with a slash", "abnf", "r = a / b\n", "/ b"],
    ["a selection ending with a slash", "abnf", "r = a / b\n", "a /"],
    [
      "a selection reaching out of a group",
      "abnf",
      "r = (a / b) / c\n",
      "b) / c",
    ],
    ["an operand without its repeat count", "abnf", "r = 2*DIGIT x\n", "DIGIT"],
    [
      "an operand with only the star of its repeat",
      "abnf",
      "r = 2*DIGIT x\n",
      "*DIGIT",
    ],
    ["an operand without its star", "ebnf", "r ::= a* b\n", "a"],
    ["a group without its plus", "ebnf", "r ::= (a b)+ c\n", "(a b)"],
    ["the left operand of an exclusion", "ebnf", "r ::= a - b c\n", "a"],
    [
      "an exclusion operator with its right operand",
      "ebnf",
      "r ::= a - b c\n",
      "- b",
    ],
    [
      "the right operand of an exclusion with a neighbour",
      "ebnf",
      "r ::= a - b c\n",
      "b c",
    ],
    [
      "a selection including an annotation",
      "ebnf",
      "r ::= a b [ wfc: Nope ]\n",
      "b [ wfc: Nope ]",
    ],
    ["a rule with an unclosed group", "abnf", "r = (a b c\n", "b c"],
    ["a rule with an unterminated string", "abnf", 'r = a "abc\n', "a"],
    ["a rule with an unmatched closer", "ebnf", "r ::= a ) b\n", "b"],
    ["a rule with an unclosed EBNF group", "ebnf", "r ::= (a b\n", "a b"],
    ["a rule with an unclosed block comment", "ebnf", "r ::= a /* open\n", "a"],
    ["a rule with a dangling alternative", "abnf", "r = a /\n", "a"],
    ["a rule with no body", "abnf", "r =\n", "r"],
    [
      "a rule sharing its line with another rule",
      "ebnf",
      "a ::= x y b ::= z\n",
      "x",
    ],
  ])("is not offered for %s", (_name, dialect, text, selection) => {
    const result = extract(text, dialect, selection);

    expect(result).toBeUndefined();
  });

  test("is not offered for a selection that spans two rules", () => {
    const s = setup("a = x\nb = y\n", "abnf");

    const actions = s.provide(s.at("x"), s.at("y") + 1);

    expect(actions).toEqual([]);
  });
});

describe("extract rule: requested code action kind", () => {
  test.each([
    ["quickfix", 0],
    ["refactor.inline", 0],
    ["refactor.extract", 1],
    ["refactor", 1],
  ])("offers %s actions: %p", (kind, count) => {
    const s = setup("r = a b\n", "abnf");
    const from = s.at("a b");

    const actions = s.provide(from, from + 3, new CodeActionKindMock(kind));

    expect(actions).toHaveLength(count);
  });
});

describe("extract rule: where the new rule goes", () => {
  test.each<Extraction>([
    [
      "blank lines between rules are kept",
      "abnf",
      "a = x y\n\nb = z\n",
      "x y",
      "a = new-rule\n\nnew-rule = x y\n\nb = z\n",
    ],
    [
      "the last rule of a spaced file is followed by a blank line",
      "abnf",
      "a = x\n\nb = y z\n",
      "y z",
      "a = x\n\nb = new-rule\n\nnew-rule = y z\n",
    ],
    [
      "the last rule of a compact file stays compact",
      "abnf",
      "a = x\nb = y z\n",
      "y z",
      "a = x\nb = new-rule\nnew-rule = y z\n",
    ],
    [
      "a file without a trailing newline",
      "abnf",
      "a = x y",
      "x y",
      "a = new-rule\nnew-rule = x y",
    ],
    [
      "a first rule in a file without a trailing newline",
      "abnf",
      "a = x y\nb = z",
      "x y",
      "a = new-rule\nnew-rule = x y\nb = z",
    ],
    [
      "after the last line of a multi-line rule",
      "abnf",
      "a = x\n    / y\n    / z\nb = w\n",
      "y",
      "a = x\n    / new-rule\n    / z\nnew-rule = y\nb = w\n",
    ],
    [
      "after a trailing comment on the last line",
      "abnf",
      "a = x y ; tail\nb = w\n",
      "x",
      "a = new-rule y ; tail\nnew-rule = x\nb = w\n",
    ],
    [
      "after the last =/ part when extracting from it",
      "abnf",
      "a = x\na =/ y z\nb = q\n",
      "y z",
      "a = x\na =/ new-rule\nnew-rule = y z\nb = q\n",
    ],
    [
      "after the last =/ part when extracting from the base",
      "abnf",
      "a = x\na =/ y z\nb = q\n",
      "x",
      "a = new-rule\na =/ y z\nnew-rule = x\nb = q\n",
    ],
    [
      "after a =/ part separated from its base",
      "abnf",
      "a = x\nb = q\na =/ y\n",
      "x",
      "a = new-rule\nb = q\na =/ y\nnew-rule = x\n",
    ],
    [
      "directly after the rule when a later rule has =/ parts",
      "abnf",
      "a = x\nb = q\nb =/ w\n",
      "x",
      "a = new-rule\nnew-rule = x\nb = q\nb =/ w\n",
    ],
    [
      "CRLF files keep CRLF",
      "abnf",
      "a = x y\r\n\r\nb = z\r\n",
      "x y",
      "a = new-rule\r\n\r\nnew-rule = x y\r\n\r\nb = z\r\n",
    ],
    [
      "CRLF files with a multi-line selection",
      "abnf",
      "a = x ; c\r\n    y\r\n",
      "x ; c\r\n    y",
      "a = new-rule\r\nnew-rule = x ; c\r\n    y\r\n",
    ],
    [
      "CRLF files without a trailing newline",
      "abnf",
      "a = x y\r\nb = z",
      "x y",
      "a = new-rule\r\nnew-rule = x y\r\nb = z",
    ],
    [
      "LF files without a trailing newline",
      "abnf",
      "a = x y",
      "x",
      "a = new-rule y\nnew-rule = x",
    ],
  ])(
    "places the rule correctly: %s",
    (_name, dialect, text, selection, resultText) => {
      const result = extract(text, dialect, selection);

      expect(result).toBe(resultText);
    },
  );
});

describe("extract rule: naming the new rule", () => {
  test.each<Extraction>([
    [
      "an existing definition named new-rule",
      "abnf",
      "new-rule = q\nr = a b\n",
      "a b",
      "new-rule = q\nr = new-rule-2\nnew-rule-2 = a b\n",
    ],
    [
      "existing definitions named new-rule and new-rule-2",
      "abnf",
      "new-rule = q\nnew-rule-2 = q\nr = a b\n",
      "a b",
      "new-rule = q\nnew-rule-2 = q\nr = new-rule-3\nnew-rule-3 = a b\n",
    ],
    [
      "an undefined but referenced new-rule",
      "abnf",
      "r = new-rule a b\n",
      "a b",
      "r = new-rule new-rule-2\nnew-rule-2 = a b\n",
    ],
    [
      "a differently cased ABNF definition",
      "abnf",
      "New-Rule = q\nr = a b\n",
      "a b",
      "New-Rule = q\nr = new-rule-2\nnew-rule-2 = a b\n",
    ],
    [
      "a differently cased ABNF reference",
      "abnf",
      "r = a NEW-RULE\n",
      "a",
      "r = new-rule-2 NEW-RULE\nnew-rule-2 = a\n",
    ],
    [
      "a differently cased EBNF definition, which does not collide",
      "ebnf",
      "New-Rule ::= q\nr ::= a b\n",
      "a b",
      "New-Rule ::= q\nr ::= new-rule\nnew-rule ::= a b\n",
    ],
    [
      "an identical EBNF definition",
      "ebnf",
      "new-rule ::= q\nr ::= a b\n",
      "a b",
      "new-rule ::= q\nr ::= new-rule-2\nnew-rule-2 ::= a b\n",
    ],
    [
      "a BNF definition written with angle brackets",
      "bnf",
      "<new-rule> ::= q\n<r> ::= <a> <b>\n",
      "<a> <b>",
      "<new-rule> ::= q\n<r> ::= <new-rule-2>\n<new-rule-2> ::= <a> <b>\n",
    ],
    [
      "an RBNF reference written with angle brackets",
      "rbnf",
      "<r> ::= <new-rule> <a>\n",
      "<a>",
      "<r> ::= <new-rule> <new-rule-2>\n<new-rule-2> ::= <a>\n",
    ],
  ])(
    "avoids a clash with %s",
    (_name, dialect, text, selection, resultText) => {
      const result = extract(text, dialect, selection);

      expect(result).toBe(resultText);
    },
  );

  test("avoids a name defined in another workspace file", () => {
    const s = setupRefactor(
      GrammarRefactorProvider as never,
      "r = a b\n",
      "abnf",
      [
        {
          path: "/workspace/other.abnf",
          text: "new-rule = q\n",
          dialect: "abnf",
        },
      ],
    );

    const [action] = s.select("a b");

    expect(action?.title).toBe('Extract rule "new-rule-2"');
  });

  test("titles the action with the new rule name", () => {
    const s = setup("r = a b\n", "abnf");

    const [action] = s.select("a b");

    expect(action?.title).toBe('Extract rule "new-rule"');
  });
});

describe("extract rule: comments and layout in the selection", () => {
  test.each<Extraction>([
    [
      "comments inside the selection move with it",
      "abnf",
      "r = a ; first\n    b ; second\n    c\n",
      "a ; first\n    b",
      "r = new-rule ; second\n    c\nnew-rule = a ; first\n    b\n",
    ],
    [
      "comments outside the selection stay in place",
      "abnf",
      "r = ; lead\n    a b ; tail\n",
      "a b",
      "r = ; lead\n    new-rule ; tail\nnew-rule = a b\n",
    ],
    [
      "a comment in the leading whitespace of the selection stays",
      "ebnf",
      "r ::= a /* x */ b /* y */ c\n",
      "/* x */ b /* y */",
      "r ::= a /* x */ new-rule /* y */ c\nnew-rule ::= b\n",
    ],
    [
      "a comment inside the selection moves with it",
      "ebnf",
      "r ::= a /* x */ b /* y */ c\n",
      "a /* x */ b",
      "r ::= new-rule /* y */ c\nnew-rule ::= a /* x */ b\n",
    ],
    [
      "a multi-line production rule",
      "ebnf",
      "r ::= a\n    | b\n    | c\n",
      "a\n    | b",
      "r ::= new-rule\n    | c\nnew-rule ::= a\n    | b\n",
    ],
    [
      "a block comment spanning lines inside the selection",
      "ebnf",
      "r ::= a /* one\n two */ b c\n",
      "a /* one\n two */ b",
      "r ::= new-rule c\nnew-rule ::= a /* one\n two */ b\n",
    ],
  ])("handles %s", (_name, dialect, text, selection, resultText) => {
    const result = extract(text, dialect, selection);

    expect(result).toBe(resultText);
  });
});

describe("extract rule: rename after the edit", () => {
  test("is offered as a refactor.extract action that starts a rename", () => {
    const s = setup("r = a b c\n", "abnf");

    const [action] = s.select("b c");

    expect(action?.kind.value).toBe("refactor.extract");
    expect(action?.command?.command).toBe("editor.action.rename");
  });

  test("starts a rename at the new reference in the edited document", () => {
    const s = setup("r = a b c\n", "abnf");

    const [action] = s.select("b c");

    const target = action?.command?.arguments[0] as [
      { path: string },
      PositionMock,
    ];
    const [uri, position] = target;
    expect(action?.command?.command).toBe("editor.action.rename");
    expect(uri.path).toBe("/workspace/test.abnf");
    expect([position.line, position.character]).toEqual([0, 6]);
  });

  test("places the rename position inside the angle brackets for BNF", () => {
    const s = setup("<r> ::= <a>\n<s> ::= <x> <y>\n", "bnf");

    const [action] = s.select("<x> <y>");

    const target = action?.command?.arguments[0] as [unknown, PositionMock];
    const position = target[1];
    expect([position.line, position.character]).toEqual([1, 9]);
  });

  test("rewrites BNF rules with the new angle-bracket rule", () => {
    const s = setup("<r> ::= <a>\n<s> ::= <x> <y>\n", "bnf");
    const [action] = s.select("<x> <y>");

    const result = s.apply(action as never);

    expect(result).toBe(
      "<r> ::= <a>\n<s> ::= <new-rule>\n<new-rule> ::= <x> <y>\n",
    );
  });
});

describe("extract rule: names and selections", () => {
  test("avoids a name that other files reference without defining", () => {
    const s = setupRefactor(
      GrammarRefactorProvider as never,
      "r = a b c\n",
      "abnf",
      [
        {
          path: "/workspace/other.abnf",
          text: "q = new-rule\n",
          dialect: "abnf",
        },
      ],
    );
    const [action] = s.select("b c");

    const result = s.apply(action as never);

    expect(result).toBe("r = a new-rule-2\nnew-rule-2 = b c\n");
  });

  test("avoids a name that other files define", () => {
    const s = setupRefactor(
      GrammarRefactorProvider as never,
      "r = a b c\n",
      "abnf",
      [
        {
          path: "/workspace/other.abnf",
          text: "new-rule = z\n",
          dialect: "abnf",
        },
      ],
    );
    const [action] = s.select("b c");

    const result = s.apply(action as never);

    expect(result).toBe("r = a new-rule-2\nnew-rule-2 = b c\n");
  });

  test("offers extraction for a selection that ends at the start of the next line", () => {
    const s = setup("r = a\n    / b c\n\nz = d\n", "abnf");
    const from = s.at("b c");

    const [action] = s.provide(from, from + "b c\n".length);

    expect(s.apply(action as never)).toBe(
      "r = a\n    / new-rule\n\nnew-rule = b c\n\nz = d\n",
    );
  });

  test("does not extend a selection that ends at the next line into another rule", () => {
    const s = setup("r = a b\nz = d\n", "abnf");
    const from = s.at("a b");

    const actions = s.provide(from, s.at("z"));

    expect(actions.map((action) => action.title)).toEqual([
      'Extract rule "new-rule"',
    ]);
  });
});
