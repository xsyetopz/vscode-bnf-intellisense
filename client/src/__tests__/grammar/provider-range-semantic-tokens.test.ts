import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { GrammarDialect } from "../../grammar/dialects.ts";
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

interface Entry {
  range: RangeMock;
  tokenType: string;
  tokenModifiers: readonly string[];
}

const SAMPLES: Record<GrammarDialect, string> = {
  abnf: 'rule = a / ALPHA ; note\r\n    / "x" %x41-5A\r\na = DIGIT\r\n',
  ebnf: "Rule ::= A | [#x20-#x21] /* multi\n   line\n   comment */\n  | 'x'\nA ::= #xA\n",
  bnf: '<rule> ::= <a> | "x" ; note\n    | <a>\n<a> ::= "y"\n',
  rbnf: "<rule> ::= <a> [ <b> ] ...\n; note\n<a> ::= 'q'\n",
};

function tokens(
  text: string,
  dialect: GrammarDialect,
  range?: RangeMock,
): Entry[] {
  const provider = new GrammarSemanticTokensProvider(createWorkspace());
  const doc = asTextDocument(
    createDocument(`/workspace/s.${dialect}`, text, dialect),
  );
  const result = (range
    ? provider.provideDocumentRangeSemanticTokens(
        doc,
        range as never,
        {} as never,
      )
    : provider.provideDocumentSemanticTokens(doc, {} as never)) as unknown as {
    data: Entry[];
  };
  return result.data;
}

const key = (entry: Entry) =>
  `${entry.range.start.line}:${entry.range.start.character}-${entry.range.end.character}:${entry.tokenType}:${entry.tokenModifiers.join(",")}`;

function startsWithin(entry: Entry, range: RangeMock): boolean {
  const { line, character } = entry.range.start;
  const after =
    line > range.start.line ||
    (line === range.start.line && character >= range.start.character);
  const before =
    line < range.end.line ||
    (line === range.end.line && character < range.end.character);
  return after && before;
}

describe("range semantic tokens", () => {
  for (const dialect of ["abnf", "ebnf", "bnf", "rbnf"] as const) {
    test(`${dialect}: every range equals the full tokens cut to the range`, () => {
      const text = SAMPLES[dialect];
      const full = tokens(text, dialect);
      expect(full.length).toBeGreaterThan(3);
      const lines = text.split(/\r\n|\n/).length;
      for (let from = 0; from <= lines; from++) {
        for (let to = from; to <= lines; to++) {
          const range = new RangeMock(from, 0, to, 0);
          expect(tokens(text, dialect, range).map(key)).toEqual(
            full.filter((entry) => startsWithin(entry, range)).map(key),
          );
        }
      }
    });

    test(`${dialect}: adjacent ranges partition the full result`, () => {
      const text = SAMPLES[dialect];
      const full = tokens(text, dialect).map(key);
      const lines = text.split(/\r\n|\n/).length;
      const parts: string[] = [];
      for (let line = 0; line <= lines; line++) {
        parts.push(
          ...tokens(text, dialect, new RangeMock(line, 0, line + 1, 0)).map(
            key,
          ),
        );
      }
      expect(parts).toEqual(full);
    });
  }

  test("a range inside a multi-line comment keeps its per-line tokens", () => {
    const text = SAMPLES.ebnf;
    const result = tokens(text, "ebnf", new RangeMock(1, 0, 3, 0));
    expect(result.map((entry) => entry.tokenType)).toEqual([
      "comment",
      "comment",
    ]);
    expect(result.map((entry) => entry.range.start.line)).toEqual([1, 2]);
  });

  test("a range may start mid-line", () => {
    const text = "a ::= b | c\n";
    const result = tokens(text, "ebnf", new RangeMock(0, 6, 0, 9));
    expect(result.map((entry) => entry.range.start.character)).toEqual([6, 8]);
  });

  test("empty and out-of-range requests give empty results", () => {
    expect(tokens("", "abnf", new RangeMock(0, 0, 0, 0))).toEqual([]);
    expect(tokens("a = b\n", "abnf", new RangeMock(5, 0, 9, 0))).toEqual([]);
    expect(tokens("a = b\n", "abnf", new RangeMock(0, 3, 0, 3))).toEqual([]);
  });

  test("mode off returns nothing, on and auto follow the full document", () => {
    const text = SAMPLES.bnf;
    const range = new RangeMock(0, 0, 1, 0);
    setConfigurationValue("bnf.semanticHighlighting.mode", "off");
    expect(tokens(text, "bnf", range)).toEqual([]);
    setConfigurationValue("bnf.semanticHighlighting.mode", "auto");
    // The limit is judged on the whole document, so a range reduces to the
    // same rule names and references as the full result does.
    setConfigurationValue("bnf.semanticHighlighting.maxTokens", 5);
    const reduced = tokens(text, "bnf").filter(
      (entry) => entry.range.start.line < 1,
    );
    expect(reduced.length).toBeGreaterThan(0);
    expect(tokens(text, "bnf", range)).toEqual(reduced);
    setConfigurationValue("bnf.semanticHighlighting.mode", "on");
    expect(tokens(text, "bnf", range).length).toBeGreaterThan(reduced.length);
  });
});
