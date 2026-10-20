import { beforeAll, describe, expect, test } from "bun:test";
import type { GrammarDialect } from "../../grammar/dialects.ts";
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

function links(text: string, dialect: GrammarDialect) {
  const doc = createDocument(`/workspace/g.${dialect}`, text, dialect);
  return new GrammarDocumentLinkProvider()
    .provideDocumentLinks(asTextDocument(doc))
    .map((link) => ({
      text: textOfRange(text, link.range),
      target: (link.target as { toString(): string }).toString(),
      line: link.range.start.line,
      column: link.range.start.character,
    }));
}

describe("document link provider", () => {
  test("links RFC numbers in ABNF comments", () => {
    expect(
      links("; see RFC 5234 and RFC7405.\nrule = a ; per RFC 3986\n", "abnf"),
    ).toEqual([
      {
        text: "RFC 5234",
        target: "https://www.rfc-editor.org/rfc/rfc5234",
        line: 0,
        column: 6,
      },
      {
        text: "RFC7405",
        target: "https://www.rfc-editor.org/rfc/rfc7405",
        line: 0,
        column: 19,
      },
      {
        text: "RFC 3986",
        target: "https://www.rfc-editor.org/rfc/rfc3986",
        line: 1,
        column: 15,
      },
    ]);
  });

  test("links RFC numbers in comments of the other dialects", () => {
    expect(links("A ::= 'x' /* RFC 2616 */\n", "ebnf")).toHaveLength(1);
    expect(links("; RFC 2616\nA ::= 'x'\n", "bnf")[0]?.target).toBe(
      "https://www.rfc-editor.org/rfc/rfc2616",
    );
    expect(links("; RFC 5511\n<a> ::= <b> ; RFC 1\n", "rbnf")).toHaveLength(2);
  });

  test("block comments are linked per line with correct columns", () => {
    const result = links(
      "/* first\n   RFC 1034 and\n RFC 1035 */\nA ::= 'x'\n",
      "ebnf",
    );
    expect(result.map((r) => [r.text, r.line, r.column])).toEqual([
      ["RFC 1034", 1, 3],
      ["RFC 1035", 2, 1],
    ]);
  });

  test("ignores code, strings and annotations", () => {
    expect(links('rule = "RFC 5234"\n', "abnf")).toEqual([]);
    expect(links("RFC ::= 'RFC 5234'\n", "ebnf")).toEqual([]);
    expect(links("A ::= 'x' [ vc: RFC 1234 ]\n", "ebnf")).toEqual([]);
    expect(
      links("; RFC\n; RFC abc\n; RFCs 5234\n; XRFC 5234\n", "abnf"),
    ).toEqual([]);
  });

  test("does not duplicate plain URLs", () => {
    expect(
      links(
        "; https://www.rfc-editor.org/rfc/rfc5234 and http://x.org/RFC1234.txt\n",
        "abnf",
      ),
    ).toEqual([]);
    expect(
      links("; https://x.org/a RFC 7405\n", "abnf").map((l) => l.text),
    ).toEqual(["RFC 7405"]);
  });

  test("normalizes leading zeros and skips RFC 0 or oversized numbers", () => {
    expect(links("; RFC 0791\n", "abnf")[0]?.target).toBe(
      "https://www.rfc-editor.org/rfc/rfc791",
    );
    expect(links("; RFC 0 and RFC 123456\n", "abnf")).toEqual([]);
  });

  test("finds links in CRLF documents", () => {
    expect(links("; RFC 1\r\n; RFC 22\r\na = b\r\n", "abnf")).toHaveLength(2);
  });

  test("an empty document has no links", () => {
    expect(links("", "abnf")).toEqual([]);
  });

  test("returns no links when cancellation was requested", () => {
    const doc = createDocument("/w/a.abnf", "; RFC 1\n", "abnf");
    expect(
      new GrammarDocumentLinkProvider().provideDocumentLinks(
        asTextDocument(doc),
        { isCancellationRequested: true } as never,
      ),
    ).toEqual([]);
  });
});
