import { beforeAll, describe, expect, test } from "bun:test";
import "../vscode-mock.ts";
import type { GrammarDialect } from "../../grammar/dialects.ts";
import { repoText } from "../repo-file.ts";

let convert: typeof import("../../grammar/commands/convert-dialect.ts");
let formatting: typeof import("../../grammar/commands/format-converted.ts");
let grammar: typeof import("../../grammar/grammar.ts");
let scanner: typeof import("../../grammar/scanner.ts");
let gate: typeof import("../../grammar/commands/parse-gate.ts");

beforeAll(async () => {
  convert = await import("../../grammar/commands/convert-dialect.ts");
  formatting = await import("../../grammar/commands/format-converted.ts");
  grammar = await import("../../grammar/grammar.ts");
  scanner = await import("../../grammar/scanner.ts");
  gate = await import("../../grammar/commands/parse-gate.ts");
});

const DIALECTS = ["abnf", "bnf", "ebnf", "rbnf"] as const;

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

const PAIRS = DIALECTS.flatMap((source) =>
  DIALECTS.filter((target) => target !== source).map(
    (target) => [source, target] as const,
  ),
);
const FORMATTED_PAIRS = PAIRS.flatMap(([source, target]) => [
  [source, target, false] as const,
  [source, target, true] as const,
]);

function example(dialect: GrammarDialect): string {
  return repoText(`examples/json.${dialect}`);
}

function exampleOutput(
  source: GrammarDialect,
  target: GrammarDialect,
  format: boolean,
) {
  return run(example(source), source, target, format);
}

describe("the JSON examples convert between all 12 dialect pairs", () => {
  test.each(FORMATTED_PAIRS)(
    "%s to %s (formatted: %p) has no blocking problem",
    (source, target, format) => {
      const out = exampleOutput(source, target, format);

      expect(problems(out.text, target)).toBeUndefined();
    },
  );

  test.each(FORMATTED_PAIRS)(
    "%s to %s (formatted: %p) has no error diagnostic",
    (source, target, format) => {
      const out = exampleOutput(source, target, format);

      const errors = grammar
        .parseGrammar(out.text, target)
        .diagnostics.filter((d) => d.severity === 0);
      expect(errors).toEqual([]);
    },
  );

  test.each(FORMATTED_PAIRS)(
    "%s to %s (formatted: %p) ends with a newline",
    (source, target, format) => {
      const out = exampleOutput(source, target, format);

      expect(out.text.endsWith("\n")).toBe(true);
    },
  );

  test.each(FORMATTED_PAIRS)(
    "%s to %s (formatted: %p) keeps at least as many rules",
    (source, target, format) => {
      const out = exampleOutput(source, target, format);

      const rules = grammar.parseGrammar(out.text, target).rules;
      expect(rules.length).toBeGreaterThanOrEqual(
        grammar.parseGrammar(example(source), source).rules.length,
      );
    },
  );

  // no warning is about the converted text itself
  test.each(FORMATTED_PAIRS)(
    "%s to %s (formatted: %p) warns of no parse problem",
    (source, target, format) => {
      const out = exampleOutput(source, target, format);

      expect(out.warnings.filter((w) => w.includes("parse problem"))).toEqual(
        [],
      );
    },
  );

  test.each(["bnf", "rbnf"] as const)(
    "ABNF to %s warns that %%x5D-10FFFF has no exact form",
    (target) => {
      const abnf = example("abnf");

      const out = run(abnf, "abnf", target);

      expect(out.warnings).toEqual([
        `unescaped: no exact ${target.toUpperCase()} form for %x5D-10FFFF; <unsupported> stands in for it and is not defined`,
      ]);
    },
  );

  test.each(["bnf", "rbnf"] as const)(
    "ABNF to %s notes %%x5D-10FFFF in the text",
    (target) => {
      const abnf = example("abnf");

      const out = run(abnf, "abnf", target);

      expect(out.text).toContain(
        `; note: no exact ${target.toUpperCase()} form for %x5D-10FFFF; <unsupported> stands in for it and is not defined`,
      );
    },
  );

  test("ABNF to EBNF has no warning", () => {
    const abnf = example("abnf");

    const out = run(abnf, "abnf", "ebnf");

    expect(out.warnings).toEqual([]);
  });

  test("the ABNF example's unescaped rule becomes EBNF char classes", () => {
    const out = run(example("abnf"), "abnf", "ebnf");

    expect(ruleLine(out.text, "unescaped")).toBe(
      "unescaped ::= [#x20-#x21] | [#x23-#x5B] | [#x5D-#x10FFFF]",
    );
  });

  test("the ABNF example's exp rule becomes EBNF with ? and +", () => {
    const out = run(example("abnf"), "abnf", "ebnf");

    expect(ruleLine(out.text, "exp")).toBe("exp ::= e (minus | plus)? DIGIT+");
  });

  test("the ABNF example's unicode rule becomes EBNF repeated references", () => {
    const out = run(example("abnf"), "abnf", "ebnf");

    expect(ruleLine(out.text, "unicode")).toBe(
      'unicode ::= "u" HEXDIG HEXDIG HEXDIG HEXDIG',
    );
  });

  test("the EBNF example's classes become ABNF ranges", () => {
    const out = run(example("ebnf"), "ebnf", "abnf");

    expect(ruleLine(out.text, "unescaped")).toBe(
      "unescaped = %x20-21 / %x23-5B / %x5D-10FFFF",
    );
  });

  test("the EBNF example's + suffix becomes an ABNF 1* prefix", () => {
    const out = run(example("ebnf"), "ebnf", "abnf");

    expect(ruleLine(out.text, "frac")).toBe('frac = "." 1*digit');
  });

  test("the EBNF example's ? suffixes become ABNF optionals", () => {
    const out = run(example("ebnf"), "ebnf", "abnf");

    expect(ruleLine(out.text, "number")).toBe(
      'number = ["-"] int [frac] [exp]',
    );
  });
});

describe("BNF output", () => {
  const out = (text: string, source: GrammarDialect = "abnf") =>
    run(text, source, "bnf").text;

  test.each(["abnf", "ebnf", "rbnf"] as const)(
    "a converted %s example has no groups or repetition",
    (source) => {
      const text = out(example(source), source);

      const groups = scanner
        .lexProductionGrammar(text, "bnf")
        .filter((token) => token.kind === "group" || token.kind === "repeat");
      expect(groups).toEqual([]);
    },
  );

  test("helper rules get unique names", () => {
    const text = out(
      'a = [x] [x] *y\na-opt = "q"\na-opt-2 = "r"\na-star = "s"\nx = "x"\ny = "y"\n',
    );

    const names = grammar.parseGrammar(text, "bnf").rules.map((r) => r.name);

    expect(new Set(names).size).toBe(names.length);
  });

  test.each(["<a-opt>", "<a-opt-2>", "<a-opt-3>", "<a-star-2>"])(
    "a clash with an existing rule still yields helper %s",
    (name) => {
      const text = out(
        'a = [x] [x] *y\na-opt = "q"\na-opt-2 = "r"\na-star = "s"\nx = "x"\ny = "y"\n',
      );

      const names = grammar.parseGrammar(text, "bnf").rules.map((r) => r.name);

      expect(names).toContain(name);
    },
  );

  test("identical optional parts reference one helper", () => {
    const text = out('a = [x] "-" [x]\nx = "x"\n');

    expect(ruleLine(text, "<a>")).toBe('<a> ::= <a-opt> "-" <a-opt>');
  });

  test("identical optional parts define the helper once", () => {
    const text = out('a = [x] "-" [x]\nx = "x"\n');

    expect(text.match(/^<a-opt> ::=/gm)?.length).toBe(1);
  });

  test("an optional becomes an opt helper", () => {
    const text = out('a = [x] *x 1*x\nx = "x"\n');

    expect(text).toContain('<a-opt> ::= <x> | ""');
  });

  test("a star becomes a recursive helper with an empty alternative", () => {
    const text = out('a = [x] *x 1*x\nx = "x"\n');

    expect(text).toContain('<a-star> ::= <x> <a-star> | ""');
  });

  test("a plus becomes a recursive helper", () => {
    const text = out('a = [x] *x 1*x\nx = "x"\n');

    expect(text).toContain("<a-plus> ::= <x> | <x> <a-plus>");
  });

  test("a repeated choice is grouped in its own rule", () => {
    const text = out('a = *(%s"p" / %s"q")\n');

    expect(text).toContain('<a-group> ::= "p" | "q"');
  });

  test("a star over a repeated choice references the group rule", () => {
    const text = out('a = *(%s"p" / %s"q")\n');

    expect(text).toContain('<a-star> ::= <a-group> <a-star> | ""');
  });

  test.each([
    ["2*4x", "<a> ::= <x> <x> <a-opt> <a-opt>"],
    ["3x", "<a> ::= <x> <x> <x>"],
    ["2*x", "<a> ::= <x> <a-plus>"],
  ])("the count %s expands into copies", (count, expected) => {
    const text = out(`a = ${count}\nx = "x"\n`);

    expect(ruleLine(text, "<a>")).toBe(expected);
  });

  test("a choice inside a sequence gets a group rule", () => {
    const text = out('a = %s"p" (%s"q" / %s"r") %s"s"\n');

    expect(ruleLine(text, "<a>")).toBe('<a> ::= "p" <a-group> "s"');
  });

  test("a small range expands", () => {
    const text = out("a = %x30-33\nb = %x30-10FFFF\n");

    expect(ruleLine(text, "<a>")).toBe('<a> ::= "0" | "1" | "2" | "3"');
  });

  test("a large range becomes a reference to an undefined rule", () => {
    const text = out("a = %x30-33\nb = %x30-10FFFF\n");

    expect(ruleLine(text, "<b>")).toBe("<b> ::= <unsupported>");
  });

  test("ABNF numeric values are escaped as BNF strings", () => {
    const text = out('a = %x5C %x22 %x0A %x09 %x00 %s"x"\n');

    expect(ruleLine(text, "<a>")).toBe(
      `<a> ::= "\\\\" '"' "\\n" "\\t" "\\x00" "x"`,
    );
  });

  test("EBNF strings have no escapes and BNF strings do", () => {
    const text = out('a ::= "\\" \'"\' "tab\\n"\n', "ebnf");

    expect(ruleLine(text, "<a>")).toBe(`<a> ::= "\\\\" '"' "tab\\\\n"`);
  });

  test("a string with a double quote is written single-quoted", () => {
    const text = out("a = %x61.22.62\n");

    expect(ruleLine(text, "<a>")).toBe(`<a> ::= 'a"b'`);
  });

  test("a string with both quote characters escapes the double quote", () => {
    const text = out("a = %x22.27\n");

    expect(ruleLine(text, "<a>")).toBe(`<a> ::= "\\"'"`);
  });

  test("a case-insensitive letter string becomes a choice per letter", () => {
    const text = out('a = "ab1"\nb = "x"\n');

    expect(ruleLine(text, "<b>")).toBe('<b> ::= "x" | "X"');
  });

  test("a multi-letter case-insensitive string needs no parentheses", () => {
    const text = out('a = "ab1"\nb = "x"\n');

    expect(ruleLine(text, "<a>")).not.toContain("(");
  });
});

describe("ABNF output", () => {
  const out = (text: string, source: GrammarDialect) =>
    run(text, source, "abnf").text;

  test("a BNF {1} is refused because the 1 is stray text", () => {
    const result = convert.convertDialect("a ::= x{1}\n", "bnf", "abnf");

    expect(result.ok).toBe(false);
  });

  test("EBNF suffixes become ABNF repetition prefixes", () => {
    const text = out('a ::= x? x* x+ ("p" x)+\nx ::= "x"\n', "ebnf");

    expect(ruleLine(text, "a")).toBe('a = [x] *x 1*x 1*(%s"p" x)');
  });

  test("EBNF classes, complements, and code points become ranges", () => {
    const text = out('a ::= [a-z] [#x30-#x39] [^"] #x41 [aeiou]\n', "ebnf");

    expect(ruleLine(text, "a")).toBe(
      "a = %x61-7A %x30-39 (%x09-0A / %x0D / %x20-21 / %x23-D7FF / %xE000-FFFD / %x10000-10FFFF) %x41 (%x61 / %x65 / %x69 / %x6F / %x75)",
    );
  });

  test("case-sensitive strings use %s, quotes and controls use %x", () => {
    const text = out('a ::= "abc" "123" \'"\' "a\\b" \'it"s\'\n', "ebnf");

    expect(ruleLine(text, "a")).toBe(
      'a = %s"abc" "123" %x22 %s"a\\b" %s"it" %x22 %s"s"',
    );
  });

  const clashing = '<a b> ::= <a-b> <a_b>\n<a-b> ::= "x"\n<a_b> ::= "y"\n';

  test("invalid and clashing names are sanitized and renamed", () => {
    const text = out(clashing, "rbnf");

    const lines = text.split("\n").filter((l) => /^\S/.test(l));
    expect(lines).toEqual([
      "a-b = a-b-2 a-b-3",
      'a-b-2 = %s"x"',
      'a-b-3 = %s"y"',
    ]);
  });

  test("invalid and clashing names are reported", () => {
    const result = run(clashing, "rbnf", "abnf");

    expect(result.warnings).toEqual([
      '"a b" is not a valid ABNF name; written as "a-b"',
      '"a-b" clashes with another name; written as "a-b-2"',
      '"a_b" is not a valid ABNF name; written as "a-b-3"',
    ]);
  });

  test("names Foo and foo are renamed in ABNF", () => {
    const result = run('Foo ::= foo\nfoo ::= "x"\n', "ebnf", "abnf");

    expect(result.text).toContain("Foo = foo-2");
  });

  test("names Foo and foo are reported as clashing", () => {
    const result = run('Foo ::= foo\nfoo ::= "x"\n', "ebnf", "abnf");

    expect(result.warnings).toEqual([
      '"foo" clashes with another name; written as "foo-2"',
    ]);
  });

  test("names starting with a digit get a prefix", () => {
    const result = run('a ::= _x\n_x ::= "y"\n', "ebnf", "abnf");

    expect(result.text).toContain("a = r--x");
  });

  const noForm = 'a ::= b - c\nb ::= d\nc ::= d\nd ::= "x"\n';

  test("something with no exact form becomes a prose value", () => {
    const result = run(noForm, "ebnf", "abnf");

    expect(ruleLine(result.text, "a")).toBe("a = <b - c>");
  });

  test("something with no exact form gets a note", () => {
    const result = run(noForm, "ebnf", "abnf");

    expect(result.text).toContain(
      "; note: no exact ABNF form for b - c; kept as prose",
    );
  });

  test("something with no exact form is reported", () => {
    const result = run(noForm, "ebnf", "abnf");

    expect(result.warnings).toEqual([
      "a: no exact ABNF form for b - c; kept as prose",
    ]);
  });
});

describe("EBNF output", () => {
  const out = (text: string, source: GrammarDialect = "abnf") =>
    run(text, source, "ebnf").text;

  test.each([
    ["a", "2*5x", "a ::= x x x? x? x?"],
    ["b", "3x", "b ::= x x x"],
    ["c", "*2x", "c ::= x? x?"],
    ["d", "2*x", "d ::= x x+"],
    ["f", "1*x", "f ::= x+"],
  ])(
    "the repetition prefix on rule %s (%s) becomes suffixes and copies",
    (name, prefix, expected) => {
      const text = out(`${name} = ${prefix}\nx = "x"\n`);

      expect(ruleLine(text, name)).toBe(expected);
    },
  );

  test("a 0*0 repetition vanishes", () => {
    const text = out('e = 0*0x "e"\nx = "x"\n');

    expect(ruleLine(text, "e")).toBe('e ::= "" ("e" | "E")');
  });

  test("a repeated sequence with a range is grouped", () => {
    const text = out('a = 2*3(%s"p" %s"q")\n');

    expect(ruleLine(text, "a")).toBe('a ::= "p" "q" "p" "q" ("p" "q")?');
  });

  test("a starred choice is grouped", () => {
    const text = out('a = *(%s"r" / %s"s")\n');

    expect(ruleLine(text, "a")).toBe('a ::= ("r" | "s")*');
  });

  test("numeric values become strings, #x codes, and classes", () => {
    const text = out(
      "a = %x41 %x0A %x0A.0D %x41.42 %x20-7E %d65-90 %b1000001\n",
    );

    expect(ruleLine(text, "a")).toBe(
      'a ::= "A" #xA #xA #xD "AB" [#x20-#x7E] [A-Z] "A"',
    );
  });

  test("case-insensitive strings become a sequence of choices", () => {
    const text = out('a = "ab" "x1" %s"ab" %i"A1"\n');

    expect(ruleLine(text, "a")).toBe(
      'a ::= ("a" | "A") ("b" | "B") ("x" | "X") "1" "ab" ("a" | "A") "1"',
    );
  });

  test("strings with both quote characters are split", () => {
    const text = out("a = %x22.27 %x61.22.27.62\n");

    expect(ruleLine(text, "a")).toBe(`a ::= '"' "'" "a" '"' "'b"`);
  });

  const prose = "a = <any text here> b\nb = %x62\n";

  test("a prose value becomes a reference to an undefined rule", () => {
    const result = run(prose, "abnf", "ebnf");

    expect(ruleLine(result.text, "a")).toBe("a ::= unsupported b");
  });

  test("a prose value gets a note", () => {
    const result = run(prose, "abnf", "ebnf");

    expect(result.text).toContain(
      "/* note: no exact EBNF form for <any text here>; unsupported stands in for it and is not defined */",
    );
  });

  test("a prose value is reported", () => {
    const result = run(prose, "abnf", "ebnf");

    expect(result.warnings).toEqual([
      "a: no exact EBNF form for <any text here>; unsupported stands in for it and is not defined",
    ]);
  });

  test("a repetition too large to expand is reported", () => {
    const result = run('a = 1000x\nx = "x"\n', "abnf", "ebnf");

    expect(result.warnings).toEqual([
      "a: no exact EBNF form for 1000*1000 repetition; unsupported stands in for it and is not defined",
    ]);
  });

  test("a repetition too large to expand becomes a reference to an undefined rule", () => {
    const result = run('a = 1000x\nx = "x"\n', "abnf", "ebnf");

    expect(ruleLine(result.text, "a")).toBe("a ::= unsupported");
  });
});

describe("RBNF output", () => {
  const out = (text: string, source: GrammarDialect = "abnf") =>
    run(text, source, "rbnf").text;

  test("repetition uses RFC 5511 optional and ellipsis forms", () => {
    const text = out('a = [x] *x 1*x 2*3x *(x y)\nx = %s"x"\ny = %s"y"\n');

    expect(ruleLine(text, "<a>")).toBe(
      "<a> ::= [<x>] [<x> ...] <x> ... <x> <x> [<x>] [(<x> <y>) ...]",
    );
  });

  test("a repeated choice is grouped", () => {
    const text = out('a = 1*(x / y)\nx = %s"x"\ny = %s"y"\n');

    expect(ruleLine(text, "<a>")).toBe("<a> ::= (<x> | <y>) ...");
  });

  test("names with spaces are kept from BNF", () => {
    const text = out('<JSON text> ::= <WS>\n<WS> ::= "x"\n', "bnf");

    expect(text).toContain("<JSON text> ::= <WS>");
  });
});

describe("refusals", () => {
  test("the same dialect is refused", () => {
    const text = "a = %x41\n";

    const result = convert.convertDialect(text, "abnf", "abnf");

    expect(result).toEqual({
      ok: false,
      reason: "The source is already written in that dialect",
    });
  });

  test("a parse error gives a reason naming parse errors", () => {
    const result = convert.convertDialect('a ::= ("x"\n', "bnf", "abnf");

    expect(result.ok === false && result.reason).toContain("parse errors");
  });

  test("a parse error gives a reason naming the line", () => {
    const result = convert.convertDialect('a ::= ("x"\n', "bnf", "abnf");

    expect(result.ok === false && result.reason).toContain("line 1");
  });

  test.each([
    ["an unclosed ABNF group", "a = (%x41\n", "abnf", "bnf"],
    ["an unclosed EBNF comment", 'a ::= "x" /* open\n', "ebnf", "abnf"],
    ["an unclosed BNF group", 'a ::= ("x"\n', "bnf", "abnf"],
  ] as const)("%s is refused", (_name, text, source, target) => {
    const result = convert.convertDialect(text, source, target);

    expect(result.ok).toBe(false);
  });

  test("an empty document is refused", () => {
    const result = convert.convertDialect("; nothing\n", "abnf", "bnf");

    expect(result.ok).toBe(false);
  });

  test("deeply nested groups are refused, not a crash", () => {
    const deep = `a ::= ${"(".repeat(3000)}"x"${")".repeat(3000)}\n`;

    const result = convert.convertDialect(deep, "ebnf", "abnf");

    expect(result.ok).toBe(false);
  });
});

describe("incremental alternatives and duplicates", () => {
  const incremental = 'Op = %s"+"\nother = %s"x"\nop =/ %s"-"\nOP =/ %s"*"\n';

  test.each(["bnf", "ebnf", "rbnf"] as const)(
    "=/ parts leave only the base rules in %s",
    (target) => {
      const out = run(incremental, "abnf", target);

      const doc = grammar.parseGrammar(out.text, target);
      expect(doc.rules.map((rule) => rule.name.replace(/[<>]/g, ""))).toEqual([
        "Op",
        "other",
      ]);
    },
  );

  test.each(["bnf", "ebnf", "rbnf"] as const)(
    "=/ parts merge into the base rule's alternatives in %s",
    (target) => {
      const out = run(incremental, "abnf", target);

      expect(out.text).toContain('"+" | "-" | "*"');
    },
  );

  const repeated = 'a ::= "x"\nb ::= "y"\na ::= "z"\n';

  test("repeated definitions in a case-sensitive source are merged", () => {
    const out = run(repeated, "ebnf", "abnf");

    expect(out.text).toContain('a = %s"x" / %s"z"');
  });

  test("repeated definitions in a case-sensitive source are reported", () => {
    const out = run(repeated, "ebnf", "abnf");

    expect(out.warnings).toEqual([
      'rule "a" is defined more than once; merged as alternatives',
    ]);
  });
});

describe("formatted output", () => {
  test.each(PAIRS)(
    "the formatter keeps %s to %s output valid",
    (source, target) => {
      const text = example(source);

      const formatted = run(text, source, target, true).text;

      expect(problems(formatted, target)).toBeUndefined();
    },
  );

  test.each(PAIRS)(
    "the formatter keeps %s to %s rule names",
    (source, target) => {
      const text = example(source);
      const names = (value: string) =>
        grammar.parseGrammar(value, target).rules.map((rule) => rule.name);

      const formatted = run(text, source, target, true).text;

      expect(names(formatted)).toEqual(names(run(text, source, target).text));
    },
  );

  test("the formatted ABNF output of the BNF example breaks alternatives", () => {
    const bnf = example("bnf");

    const out = run(bnf, "bnf", "abnf", true);

    expect(out.text).toMatch(/value\s+= object\n\s+\/ array/);
  });
});
