import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { GrammarDialect } from "../../grammar/dialects.ts";
import {
  PositionMock,
  type RangeMock,
  resetConfigurationValues,
} from "../vscode-mock.ts";
import {
  applyTextEdits,
  asTextDocument,
  createDocument,
  loadGrammarTestCore,
} from "./provider-test-utils.ts";

let GrammarOnTypeFormattingProvider: typeof import("../../grammar/providers/on-type-formatting.ts").GrammarOnTypeFormattingProvider;

beforeAll(async () => {
  await loadGrammarTestCore();
  ({ GrammarOnTypeFormattingProvider } = await import(
    "../../grammar/providers/on-type-formatting.ts"
  ));
});

afterEach(() => {
  resetConfigurationValues();
});

type Edit = { range: RangeMock; newText: string };
type Options = { insertSpaces?: boolean; tabSize?: number };
const SPACES: Options = { insertSpaces: true, tabSize: 4 };
const TABS: Options = { insertSpaces: false, tabSize: 4 };

/** The text after pressing Enter so that the cursor is at the start of `line`. */
function enter(
  text: string,
  dialect: GrammarDialect,
  line: number,
  options: Options = {},
): string {
  const doc = createDocument(`/w/g.${dialect}`, text, dialect);
  const edits =
    new GrammarOnTypeFormattingProvider().provideOnTypeFormattingEdits(
      asTextDocument(doc),
      new PositionMock(line, 0) as never,
      "\n",
      options as never,
    ) as unknown as Edit[];
  return applyTextEdits(text, edits);
}

describe("on-type formatting indents with tabs when the editor wants tabs", () => {
  test.each([
    ["a tab after a short rule name", "a = b /\n\n", 1, TABS, "a = b /\n\t\n"],
    [
      "a tab plus a space when the name fills a tab stop of 8",
      "abcdef = b /\n\n",
      1,
      { ...TABS, tabSize: 8 },
      "abcdef = b /\n\t \n",
    ],
    [
      "two tabs plus spaces for a long name",
      "abcdefg = b /\n\n",
      1,
      TABS,
      "abcdefg = b /\n\t\t  \n",
    ],
    [
      "nothing when the indent is already tabs",
      "a = b /\n\t\n",
      1,
      TABS,
      "a = b /\n\t\n",
    ],
    [
      "the tab indent of an existing alternative line",
      "a = b\n\t/ c\n/ d\n",
      2,
      TABS,
      "a = b\n\t/ c\n\t/ d\n",
    ],
  ] as const)("%s", (_name, text, line, options, expected) => {
    expect(enter(text, "abnf", line, options)).toBe(expected);
  });
});

describe("on-type formatting understands quotes", () => {
  test.each([
    [
      "an apostrophe in an ABNF comment is not a quote",
      "a = b ; it's\n  /\n\n",
      2,
      "a = b ; it's\n  /\n    \n",
    ],
    [
      "an ABNF %x27 is not a quote",
      "a = %x27 /\n/ c\n",
      1,
      "a = %x27 /\n    / c\n",
    ],
    [
      "an apostrophe in a trailing ABNF comment is not a quote",
      "a = b\n/ c ; it's\n",
      1,
      "a = b\n    / c ; it's\n",
    ],
    [
      "an escaped quote does not open an ABNF string",
      'a = "\\" /\n\n',
      1,
      'a = "\\" /\n    \n',
    ],
    [
      "an ABNF prose value may contain a quote",
      'a = <say "hi> /\n\n',
      1,
      'a = <say "hi> /\n    \n',
    ],
  ] as const)("%s", (_name, text, line, expected) => {
    expect(enter(text, "abnf", line, SPACES)).toBe(expected);
  });

  test.each([
    [
      "a quote of the other kind inside an EBNF string is text",
      `A ::= "'" B\n| C\n`,
      1,
      `A ::= "'" B\n      | C\n`,
    ],
    [
      "a quote inside an EBNF character class is text",
      "a ::= [\"'] |\n\n",
      1,
      "a ::= [\"'] |\n      \n",
    ],
    [
      "an apostrophe inside an EBNF block comment is text",
      "a ::= b /* don't */ |\n\n",
      1,
      "a ::= b /* don't */ |\n      \n",
    ],
    [
      "a really open EBNF string is left alone",
      "A ::= 'x\n| C'\n",
      1,
      "A ::= 'x\n| C'\n",
    ],
  ] as const)("%s", (_name, text, line, expected) => {
    expect(enter(text, "ebnf", line, SPACES)).toBe(expected);
  });

  test.each([
    ["a really open ABNF string is left alone", 'a = "x /\n\n'],
    ["an open ABNF prose value is left alone", "a = <x /\n\n"],
  ])("%s", (_name, text) => {
    expect(enter(text, "abnf", 1, SPACES)).toBe(text);
  });
});

describe("on-type formatting of continuation lines", () => {
  test("operator lines inside block comments are not alternative lines", () => {
    const text = "A ::= B\n/* | x\n   | y */\n| C\n";

    expect(enter(text, "ebnf", 3)).toBe(
      "A ::= B\n/* | x\n   | y */\n      | C\n",
    );
  });

  test("an ABNF body cut in the middle is indented as a continuation", () => {
    expect(enter("a = b\nc\n", "abnf", 1)).toBe("a = b\n    c\n");
  });

  test.each([
    ["a new rule below a finished one", "a = b\nc = d\n"],
    ["a name below a rule ending in a comment", "a = b ; note\nc\n"],
  ])("%s is not touched", (_name, text) => {
    expect(enter(text, "abnf", 1)).toBe(text);
  });

  test.each([
    ["an ABNF ; comment line below a rule", "a = b\n; note\n", "abnf"],
    ["an EBNF comment line below a rule", "a ::= b\n/* note */\n", "ebnf"],
    [
      "an ABNF comment line below a commented rule",
      "a = b ; note\n; more\n",
      "abnf",
    ],
  ] as const)("%s is left alone", (_name, text, dialect) => {
    expect(enter(text, dialect, 1, SPACES)).toBe(text);
  });
});
