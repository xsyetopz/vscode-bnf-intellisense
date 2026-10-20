import { beforeAll, describe, expect, test } from "bun:test";
import "./vscode-mock.ts";

let parseAbnf: typeof import("../abnf/parser.ts").parseAbnf;
let buildAbnfSymbolTable: typeof import("../abnf/parser.ts").buildAbnfSymbolTable;

beforeAll(async () => {
  ({ parseAbnf, buildAbnfSymbolTable } = await import("../abnf/parser.ts"));
});

// DiagnosticSeverity values in the vscode mock.
const ERROR = 0;
const HINT = 3;

function messages(text: string, severity?: number): string[] {
  return parseAbnf(text)
    .diagnostics.filter(
      (d) => severity === undefined || d.severity === severity,
    )
    .map((d) => d.message);
}

describe("ABNF parser diagnostics", () => {
  describe("stray tokens", () => {
    test.each([
      ["a = b ) c\n", 'Unexpected ")"'],
      ["a = b & c\n", 'Unexpected "&"'],
      ['a = "x" ]\n', 'Unexpected "]"'],
      ["a = b\n  c = d\n", 'Unexpected "="'],
    ])("reports an error for %p", (text, message) => {
      const errors = messages(text, ERROR);

      expect(errors).toContain(message);
    });

    test("keeps references that follow a stray token", () => {
      const doc = parseAbnf('a = b ) c\nc = "x"\n');

      expect(doc.rules[0]?.references.map((r) => r.name)).toEqual(["b", "c"]);
    });

    test("keeps references on an indented line that looks like a rule", () => {
      const doc = parseAbnf("a = b\n  c = d\n");

      expect(doc.rules[0]?.references.map((r) => r.name)).toEqual([
        "b",
        "c",
        "d",
      ]);
    });
  });

  describe("lines that do not start a rule", () => {
    test("reports one error for a line without a definition", () => {
      expect(messages("a b\nc = x\n", ERROR)).toHaveLength(1);
    });

    test("requires a rule name to start with a letter", () => {
      expect(messages('1abc = "x"\n', ERROR)[0]).toContain(
        "must start with a letter",
      );
    });

    test("requires a rule definition to start in column 0", () => {
      expect(messages('  foo = "x"\n', ERROR)[0]).toContain("column 0");
    });

    test("reports a definition without a name", () => {
      expect(messages('= "x"\n', ERROR)[0]).toContain(
        "expected a rule definition",
      );
    });

    test("does not create a rule from an invalid name", () => {
      const doc = parseAbnf('1abc = "x"\nb = "y"\n');

      expect(doc.rules.map((r) => r.name)).toEqual(["b"]);
    });
  });

  test("reports a column-0 continuation line as an error", () => {
    const doc = parseAbnf('a = b\nc\nb = "x"\n');

    expect(doc.diagnostics).toHaveLength(1);
    expect(doc.diagnostics[0]?.severity).toBe(ERROR);
    expect(doc.diagnostics[0]?.message).toContain(
      "continuation lines must be indented",
    );
    expect(doc.diagnostics[0]?.range.start.line).toBe(1);
    expect(doc.rules.map((r) => r.name)).toEqual(["a", "b"]);
  });

  describe("strings and prose", () => {
    test.each([
      ['a = "abc\n', "Unterminated string"],
      ["a = <abc\n", "Unterminated prose"],
      ['a = %s"abc\n', "Unterminated string"],
    ])("reports an error for unterminated %p", (text, message) => {
      expect(messages(text, ERROR)[0]).toContain(message);
    });

    test.each(['a = "abc"\n', "a = <abc>\n"])(
      "accepts terminated %p",
      (text) => {
        expect(messages(text)).toEqual([]);
      },
    );

    test.each(['a = "xé"\n', 'a = "x\ty"\n', "a = <xé>\n"])(
      "warns about characters outside printable ASCII in %p",
      (text) => {
        expect(messages(text)[0]).toContain("outside printable ASCII");
      },
    );
  });

  describe("numeric values", () => {
    test.each([
      ["a = %x\n", "no digits"],
      ["a = %x41-\n", "missing its upper bound"],
      ["a = %x5A-41\n", "lower bound greater"],
      ["a = %d1F\n", "Invalid decimal digit"],
      ["a = %b102\n", "Invalid binary digit"],
      ["a = %q41\n", "Invalid numeric value"],
    ])("reports an error for %p", (text, message) => {
      expect(messages(text, ERROR)[0]).toContain(message);
    });

    test("reports an invalid hexadecimal digit exactly once", () => {
      expect(messages("a = %xG1\n", ERROR)).toEqual([
        'Invalid hexadecimal digit in numeric value "%xG1"',
      ]);
    });

    test("accepts valid ranges, sequences and bases", () => {
      expect(messages("a = %x41-5A / %x41.42.43 / %d65 / %b1010\n")).toEqual(
        [],
      );
    });

    test("does not read an invalid numeric value as a rule reference", () => {
      expect(parseAbnf("a = %q41\n").rules[0]?.references).toEqual([]);
    });

    test("reports one error for a doubled dot", () => {
      expect(messages("a = %x41..42\n", ERROR)).toEqual([
        'Invalid numeric value "%x41..42": expected "." followed by digits between values',
      ]);
    });

    test("reports one error for a range combined with concatenation", () => {
      expect(messages("a = %x41-42.43\n", ERROR)).toEqual([
        'Invalid numeric value "%x41-42.43": a range cannot be combined with "." concatenation',
      ]);
    });

    test("reports one error for a range with two dashes", () => {
      expect(messages("a = %x41-42-43\n", ERROR)).toEqual([
        'Invalid numeric value "%x41-42-43": a range takes exactly one "-"',
      ]);
    });

    test("accepts a dotted sequence next to a range", () => {
      expect(messages("a = %x41.42.43 / %x41-5A\n")).toEqual([]);
    });
  });

  describe("repetition", () => {
    test("reports an error when the minimum exceeds the maximum", () => {
      expect(messages('a = 5*3"x"\n', ERROR)[0]).toContain(
        "greater than its maximum",
      );
    });

    test("hints about 0*0 without reporting an error", () => {
      expect(messages('a = 0*0"x"\n', HINT)).toHaveLength(1);
      expect(messages('a = 0*0"x"\n', ERROR)).toEqual([]);
    });

    test("reports a repetition with no element", () => {
      expect(messages("a = 3*\n", ERROR)[0]).toContain("no element");
    });

    test("accepts the valid repetition forms", () => {
      expect(messages('a = 1*3"x" *"y" 2*"z" *2"w" 3"v"\n')).toEqual([]);
      expect(messages('a = 3*5"x" 2*b *c\n')).toEqual([]);
    });

    test("hints that 1*1 equals the element itself", () => {
      expect(messages('a = 1*1"x"\n', HINT)).toEqual([
        "Repetition 1*1 is the same as the element itself",
      ]);
    });

    test("accepts an exact count of 1", () => {
      expect(messages('a = 1"x"\n')).toEqual([]);
    });

    test.each(['a = 3* "x"\n', 'a = 3 *"x"\n', 'a = 3 * "x"\n'])(
      "reports whitespace inside the repetition in %p",
      (text) => {
        expect(messages(text, ERROR)).toEqual([
          'Whitespace is not allowed inside a repetition: write it as one unit, such as 3*"x"',
        ]);
      },
    );
  });

  describe("doc comments", () => {
    test("does not treat a trailing inline comment as the next rule's doc comment", () => {
      const doc = parseAbnf("a = b ; trailing\nc = d\n");

      expect(doc.rules[1]?.precedingComment).toBe(undefined);
    });

    test("uses a column-0 comment above a rule as its doc comment", () => {
      const doc = parseAbnf("a = b\n; doc for c\nc = d\n");

      expect(doc.rules[1]?.precedingComment).toBe("doc for c");
    });

    test("does not treat an indented comment as a doc comment", () => {
      const doc = parseAbnf("a = b\n  ; indented\nc = d\n");

      expect(doc.rules[1]?.precedingComment).toBe(undefined);
    });
  });

  describe("definition range", () => {
    test("ends at the last token, before a following comment", () => {
      const doc = parseAbnf("a = b\n; doc\nc = d\n");

      expect(doc.rules[0]?.definitionRange.end.line).toBe(0);
      expect(doc.rules[0]?.definitionRange.end.character).toBe(5);
    });

    test("ends at the last token of a multi-line rule, before its trailing comment", () => {
      const doc = parseAbnf("a = b\n    / c ; tail\n\nd = e\n");

      expect(doc.rules[0]?.definitionRange.end.line).toBe(1);
      expect(doc.rules[0]?.definitionRange.end.character).toBe(7);
    });

    test("ends after the equals sign for a rule with no elements", () => {
      const doc = parseAbnf("a =\n; c\nb = x\n");

      expect(doc.rules[0]?.definitionRange.end.character).toBe(3);
    });
  });

  test("keeps references on skipped non-rule lines", () => {
    const doc = parseAbnf('a = b\nc\nb = "x"\nc = "y"\n');

    const table = buildAbnfSymbolTable(doc);

    expect(doc.rules[0]?.references.map((r) => r.name)).toEqual(["b", "c"]);
    expect(table.references.has("c")).toBe(true);
  });

  describe("valid RFC-style grammar", () => {
    const text = [
      "; rule list",
      "rulelist = 1*( rule / (*c-wsp c-nl) )",
      "rule = rulename defined-as elements c-nl",
      "  ; continuation comment",
      '  / "x"',
      "",
      "; doc",
      'rulename = ALPHA *(ALPHA / DIGIT / "-")',
      "",
    ].join("\n");

    test("produces no diagnostics with LF line endings", () => {
      expect(parseAbnf(text).diagnostics).toEqual([]);
    });

    test("produces no diagnostics with CRLF line endings", () => {
      expect(parseAbnf(text.replace(/\n/g, "\r\n")).diagnostics).toEqual([]);
    });
  });
});

describe("ABNF empty groups", () => {
  test.each([
    ["a = ()\n", 'Empty group: "()" has nothing inside'],
    ["a = x ( ) y\n", 'Empty group: "()" has nothing inside'],
    ["a = []\n", 'Empty option: "[]" has nothing inside'],
    ["a = x / [ ]\n", 'Empty option: "[]" has nothing inside'],
  ])("%j is an error", (text, message) => {
    const found = parseAbnf(text).diagnostics.filter(
      (d) => d.code === "abnf.empty-group",
    );

    expect(found.map((d) => d.message)).toEqual([message]);
    expect(found[0]?.severity).toBe(ERROR);
  });

  test("groups with content are not reported", () => {
    const found = parseAbnf('a = ( "x" ) [ "y" ] *( "z" )\n').diagnostics;

    expect(found.filter((d) => d.code === "abnf.empty-group")).toEqual([]);
  });

  test.each(["a = *\n", "a = ( * )\n", "a = 3*\n"])(
    "%j reports a repetition with no element",
    (text) => {
      const codes = parseAbnf(text).diagnostics.map((d) => d.code);

      expect(codes).toContain("abnf.repetition-no-element");
    },
  );
});
