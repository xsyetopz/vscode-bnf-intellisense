import { beforeAll, describe, expect, test } from "bun:test";
import { RangeMock } from "../vscode-mock.ts";
import {
  convertEveryProduction,
  diagnose,
  FILE_WIDE_TITLE,
  grammar,
  loadCodeActionCore,
  ONE_PRODUCTION_TITLE,
  quickFixes,
} from "./code-action-test-utils.ts";

beforeAll(async () => {
  await loadCodeActionCore();
});

function parsedDiagnostics(text: string) {
  return grammar.parseGrammar(text, "ebnf").diagnostics;
}

describe("ISO to W3C conversion keeps the meaning", () => {
  test("optional brackets become ? and repetition braces become *", () => {
    const text = 'a = [ "z" ] , b ;\nb = { "q" } ;\n';

    const out = convertEveryProduction(text) as string;

    expect(out).toBe('a ::= "z"? b\nb ::= "q"*\n');
    expect(parsedDiagnostics(out)).toHaveLength(0);
    expect(
      diagnose(out, "ebnf").some((d) => d.code === "bnf.undefined-reference"),
    ).toBe(false);
  });

  test("grouped braces and brackets keep their group", () => {
    const text =
      'a = { "x" , "y" } ;\nb = { c } ;\nc = [ "q" ] ;\nd = [ c , "r" ] ;\n';

    const out = convertEveryProduction(text) as string;

    expect(out).toBe(
      'a ::= ( "x" "y" )*\nb ::= c*\nc ::= "q"?\nd ::= ( c "r" )?\n',
    );
    expect(parsedDiagnostics(out)).toHaveLength(0);
  });

  test("a dot terminator is removed like a semicolon", () => {
    const text = 'a = "x" , b .\nb = "y" .\n';

    const out = convertEveryProduction(text) as string;

    expect(out).toBe('a ::= "x" b\nb ::= "y"\n');
    expect(parsedDiagnostics(out)).toHaveLength(0);
  });

  test("a trailing comma before the terminator is dropped", () => {
    const fixes = quickFixes('a = "x" , ;\n', "ebnf");

    const one = fixes.find((f) => f.title === ONE_PRODUCTION_TITLE);

    expect(one?.text).toBe('a ::= "x"\n');
  });

  test("a=b with commas and a closing semicolon converts in one fix", () => {
    const text = "a=b , 'c' ;\n";
    const diagnostic = grammar
      .parseGrammar(text, "ebnf")
      .diagnostics.find((d) => d.message.includes("Use "));
    expect(diagnostic).toBeDefined();

    const fixes = quickFixes(text, "ebnf", { diagnostics: [diagnostic] });

    expect(fixes[0]?.text).toBe("a::=b 'c'\n");
  });
});

describe("ISO to W3C conversion of comments", () => {
  test("(* *) comments become /* */ without spurious references", () => {
    const text = 'a = "x" , b ; (* note *)\nb = "y" ; (* c *)\n';

    const out = convertEveryProduction(text) as string;

    expect(out).toBe('a ::= "x" b /* note */\nb ::= "y" /* c */\n');
    expect(diagnose(out, "ebnf").filter((d) => d.severity <= 1)).toHaveLength(
      0,
    );
  });

  test("a comment between two productions on one line stays between them", () => {
    const text = 'a = "x" ; (* c *) b = "y" ;\n';

    const out = convertEveryProduction(text) as string;

    expect(out).toBe('a ::= "x" /* c */\nb ::= "y"\n');
    expect(grammar.parseGrammar(out, "ebnf").rules).toHaveLength(2);
    expect(parsedDiagnostics(out)).toHaveLength(0);
  });

  test("a leading header comment is converted", () => {
    const text = '(* header *)\na = "x" ;\nb = "y" ;\n';

    const out = convertEveryProduction(text) as string;

    expect(out).toBe('/* header */\na ::= "x"\nb ::= "y"\n');
    expect(parsedDiagnostics(out)).toHaveLength(0);
  });

  test("converting one production converts its header comment", () => {
    const fixes = quickFixes('(* header *)\na = "x" ;\n', "ebnf");

    const one = fixes.find((f) => f.title === ONE_PRODUCTION_TITLE);

    expect(one?.text).toBe('/* header */\na ::= "x"\n');
  });

  test("converting one production leaves a file header separated by a blank line", () => {
    const text = "(* file header *)\n\n\nexpr = 'x';\nother = 'y';\n";

    const one = quickFixes(text, "ebnf").find(
      (f) => f.title === ONE_PRODUCTION_TITLE,
    );
    const all = convertEveryProduction(text) as string;

    expect(one?.text).toBe(
      "(* file header *)\n\n\nexpr ::= 'x'\nother = 'y';\n",
    );
    expect(all).toBe("/* file header */\n\n\nexpr ::= 'x'\nother ::= 'y'\n");
  });

  test("converting one production keeps a comment chain only up to the first blank line", () => {
    const text = "(* far *)\n\n(* near *)\nexpr = 'x';\n";

    const one = quickFixes(text, "ebnf").find(
      (f) => f.title === ONE_PRODUCTION_TITLE,
    );

    expect(one?.text).toBe("(* far *)\n\n/* near */\nexpr ::= 'x'\n");
  });

  test("header, trailing, and mid-file comments are converted", () => {
    const text =
      '(* head *)\nw ::= "ok"\nx = "y" ; (* tail *)\n(* mid *)\nz ::= "q"\ny = "t" ;\n';

    const one = quickFixes(text, "ebnf").find(
      (f) => f.title === ONE_PRODUCTION_TITLE,
    );
    const all = convertEveryProduction(text) as string;

    expect(one?.text).toContain("(* head *)");
    expect(one?.text).toContain("/* tail */");
    expect(all).toContain("/* head */");
    expect(all).toContain("/* mid */");
    expect(all).not.toContain("(*");
    expect(parsedDiagnostics(all)).toHaveLength(0);
  });

  test("strings that look like comments are left alone", () => {
    const text = `a = "x" ;\nb ::= "(* not a comment *)" '(*'\nc = "y" ;\n`;

    const all = convertEveryProduction(text) as string;

    expect(all).toContain(`b ::= "(* not a comment *)" '(*'`);
  });
});

describe("ISO to W3C conversion of repetition counts", () => {
  test("n * x expands to n copies", () => {
    const text = 'a = 3 * "a" ;\nb = 2 * ( "x" , c ) ;\nc = 1 * { "q" } ;\n';

    const out = convertEveryProduction(text) as string;

    expect(out).toBe(
      'a ::= "a" "a" "a"\nb ::= (( "x" c ) ( "x" c ))\nc ::= "q"*\n',
    );
    expect(parsedDiagnostics(out)).toHaveLength(0);
  });

  test("nested repetitions expand inside each copy", () => {
    const text = 'a = 2 * ( 2 * "x" ) ;\nb = "y" ;\n';

    const out = convertEveryProduction(text) as string;

    expect(out).toBe('a ::= (( "x" "x" ) ( "x" "x" ))\nb ::= "y"\n');
  });

  test.each(["0", "17"])(
    "a repetition count of %s is refused with a reason",
    (count) => {
      const text = `a = ${count} * "a" ;\nb = "y" ;\nc = "z" ;\n`;

      const fixes = quickFixes(text, "ebnf");

      const refused = fixes.find((f) =>
        f.title.startsWith('Cannot convert "a"'),
      );
      expect(refused?.reason).toContain(`repetition count ${count}`);
      expect(
        fixes.find((f) => f.title.startsWith(FILE_WIDE_TITLE))?.text,
      ).toContain(`a = ${count} * "a"`);
    },
  );

  test("a repetition count of 16 is expanded", () => {
    const text = 'a = 16 * "a" ;\nb = "y" ;\n';

    const out = convertEveryProduction(text) as string;

    expect(out.match(/"a"/g)).toHaveLength(16);
  });
});

describe("ISO to W3C conversion refusals", () => {
  test.each(["? any ?", '(/ "x" /)', "multi word"])(
    "the production with body %s is refused and the others convert",
    (body) => {
      const text = `a = ${body} ;\nb = "y" ;\nc = "z" ;\n`;

      const out = convertEveryProduction(text) as string;

      expect(out).toContain(`a = ${body}`);
      expect(out).toContain('b ::= "y"');
      expect(out).toContain('c ::= "z"');
    },
  );

  test("a refused lone production offers no single-production fix", () => {
    const fixes = quickFixes("a = ? any ? ;\n", "ebnf");

    expect(fixes.find((f) => f.title === ONE_PRODUCTION_TITLE)).toBeUndefined();
  });

  test("a comment containing */ refuses its production", () => {
    const text = 'a = "x" , (* tricky */ here *) "y" ;\nb = "q" ;\nc = "r" ;\n';

    const out = convertEveryProduction(text) as string;
    const reasons = quickFixes(text, "ebnf")
      .filter((f) => f.title.startsWith("Cannot convert"))
      .map((f) => f.reason);

    expect(out).toContain('a = "x" ,');
    expect(out).toContain('b ::= "q"');
    expect(reasons[0]).toContain('"*/"');
  });

  test("a comment containing */ after the terminator refuses its production", () => {
    const text = 'a = "x" ; (* bad */ *)\nb = "q" ;\nc = "r" ;\n';

    const out = convertEveryProduction(text) as string;

    expect(out).toContain('a = "x" ; (* bad */ *)');
    expect(out).toContain('b ::= "q"');
  });

  test.each([
    ['a = "x" (* p (* q *) r *) ;\nb = "y" ;\n', "nested comment"],
    ['a = "x" , (* a */ b *) ;\nb = "y" ;\n', '"*/"'],
  ])("the refusal reason for %j mentions %s", (text, expected) => {
    const reason = quickFixes(text, "ebnf").find((f) =>
      f.title.startsWith("Cannot convert"),
    )?.reason;

    expect(reason).toContain(expected);
  });

  test("an unterminated comment is refused as unterminated", () => {
    const reason = quickFixes('a = "x" , (* open ;\nb = "y" ;\n', "ebnf").find(
      (f) => f.title.startsWith("Cannot convert"),
    )?.reason;

    expect(reason).toBe("unterminated comment");
  });
});

describe("ISO to W3C conversion layout", () => {
  const text = 'a = "x" ; b = "y" ;\n';

  test("several productions on one line are split into lines", () => {
    const out = convertEveryProduction(text) as string;

    expect(out).toBe('a ::= "x"\nb ::= "y"\n');
    expect(grammar.parseGrammar(out, "ebnf").rules).toHaveLength(2);
  });

  test("converting one of several productions on a line splits them", () => {
    const one = quickFixes(text, "ebnf").find(
      (f) => f.title === ONE_PRODUCTION_TITLE,
    );

    expect(one?.text).toBe('a ::= "x"\nb ::= "y"\n');
  });

  test("line breaks follow the document's CRLF", () => {
    const out = convertEveryProduction(
      'a = "x" ; b = "y" ;\r\nc = "z" ;\r\n',
    ) as string;

    expect(out).toBe('a ::= "x"\r\nb ::= "y"\r\nc ::= "z"\r\n');
  });
});

describe("file-wide conversion offer", () => {
  test("is not offered with a single ISO production", () => {
    const fixes = quickFixes('a = "x" ;\nb ::= "y"\n', "ebnf");

    expect(fixes.some((f) => f.title.startsWith(FILE_WIDE_TITLE))).toBe(false);
    expect(fixes.some((f) => f.title === ONE_PRODUCTION_TITLE)).toBe(true);
  });

  test("is offered with two ISO productions", () => {
    const fixes = quickFixes('a = "x" ;\nb = "y" ;\n', "ebnf");

    expect(fixes.some((f) => f.title.startsWith(FILE_WIDE_TITLE))).toBe(true);
  });

  test("is not offered for a foreign diagnostic with the same message", () => {
    const foreign = {
      message: 'Use "::=" for W3C XML EBNF',
      range: new RangeMock(0, 0, 0, 7),
    };

    const fixes = quickFixes("a = b ;\n", "ebnf", { diagnostics: [foreign] });

    expect(fixes).toHaveLength(0);
  });
});

describe("ISO comments inside W3C EBNF", () => {
  const COMMENT_FIX = 'Use "/* ... */" for this EBNF comment';

  test.each([
    ["punctuation inside", "a ::= x (* iso, comment; *)\n"],
    ["plain text", "a ::= x (* plain *)\n"],
    ["between productions", 'a ::= "x"\n(* note, here; *)\nb ::= a\n'],
    ["with an apostrophe", "a ::= x (* don't *)\n"],
  ])(
    "a comment with %s gives one ISO diagnostic and nothing else",
    (_n, text) => {
      const codes = parsedDiagnostics(text).map((d) => String(d.code));

      expect(codes).toEqual(["bnf.iso-ebnf"]);
    },
  );

  test("the diagnostic covers the whole comment", () => {
    const text = "a ::= x (* iso, comment; *)\n";

    const [diagnostic] = parsedDiagnostics(text);

    expect(diagnostic?.range.start.character).toBe(text.indexOf("(*"));
    expect(diagnostic?.range.end.character).toBe(
      text.indexOf("*)") + "*)".length,
    );
  });

  test("the quick fix turns the comment into a block comment", () => {
    const text = "a ::= x (* iso, comment; *)\nb ::= a\n";

    const out = quickFixes(text, "ebnf").find((f) => f.title === COMMENT_FIX);

    expect(out?.text).toBe("a ::= x /* iso, comment; */\nb ::= a\n");
    expect(parsedDiagnostics(out?.text ?? "")).toHaveLength(0);
  });

  test("the fix changes only the comment it was asked for", () => {
    const text = "(* one *)\na ::= x\n(* two *)\n";
    const fixes = quickFixes(text, "ebnf").filter(
      (f) => f.title === COMMENT_FIX,
    );

    expect(fixes.map((f) => f.text)).toContain(
      "/* one */\na ::= x\n(* two *)\n",
    );
  });

  test.each([
    ["an unclosed (*", "a ::= x (* never closed\n"],
    ["(* in a string", 'a ::= "(* not a comment *)"\n'],
    ["(* in a character class", "a ::= [(*]\n"],
    ["(* in a block comment", "a ::= x /* (* *) */\n"],
  ])("%s is not an ISO comment", (_n, text) => {
    const codes = parsedDiagnostics(text).map((d) => String(d.code));

    expect(codes).not.toContain("bnf.iso-ebnf");
  });

  test("a comment inside an ISO production adds no second diagnostic", () => {
    const text = 'a = "x" , (* inner, note; *) "y" ;\n';

    const codes = parsedDiagnostics(text).map((d) => String(d.code));

    expect(codes).toEqual(["bnf.iso-ebnf"]);
  });

  test("a group may still follow an opening parenthesis after a space", () => {
    const codes = parsedDiagnostics("a ::= ( x )* y\n").map((d) =>
      String(d.code),
    );

    expect(codes).toEqual([]);
  });
});
