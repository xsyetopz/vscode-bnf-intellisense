import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { GrammarDialect } from "../../grammar/dialects.ts";
import { RangeMock, resetConfigurationValues } from "../vscode-mock.ts";
import {
  applyTextEdits,
  asTextDocument,
  createDocument,
  loadGrammarTestCore,
} from "./provider-test-utils.ts";

let GrammarRangeFormattingProvider: typeof import("../../grammar/formatting-provider.ts").GrammarRangeFormattingProvider;

beforeAll(async () => {
  await loadGrammarTestCore();
  ({ GrammarRangeFormattingProvider } = await import(
    "../../grammar/formatting-provider.ts"
  ));
});

afterEach(() => {
  resetConfigurationValues();
});

type Edit = { range: RangeMock; newText: string };

function rangeFormat(
  text: string,
  dialect: GrammarDialect,
  range: RangeMock,
): Edit[] {
  const doc = createDocument(`/w/g.${dialect}`, text, dialect);
  return new GrammarRangeFormattingProvider().provideDocumentRangeFormattingEdits(
    asTextDocument(doc),
    range as never,
    {} as never,
  ) as unknown as Edit[];
}

const withoutWhitespace = (text: string) => text.replace(/\s+/g, "");

describe("range formatting never loses text", () => {
  test.each(["b=; c=", "b=  ; c\nd = e\n", "b = ; c\n"])(
    "an ABNF empty body keeps its trailing comment: %j",
    (text) => {
      const edits = rangeFormat(text, "abnf", new RangeMock(0, 0, 0, 0));

      expect(withoutWhitespace(applyTextEdits(text, edits))).toBe(
        withoutWhitespace(text),
      );
    },
  );

  test("RBNF garbage keeps every character", () => {
    const text = "<a> ::= ||::=; c ::= ::= ]|((   | |[";

    const edits = rangeFormat(text, "rbnf", new RangeMock(0, 0, 0, 0));

    expect(withoutWhitespace(applyTextEdits(text, edits))).toBe(
      withoutWhitespace(text),
    );
  });

  test("random input only ever changes whitespace, within the requested lines", () => {
    const parts: Record<GrammarDialect, string[]> = {
      abnf: [
        "a",
        "b",
        "=",
        "=/",
        "/",
        "(",
        ")",
        "[",
        "]",
        '"x"',
        "; c",
        "\n",
        "\n ",
        "  ",
        "*",
        "%x41",
      ],
      ebnf: [
        "a",
        "::=",
        "|",
        "(",
        ")",
        "[a-z]",
        '"x"',
        "/* c */",
        "/* c\n d */",
        "\n",
        "\n ",
        "  ",
        "?",
      ],
      bnf: [
        "<a>",
        "<b>",
        "::=",
        "|",
        "(",
        ")",
        '"x"',
        "; c",
        "\n",
        "\n ",
        "  ",
      ],
      rbnf: [
        "<a>",
        "<b>",
        "::=",
        "|",
        "(",
        ")",
        '"x"',
        "; c",
        "/* c\n d */",
        "\n",
        "\n ",
        "  ",
        "[",
        "]",
      ],
    };
    let seed = 12345;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (const dialect of Object.keys(parts) as GrammarDialect[]) {
      const pool = parts[dialect];
      for (let iteration = 0; iteration < 600; iteration++) {
        let text = "";
        for (let i = 0, n = 3 + next(22); i < n; i++) {
          text += (pool[next(pool.length)] ?? "") + (next(2) ? " " : "");
        }
        const lines = text.split(/\r\n|\n|\r/);
        const first = next(lines.length);
        const last = first + next(lines.length - first);

        const edits = rangeFormat(
          text,
          dialect,
          new RangeMock(first, 0, last, lines[last]?.length ?? 0),
        );

        expect(withoutWhitespace(applyTextEdits(text, edits))).toBe(
          withoutWhitespace(text),
        );
        for (const edit of edits) {
          expect(edit.range.end.line).toBeGreaterThanOrEqual(first);
          expect(edit.range.start.line).toBeLessThanOrEqual(last);
        }
      }
    }
  });
});
