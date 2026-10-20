import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  RangeMock,
  resetConfigurationValues,
  setConfigurationValue,
} from "../vscode-mock.ts";
import {
  asTextDocument,
  createDocument,
  createWorkspace,
  loadGrammarTestCore,
} from "./provider-test-utils.ts";

let GrammarSemanticTokensProvider: typeof import("../../grammar/semantic-tokens.ts").GrammarSemanticTokensProvider;
let GrammarInlayHintsProvider: typeof import("../../grammar/providers/inlay-hints.ts").GrammarInlayHintsProvider;
const token = {} as never;

beforeAll(async () => {
  await loadGrammarTestCore();
  ({ GrammarSemanticTokensProvider } = await import(
    "../../grammar/semantic-tokens.ts"
  ));
  ({ GrammarInlayHintsProvider } = await import(
    "../../grammar/providers/inlay-hints.ts"
  ));
});

afterEach(() => {
  resetConfigurationValues();
});

function hintLabels(path: string, text: string): string[] {
  const doc = createDocument(path, text, "ebnf");
  const hints = new GrammarInlayHintsProvider(
    createWorkspace(),
  ).provideInlayHints(
    asTextDocument(doc),
    new RangeMock(0, 0, 5, 0) as never,
    token,
  ) as unknown as Array<{ label: string }>;
  return hints.map((hint) => hint.label);
}

describe("recursive rules", () => {
  const recursive = 'list ::= item | list "," item\nitem ::= "x"\n';

  test("a self reference gets a semantic token", () => {
    const doc = createDocument("/w/a.ebnf", recursive, "ebnf");

    const tokens = new GrammarSemanticTokensProvider(
      createWorkspace(),
    ).provideDocumentSemanticTokens(asTextDocument(doc), token) as unknown as {
      data: Array<{ range: RangeMock; tokenType: string }>;
    };

    expect(
      tokens.data.some(
        (entry) =>
          entry.range.start.character === 16 &&
          entry.range.start.line === 0 &&
          entry.tokenType === "parameter",
      ),
    ).toBe(true);
  });

  test("a recursive rule gets the recursive inlay hint", () => {
    setConfigurationValue("bnf.inlayHints.recursion", true);

    const labels = hintLabels("/w/a.ebnf", recursive);

    expect(labels.map((label) => label.trim())).toEqual(["recursive"]);
  });

  test("a rule that only refers to itself gets the unused inlay marker", () => {
    setConfigurationValue("bnf.inlayHints.unusedMarker", true);

    const labels = hintLabels(
      "/w/a.ebnf",
      'root ::= item\nitem ::= "x"\nloop ::= loop "y"\n',
    );

    expect(labels.filter((label) => label.includes("unused"))).toHaveLength(2);
  });
});
