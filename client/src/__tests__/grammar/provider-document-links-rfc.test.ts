import { beforeAll, describe, expect, test } from "bun:test";
import {
  asTextDocument,
  createDocument,
  loadGrammarTestCore,
  textOfRange,
} from "./provider-test-utils.ts";

let GrammarDocumentLinkProvider: typeof import("../../grammar/providers/document-links.ts").GrammarDocumentLinkProvider;

beforeAll(async () => {
  await loadGrammarTestCore();
  ({ GrammarDocumentLinkProvider } = await import(
    "../../grammar/providers/document-links.ts"
  ));
});

function linkedTexts(text: string): string[] {
  const doc = createDocument("/w/g.abnf", text, "abnf");
  return new GrammarDocumentLinkProvider()
    .provideDocumentLinks(asTextDocument(doc))
    .map((link) => textOfRange(text, link.range));
}

describe("RFC references in comments", () => {
  test("case, hyphen, and tab variants are linked", () => {
    const linked = linkedTexts(
      "; rfc 5234\n; RFC-5234\n; RFC\t5234\n; Rfc5234\n",
    );

    expect(linked).toEqual(["rfc 5234", "RFC-5234", "RFC\t5234", "Rfc5234"]);
  });

  test("a number glued to letters is not a reference", () => {
    expect(linkedTexts("; RFC5234bis\n; RFC 5234x\n; RFC_5234\n")).toEqual([]);
  });

  test("trailing punctuation is not part of the link", () => {
    expect(linkedTexts("; RFC5234, RFC 5234.\n")).toEqual([
      "RFC5234",
      "RFC 5234",
    ]);
  });
});
