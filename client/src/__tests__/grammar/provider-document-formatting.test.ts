import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  resetConfigurationValues,
  setConfigurationValue,
} from "../vscode-mock.ts";
import {
  asTextDocument,
  createDocument,
  loadGrammarTestCore,
} from "./provider-test-utils.ts";

let GrammarFormattingProvider: typeof import("../../grammar/formatting-provider.ts").GrammarFormattingProvider;
const token = {} as never;

beforeAll(async () => {
  await loadGrammarTestCore();
  ({ GrammarFormattingProvider } = await import(
    "../../grammar/formatting-provider.ts"
  ));
});

afterEach(() => {
  resetConfigurationValues();
});

function format(text: string) {
  const doc = createDocument("/w/a.ebnf", text, "ebnf");
  return new GrammarFormattingProvider().provideDocumentFormattingEdits(
    asTextDocument(doc),
    {} as never,
    token,
  ) as unknown as Array<{ newText?: string; text?: string }>;
}

describe("document formatting", () => {
  test("returns no edits when the text is already formatted", () => {
    expect(format("a ::= 'x'\n")).toEqual([]);
  });

  test("returns one edit when the text needs formatting", () => {
    expect(format("a   ::=   'x'   \n")).toHaveLength(1);
  });

  test("a continuation indent below 1 is treated as 1", () => {
    setConfigurationValue("bnf.formatting.continuationIndent", 0);
    setConfigurationValue("bnf.formatting.alternativeIndent", "indent");

    const edits = format("a ::= 'x' | 'y'\n");

    expect(edits[0]?.newText ?? edits[0]?.text).toBe("a ::= 'x'\n | 'y'\n");
  });
});
