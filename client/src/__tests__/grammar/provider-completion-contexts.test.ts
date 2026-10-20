import { beforeAll, describe, expect, test } from "bun:test";
import { PositionMock, type RangeMock } from "../vscode-mock.ts";
import {
  asTextDocument,
  createDocument,
  createWorkspace,
  loadGrammarTestCore,
} from "./provider-test-utils.ts";

type Completion = typeof import("../../grammar/completion.ts");
let completion: Completion;
const token = {} as never;
const DOLLAR = "$";

beforeAll(async () => {
  await loadGrammarTestCore();
  completion = await import("../../grammar/completion.ts");
});

function complete(
  text: string,
  dialect: "ebnf" | "bnf" | "abnf" | "rbnf",
  line: number,
  character: number,
) {
  return new completion.GrammarCompletionProvider(
    createWorkspace(),
  ).provideCompletionItems(
    asTextDocument(createDocument(`/w/a.${dialect}`, text, dialect)),
    new PositionMock(line, character) as never,
    token,
  ) as unknown as Array<{
    label: string;
    range?: RangeMock;
    insertText?: { value: string };
  }>;
}

describe("completion is suppressed", () => {
  test.each([
    ["inside a string", "a ::= 'x y' | b\nb ::= 'q'\n", "ebnf", 0, 8],
    [
      "inside a block comment",
      "a ::= /* note */ b\nb ::= 'q'\n",
      "ebnf",
      0,
      12,
    ],
    ["inside a character class", "a ::= [a-z] b\nb ::= 'q'\n", "ebnf", 0, 9],
    [
      "inside a BNF line comment",
      "<a> ::= <b> ; note\n<b> ::= 'q'\n",
      "bnf",
      0,
      16,
    ],
    ["inside an ABNF comment", 'a = "x" / b ; note\nb = "q"\n', "abnf", 0, 5],
  ] as const)("%s", (_name, text, dialect, line, character) => {
    expect(complete(text, dialect, line, character)).toEqual([]);
  });

  test("but offered in plain rule position", () => {
    expect(
      complete("a ::= b\nb ::= 'q'\n", "ebnf", 0, 7).length,
    ).toBeGreaterThan(0);
  });
});

describe("BNF completion", () => {
  test("after '<' replaces the typed '<' instead of doubling it", () => {
    const items = complete('<a> ::= <\n<bee> ::= "x"\n', "bnf", 0, 9);

    const bee = items.find((item) => item.label === "<bee>");

    expect(bee?.range?.start.character).toBe(8);
    expect(bee?.range?.end.character).toBe(9);
  });
});

describe("RBNF completion", () => {
  test("offers [ ] and ... instead of ABNF repeats", () => {
    const items = complete("<a> ::= <b>\n<b> ::= 'x'\n", "rbnf", 0, 11);

    const bodies = items.flatMap((item) =>
      item.insertText ? [item.insertText.value] : [],
    );

    expect(bodies).toContain(`[${DOLLAR}{1:element}]`);
    expect(bodies).toContain(`${DOLLAR}{1:element} ...`);
    expect(bodies.some((body) => body.includes("*("))).toBe(false);
  });
});

describe("completion trigger characters", () => {
  test.each([
    ["abnf", ["%"]],
    ["ebnf", ["#"]],
    ["bnf", ["<"]],
    ["rbnf", ["<"]],
  ])("%s triggers on %j", (language, expected) => {
    const triggers = Object.fromEntries(
      completion.COMPLETION_TRIGGERS.map((entry) => [
        entry.language,
        entry.triggers,
      ]),
    );

    expect(triggers[language]).toEqual(expected);
  });
});
