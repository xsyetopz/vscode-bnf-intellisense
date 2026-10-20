import { describe, expect, test } from "bun:test";
import "../vscode-mock.ts";
import { formatProductionGrammarDocument } from "../../grammar/format.ts";

const config = {
  alignEquals: true,
  alignProductionNumbers: true,
  alternativeIndent: "align" as const,
  blankLinesBetweenRules: 1,
  breakAlternatives: "always" as const,
  continuationIndent: 4,
  insertFinalNewline: true,
  maxLineLength: 80,
  preserveCommentSpacing: true,
  spaceBeforeInlineComment: 2,
  trimTrailingBlankLines: true,
};

function format(
  text: string,
  dialect: "bnf" | "ebnf" | "rbnf",
  overrides: Partial<{
    [K in keyof typeof config]: (typeof config)[K] extends string
      ? string
      : (typeof config)[K];
  }> = {},
): string {
  return formatProductionGrammarDocument(text, dialect, {
    ...config,
    ...overrides,
  } as typeof config);
}

function compact(text: string): string {
  return text.replace(/\s+/g, "");
}

describe("production grammar formatter", () => {
  test("aligns BNF assignments and breaks top-level alternatives", () => {
    const formatted = formatProductionGrammarDocument(
      '<value> ::= <object> | <array> | <string>\n<longer-name> ::= "x"\n',
      "bnf",
      config,
    );
    expect(formatted).toContain(
      "<value>       ::= <object>\n                  | <array>\n                  | <string>",
    );
    expect(formatted).toContain('<longer-name> ::= "x"');
  });

  test("keeps nested EBNF choices inline", () => {
    const formatted = formatProductionGrammarDocument(
      'char ::= unescaped | "\\\\" ("quote" | "/")\n',
      "ebnf",
      config,
    );
    expect(formatted).toContain(
      'char ::= unescaped\n         | "\\\\" ("quote" | "/")',
    );
  });

  test("aligns RBNF names with spaces", () => {
    const formatted = formatProductionGrammarDocument(
      '<JSON text> ::= <WS> <value> <WS>\n<digit one through nine> ::= "1" | "2"\n',
      "rbnf",
      config,
    );
    expect(formatted).toContain(
      "<JSON text>              ::= <WS> <value> <WS>",
    );
    expect(formatted).toContain(
      '<digit one through nine> ::= "1"\n                             | "2"',
    );
  });

  test("can disable EBNF production number alignment", () => {
    const formatted = formatProductionGrammarDocument(
      "[1] document ::= prolog element\n[123] content ::= CharData\n",
      "ebnf",
      { ...config, alignProductionNumbers: false, breakAlternatives: "never" },
    );
    expect(formatted).toContain("[1] document ::= prolog element");
    expect(formatted).toContain("[123] content");
    expect(formatted).toContain("::= CharData");
  });

  test("trims trailing blank lines and normalizes inline comment spacing", () => {
    const formatted = formatProductionGrammarDocument(
      "value ::= item;note\n\n\n",
      "bnf",
      config,
    );
    expect(formatted).toBe("value ::= item  ;note\n");
  });

  describe("character classes", () => {
    test("keeps a semicolon inside a character class", () => {
      const input = "a ::= [^;] | b\n";

      const out = format(input, "ebnf");

      expect(compact(out)).toBe("a::=[^;]|b");
      expect(out).toContain("[^;]");
    });

    test("keeps a comment opener inside a character class", () => {
      const out = format("a ::= [/*] | b\n", "ebnf");

      expect(out).toContain("[/*]");
    });

    test("leaves a lone class rule unchanged", () => {
      const out = format("a ::= [^;]\n", "ebnf", {
        breakAlternatives: "never",
      });

      expect(out).toBe("a ::= [^;]\n");
    });

    test("does not count angle brackets in a class as nesting", () => {
      const out = format("a ::= [^<] | b | c\n", "ebnf");

      expect(out).toBe("a ::= [^<]\n      | b\n      | c\n");
    });

    test("does not count parentheses in a class as nesting", () => {
      const out = format("a ::= ( [)] | b ) | c\n", "ebnf");

      expect(out).toBe("a ::= ( [)] | b )\n      | c\n");
    });
  });

  describe("blankLinesBetweenRules", () => {
    const text = "a ::= 'x'\nb ::= 'y'\n";

    test("0 puts no blank line between rules", () => {
      const out = format(text, "ebnf", { blankLinesBetweenRules: 0 });

      expect(out).toBe(text);
    });

    test("1 puts one blank line between rules", () => {
      const out = format(text, "ebnf", { blankLinesBetweenRules: 1 });

      expect(out).toBe("a ::= 'x'\n\nb ::= 'y'\n");
    });

    test("2 puts two blank lines between rules", () => {
      const out = format(text, "ebnf", { blankLinesBetweenRules: 2 });

      expect(out).toBe("a ::= 'x'\n\n\nb ::= 'y'\n");
    });

    test("2 collapses a longer run of blank lines to two", () => {
      const out = format("a ::= 'x'\n\n\n\n\nb ::= 'y'\n", "ebnf", {
        blankLinesBetweenRules: 2,
      });

      expect(out).toBe("a ::= 'x'\n\n\nb ::= 'y'\n");
    });

    test("adds a blank line after a multi-line rule", () => {
      const out = format("a ::= 'x'\n  | 'y'\nb ::= 'z'\n", "ebnf");

      expect(out).toBe("a ::= 'x'\n      | 'y'\n\nb ::= 'z'\n");
    });
  });

  describe("comments", () => {
    test("does not reformat rule-looking lines inside block comments", () => {
      const text = "/*\nfoo   ::=   a | b\n*/\nx ::= 'y'\n";

      const out = format(text, "ebnf");

      expect(out).toBe(text);
    });

    test("keeps the lines of a rule with comments between alternatives", () => {
      const text = "a ::= 'x' /* one */\n    | 'y' /* two */\n";

      const out = format(text, "ebnf");

      expect(out).toContain("/* one */");
      expect(out).toContain("/* two */");
      expect(out.split("\n")).toHaveLength(3);
    });

    test("is stable for a rule with comments between alternatives", () => {
      const out = format("a ::= 'x' /* one */\n    | 'y' /* two */\n", "ebnf");

      expect(format(out, "ebnf")).toBe(out);
    });

    test("keeps a trailing comment containing a bar in BNF", () => {
      const out = format('<a> ::= "x" ; c | d\n', "bnf");

      expect(out).toBe('<a> ::= "x"  ; c | d\n');
    });

    test("keeps a trailing block comment in EBNF", () => {
      const out = format("a ::= b /* c */\n", "ebnf");

      expect(out).toBe("a ::= b  /* c */\n");
    });

    test("keeps a comment that precedes a rule on the same line", () => {
      const out = format("/* c */ a ::= b | c\nb ::= 'x'\n", "ebnf");

      expect(out).toContain("/* c */");
      expect(out.indexOf("/* c */")).toBeLessThan(out.indexOf("a ::="));
      expect(format(out, "ebnf")).toBe(out);
    });

    test("keeps a same-line comment before a rule whose body has a multi-line comment", () => {
      const out = format("/* c */ a ::= b /* d\n e */\n", "ebnf");

      expect(out).toContain("/* c */");
      expect(out).toContain("/* d");
    });

    test("keeps a multi-line comment ahead of a rule on its closing line", () => {
      const out = format("/* a\n b */ x ::= y | z\n", "ebnf");

      expect(out).toContain("b */ x");
    });
  });

  test("re-indents continuation lines after realigning", () => {
    const text = "aaaaaaaa ::= 'x'\n      | 'y'\nb ::= 'z' | 'w'\n";

    const out = format(text, "ebnf");

    expect(out).toBe(
      "aaaaaaaa ::= 'x'\n             | 'y'\n\nb        ::= 'z'\n             | 'w'\n",
    );
  });

  test("emits a rule with unbalanced delimiters verbatim", () => {
    const text = "a   ::=   ( 'x'  |  'y'\nb ::= 'z'\n";

    const out = format(text, "ebnf");

    expect(out).toContain("a   ::=   ( 'x'  |  'y'");
  });

  describe("alternativeIndent", () => {
    const text = '<long name> ::= "a" | "b"\n';

    test("align lines alternatives up under the first one", () => {
      const out = format(text, "bnf");

      expect(out).toContain(`\n${" ".repeat(16)}| "b"`);
    });

    test("indent uses the continuation indent", () => {
      const out = format(text, "bnf", { alternativeIndent: "indent" });

      expect(out).toBe('<long name> ::= "a"\n    | "b"\n');
    });
  });

  test("pads production numbers so names line up", () => {
    const text =
      "[1] document ::= prolog\n[10] AttValue ::= 'x'\n[100] z ::= 'q'\n";

    const out = format(text, "ebnf", { blankLinesBetweenRules: 0 });

    expect(out.split("\n").slice(0, 3)).toEqual([
      "[1]   document ::= prolog",
      "[10]  AttValue ::= 'x'",
      "[100] z        ::= 'q'",
    ]);
  });

  describe("line endings", () => {
    test.each(["\r\n", "\r"])("preserves %p line endings", (eol) => {
      const text = `a ::= 'x' | 'y'${eol}b ::= 'z'${eol}`;

      const out = format(text, "ebnf");

      expect(out).toBe(`a ::= 'x'${eol}      | 'y'${eol}${eol}b ::= 'z'${eol}`);
      expect(out.replace(/\r\n|\r/g, "")).not.toContain("\n");
    });

    test.each(["\r\n", "\r"])("is idempotent with %p line endings", (eol) => {
      const out = format(`a ::= 'x' | 'y'${eol}b ::= 'z'${eol}`, "ebnf");

      expect(format(out, "ebnf")).toBe(out);
    });
  });

  test("keeps the bar of an empty trailing alternative", () => {
    const out = format('<a> ::= "x" |\n', "bnf");

    expect(out).toContain("|");
  });

  test("does not let a W3C backslash string hide the following alternative", () => {
    const out = format('a ::= "\\" | b\n', "ebnf");

    expect(out).toBe('a ::= "\\"\n      | b\n');
  });

  test.each([
    ["<o\n  ect> ::= 'x'\n", "bnf"],
    ["a ::= [#x\n 7F-#x1FFF]\n", "ebnf"],
    ["a ::= b [WFC: PEs in Inter\nnal Subset]\n", "ebnf"],
  ] as const)(
    "leaves brackets split across lines unchanged in %p",
    (text, dialect) => {
      const out = format(text, dialect);

      expect(out).toBe(text);
    },
  );

  test("keeps a rule followed by column-0 garbage verbatim", async () => {
    const { parseProductionGrammar } = await import("../../grammar/parser.ts");
    const text = "a ::= b\ngarbage\n";

    const out = format(text, "ebnf");

    expect(out).toBe(text);
    const messages = parseProductionGrammar(text, "ebnf").diagnostics.map(
      (d) => d.message,
    );
    expect(messages.some((m) => m.includes("column 0"))).toBe(true);
  });
});
