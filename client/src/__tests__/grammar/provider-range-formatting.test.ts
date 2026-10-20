import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { GrammarDialect } from "../../grammar/dialects.ts";
import {
  RangeMock,
  resetConfigurationValues,
  setConfigurationValue,
} from "../vscode-mock.ts";
import {
  applyTextEdits,
  asTextDocument,
  createDocument,
  loadGrammarTestCore,
} from "./provider-test-utils.ts";

let GrammarFormattingProvider: typeof import("../../grammar/formatting-provider.ts").GrammarFormattingProvider;
let GrammarRangeFormattingProvider: typeof import("../../grammar/formatting-provider.ts").GrammarRangeFormattingProvider;

beforeAll(async () => {
  await loadGrammarTestCore();
  ({ GrammarFormattingProvider, GrammarRangeFormattingProvider } = await import(
    "../../grammar/formatting-provider.ts"
  ));
});

afterEach(() => {
  resetConfigurationValues();
});

type Edit = { range: RangeMock; newText: string };

const SAMPLES: Record<GrammarDialect, string> = {
  abnf: [
    "first   =   a /b   ; one",
    "",
    "second = c / d",
    "    / e",
    "",
    "third-rule=f",
    "",
  ].join("\n"),
  ebnf: [
    "First   ::=   A |B   /* one */",
    "",
    "Second ::= C | D",
    "    | E",
    "",
    "Third-rule::=F",
    "",
  ].join("\n"),
  bnf: [
    "<first>   ::=   <a> |<b>   ; one",
    "",
    "<second> ::= <c> | <d>",
    "    | <e>",
    "",
    "<third-rule>::=<f>",
    "",
  ].join("\n"),
  rbnf: [
    "<first>   ::=   <a> |<b>   ; one",
    "",
    "<second> ::= <c> | <d>",
    "    | <e>",
    "",
    "<third-rule>::=<f>",
    "",
  ].join("\n"),
};

function full(text: string, dialect: GrammarDialect): string {
  const doc = createDocument(`/w/g.${dialect}`, text, dialect);
  const edits = new GrammarFormattingProvider().provideDocumentFormattingEdits(
    asTextDocument(doc),
    {} as never,
    {} as never,
  ) as unknown as Edit[];
  return applyTextEdits(text, edits);
}

function ranged(
  text: string,
  dialect: GrammarDialect,
  range: RangeMock,
  token?: unknown,
): Edit[] {
  const doc = createDocument(`/w/g.${dialect}`, text, dialect);
  return new GrammarRangeFormattingProvider().provideDocumentRangeFormattingEdits(
    asTextDocument(doc),
    range as never,
    {} as never,
    token as never,
  ) as unknown as Edit[];
}

const lineCount = (text: string) => text.split(/\r\n|\n|\r/).length;
const wholeDocument = (text: string) => new RangeMock(0, 0, lineCount(text), 0);

describe("range formatting provider", () => {
  for (const dialect of ["abnf", "ebnf", "bnf", "rbnf"] as const) {
    describe(dialect, () => {
      const text = SAMPLES[dialect];

      test("formatting the whole document by range equals full formatting", () => {
        const expected = full(text, dialect);
        expect(expected).not.toBe(text);
        expect(
          applyTextEdits(text, ranged(text, dialect, wholeDocument(text))),
        ).toBe(expected);
      });

      test("only the rule under the range is touched", () => {
        const expected = full(text, dialect).split("\n");
        const original = text.split("\n");
        // A one-character selection inside the second rule.
        const edits = ranged(text, dialect, new RangeMock(2, 3, 2, 4));
        const result = applyTextEdits(text, edits).split("\n");
        // Rule two spans original lines 2-3; everything else is untouched.
        expect(result[0]).toBe(original[0]);
        expect(result[1]).toBe(original[1]);
        expect(result.at(-3)).toBe(original.at(-3));
        expect(result.at(-2)).toBe(original.at(-2));
        const secondFirstLine = expected.findIndex((line) =>
          line.includes(
            dialect === "bnf" || dialect === "rbnf"
              ? "<second>"
              : dialect === "abnf"
                ? "second"
                : "Second",
          ),
        );
        const rule = [expected[secondFirstLine], expected[secondFirstLine + 1]];
        expect(result.slice(2, 4)).toEqual(rule as string[]);
        for (const edit of edits) {
          expect(edit.range.start.line).toBeGreaterThanOrEqual(2);
          expect(edit.range.end.line).toBeLessThanOrEqual(3);
        }
      });

      test("a range between rules or inside blank lines edits nothing", () => {
        expect(ranged(text, dialect, new RangeMock(1, 0, 1, 0))).toEqual([]);
        expect(ranged(text, dialect, new RangeMock(4, 0, 4, 0))).toEqual([]);
      });

      test("a selection ending at column 0 leaves the next rule alone", () => {
        const edits = ranged(text, dialect, new RangeMock(0, 0, 2, 0));
        expect(Math.max(...edits.map((e) => e.range.end.line))).toBe(0);
      });

      test("an already formatted document produces no edits", () => {
        const formatted = full(text, dialect);
        expect(ranged(formatted, dialect, wholeDocument(formatted))).toEqual(
          [],
        );
      });

      test("CRLF line endings are kept", () => {
        const crlf = text.replace(/\n/g, "\r\n");
        const result = applyTextEdits(
          crlf,
          ranged(crlf, dialect, wholeDocument(crlf)),
        );
        expect(result).toBe(full(crlf, dialect));
        expect(result.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
      });
    });
  }

  test("empty and whitespace documents and cancellation give no edits", () => {
    expect(ranged("", "abnf", new RangeMock(0, 0, 0, 0))).toEqual([]);
    expect(ranged("  \n\n", "ebnf", new RangeMock(0, 0, 2, 0))).toEqual([]);
    expect(
      ranged(SAMPLES.abnf, "abnf", wholeDocument(SAMPLES.abnf), {
        isCancellationRequested: true,
      }),
    ).toEqual([]);
  });

  test("aligns with neighbouring rules like full formatting", () => {
    const text = "a = x\nlonger-name = y\nb = z\n";
    const edits = ranged(text, "abnf", new RangeMock(0, 0, 0, 5));
    expect(applyTextEdits(text, edits)).toBe(
      "a           = x\nlonger-name = y\nb = z\n",
    );
  });

  test("blank lines between rules are outside every rule and stay as they are", () => {
    const text = "a = b\nc = d\n";
    expect(full(text, "abnf")).toBe("a = b\n\nc = d\n");
    expect(ranged(text, "abnf", wholeDocument(text))).toEqual([]);
  });

  test("rules with syntax errors stay verbatim", () => {
    const text = "a   =   (b\n\nc   =   d\n";
    const edits = ranged(text, "abnf", wholeDocument(text));
    expect(applyTextEdits(text, edits)).toBe("a   =   (b\n\nc = d\n");
  });

  test("respects formatter settings", () => {
    setConfigurationValue("bnf.formatting.alternativeIndent", "indent");
    setConfigurationValue("bnf.formatting.continuationIndent", 2);
    const text = "r = a / b\n";
    const expected = full(text, "abnf");
    expect(expected).toBe("r = a\n  / b\n");
    expect(
      applyTextEdits(text, ranged(text, "abnf", new RangeMock(0, 0, 0, 3))),
    ).toBe(expected);
  });

  test("production rules with comments format by range too", () => {
    const text = "A ::= B\n  /* inner */ | C\n\nD ::=   E\n";
    const expected = full(text, "ebnf");
    expect(
      applyTextEdits(text, ranged(text, "ebnf", wholeDocument(text))),
    ).toBe(expected);
  });
});
