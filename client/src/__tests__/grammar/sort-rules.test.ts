import { beforeAll, describe, expect, test } from "bun:test";
import "../vscode-mock.ts";
import type { GrammarDialect } from "../../grammar/dialects.ts";
import { repoText } from "../repo-file.ts";

let sorting: typeof import("../../grammar/commands/sort-rules.ts");
let grammar: typeof import("../../grammar/grammar.ts");

beforeAll(async () => {
  sorting = await import("../../grammar/commands/sort-rules.ts");
  grammar = await import("../../grammar/grammar.ts");
});

type Mode = "alphabetical" | "dependency";

function sort(
  text: string,
  dialect: GrammarDialect,
  mode: Mode = "alphabetical",
  selection?: { start: number; end: number },
): string {
  const result = sorting.sortRules(text, dialect, mode, selection);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.text;
}

function names(text: string, dialect: GrammarDialect): string[] {
  return grammar.parseGrammar(text, dialect).rules.map((rule) => rule.name);
}

function lines(...parts: string[]): string {
  return `${parts.join("\n")}\n`;
}

function applyEdit(
  text: string,
  edit: { start: number; end: number; newText: string },
): string {
  return text.slice(0, edit.start) + edit.newText + text.slice(edit.end);
}

describe("sortRules alphabetical", () => {
  test("ABNF names compare without case", () => {
    const text = "beta = %x41\nAlpha = %x42\nGAMMA = %x43\ndelta = %x44\n";

    const out = sort(text, "abnf");

    expect(names(out, "abnf")).toEqual(["Alpha", "beta", "delta", "GAMMA"]);
  });

  test.each<[GrammarDialect, string, string[]]>([
    ["bnf", '<b> ::= "x"\n<a> ::= "x"\n<B> ::= "x"\n', ["<a>", "<B>", "<b>"]],
    ["ebnf", 'b ::= "x"\na ::= "x"\nB ::= "x"\n', ["a", "B", "b"]],
    [
      "rbnf",
      '<b x> ::= "x"\n<B y> ::= "x"\n<a> ::= "x"\n',
      ["<a>", "<b x>", "<B y>"],
    ],
  ])(
    "%s names compare ignoring case first, then by case",
    (dialect, text, expected) => {
      const out = sort(text, dialect);

      expect(names(out, dialect)).toEqual(expected);
    },
  );

  test("angle brackets do not decide the order in BNF", () => {
    const text = 'zed ::= "x"\n<mid> ::= "x"\nabc ::= "x"\n';

    const out = sort(text, "bnf");

    expect(names(out, "bnf")).toEqual(["abc", "<mid>", "zed"]);
  });

  test("EBNF names sort without regard to case", () => {
    const out = sort('z ::= "x"\nB ::= "x"\na ::= "x"\n', "ebnf");

    expect(names(out, "ebnf")).toEqual(["a", "B", "z"]);
  });

  test("a rule's =/ parts stay right after it", () => {
    const text = "b = %x42\na = %x41\nb =/ %x43\n";

    const out = sort(text, "abnf");

    expect(out).toBe("a = %x41\nb = %x42\nb =/ %x43\n");
  });

  test.each<[GrammarDialect, string]>([
    ["abnf", "b = %x41\nb = %x42\na = b\n"],
    ["bnf", '<b> ::= "x"\n<b> ::= "y"\n<a> ::= <b>\n'],
    ["ebnf", 'b ::= "x"\nb ::= "y"\na ::= b\n'],
    ["rbnf", '<b> ::= "x"\n<b> ::= "y"\n<a> ::= <b>\n'],
  ])("a rule defined twice is refused in %s", (dialect, text) => {
    const result = sorting.sortRules(text, dialect, "alphabetical");

    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining("more than one definition"),
    });
  });

  test("EBNF production numbers move with their rule", () => {
    const text = '[1] b ::= "x"\n[2] a ::= "y"\n';

    const out = sort(text, "ebnf");

    expect(out).toBe('[2] a ::= "y"\n[1] b ::= "x"\n');
  });
});

describe("sortRules comments", () => {
  test("comment lines directly above a rule move with it", () => {
    const text = lines(
      "; header",
      "",
      "; about b",
      "; more about b",
      "b = %x41",
      "; about a",
      "a = %x42",
    );

    const out = sort(text, "abnf");

    expect(out).toBe(
      lines(
        "; header",
        "",
        "; about a",
        "a = %x42",
        "; about b",
        "; more about b",
        "b = %x41",
      ),
    );
  });

  test("a comment separated by a blank line stays where it is", () => {
    const text = "b = %x41\n\n; free note\n\na = %x42\n";

    const out = sort(text, "abnf");

    expect(out).toBe("a = %x42\n\n; free note\n\nb = %x41\n");
  });

  test("a trailing comment on the last line moves with the rule", () => {
    const text = 'b ::= "x" ; about b\na ::= "y" ; about a\n';

    const out = sort(text, "bnf");

    expect(out).toBe('a ::= "y" ; about a\nb ::= "x" ; about b\n');
  });

  test("indented comment lines after an ABNF rule stay with it", () => {
    const text = "b = %x41\n    ; tail of b\na = %x42\n";

    const out = sort(text, "abnf");

    expect(out).toBe("a = %x42\nb = %x41\n    ; tail of b\n");
  });

  test("a multi-line EBNF block comment above a rule moves with it", () => {
    const text = lines(
      "/* about b",
      "   second line */",
      'b ::= "x"',
      "/* about a */",
      'a ::= "y"',
    );

    const out = sort(text, "ebnf");

    expect(out).toBe(
      lines(
        "/* about a */",
        'a ::= "y"',
        "/* about b",
        "   second line */",
        'b ::= "x"',
      ),
    );
  });

  test("an indented comment line after a BNF rule stays with that rule", () => {
    const text = 'b ::= "x"\n  ; inside b\na ::= "y"\n';

    const out = sort(text, "bnf");

    expect(out).toBe('a ::= "y"\nb ::= "x"\n  ; inside b\n');
  });

  test("only column 0 comments attach to the next rule", () => {
    const text = 'b ::= "x"\n; about a\na ::= "y"\n';

    const out = sort(text, "bnf");

    expect(out).toBe('; about a\na ::= "y"\nb ::= "x"\n');
  });
});

describe("sortRules incremental alternatives", () => {
  test("=/ parts stay right after their base rule", () => {
    const text = lines(
      "c = %x43",
      "b = %x41",
      "a = %x42",
      "b =/ %x44",
      "c =/ %x45",
    );

    const out = sort(text, "abnf");

    expect(out).toBe(
      lines("a = %x42", "b = %x41", "b =/ %x44", "c = %x43", "c =/ %x45"),
    );
  });

  test("=/ names match without case", () => {
    const text = "B = %x41\nA = %x42\nb =/ %x44\n";

    const out = sort(text, "abnf");

    expect(out).toBe("A = %x42\nB = %x41\nb =/ %x44\n");
  });

  test("dependency order keeps =/ parts right after the base", () => {
    const text = "a = b\nb = %x41\nz = %x42\nb =/ c\nc = %x43\n";

    const out = sort(text, "abnf", "dependency");

    expect(out).toBe("a = b\nb = %x41\nb =/ c\nc = %x43\nz = %x42\n");
  });
});

describe("sortRules dependency order", () => {
  test("breadth first from the first rule, then the rest in source order", () => {
    const text = lines(
      "start = a b",
      "z = %x41",
      "b = d",
      "y = %x42",
      "a = c",
      "c = %x43",
      "d = %x44",
    );

    const out = sort(text, "abnf", "dependency");

    expect(names(out, "abnf")).toEqual(["start", "a", "b", "c", "d", "z", "y"]);
  });

  test("ABNF references match rule names without case", () => {
    const text = "S = Y\nZ = %x41\ny = %x42\n";

    const out = sort(text, "abnf", "dependency");

    expect(names(out, "abnf")).toEqual(["S", "y", "Z"]);
  });

  test("BNF references match rule names with case", () => {
    const text = 'S ::= Y\nZ ::= "a"\ny ::= "b"\nY ::= "c"\n';

    const out = sort(text, "bnf", "dependency");

    expect(names(out, "bnf")).toEqual(["S", "Y", "Z", "y"]);
  });

  test("cycles and self references terminate", () => {
    const text = "a = b a\nb = c\nc = a b\nd = d\n";

    const out = sort(text, "abnf", "dependency");

    expect(names(out, "abnf")).toEqual(["a", "b", "c", "d"]);
  });

  test("undefined references are ignored", () => {
    const text = "a = nothing\nb = %x41\n";

    const out = sort(text, "abnf", "dependency");

    expect(out).toBe(text);
  });

  test("RBNF references may contain spaces", () => {
    const text = '<top> ::= <a b>\n<z> ::= "x"\n<a b> ::= "y"\n';

    const out = sort(text, "rbnf", "dependency");

    expect(names(out, "rbnf")).toEqual(["<top>", "<a b>", "<z>"]);
  });
});

describe("sortRules selection", () => {
  const text = lines(
    "e = %x41",
    "d = %x42",
    "c = %x43",
    "b = %x44",
    "a = %x45",
  );

  test("only the selected rules trade places", () => {
    const selection = {
      start: text.indexOf("d ="),
      end: text.indexOf("b =") + 2,
    };

    const out = sort(text, "abnf", "alphabetical", selection);

    expect(out).toBe(
      lines("e = %x41", "b = %x44", "c = %x43", "d = %x42", "a = %x45"),
    );
  });

  test("a selection that touches only one rule changes nothing", () => {
    const start = text.indexOf("c =") + 1;

    const out = sort(text, "abnf", "alphabetical", { start, end: start + 1 });

    expect(out).toBe(text);
  });

  test("a selection that ends inside a rule selects that rule", () => {
    const selection = {
      start: text.indexOf("c =") + 1,
      end: text.indexOf("b =") + 1,
    };

    const out = sort(text, "abnf", "alphabetical", selection);

    expect(out).toBe(
      lines("e = %x41", "d = %x42", "b = %x44", "c = %x43", "a = %x45"),
    );
  });

  test("a selection ending at the start of a line excludes that line", () => {
    const selection = { start: text.indexOf("d ="), end: text.indexOf("c =") };

    const result = sorting.sortRules(text, "abnf", "alphabetical", selection);

    expect(result).toEqual({ ok: true, changed: false, text });
  });

  test("a selection without a rule is refused", () => {
    const result = sorting.sortRules(
      "; only\n\na = %x41\n",
      "abnf",
      "alphabetical",
      { start: 0, end: 3 },
    );

    expect(result.ok).toBe(false);
  });

  test("selected =/ parts bring their base along", () => {
    const source = "z = %x41\nb = %x42\na = %x43\nb =/ %x44\n";
    const selection = { start: source.indexOf("a ="), end: source.length };

    const out = sort(source, "abnf", "alphabetical", selection);

    expect(out).toBe("z = %x41\na = %x43\nb = %x42\nb =/ %x44\n");
  });

  test("dependency order inside a selection starts at its first rule", () => {
    const source = "x = b\na = c\nb = %x44\nc = %x45\n";
    const selection = { start: source.indexOf("a ="), end: source.length };

    const out = sort(source, "abnf", "dependency", selection);

    expect(names(out, "abnf")).toEqual(["x", "a", "c", "b"]);
  });
});

describe("sortRules refusals", () => {
  test.each([
    ["an unbalanced BNF group", 'b ::= ("x"\na ::= "y"\n', "bnf"],
    ["an unclosed ABNF group", "b = (%x41\na = %x42\n", "abnf"],
    ["ISO EBNF syntax", 'b = "x" ;\na = "y" ;\n', "ebnf"],
    ["text before the first rule", 'stray\nb ::= "x"\na ::= "y"\n', "bnf"],
    ["an unterminated comment", 'b ::= "x"\na ::= "y" /* open\n', "ebnf"],
  ] as const)("refuses %s", (_name, text, dialect) => {
    const result = sorting.sortRules(text, dialect, "alphabetical");

    expect(result.ok).toBe(false);
  });

  test("the reason names the line of the first parse error", () => {
    const text = "b = %x41\n= oops\na = %x42\n";

    const result = sorting.sortRules(text, "abnf", "alphabetical");

    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.reason).toContain("parse errors");
    expect(result.ok ? "" : result.reason).toContain("line 2");
  });
});

describe("sortRules text safety", () => {
  const sample = lines(
    "; header",
    "",
    "; c",
    "c = b",
    "    / %x41",
    "; b",
    "b = a",
    "a = %x42 ; trailing",
  );

  test("CRLF line breaks are kept and none are added", () => {
    const crlf = sample.replace(/\n/g, "\r\n");

    const out = sort(crlf, "abnf");

    expect(out.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(out.split("\r\n").length).toBe(crlf.split("\r\n").length);
    expect(names(out, "abnf")).toEqual(["a", "b", "c"]);
  });

  test("CR-only line breaks are kept", () => {
    const text = 'b ::= "x"\ra ::= "y"\r';

    const out = sort(text, "bnf");

    expect(out).toBe('a ::= "y"\rb ::= "x"\r');
  });

  test("a file without a final newline stays without one", () => {
    const text = "c = %x41\nb = %x42\na = %x43";

    const out = sort(text, "abnf");

    expect(out).toBe("a = %x43\nb = %x42\nc = %x41");
  });

  test("the edit turns the original into the sorted text", () => {
    const result = sorting.sortRules(sample, "abnf", "alphabetical");

    expect(result.ok && result.changed).toBe(true);
    if (result.ok && result.changed) {
      expect(applyEdit(sample, result.edit)).toBe(result.text);
    }
  });

  test("the edit leaves the unchanged header out", () => {
    const result = sorting.sortRules(sample, "abnf", "alphabetical");

    expect(result.ok && result.changed).toBe(true);
    if (result.ok && result.changed) {
      expect(result.edit.start).toBeGreaterThan(sample.indexOf("; c") - 1);
    }
  });

  test.each(["alphabetical", "dependency"] as const)(
    "an already %s-sorted document gives no edit",
    (mode) => {
      const sorted = sort(sample, "abnf", mode);

      const again = sorting.sortRules(sorted, "abnf", mode);

      expect(again).toEqual({ ok: true, changed: false, text: sorted });
    },
  );

  test("a single rule gives no edit", () => {
    const result = sorting.sortRules("a = %x41\n", "abnf", "alphabetical");

    expect(result).toEqual({ ok: true, changed: false, text: "a = %x41\n" });
  });

  test("an empty document gives no edit", () => {
    const result = sorting.sortRules("", "bnf", "dependency");

    expect(result).toEqual({ ok: true, changed: false, text: "" });
  });

  test("a document with only a comment gives no edit", () => {
    const result = sorting.sortRules(
      "; just a comment\n",
      "abnf",
      "alphabetical",
    );

    expect(result).toEqual({
      ok: true,
      changed: false,
      text: "; just a comment\n",
    });
  });

  test("blank lines between rules stay in their positions", () => {
    const text = "b = %x41\n\n\na = %x42\nc = %x43\n";

    const out = sort(text, "abnf");

    expect(out).toBe("a = %x42\n\n\nb = %x41\nc = %x43\n");
  });

  test("text after the last rule is kept", () => {
    const text = "b = %x41\na = %x42\n\n; the end\n";

    const out = sort(text, "abnf");

    expect(out).toBe("a = %x42\nb = %x41\n\n; the end\n");
  });

  test("multi-line rules move as a unit", () => {
    const text = 'b ::= "x"\n  | "y"\n  | ( "z"\n      "w" )\na ::= "q"\n';

    const out = sort(text, "bnf");

    expect(out).toBe('a ::= "q"\nb ::= "x"\n  | "y"\n  | ( "z"\n      "w" )\n');
  });
});

describe("sortRules on the example grammars", () => {
  const cases = (["abnf", "bnf", "ebnf", "rbnf"] as const).flatMap((dialect) =>
    (["alphabetical", "dependency"] as const).map(
      (mode) => [dialect, mode] as const,
    ),
  );

  test.each(cases)("%s %s keeps the same rules", (dialect, mode) => {
    const source = repoText(`examples/json.${dialect}`);

    const out = sort(source, dialect, mode);

    expect([...names(out, dialect)].sort()).toEqual(
      [...names(source, dialect)].sort(),
    );
  });

  test.each(cases)("%s %s only moves whole lines", (dialect, mode) => {
    const source = repoText(`examples/json.${dialect}`);

    const out = sort(source, dialect, mode);

    expect(out.split("\n").sort()).toEqual(source.split("\n").sort());
  });

  test.each(cases)("%s %s adds no parse errors", (dialect, mode) => {
    const source = repoText(`examples/json.${dialect}`);

    const out = sort(source, dialect, mode);

    const errors = grammar
      .parseGrammar(out, dialect)
      .diagnostics.filter((diagnostic) => diagnostic.severity === 0);
    expect(errors).toEqual([]);
  });

  test.each(cases)("%s %s is idempotent", (dialect, mode) => {
    const source = repoText(`examples/json.${dialect}`);
    const once = sort(source, dialect, mode);

    const twice = sorting.sortRules(once, dialect, mode);

    expect(twice).toEqual({ ok: true, changed: false, text: once });
  });

  test("alphabetical order of the ABNF example", () => {
    const source = repoText("examples/json.abnf");

    const sorted = names(sort(source, "abnf"), "abnf");

    expect(sorted).toEqual(
      [...sorted].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)),
    );
  });

  test("dependency order of the ABNF example starts at json-text", () => {
    const source = repoText("examples/json.abnf");

    const sorted = names(sort(source, "abnf", "dependency"), "abnf");

    expect(sorted.slice(0, 4)).toEqual(["json-text", "ws", "value", "object"]);
  });
});
