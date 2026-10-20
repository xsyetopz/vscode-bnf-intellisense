import { beforeAll, describe, expect, test } from "bun:test";
import {
  type RangeMock,
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

beforeAll(async () => {
  await loadGrammarTestCore();
  ({ GrammarSemanticTokensProvider } = await import(
    "../../grammar/semantic-tokens.ts"
  ));
});

describe("grammar semantic tokens provider", () => {
  test("produces semantic tokens for operators, strings, classes, and references", () => {
    resetConfigurationValues();
    const workspace = createWorkspace();
    const provider = new GrammarSemanticTokensProvider(workspace);
    const doc = createDocument(
      "/workspace/semantic.ebnf",
      'root ::= [#x20-#x21] | "x" | other\nother ::= #xA\n',
      "ebnf",
    );
    const result = provider.provideDocumentSemanticTokens(
      asTextDocument(doc),
      {} as never,
    ) as unknown as {
      data: Array<{ tokenType: string; tokenModifiers: readonly string[] }>;
    };

    expect(result.data.some((entry) => entry.tokenType === "operator")).toBe(
      true,
    );
    expect(result.data.some((entry) => entry.tokenType === "string")).toBe(
      true,
    );
    expect(result.data.some((entry) => entry.tokenType === "regexp")).toBe(
      true,
    );
    expect(result.data.some((entry) => entry.tokenType === "number")).toBe(
      true,
    );
    expect(result.data.some((entry) => entry.tokenType === "parameter")).toBe(
      true,
    );
    expect(
      result.data.some(
        (entry) =>
          entry.tokenType === "type" &&
          entry.tokenModifiers.includes("definition"),
      ),
    ).toBe(true);
  });

  test("sorts semantic tokens and keeps symbol ranges whole", () => {
    resetConfigurationValues();
    const workspace = createWorkspace();
    const provider = new GrammarSemanticTokensProvider(workspace);
    const doc = createDocument(
      "/workspace/unicode.ebnf",
      'root ::= "😀" | other\nother ::= "x"\n',
      "ebnf",
    );
    const result = provider.provideDocumentSemanticTokens(
      asTextDocument(doc),
      {} as never,
    ) as unknown as {
      data: Array<{
        range: RangeMock;
        tokenType: string;
        tokenModifiers: readonly string[];
      }>;
    };

    for (let i = 1; i < result.data.length; i++) {
      const previous = result.data[i - 1]?.range;
      const current = result.data[i]?.range;
      expect(
        (previous?.start.line ?? 0) < (current?.start.line ?? 0) ||
          ((previous?.start.line ?? 0) === (current?.start.line ?? 0) &&
            (previous?.start.character ?? 0) <=
              (current?.start.character ?? 0)),
      ).toBe(true);
    }
    expect(
      result.data.some(
        (entry) =>
          entry.tokenType === "string" &&
          entry.range.start.character === 9 &&
          entry.range.end.character === 13,
      ),
    ).toBe(true);
    expect(
      result.data.some(
        (entry) =>
          entry.tokenType === "parameter" &&
          entry.range.start.character === 16 &&
          entry.range.end.character === 21,
      ),
    ).toBe(true);
  });

  test("falls back from semantic tokens through user settings", () => {
    resetConfigurationValues();
    const workspace = createWorkspace();
    const provider = new GrammarSemanticTokensProvider(workspace);
    const doc = createDocument(
      "/workspace/fallback.ebnf",
      'root ::= "x" | other\nother ::= "y"\n',
      "ebnf",
    );

    setConfigurationValue("bnf.semanticHighlighting.mode", "off");
    expect(
      (
        provider.provideDocumentSemanticTokens(
          asTextDocument(doc),
          {} as never,
        ) as unknown as { data: unknown[] }
      ).data,
    ).toEqual([]);

    setConfigurationValue("bnf.semanticHighlighting.mode", "auto");
    setConfigurationValue("bnf.semanticHighlighting.maxTokens", 1);
    const reduced = (
      provider.provideDocumentSemanticTokens(
        asTextDocument(doc),
        {} as never,
      ) as unknown as { data: unknown[] }
    ).data.length;
    expect(reduced).toBeGreaterThan(0);

    setConfigurationValue("bnf.semanticHighlighting.mode", "on");
    expect(
      (
        provider.provideDocumentSemanticTokens(
          asTextDocument(doc),
          {} as never,
        ) as unknown as { data: unknown[] }
      ).data.length,
    ).toBeGreaterThan(reduced);
    resetConfigurationValues();
  });
});
