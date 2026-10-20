import { describe, expect, test } from "bun:test";
import {
  type AbnfFormatterConfig,
  formatAbnfDocument,
} from "../abnf/format.ts";
import { tokenize } from "../abnf/tokenizer.ts";
import { AbnfTokenKind } from "../abnf/types.ts";

function config(overrides?: Partial<AbnfFormatterConfig>): AbnfFormatterConfig {
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

function significant(text: string): string[] {
  return tokenize(text)
    .filter(
      (t) =>
        t.kind !== AbnfTokenKind.Whitespace && t.kind !== AbnfTokenKind.Newline,
    )
    .map((t) => t.text);
}

const OPTION_SETS: Partial<AbnfFormatterConfig>[] = [
  {},
  { alternativeIndent: "indent", continuationIndent: 0 },
  { breakAlternatives: "never", maxLineLength: 20 },
  { alignEquals: false, preserveContinuationLineBreaks: true },
];

function expectSafe(input: string): void {
  for (const options of OPTION_SETS) {
    const once = formatAbnfDocument(input, config(options));
    expect(significant(once)).toEqual(significant(input));
    expect(formatAbnfDocument(once, config(options))).toBe(once);
  }
}

describe("ABNF formatter safety", () => {
  test("keeps the continuation when a column-0 comment sits inside a rule", () => {
    const input = 'a = b\n; note\n    / c\nb = "x"\nc = "y"\n';

    const out = formatAbnfDocument(input, config());

    expect(out).toContain("/ c");
    expect(out).toContain("; note");
    expectSafe(input);
  });

  test("keeps top-level junk verbatim", () => {
    const input = 'a = b\n) stray\n%x41\nb = "x"\n';

    const out = formatAbnfDocument(input, config());

    expect(out).toContain(") stray");
    expect(out).toContain("%x41");
    expectSafe(input);
  });

  test.each([0, -3, Number.NaN])(
    "clamps continuationIndent %p to at least one space",
    (continuationIndent) => {
      const input = "a = b / c / d\n";

      const out = formatAbnfDocument(
        input,
        config({ alternativeIndent: "indent", continuationIndent }),
      );

      const lines = out.split("\n").filter((l) => l.length > 0);
      for (const line of lines.slice(1)) {
        expect(line.startsWith(" ")).toBe(true);
      }
      expect(significant(out)).toEqual(significant(input));
      expectSafe(input);
    },
  );

  test("preserves CRLF line endings", () => {
    const crlf = 'a = b\r\n    / c\r\nb = "x"\r\nc = "y"\r\n';

    const out = formatAbnfDocument(crlf, config());

    expect(out.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(out.endsWith("\r\n")).toBe(true);
  });

  test("preserves CR line endings", () => {
    const cr = 'a = b\r    / c\rb = "x"\rc = "y"\r';

    const out = formatAbnfDocument(cr, config());

    expect(out).not.toContain("\n");
    expect(out.endsWith("\r")).toBe(true);
  });

  test("does not introduce CR into LF documents", () => {
    const lf = 'a = b\n    / c\nb = "x"\nc = "y"\n';

    const out = formatAbnfDocument(lf, config());

    expect(out).not.toContain("\r");
  });

  test("uses CRLF for inserted separators and final newline in CRLF documents", () => {
    const out = formatAbnfDocument("a = b\r\nb = c", config());

    expect(out).toBe("a = b\r\n\r\nb = c\r\n");
  });

  test.each(['true = %s"t" / / %s"f"\n', "a = / b\n", "a = b /\n"])(
    "keeps empty alternatives in %p",
    (input) => {
      const out = formatAbnfDocument(input, config());

      const slashes = (text: string) =>
        significant(text).filter((t) => t === "/");
      expect(slashes(out)).toHaveLength(slashes(input).length);
      expectSafe(input);
    },
  );

  test("emits rules with parse errors verbatim", () => {
    const input = 'a   =  (b   / c\nlonger = "x"   ; fine\n';

    const out = formatAbnfDocument(input, config());

    expect(out).toContain("a   =  (b   / c");
    expect(out).toContain('longer = "x"  ; fine');
    expectSafe(input);
  });

  test("leaves an unterminated string rule unchanged", () => {
    const input = 'a   =   "abc\n';

    const out = formatAbnfDocument(input, config());

    expect(out).toBe(input);
  });

  test("keeps comments between rules standalone", () => {
    const input = "a = b\n\n; doc for c\nc = d\n";

    const out = formatAbnfDocument(input, config());

    expect(out).toBe("a = b\n; doc for c\nc = d\n");
  });
});
