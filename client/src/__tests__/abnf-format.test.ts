import { describe, expect, test } from "bun:test";
import {
  type AbnfFormatterConfig,
  formatAbnfDocument,
} from "../abnf/format.ts";

const RULE_DEFINITION_RE = /^[A-Za-z][A-Za-z0-9-]*\s*=\/?/;

function defaultConfig(
  overrides?: Partial<AbnfFormatterConfig>,
): AbnfFormatterConfig {
  return {
    alignEquals: true,
    continuationIndent: 4,
    alternativeIndent: "align",
    insertFinalNewline: true,
    blankLinesBetweenRules: 1,
    breakAlternatives: "always",
    maxLineLength: 80,
    preserveContinuationLineBreaks: false,
    spaceBeforeInlineComment: 2,
    ...overrides,
  };
}

function ruleBodyLines(formatted: string): string[] {
  const lines = formatted.replace(/\r\n/g, "\n").split("\n");
  const body: string[] = [];
  let inRule = false;

  for (const line of lines) {
    if (RULE_DEFINITION_RE.test(line)) {
      inRule = true;
      continue;
    }
    if (!inRule) {
      continue;
    }
    if (line.trim().length === 0) {
      inRule = false;
      continue;
    }
    if (RULE_DEFINITION_RE.test(line)) {
      inRule = true;
      continue;
    }
    if (line.startsWith(";")) {
      inRule = false;
      continue;
    }
    body.push(line);
  }

  return body;
}

describe("ABNF formatter", () => {
  test("breaks alternatives onto indented lines by default", () => {
    const input = "r = a / b / c\n";

    const formatted = formatAbnfDocument(input, defaultConfig());

    expect(formatted).toContain("\n");
    expect(formatted).toContain("/ ");
    for (const line of ruleBodyLines(formatted)) {
      expect(line.startsWith(" ")).toBe(true);
    }
  });

  test("keeps alternatives inline in auto mode when they fit", () => {
    const input = "r = a / b / c\n";

    const formatted = formatAbnfDocument(
      input,
      defaultConfig({ breakAlternatives: "auto", maxLineLength: 80 }),
    );

    expect(formatted.trimEnd()).toBe("r = a / b / c");
  });

  test("wraps long concatenations onto indented continuation lines", () => {
    const input =
      "rule = a b c d e f g h i j k l m n o p q r s t u v w x y z\n";

    const formatted = formatAbnfDocument(
      input,
      defaultConfig({ breakAlternatives: "never", maxLineLength: 40 }),
    );

    const lines = formatted.trimEnd().split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i]?.startsWith(" ")).toBe(true);
    }
  });

  test("keeps continuation line breaks when preserveContinuationLineBreaks is on", () => {
    const input = "r = a b\n    c d\n";

    const formatted = formatAbnfDocument(
      input,
      defaultConfig({
        preserveContinuationLineBreaks: true,
        breakAlternatives: "never",
      }),
    );

    const lines = formatted.trimEnd().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[1]?.startsWith(" ")).toBe(true);
  });

  test("moves tokens after an inline comment onto the next line", () => {
    const input = "r = a ; comment\n    b\n";

    const formatted = formatAbnfDocument(
      input,
      defaultConfig({ breakAlternatives: "never" }),
    );

    const lines = formatted.trimEnd().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("; comment");
    expect(lines[0]).not.toContain(" b");
    expect(lines[1]?.trimStart()).toBe("b");
  });

  test("separates rules by the configured number of blank lines", () => {
    const input = "a = b\nc = d\n";

    const formatted = formatAbnfDocument(
      input,
      defaultConfig({ blankLinesBetweenRules: 2 }),
    );

    const lines = formatted.replace(/\r\n/g, "\n").trimEnd().split("\n");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("");
  });

  describe("indented continuation comments", () => {
    const input = [
      "ALPHA = %x41-5A / %x61-7A ; A-Z / a-z",
      "",
      "CHAR = %x01-7F",
      "    ; any 7-bit US-ASCII character,",
      "    ;  excluding NUL",
      "CR = %x0D",
      "    ; carriage return",
      "",
      "CRLF = CR LF",
      "    ; Internet standard newline",
      "",
    ].join("\n");
    const expected = [
      "ALPHA = %x41-5A",
      "        / %x61-7A  ; A-Z / a-z",
      "",
      "CHAR  = %x01-7F",
      "        ; any 7-bit US-ASCII character,",
      "        ;  excluding NUL",
      "",
      "CR    = %x0D",
      "        ; carriage return",
      "",
      "CRLF  = CR LF",
      "        ; Internet standard newline",
      "",
    ].join("\n");

    test("stay inside the rule they follow", () => {
      const formatted = formatAbnfDocument(input, defaultConfig());

      expect(formatted).toBe(expected);
    });

    test("are stable when formatted again", () => {
      const formatted = formatAbnfDocument(input, defaultConfig());

      expect(formatAbnfDocument(formatted, defaultConfig())).toBe(formatted);
    });

    test("are not read as the next rule's doc comment", async () => {
      const { parseAbnf } = await import("../abnf/parser.ts");
      const formatted = formatAbnfDocument(input, defaultConfig());

      const crlf = parseAbnf(formatted).rules.find((r) => r.name === "CRLF");

      expect(crlf?.precedingComment).toBe(undefined);
    });

    test("format the same with CRLF line endings", () => {
      const formatted = formatAbnfDocument(
        input.replace(/\n/g, "\r\n"),
        defaultConfig(),
      );

      expect(formatted).toBe(expected.replace(/\n/g, "\r\n"));
    });
  });

  test("keeps an indented comment after a blank line free-standing", async () => {
    const { parseAbnf } = await import("../abnf/parser.ts");
    const input = 'a = b\n\n    ; c\nb = "x"\n';

    const formatted = formatAbnfDocument(input, defaultConfig());

    expect(formatted).toBe(input);
    expect(formatAbnfDocument(formatted, defaultConfig())).toBe(formatted);
    expect(parseAbnf(formatted).rules[1]?.precedingComment).toBe(undefined);
  });
});
