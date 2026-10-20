import { beforeAll, describe, expect, test } from "bun:test";
import type { GrammarDialect } from "../../grammar/dialects.ts";
import { PositionMock } from "../vscode-mock.ts";
import {
  asTextDocument,
  createDocument,
  createWorkspace,
  loadGrammarTestCore,
} from "./provider-test-utils.ts";

let GrammarLinkedEditingRangeProvider: typeof import("../../grammar/providers/linked-editing.ts").GrammarLinkedEditingRangeProvider;
let parseGrammar: typeof import("../../grammar/grammar.ts").parseGrammar;

beforeAll(async () => {
  await loadGrammarTestCore();
  ({ GrammarLinkedEditingRangeProvider } = await import(
    "../../grammar/providers/linked-editing.ts"
  ));
  ({ parseGrammar } = await import("../../grammar/grammar.ts"));
});

function link(
  text: string,
  dialect: GrammarDialect,
  line: number,
  character: number,
) {
  const doc = createDocument(`/w/g.${dialect}`, text, dialect);
  return new GrammarLinkedEditingRangeProvider(
    createWorkspace(),
  ).provideLinkedEditingRanges(
    asTextDocument(doc),
    new PositionMock(line, character) as never,
  );
}

function wordPatternAccepts(
  pattern: RegExp | undefined,
  word: string,
): boolean {
  return new RegExp(`^(?:${(pattern as RegExp).source})$`).test(word);
}

describe("linked editing of names", () => {
  test("a user rule named like a core rule is linked with its references", () => {
    const text = 'ALPHA = "x"\nb = ALPHA\n';

    expect(link(text, "abnf", 0, 2)?.ranges).toHaveLength(2);
  });

  test("a core rule reference without a user definition is not linked", () => {
    expect(link("b = ALPHA\n", "abnf", 0, 6)).toBeUndefined();
  });

  test.each([
    ["abnf", "a-b1"],
    ["ebnf", "a.b:c-d_e"],
    ["bnf", "x_1"],
  ] as const)("the %s word pattern accepts the name %j", (dialect, name) => {
    const operator = dialect === "abnf" ? "=" : "::=";

    const result = link(`${name} ${operator} "x"\n`, dialect, 0, 1);

    expect(wordPatternAccepts(result?.wordPattern, name)).toBe(true);
  });

  test.each(["abnf", "ebnf", "bnf"] as const)(
    "the %s word pattern rejects non-ASCII letters, as the parser does",
    (dialect) => {
      const result = link(
        dialect === "abnf" ? 'a = "x"\n' : 'a ::= "x"\n',
        dialect,
        0,
        0,
      );

      expect(wordPatternAccepts(result?.wordPattern, "café")).toBe(false);
    },
  );

  test("the parser does not read non-ASCII letters as part of a name", () => {
    const name = parseGrammar('café ::= "x"\n', "ebnf").rules[0]?.name;

    expect(name).not.toBe("café");
  });
});
