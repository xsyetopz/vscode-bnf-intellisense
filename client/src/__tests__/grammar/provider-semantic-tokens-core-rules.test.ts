import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { type RangeMock, resetConfigurationValues } from "../vscode-mock.ts";
import {
  asTextDocument,
  createDocument,
  createWorkspace,
  loadGrammarTestCore,
} from "./provider-test-utils.ts";

let GrammarSemanticTokensProvider: typeof import("../../grammar/semantic-tokens.ts").GrammarSemanticTokensProvider;

beforeAll(async () => {
  await loadGrammarTestCore();
  ({ GrammarSemanticTokensProvider } = await import(
    "../../grammar/semantic-tokens.ts"
  ));
});

afterEach(() => {
  resetConfigurationValues();
});

type SemanticToken = {
  range: RangeMock;
  tokenType: string;
  tokenModifiers: readonly string[];
};

function tokenOnFirstLine(character: number): SemanticToken | undefined {
  const doc = createDocument(
    "/w/a.abnf",
    'root = DIGIT ALPHA\nDIGIT = "x"\n',
    "abnf",
  );
  const result = new GrammarSemanticTokensProvider(
    createWorkspace(),
  ).provideDocumentSemanticTokens(
    asTextDocument(doc),
    {} as never,
  ) as unknown as { data: SemanticToken[] };
  return result.data.find(
    (entry) =>
      entry.range.start.line === 0 && entry.range.start.character === character,
  );
}

describe("semantic tokens for core rule names", () => {
  test("a user rule that redefines a core name is not styled as core", () => {
    const token = tokenOnFirstLine(7);

    expect(token?.tokenType).toBe("parameter");
    expect(token?.tokenModifiers).not.toContain("defaultLibrary");
  });

  test("a core rule that is not redefined is styled as default library", () => {
    const token = tokenOnFirstLine(13);

    expect(token?.tokenModifiers).toContain("defaultLibrary");
  });
});
