import { beforeAll, describe, expect, test } from "bun:test";
import { growthForFourfoldInput, MAX_LINEAR_GROWTH } from "../scaling.ts";
import "../vscode-mock.ts";
import type { GrammarDialect } from "../../grammar/dialects.ts";
import {
  lexProductionGrammar,
  scanProductionGrammar,
} from "../../grammar/scanner.ts";
import { tokenizeGrammar } from "../../grammar/tokenizer.ts";

let grammar: typeof import("../../grammar/grammar.ts");
let diagnostics: typeof import("../../grammar/diagnostics.ts");

beforeAll(async () => {
  grammar = await import("../../grammar/grammar.ts");
  diagnostics = await import("../../grammar/diagnostics.ts");
});

function analyze(text: string, dialect: GrammarDialect) {
  const document = grammar.parseGrammar(text, dialect);
  const symbolTable = grammar.buildGrammarSymbolTable(document, dialect);
  const messages = diagnostics
    .collectGrammarDiagnostics({ dialect, document, symbolTable }, text)
    .map((diagnostic) => diagnostic.message);
  const refs = (index: number) =>
    document.rules[index]?.references.map((ref) => ref.name) ?? [];
  return { document, messages, refs };
}

const hasMessage = (messages: string[], part: string) =>
  messages.some((m) => m.includes(part));

describe("production grammar scanner", () => {
  describe("quotes and character classes", () => {
    test("does not start a string at a quote inside an EBNF character class", () => {
      const { refs, messages } = analyze(
        `AttValue ::= '"' ([^<&"] | Reference)* '"'\nReference ::= 'x'\n`,
        "ebnf",
      );

      expect(refs(0)).toEqual(["Reference"]);
      expect(hasMessage(messages, "delimiter")).toBe(false);
    });

    test("reports no delimiter problem for quotes in classes next to quoted strings", () => {
      const { messages } = analyze(
        `SystemLiteral ::= ('"' [^"]* '"') | ("'" [^']* "'")\n`,
        "ebnf",
      );

      expect(hasMessage(messages, "delimiter")).toBe(false);
    });

    test("does not treat a semicolon or comment opener inside an EBNF class as a comment", () => {
      const tokens = tokenizeGrammar("a ::= [^;] | [/*] | b\n", "ebnf");

      expect(tokens.some((token) => token.kind === "comment")).toBe(false);
      expect(
        tokens.filter((token) => token.kind === "charClass").map((t) => t.text),
      ).toEqual(["[^;]", "[/*]"]);
    });

    test("gives W3C EBNF strings no escapes", () => {
      const { refs } = analyze(`a ::= "\\" | b\nb ::= 'q'\n`, "ebnf");

      expect(refs(0)).toEqual(["b"]);
    });

    test("tokenizes a backslash inside a W3C EBNF string as part of the literal", () => {
      const tokens = tokenizeGrammar(`a ::= "\\" | b\n`, "ebnf");

      expect(tokens.find((token) => token.kind === "literal")?.text).toBe(
        '"\\"',
      );
    });
  });

  describe("comments", () => {
    test("keeps references after an apostrophe in an EBNF comment", () => {
      const { refs } = analyze(
        `a ::= b /* don't */ c\n  | d 'x'\nb ::= 'q'\n`,
        "ebnf",
      );

      expect(refs(0)).toEqual(["b", "c", "d"]);
    });

    test("keeps references after an apostrophe in a BNF comment", () => {
      const { refs } = analyze(`<a> ::= <b> ; don't\n  | <c> 'x'\n`, "bnf");

      expect(refs(0)).toEqual(["<b>", "<c>"]);
    });

    test("keeps references after an apostrophe in a leading comment", () => {
      const { refs } = analyze(`/* don't */\na ::= b 'c'\nb ::= 'd'\n`, "ebnf");

      expect(refs(0)).toEqual(["b"]);
    });

    test("treats a semicolon in EBNF as ordinary syntax", () => {
      const { refs } = analyze("a ::= b ; c\nb ::= 'x'\nc ::= 'y'\n", "ebnf");

      expect(refs(0)).toEqual(["b", "c"]);
    });

    test("treats a semicolon in BNF as a comment", () => {
      const { refs } = analyze("<a> ::= <b> ; <c>\n", "bnf");

      expect(refs(0)).toEqual(["<b>"]);
    });

    test("does not define a rule from rule-looking text in a comment", () => {
      const { document, messages } = analyze(
        `a ::= b\n/*\n  foo ::= bar\n*/\nb ::= 'x'\n`,
        "ebnf",
      );

      expect(document.rules.map((rule) => rule.name)).toEqual(["a", "b"]);
      expect(hasMessage(messages, '"bar"')).toBe(false);
    });

    test("reports an unterminated comment and still sees later references", () => {
      const { messages, refs } = analyze(
        `a ::= b /* never closed\nb ::= 'x'\n`,
        "ebnf",
      );

      expect(hasMessage(messages, "Unterminated comment")).toBe(true);
      expect(refs(0)).toEqual(["b"]);
    });

    test("reports an unterminated string", () => {
      const { messages } = analyze(`a ::= "open\n`, "ebnf");

      expect(hasMessage(messages, "Unterminated string")).toBe(true);
    });
  });

  describe("references", () => {
    test("keeps self references as references", () => {
      const { refs } = analyze(
        `list ::= item | list "," item\nitem ::= "x"\n`,
        "ebnf",
      );

      expect(refs(0)).toEqual(["item", "list", "item"]);
    });

    test("records a self reference in the symbol table", () => {
      const { document } = analyze(
        `list ::= item | list "," item\nitem ::= "x"\n`,
        "ebnf",
      );

      const symbols = grammar.buildGrammarSymbolTable(document, "ebnf");

      expect(symbols.references.get("list")).toHaveLength(1);
    });

    test("tokenizes a self reference as a reference, its definition as a rule name", () => {
      const tokens = tokenizeGrammar(
        `list ::= item | list "," item\n`,
        "ebnf",
      ).filter((token) => token.text === "list");

      expect(tokens.map((token) => token.kind)).toEqual([
        "ruleName",
        "reference",
      ]);
    });

    test("counts rules named x as referenced", () => {
      const { messages, refs } = analyze(`a ::= x\nx ::= 'y'\n`, "ebnf");

      expect(refs(0)).toEqual(["x"]);
      expect(hasMessage(messages, '"x" is not referenced')).toBe(false);
    });

    test("keeps a reference named X", () => {
      const { refs } = analyze(`<a> ::= X\n`, "bnf");

      expect(refs(0)).toEqual(["X"]);
    });

    test("ignores bare words in an RBNF body for references", () => {
      const { refs } = analyze("<a> ::= foo ...\n", "rbnf");

      expect(refs(0)).toEqual([]);
    });
  });

  describe("character codes", () => {
    test("accepts #x inside strings and character classes", () => {
      const { messages } = analyze(`a ::= '&#x' [0-9a-fA-F]+ ';'\n`, "ebnf");

      expect(messages).not.toContain(
        "W3C XML EBNF character codes must use hexadecimal digits after #x",
      );
    });

    test("accepts #xZZ inside a string", () => {
      const { messages } = analyze(`a ::= "#xZZ" | 'q'\n`, "ebnf");

      expect(hasMessage(messages, "hexadecimal")).toBe(false);
    });

    test("reports a non-hexadecimal character code", () => {
      const { messages } = analyze("a ::= #xZZ\n", "ebnf");

      expect(hasMessage(messages, "hexadecimal")).toBe(true);
    });

    test("reports a non-hexadecimal character code inside a class", () => {
      const { messages } = analyze("a ::= [#xG]\n", "ebnf");

      expect(hasMessage(messages, "hexadecimal")).toBe(true);
    });
  });

  describe("line structure", () => {
    test("flags column-0 garbage between BNF rules", () => {
      const { messages } = analyze(
        `<a> ::= <b>\nthis is garbage\n<b> ::= "x"\n`,
        "bnf",
      );

      expect(hasMessage(messages, "column 0")).toBe(true);
    });

    test("does not flag an indented continuation line", () => {
      const { messages } = analyze(
        `<a> ::= <b>\n  | <b>\n<b> ::= "x"\n`,
        "bnf",
      );

      expect(hasMessage(messages, "column 0")).toBe(false);
    });

    test.each([
      ["hello world\na ::= 'x'\n", "ebnf"],
      ["<a> = 'x'\n", "bnf"],
      ["garbage\n<a> ::= 'x'\n", "bnf"],
    ] as const)(
      "reports unexpected tokens before the first rule in %p",
      (text, dialect) => {
        const { messages } = analyze(text, dialect);

        expect(hasMessage(messages, "Unexpected")).toBe(true);
      },
    );

    test("reports nothing for a single valid rule", () => {
      const { messages } = analyze("a ::= 'x'\n", "ebnf");

      expect(messages).toEqual([]);
    });
  });

  describe("rule names", () => {
    test("flags an ISO assignment after a rule", () => {
      const { messages } = analyze(`a ::= b\nb = 'x' ;\n`, "ebnf");

      expect(hasMessage(messages, "ISO/IEC 14977")).toBe(true);
    });

    test("ignores an ISO assignment inside a comment", () => {
      const { messages } = analyze(`a ::= 'x'\n/*\n b = c\n*/\n`, "ebnf");

      expect(hasMessage(messages, "ISO/IEC 14977")).toBe(false);
    });

    test("flags an angle-bracket rule name in EBNF", () => {
      const { messages } = analyze(`<a> ::= 'x'\n`, "ebnf");

      expect(hasMessage(messages, "not a valid rule name")).toBe(true);
    });

    test("flags a bare identifier on the right in RBNF", () => {
      const { messages } = analyze(`a ::= <b>\n`, "rbnf");

      expect(hasMessage(messages, "not a valid rule name")).toBe(true);
    });

    test("flags a tab inside an RBNF name", () => {
      const { messages } = analyze("<a\tb> ::= <c>\n", "rbnf");

      expect(hasMessage(messages, "one line")).toBe(true);
    });

    test("diagnoses a bare word in an RBNF body", () => {
      const { messages } = analyze("<a> ::= b\n", "rbnf");

      expect(hasMessage(messages, "bare word")).toBe(true);
    });

    test("accepts references and literals in an RBNF body", () => {
      const { messages } = analyze("<a> ::= <b> 'x'\n<b> ::= 'y'\n", "rbnf");

      expect(messages).toEqual([]);
    });
  });

  describe("exclusion", () => {
    test("hints at spaces for A-B written without them", () => {
      const document = grammar.parseGrammar(
        "a ::= b-c\nb ::= 'x'\nc ::= 'y'\n",
        "ebnf",
      );

      const hint = document.diagnostics.find((diagnostic) =>
        diagnostic.message.includes("exclusion"),
      );

      expect(hint?.message).toContain('"b - c"');
    });

    test("gives no exclusion hint for A - B", () => {
      const document = grammar.parseGrammar(
        "a ::= b - c\nb ::= 'x'\nc ::= 'y'\n",
        "ebnf",
      );

      expect(
        document.diagnostics.some((d) => d.message.includes("exclusion")),
      ).toBe(false);
    });

    test("tokenizes a spaced minus as an operator", () => {
      const tokens = tokenizeGrammar("a ::= b - c\n", "ebnf");

      expect(tokens.some((t) => t.kind === "operator" && t.text === "-")).toBe(
        true,
      );
    });
  });

  describe("name case sensitivity", () => {
    test("treats EBNF names that differ by case as distinct", () => {
      const { messages } = analyze(`Name ::= name\nname ::= 'x'\n`, "ebnf");

      expect(hasMessage(messages, "more than one")).toBe(false);
    });

    test("treats RBNF names that differ by case as distinct", () => {
      const { messages } = analyze(`<a> ::= <B C>\n<b c> ::= "x"\n`, "rbnf");

      expect(hasMessage(messages, '"<B C>" has no definition')).toBe(true);
    });

    test("normalizes names by dialect", () => {
      expect(grammar.normalizeSymbolName("Name", "ebnf")).toBe("Name");
      expect(grammar.normalizeSymbolName("Name", "abnf")).toBe("name");
    });

    test("resolves ABNF references regardless of case", () => {
      const { messages } = analyze(`a = B\nb = "x"\n`, "abnf");

      expect(hasMessage(messages, "no definition")).toBe(false);
    });
  });

  describe("ranges and doc comments", () => {
    test.each([["\r"], ["\r\n"], ["\n"]])(
      "computes positions correctly with %p line endings",
      (eol) => {
        const { document } = analyze(`a ::= 'x'${eol}b ::= a${eol}`, "ebnf");

        const ref = document.rules[1]?.references[0];

        expect(ref?.range.start.line).toBe(1);
        expect(ref?.range.start.character).toBe(6);
        expect(document.rules[1]?.nameRange.start.line).toBe(1);
      },
    );

    test("ends the definition range at the last token", () => {
      const { document } = analyze(
        `a ::= 'x'\n\n; about b\n\nb ::= 'y'\n`,
        "bnf",
      );

      expect(document.rules[0]?.definitionRange.end.line).toBe(0);
      expect(document.rules[0]?.definitionRange.end.character).toBe(9);
    });

    test("joins a multi-line block comment into the doc comment", () => {
      const { document } = analyze(
        `/* line one\n   line two */\na ::= 'x'\n`,
        "ebnf",
      );

      expect(document.rules[0]?.precedingComment).toBe("line one\nline two");
    });

    test("does not use a trailing inline comment as the next rule's doc comment", () => {
      const { document } = analyze(`a ::= 'x' ; trailing\nb ::= 'y'\n`, "bnf");

      expect(document.rules[1]?.precedingComment).toBeUndefined();
      expect(document.rules[0]?.definitionText).toBe("'x'");
    });
  });

  describe("performance and token kinds", () => {
    test("unclosed brackets are scanned in near-linear time", () => {
      const growth = growthForFourfoldInput((count) => {
        const text = `a ::= ${"[".repeat(count)}\n`;
        // Recent scans are remembered per text, so every run gets a text
        // that differs from the earlier ones and does real work.
        let run = 0;
        return () => {
          run++;
          scanProductionGrammar(`${text}${"\n".repeat(run)}`, "ebnf");
        };
      }, 50_000);
      const scan = scanProductionGrammar(
        `a ::= ${"[".repeat(200_000)}\n`,
        "ebnf",
      );

      expect(growth).toBeLessThan(MAX_LINEAR_GROWTH);
      expect(scan.productions).toHaveLength(1);
    });

    test.each([
      [
        "unclosed openers after a head",
        (n: number) => `a ::= y\n${"  x (* c\n".repeat(n)}`,
      ],
      ["nested unclosed openers", (n: number) => `${"(* (* (*\n".repeat(n)}`],
      [
        "unclosed openers in a headless document",
        (n: number) => `${"x (* c\n".repeat(n)}`,
      ],
    ])(
      "unclosed ISO openers are scanned in near-linear time: %s",
      (_name, build) => {
        const growth = growthForFourfoldInput((count) => {
          const text = build(count);
          return () => {
            lexProductionGrammar(text, "ebnf");
          };
        }, 2000);

        expect(growth).toBeLessThan(MAX_LINEAR_GROWTH);
      },
    );

    test("scans a large run of unclosed ISO openers in near-linear time", () => {
      const build = (n: number) => `a ::= y\n${"  x (* c\n".repeat(n)}`;

      const growth = growthForFourfoldInput((count) => {
        const text = build(count);
        // Recent scans are remembered per text, so every run gets a text
        // that differs from the earlier ones and does real work.
        let run = 0;
        return () => {
          run++;
          scanProductionGrammar(`${text}${"\n".repeat(run)}`, "ebnf");
        };
      }, 2000);
      const scan = scanProductionGrammar(build(50_000), "ebnf");

      expect(growth).toBeLessThan(MAX_LINEAR_GROWTH);
      expect(scan.productions).toHaveLength(1);
      expect(scan.unclosedIsoOpeners.size).toBe(50_000);
    });

    test("classifies character classes and annotations", () => {
      const scan = scanProductionGrammar("a ::= [x] [wfc: y] [^z]\n", "ebnf");

      expect(scan.tokens.map((t) => t.kind)).toEqual([
        "name",
        "assignment",
        "charClass",
        "annotation",
        "charClass",
      ]);
    });
  });

  describe("ISO comment opener token kinds", () => {
    const kindsOf = (text: string) =>
      scanProductionGrammar(text, "ebnf").tokens.map((t) => t.kind);

    test("(*) is a group, a repeat, and a group", () => {
      const kinds = kindsOf("a ::= (*)\n").slice(2);

      expect(kinds).toEqual(["group", "repeat", "group"]);
    });

    test("x(*c*)y is a name, a comment, and a name", () => {
      const kinds = kindsOf("a ::= x(*c*)y\n").slice(2);

      expect(kinds).toEqual(["name", "comment", "name"]);
    });

    test("[(*] is one character class", () => {
      const kinds = kindsOf("a ::= [(*]\n").slice(2);

      expect(kinds).toEqual(["charClass"]);
    });

    test('"(*" is one string', () => {
      const kinds = kindsOf('a ::= "(*"\n').slice(2);

      expect(kinds).toEqual(["string"]);
    });

    test("a CRLF multi-line comment is one comment", () => {
      const text = "a ::= x (* one\r\n  two *) y\r\n";

      const comments = scanProductionGrammar(text, "ebnf").tokens.filter(
        (t) => t.kind === "comment",
      );

      expect(comments).toHaveLength(1);
      expect(comments[0]?.text).toBe("(* one\r\n  two *)");
      expect(comments[0]?.iso).toBe(true);
    });

    test("nested comments match depth like a stack", () => {
      const text = "a ::= (* (* n *) *) b (* x\n";

      const comments = scanProductionGrammar(text, "ebnf").tokens.filter(
        (t) => t.kind === "comment",
      );

      expect(comments.map((c) => c.text)).toEqual(["(* (* n *) *)"]);
    });

    test("an opener stops at the next production head", () => {
      const scan = scanProductionGrammar(
        "a ::= x (* open\nb ::= y *)\n",
        "ebnf",
      );

      expect(scan.productions.map((p) => p.nameToken.text)).toEqual(["a", "b"]);
      expect(scan.unclosedIsoOpeners.get(8)).toBe("production");
    });
  });
});
