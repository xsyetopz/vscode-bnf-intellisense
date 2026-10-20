import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { GrammarDialect } from "../../grammar/dialects.ts";
import {
  PositionMock,
  resetConfigurationValues,
  setConfigurationValue,
  setLanguageConfigurationValue,
} from "../vscode-mock.ts";
import {
  applyTextEdits,
  asTextDocument,
  createDocument,
  loadGrammarTestCore,
} from "./provider-test-utils.ts";

let GrammarOnTypeFormattingProvider: typeof import("../../grammar/providers/on-type-formatting.ts").GrammarOnTypeFormattingProvider;
let ON_TYPE_FORMATTING_TRIGGERS: typeof import("../../grammar/providers/on-type-formatting.ts").ON_TYPE_FORMATTING_TRIGGERS;

beforeAll(async () => {
  await loadGrammarTestCore();
  ({ GrammarOnTypeFormattingProvider, ON_TYPE_FORMATTING_TRIGGERS } =
    await import("../../grammar/providers/on-type-formatting.ts"));
});

afterEach(() => {
  resetConfigurationValues();
});

/**
 * Types Enter: `before` is the text up to the cursor line, and the cursor is
 * on the line `line` of `text`, which already contains the new line.
 */
function enter(
  text: string,
  dialect: GrammarDialect,
  line: number,
  ch = "\n",
): string {
  const doc = createDocument(`/w/g.${dialect}`, text, dialect);
  const edits =
    new GrammarOnTypeFormattingProvider().provideOnTypeFormattingEdits(
      asTextDocument(doc),
      new PositionMock(line, 0) as never,
      ch,
      {} as never,
    ) as unknown as Array<{
      range: { start: PositionMock; end: PositionMock };
      newText: string;
    }>;
  return applyTextEdits(text, edits);
}

describe("on-type formatting provider", () => {
  test("only newline is a trigger", () => {
    expect([...ON_TYPE_FORMATTING_TRIGGERS]).toEqual(["\n"]);
    expect(enter("a = b |\n\n", "abnf", 1, ";")).toBe("a = b |\n\n");
  });

  test("indents under the first item after a trailing operator (align)", () => {
    expect(enter("a = b /\n\n", "abnf", 1)).toBe("a = b /\n    \n");
    expect(enter("expr ::= A |\n\n", "ebnf", 1)).toBe(
      "expr ::= A |\n         \n",
    );
    expect(enter("<a> ::= <b> |\n\n", "bnf", 1)).toBe(
      "<a> ::= <b> |\n        \n",
    );
    expect(enter("<a> ::= <b> |\n\n", "rbnf", 1)).toBe(
      "<a> ::= <b> |\n        \n",
    );
  });

  test("replaces auto-indentation that is wrong, keeps the right one", () => {
    expect(enter("a = b /\n  \n", "abnf", 1)).toBe("a = b /\n    \n");
    expect(enter("a = b /\n        \n", "abnf", 1)).toBe("a = b /\n    \n");
    expect(enter("a = b /\n    \n", "abnf", 1)).toBe("a = b /\n    \n");
  });

  test("indent mode and continuationIndent are respected", () => {
    setConfigurationValue("bnf.formatting.alternativeIndent", "indent");
    setConfigurationValue("bnf.formatting.continuationIndent", 2);
    expect(enter("a = b /\n\n", "abnf", 1)).toBe("a = b /\n  \n");
    expect(enter("A ::= B |\n\n", "ebnf", 1)).toBe("A ::= B |\n  \n");
    setConfigurationValue("bnf.formatting.continuationIndent", 0);
    expect(enter("a = b /\n\n", "abnf", 1)).toBe("a = b /\n \n");
  });

  test("per-language settings apply", () => {
    setLanguageConfigurationValue(
      "abnf",
      "bnf.formatting.alternativeIndent",
      "indent",
    );
    expect(enter("a = b /\n\n", "abnf", 1)).toBe(
      "a = b /\n    \n".replace("    ", "    "),
    );
    setLanguageConfigurationValue(
      "abnf",
      "bnf.formatting.continuationIndent",
      3,
    );
    expect(enter("a = b /\n\n", "abnf", 1)).toBe("a = b /\n   \n");
    expect(enter("A ::= B |\n\n", "ebnf", 1)).toBe("A ::= B |\n      \n");
  });

  test("an empty body and unclosed delimiters need a continuation", () => {
    expect(enter("a =\n\n", "abnf", 1)).toBe("a =\n    \n");
    expect(enter("A ::=\n\n", "ebnf", 1)).toBe("A ::=\n    \n");
    expect(enter("a = ( b\n\n", "abnf", 1)).toBe("a = ( b\n    \n");
  });

  test("splitting a rule line puts the tail where the formatter would", () => {
    // `a = b / c` split before `/ c`: the tail starts at column 0.
    expect(enter("a = b\n/ c\n", "abnf", 1)).toBe("a = b\n    / c\n");
    expect(enter("A ::= B\n| C\n", "ebnf", 1)).toBe("A ::= B\n      | C\n");
    // A tail inside a rule that goes on stays an operand.
    expect(enter("a = b\n     / c\n     / d\n", "abnf", 1)).toBe(
      "a = b\n     / c\n     / d\n",
    );
  });

  test("an existing alternative line in the rule sets the indent", () => {
    // A blank line inside a rule that goes on could take an operator or an
    // operand: nothing is edited.
    const text = "a = b\n  / c\n\n  / d\n";
    expect(enter(text, "abnf", 2)).toBe(text);
    const split = "a = b\n  / c\n/ d\n";
    expect(enter(split, "abnf", 2)).toBe("a = b\n  / c\n  / d\n");
  });

  test("wrapped lines sit two columns right of their operator", () => {
    const text = "a = b\n    / c d\n\n";
    // The cursor line after an operator line, with the rule unfinished.
    expect(enter("a = b\n    / c /\n\n", "abnf", 2)).toBe(
      "a = b\n    / c /\n      \n",
    );
    expect(enter(text, "abnf", 2)).toBe(text);
  });

  describe("leaves the document unchanged", () => {
    test.each([
      ["after a finished rule", "a = b\n\n", "abnf", 1],
      ["on a blank line after a comment", "; c\n\n", "abnf", 1],
      ["outside any rule", "\n\n", "abnf", 1],
      ["inside an open EBNF comment", "A ::= B /* open\n\n*/\n", "ebnf", 1],
      ["after an operator inside a comment", "a = b ; note |\nx\n", "abnf", 1],
      [
        "before an operator that starts inside a comment",
        "a = b ; no\n| te\n",
        "abnf",
        1,
      ],
      ["inside a string", 'a = "x |\n| y"\n', "abnf", 1],
      ["in an empty document", "", "abnf", 0],
      ["when the cursor is on the operator line", "a = b |\n\n", "abnf", 0],
    ] as const)("%s", (_label, text, dialect, line) => {
      expect(enter(text, dialect, line)).toBe(text);
    });
  });

  test("works with CRLF documents", () => {
    expect(enter("a = b /\r\n\r\n", "abnf", 1)).toBe("a = b /\r\n    \r\n");
    expect(enter("A ::= B\r\n| C\r\n", "ebnf", 1)).toBe(
      "A ::= B\r\n      | C\r\n",
    );
  });

  test("honours cancellation", () => {
    const doc = createDocument("/w/g.abnf", "a = b /\n\n", "abnf");
    expect(
      new GrammarOnTypeFormattingProvider().provideOnTypeFormattingEdits(
        asTextDocument(doc),
        new PositionMock(1, 0) as never,
        "\n",
        {} as never,
        { isCancellationRequested: true } as never,
      ),
    ).toEqual([]);
  });
});
