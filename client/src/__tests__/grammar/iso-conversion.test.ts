import { beforeAll, describe, expect, test } from "bun:test";
import "../vscode-mock.ts";

let iso: typeof import("../../grammar/iso-conversion.ts");
let grammar: typeof import("../../grammar/grammar.ts");

beforeAll(async () => {
  iso = await import("../../grammar/iso-conversion.ts");
  grammar = await import("../../grammar/grammar.ts");
});

function convert(text: string): { text: string; reason?: string } {
  const statements = iso.convertIsoText(text, 0, text.length);
  const refused = statements.find((s) => !s.convertible);
  if (refused) {
    return { text, ...(refused.reason ? { reason: refused.reason } : {}) };
  }
  const edits = statements
    .flatMap((s) => s.edits)
    .sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  for (const edit of edits) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return { text: out };
}

describe("ISO conversion of empty groups", () => {
  describe.each([
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ] as const)("%s %s", (open, close) => {
    const empty = `${open} ${close}`;

    test.each([
      [`a = ${empty} , "x" ;`, 'a ::= "x"'],
      [`a = "x" , ${empty} , "y" ;`, 'a ::= "x" "y"'],
      [`a = "x" , ${empty} ;`, 'a ::= "x"'],
    ])("drops the empty group in %p", (input, expected) => {
      const out = convert(input);

      expect(out.text).toBe(expected);
    });

    test.each([
      [`a = "x",${open}${close},"y";`, 'a ::= "x" "y"'],
      [`a = "x" , ${empty} , ${empty} , "y" ;`, 'a ::= "x" "y"'],
      [`a = "x" , ${empty} , ${empty} ;`, 'a ::= "x"'],
    ])(
      "drops empty groups written without spaces or in sequence: %p",
      (input, expected) => {
        const out = convert(input);

        expect(out.text).toBe(expected);
      },
    );

    test("produces output that re-parses without diagnostics", () => {
      const out = convert(`a = ${empty} , "x" , ${empty} ;`).text;

      const document = grammar.parseGrammar(out, "ebnf");

      expect(document.diagnostics).toHaveLength(0);
    });

    test.each([
      (e: string) => e,
      (e: string) => `${e} | "x"`,
      (e: string) => `"x" | ${e}`,
      (e: string) => `"x" | ${e} | "y"`,
      (e: string) => `( ${e} )`,
    ])("refuses a body that is only an empty group (variant %#)", (body) => {
      const out = convert(`a = ${body(empty)} ;`);

      expect(out.reason).toBe("empty group");
    });
  });

  test("refuses an empty group used as a repetition element", () => {
    const out = convert('a = 2 * { } , "x" ;');

    expect(out.reason).toBe("empty group");
  });

  test("converts non-empty groups normally", () => {
    const out = convert('a = { "x" } , [ "y" ] ;');

    expect(out.text).toBe('a ::= "x"* "y"?');
  });
});
