import { beforeAll, describe, expect, test } from "bun:test";
import "../vscode-mock.ts";
import type { GrammarDialect } from "../../grammar/dialects.ts";
import { repoText } from "../repo-file.ts";

let convert: typeof import("../../grammar/commands/convert-dialect.ts");
let formatting: typeof import("../../grammar/commands/format-converted.ts");
let grammar: typeof import("../../grammar/grammar.ts");
let gate: typeof import("../../grammar/commands/parse-gate.ts");
let readAbnf: typeof import("../../grammar/commands/read-abnf.ts").readAbnf;

beforeAll(async () => {
  convert = await import("../../grammar/commands/convert-dialect.ts");
  formatting = await import("../../grammar/commands/format-converted.ts");
  grammar = await import("../../grammar/grammar.ts");
  gate = await import("../../grammar/commands/parse-gate.ts");
  ({ readAbnf } = await import("../../grammar/commands/read-abnf.ts"));
});

function run(
  text: string,
  source: GrammarDialect,
  target: GrammarDialect,
  format = false,
): { text: string; warnings: string[] } {
  const result = convert.convertDialect(text, source, target, {
    ...(format
      ? { format: (out: string) => formatting.formatConverted(out, target) }
      : {}),
  });
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result;
}

/** One rule line of the output, found by its name. */
function ruleLine(text: string, name: string): string {
  const line = text
    .split("\n")
    .find((candidate) => /^\S/.test(candidate) && candidate.startsWith(name));
  if (line === undefined) {
    throw new Error(`no rule ${name} in:\n${text}`);
  }
  return line;
}

function problems(text: string, dialect: GrammarDialect): string | undefined {
  return gate.firstBlockingProblem(
    grammar.parseGrammar(text, dialect).diagnostics,
  );
}

function example(dialect: GrammarDialect): string {
  return repoText(`examples/json.${dialect}`);
}

describe("ABNF core rules", () => {
  test("used core rules are announced by a comment", () => {
    const out = run("a = 1*HEXDIG\n", "abnf", "ebnf");

    expect(out.text).toContain(
      "/* ABNF core rules (RFC 5234, Appendix B) used above */",
    );
  });

  test("a used core rule is added", () => {
    const out = run("a = 1*HEXDIG\n", "abnf", "ebnf");

    expect(ruleLine(out.text, "HEXDIG")).toBe(
      'HEXDIG ::= DIGIT | "a" | "A" | "b" | "B" | "c" | "C" | "d" | "D" | "e" | "E" | "f" | "F"',
    );
  });

  test("a core rule needed by a used core rule is added", () => {
    const out = run("a = 1*HEXDIG\n", "abnf", "ebnf");

    expect(ruleLine(out.text, "DIGIT")).toBe("DIGIT ::= [0-9]");
  });

  test("unused core rules are not added", () => {
    const out = run("a = 1*HEXDIG\n", "abnf", "ebnf");

    expect(out.text).not.toContain("ALPHA");
  });

  test("a core rule referenced in another case is resolved", () => {
    const out = run("a = 2digit\n", "abnf", "bnf");

    expect(ruleLine(out.text, "<a>")).toBe("<a> ::= <DIGIT> <DIGIT>");
  });

  test("a core rule referenced in another case is added", () => {
    const out = run("a = 2digit\n", "abnf", "bnf");

    expect(out.text).toContain("<DIGIT> ::=");
  });

  test("a rule that redefines a core rule is not replaced", () => {
    const out = run('a = DIGIT\nDIGIT = %s"x"\n', "abnf", "ebnf");

    expect(out.text.match(/^DIGIT ::=/gm)?.length).toBe(1);
  });

  test("a rule that redefines a core rule keeps its own body", () => {
    const out = run('a = DIGIT\nDIGIT = %s"x"\n', "abnf", "ebnf");

    expect(out.text).toContain('DIGIT ::= "x"');
  });

  test("transitive core rules keep their order", () => {
    const out = run("a = LWSP\n", "abnf", "ebnf");

    const names = grammar
      .parseGrammar(out.text, "ebnf")
      .rules.map((r) => r.name);
    expect(names).toEqual([
      "a",
      "CR",
      "CRLF",
      "HTAB",
      "LF",
      "LWSP",
      "SP",
      "WSP",
    ]);
  });

  test("an ABNF target never gets core rule copies", () => {
    const out = run("a ::= digit\ndigit ::= [0-9]\n", "ebnf", "abnf");

    expect(out.text).toContain("digit = %x30-39");
  });
});

describe("names and case", () => {
  const caseDiffers = 'Value = Item\nITEM = %s"x"\n';

  test("ABNF references in another case use the definition's spelling", () => {
    const out = run(caseDiffers, "abnf", "bnf");

    expect(ruleLine(out.text, "<Value>")).toBe("<Value> ::= <ITEM>");
  });

  test("ABNF names that differ only by case are reported", () => {
    const out = run(caseDiffers, "abnf", "bnf");

    expect(out.warnings).toEqual([
      'names "Item", "ITEM" differ only by case; ABNF treats them as one name, written as "ITEM"',
    ]);
  });

  test("case-sensitive names that differ only by case stay apart in BNF", () => {
    const out = run('A ::= a\na ::= "x"\n', "ebnf", "bnf");

    expect(out.text).toContain("<A> ::= <a>");
  });

  test("case-sensitive names that differ only by case give no warning", () => {
    const out = run('A ::= a\na ::= "x"\n', "ebnf", "bnf");

    expect(out.warnings).toEqual([]);
  });

  test("an undefined reference keeps its name", () => {
    const out = run("a = missing\n", "abnf", "ebnf");

    expect(out.text).toContain("a ::= missing");
  });

  test("an undefined reference gives no warning", () => {
    const out = run("a = missing\n", "abnf", "ebnf");

    expect(out.warnings).toEqual([]);
  });

  test.each([
    ["bnf", "<a> ::= <b>"],
    ["rbnf", "<a> ::= <b>"],
    ["ebnf", "a ::= b"],
  ] as const)("ABNF to %s writes the rule as %s", (target, expected) => {
    const text = 'a = b\nb = %s"x"\n';

    const out = run(text, "abnf", target);

    expect(out.text).toContain(expected);
  });

  test("BNF names without brackets and with brackets are the same name", () => {
    const out = run('a ::= b <b>\n<b> ::= "x"\n', "bnf", "ebnf");

    expect(out.text).toContain("a ::= b b");
  });
});

describe("exclusions, prose, and unsupported constructs", () => {
  const classDiff = "a ::= [a-z] - [aeiou]\n";

  test("a class difference is exact in ABNF", () => {
    const out = run(classDiff, "ebnf", "abnf");

    expect(out.text).toContain(
      "a = %x62-64 / %x66-68 / %x6A-6E / %x70-74 / %x76-7A",
    );
  });

  test("a class difference gives no warning in BNF", () => {
    const bnf = run(classDiff, "ebnf", "bnf");

    expect(bnf.warnings).toEqual([]);
  });

  test("a class difference is exact in BNF", () => {
    const bnf = run(classDiff, "ebnf", "bnf");

    expect(bnf.text).toContain('"b" | "c" | "d" | "f"');
  });

  test("a one-character string can be subtracted", () => {
    const out = run('a ::= [a-c] - "b"\n', "ebnf", "abnf");

    expect(ruleLine(out.text, "a")).toBe("a = %x61 / %x63");
  });

  const ruleDiff = 'a ::= b - c\nb ::= "x" "y"\nc ::= "z"\n';
  const STANDS_IN = "stands in for it and is not defined";

  test.each(["bnf", "rbnf"] as const)(
    "a difference of rules is reported in %s",
    (target) => {
      const out = run(ruleDiff, "ebnf", target);

      expect(out.warnings).toEqual([
        `a: no exact ${target.toUpperCase()} form for b - c; <unsupported> ${STANDS_IN}`,
      ]);
    },
  );

  test.each(["bnf", "rbnf"] as const)(
    "a difference of rules keeps its source text in a note in %s",
    (target) => {
      const out = run(ruleDiff, "ebnf", target);

      expect(out.text).toContain(
        `; note: no exact ${target.toUpperCase()} form for b - c; <unsupported> ${STANDS_IN}`,
      );
    },
  );

  test.each(["bnf", "rbnf"] as const)(
    "a difference of rules refers to an undefined rule in %s",
    (target) => {
      const out = run(ruleDiff, "ebnf", target);

      expect(ruleLine(out.text, "<a>")).toBe("<a> ::= <unsupported>");
    },
  );

  test("a difference of single-character rules is exact in BNF", () => {
    const out = run("a ::= b - c\nb ::= [a-z]\nc ::= [q]\n", "ebnf", "bnf");

    expect(out.warnings).toEqual([]);
  });

  test("a difference of single-character rules lists the remaining letters in BNF", () => {
    const out = run("a ::= b - c\nb ::= [a-c]\nc ::= [b]\n", "ebnf", "bnf");

    expect(ruleLine(out.text, "<a>")).toBe('<a> ::= "a" | "c"');
  });

  test("a difference of single-character rules is exact in ABNF", () => {
    const out = run("a ::= b - c\nb ::= [a-c]\nc ::= [b]\n", "ebnf", "abnf");

    expect(ruleLine(out.text, "a")).toBe("a = %x61 / %x63");
  });

  test("a negated class is reported in BNF", () => {
    const out = run("a ::= [^a-z]\n", "ebnf", "bnf");

    expect(out.warnings).toEqual([
      `a: no exact BNF form for [^a-z]; <unsupported> ${STANDS_IN}`,
    ]);
  });

  test("a negated class refers to an undefined rule in BNF, not to a string", () => {
    const out = run("a ::= [^a-z]\n", "ebnf", "bnf");

    expect(ruleLine(out.text, "<a>")).toBe("<a> ::= <unsupported>");
  });

  test("a negated class excludes characters W3C Char does not allow in ABNF", () => {
    const out = run("a ::= [^a]\n", "ebnf", "abnf");

    expect(ruleLine(out.text, "a")).toBe(
      "a = %x09-0A / %x0D / %x20-60 / %x62-D7FF / %xE000-FFFD / %x10000-10FFFF",
    );
  });

  test.each(["bnf", "ebnf", "rbnf"] as const)(
    "a prose value gives one warning in %s",
    (target) => {
      const out = run("a = <any text>\n", "abnf", target);

      expect(out.warnings.length).toBe(1);
    },
  );

  test.each(["bnf", "ebnf", "rbnf"] as const)(
    "a prose value is not written as a string in %s",
    (target) => {
      const out = run("a = <any text>\n", "abnf", target);

      expect(out.text).not.toContain('"<any text>"');
    },
  );

  test.each([
    ["bnf", "<a> ::= <unsupported>"],
    ["rbnf", "<a> ::= <unsupported>"],
    ["ebnf", "a ::= unsupported"],
  ] as const)(
    "a prose value refers to an undefined rule in %s",
    (target, expected) => {
      const out = run("a = <any text>\n", "abnf", target);

      expect(ruleLine(out.text, target === "ebnf" ? "a" : "<a>")).toBe(
        expected,
      );
    },
  );

  test("a placeholder name does not clash with a rule of that name", () => {
    const out = run("unsupported = <x>\n", "abnf", "ebnf");

    expect(ruleLine(out.text, "unsupported")).toBe(
      "unsupported ::= unsupported-2",
    );
  });

  test("two placeholders in one grammar get different names", () => {
    const out = run("a = <x> <y>\n", "abnf", "ebnf");

    expect(ruleLine(out.text, "a")).toBe("a ::= unsupported unsupported-2");
  });

  test("a prose value that holds quotes still gives a valid EBNF file", () => {
    const out = run(`a = <say "hi" it's>\n`, "abnf", "ebnf");

    expect(problems(out.text, "ebnf")).toBeUndefined();
  });

  test("a prose value that holds quotes gives one warning", () => {
    const out = run(`a = <say "hi" it's>\n`, "abnf", "ebnf");

    expect(out.warnings.length).toBe(1);
  });

  test("the source text that has no form stays in a note", () => {
    const out = run("a ::= [^a]\n", "ebnf", "rbnf");

    expect(out.text).toContain("[^a]");
  });

  const annotated = 'a ::= "x" [ wfc: Rule ] "y"\n';

  test("EBNF annotations are reported as dropped", () => {
    const out = run(annotated, "ebnf", "bnf");

    expect(out.warnings).toEqual(["a: annotation [ wfc: Rule ] was dropped"]);
  });

  test("EBNF annotations are removed from the rule", () => {
    const out = run(annotated, "ebnf", "bnf");

    expect(ruleLine(out.text, "<a>")).toBe('<a> ::= "x" "y"');
  });
});

describe("comments", () => {
  const commented = [
    "; Header text",
    "",
    "; about a",
    "; second line",
    "a = b ; trailing a",
    'b = %s"x"',
    "",
    "; the end",
    "",
  ].join("\n");

  test("comments above rules and after them are carried over to BNF", () => {
    const bnf = run(commented, "abnf", "bnf").text;

    expect(bnf).toBe(
      [
        "; Header text",
        "",
        "; about a",
        "; second line",
        "<a> ::= <b> ; trailing a",
        "",
        '<b> ::= "x"',
        "",
        "; the end",
        "",
      ].join("\n"),
    );
  });

  test("comments above rules and after them are carried over to EBNF", () => {
    const ebnf = run(commented, "abnf", "ebnf").text;

    expect(ebnf).toBe(
      [
        "/* Header text */",
        "",
        "/* about a */",
        "/* second line */",
        "a ::= b /* trailing a */",
        "",
        'b ::= "x"',
        "",
        "/* the end */",
        "",
      ].join("\n"),
    );
  });

  const blockComments = [
    "/* first",
    "   second */",
    'a ::= "x" /* t */',
    "",
  ].join("\n");

  test("EBNF block comments become ABNF line comments", () => {
    const out = run(blockComments, "ebnf", "abnf");

    expect(out.text).toBe(
      ["; first", "; second", 'a = %s"x" ; t', ""].join("\n"),
    );
  });

  test("ABNF line comments come back as one EBNF block comment per line", () => {
    const abnf = run(blockComments, "ebnf", "abnf").text;

    const back = run(abnf, "abnf", "ebnf").text;

    expect(back).toContain("/* first */\n/* second */");
  });

  test("comment text cannot close an EBNF comment early", () => {
    const out = run('; a */ b\na = %s"x"\n', "abnf", "ebnf");

    expect(out.text).toContain("/* a * / b */");
  });

  test("comment text with a closer still gives a valid EBNF file", () => {
    const out = run('; a */ b\na = %s"x"\n', "abnf", "ebnf");

    expect(problems(out.text, "ebnf")).toBeUndefined();
  });

  test("comments inside a rule body are reported, not silently lost", () => {
    const abnf = 'a = "x"\n    ; between\n    / "y" ; inner\n';

    const out = run(abnf, "abnf", "bnf");

    expect(out.warnings).toEqual([
      "1 comment(s) inside rule bodies were not carried over",
    ]);
  });

  test("an indented comment after a rule documents the next rule", () => {
    const out = run('a ::= "x"\n  ; about b\nb ::= "y"\n', "bnf", "abnf");

    expect(out.text).toBe(
      ['a = %s"x"', "", "; about b", 'b = %s"y"', ""].join("\n"),
    );
  });

  test("a comment that is not next to its rule stays unattached", () => {
    const out = run('; free\n\na ::= "x"\n', "bnf", "ebnf");

    expect(out.text).toBe('/* free */\n\na ::= "x"\n');
  });
});

describe("source forms", () => {
  test("a CRLF source converts like an LF one", () => {
    const abnf = example("abnf");
    const crlf = abnf.replace(/\n/g, "\r\n");

    const out = run(crlf, "abnf", "ebnf");

    expect(out.text).toBe(run(abnf, "abnf", "ebnf").text);
  });

  test("a CR source converts like an LF one", () => {
    const abnf = example("abnf");
    const cr = abnf.replace(/\n/g, "\r");

    const out = run(cr, "abnf", "ebnf");

    expect(out.text).toBe(run(abnf, "abnf", "ebnf").text);
  });

  test("a CRLF EBNF source converts like an LF one", () => {
    const ebnf = example("ebnf");

    const out = run(ebnf.replace(/\n/g, "\r\n"), "ebnf", "bnf");

    expect(out.text).toBe(run(ebnf, "ebnf", "bnf").text);
  });

  test("EBNF production numbers are dropped", () => {
    const out = run('[1] a ::= b\n[2] b ::= "x"\n', "ebnf", "bnf");

    expect(out.text).toBe('<a> ::= <b>\n\n<b> ::= "x"\n');
  });

  test("BNF braces and brackets become EBNF * and ?", () => {
    const out = run('a ::= ["x"] {"y"} ("z" | "w")\n', "bnf", "ebnf");

    expect(ruleLine(out.text, "a")).toBe('a ::= "x"? "y"* ("z" | "w")');
  });

  const emptyAlt = 'a ::= "x" | | "y"\nb ::= ( | "q")\n';

  test("an empty BNF alternative becomes an empty ABNF string", () => {
    const abnf = run(emptyAlt, "bnf", "abnf");

    expect(ruleLine(abnf.text, "a")).toBe('a = %s"x" / "" / %s"y"');
  });

  test("empty alternatives and empty rules stay valid in ABNF", () => {
    const abnf = run(emptyAlt, "bnf", "abnf");

    expect(problems(abnf.text, "abnf")).toBeUndefined();
  });

  test("a string with non-ASCII characters splits into a string and a code in ABNF", () => {
    const out = run('a ::= "caf\u00e9"\n', "bnf", "abnf");

    expect(ruleLine(out.text, "a")).toBe('a = %s"caf" %xE9');
  });

  test("a non-ASCII ABNF code point comes back as a string in EBNF", () => {
    const abnf = run('a ::= "caf\u00e9"\n', "bnf", "abnf").text;

    const back = run(abnf, "abnf", "ebnf");

    expect(ruleLine(back.text, "a")).toBe('a ::= "caf" "\u00e9"');
  });

  test("a code point above U+FFFF is written as a BNF string", () => {
    const out = run("a = %x1F600\n", "abnf", "bnf");

    expect(ruleLine(out.text, "<a>")).toBe('<a> ::= "\u{1F600}"');
  });

  test("a code point above U+FFFF is written as an EBNF string", () => {
    const out = run("a = %x1F600\n", "abnf", "ebnf");

    expect(ruleLine(out.text, "a")).toBe('a ::= "\u{1F600}"');
  });

  test("an ABNF range out of the character range still parses as one rule", () => {
    const parsed = grammar.parseGrammar("a = %x110000-110001\n", "abnf");

    expect(parsed.rules.length).toBe(1);
  });

  test("an ABNF value out of the character range is reported and gets a placeholder", () => {
    const out = convert.convertDialect("a = %x110000\n", "abnf", "bnf");

    expect(out.ok && out.warnings).toEqual([
      "a: no exact BNF form for %x110000; <unsupported> stands in for it and is not defined",
    ]);
  });
});

describe("escapes round trip", () => {
  /** All string text of the first rule, joined in order. */
  const text = (source: string): string => {
    const parts: string[] = [];
    const walk = (node: unknown): void => {
      const value = node as { kind: string; value?: string; items?: unknown[] };
      if (value.kind === "str") {
        parts.push(value.value ?? "");
      }
      for (const item of value.items ?? []) {
        walk(item);
      }
    };
    walk(readAbnf(source).rules[0]?.body);
    return parts.join("");
  };

  const controls = "a = %x00.0A.09.5C.22.27.7F.E9 %x41\n";

  test("control characters, quotes and backslashes are escaped in BNF", () => {
    const bnf = run(controls, "abnf", "bnf").text;

    expect(ruleLine(bnf, "<a>")).toBe(
      '<a> ::= "\\x00\\n\\t\\\\\\"\'\\x7F\u00e9" "A"',
    );
  });

  test("control characters, quotes and backslashes survive ABNF to BNF to ABNF", () => {
    const bnf = run(controls, "abnf", "bnf").text;

    const back = run(bnf, "bnf", "abnf").text;

    expect(text(back)).toBe(text(controls));
  });

  test("the round-tripped ABNF string holds the original characters", () => {
    const bnf = run(controls, "abnf", "bnf").text;

    const back = run(bnf, "bnf", "abnf").text;

    expect(text(back)).toBe("\u0000\n\t\\\"'\u007f\u00e9A");
  });

  const ebnfControls = "a = %x00.0A.0D.20.22.27.41\n";

  test("EBNF controls use character codes", () => {
    const ebnf = run(ebnfControls, "abnf", "ebnf").text;

    expect(ruleLine(ebnf, "a")).toBe(`a ::= #x0 #xA #xD " " '"' "'A"`);
  });

  test("EBNF controls survive ABNF to EBNF to ABNF", () => {
    const ebnf = run(ebnfControls, "abnf", "ebnf").text;

    const back = run(ebnf, "ebnf", "abnf").text;

    expect(text(back)).toBe("\u0000\n\r \"'A");
  });
});
