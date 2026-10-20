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

beforeAll(async () => {
  await loadGrammarTestCore();
  ({ GrammarSemanticTokensProvider } = await import(
    "../../grammar/semantic-tokens.ts"
  ));
});

afterEach(() => {
  resetConfigurationValues();
});

describe("range semantic tokens", () => {
  const provider = () => new GrammarSemanticTokensProvider(createWorkspace());
  let version = 0;
  const tokensFor = (p: ReturnType<typeof provider>, text: string): string => {
    const mock = createDocument("/w/s.abnf", text, "abnf");
    mock.version = ++version;
    const doc = asTextDocument(mock);
    return JSON.stringify(
      p.provideDocumentRangeSemanticTokens(
        doc,
        new RangeMock(0, 0, 9, 0) as never,
        {} as never,
      ),
    );
  };

  test("repeated requests for the same text return identical tokens", () => {
    const p = provider();
    const first = tokensFor(p, "a = b\n");

    expect(tokensFor(p, "a = b\n")).toBe(first);
  });

  test("an edit changes the tokens", () => {
    const p = provider();
    const first = tokensFor(p, "a = b\n");

    expect(tokensFor(p, "a = c\nc = d\n")).not.toBe(first);
  });

  test("a settings change changes the tokens for the same text", () => {
    const p = provider();
    const first = tokensFor(p, "a = b\n");

    setConfigurationValue("bnf.semanticHighlighting.mode", "off");

    expect(tokensFor(p, "a = b\n")).not.toBe(first);
  });
});
