import { beforeAll, describe, expect, test } from "bun:test";
import { PositionMock } from "../vscode-mock.ts";
import {
  asTextDocument,
  createDocument,
  createWorkspace,
  loadGrammarTestCore,
} from "./provider-test-utils.ts";

let getWordLookup: typeof import("../../grammar/providers/word-at-position.ts").getWordLookup;

beforeAll(async () => {
  await loadGrammarTestCore();
  ({ getWordLookup } = await import(
    "../../grammar/providers/word-at-position.ts"
  ));
});

describe("word lookup", () => {
  const ebnf = createDocument(
    "/w/a.ebnf",
    "a ::= xml:lang 'a'\nxml:lang ::= 'x' /* comment a */\nb.c ::= a\n",
    "ebnf",
  );
  const lookup = (line: number, character: number) =>
    getWordLookup(
      asTextDocument(ebnf),
      new PositionMock(line, character) as never,
      createWorkspace(),
    );

  test("a word inside a string is not a symbol", () => {
    expect(lookup(0, 16)).toBeUndefined();
  });

  test("a word inside a comment is not a symbol", () => {
    expect(lookup(1, 24)).toBeUndefined();
  });

  test("a colon name is one symbol", () => {
    expect(lookup(0, 10)?.text).toBe("xml:lang");
  });

  test("a dotted name is one symbol", () => {
    expect(lookup(2, 1)?.text).toBe("b.c");
  });

  test("a word inside an ABNF comment is not a symbol", () => {
    const abnf = createDocument(
      "/w/a.abnf",
      'a = b ; a comment\nb = "a"\n',
      "abnf",
    );

    const result = getWordLookup(
      asTextDocument(abnf),
      new PositionMock(0, 14) as never,
      createWorkspace(),
    );

    expect(result).toBeUndefined();
  });
});
