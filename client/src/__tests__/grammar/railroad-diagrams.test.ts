import { beforeAll, describe, expect, test } from "bun:test";
import "../vscode-mock.ts";
import type { GrammarDialect } from "../../grammar/dialects.ts";
import { buildProductionBody } from "../../grammar/railroad/build.ts";
import type { RuleDiagram } from "../../grammar/railroad/diagrams.ts";
import {
  optionalOf,
  type RailNode,
  repeatOf,
} from "../../grammar/railroad/model.ts";
import { repoText } from "../repo-file.ts";
import { heightOf, labelsOf, positionOf } from "./railroad-test-utils.ts";

let parseGrammar: typeof import("../../grammar/grammar.ts").parseGrammar;
let buildRuleDiagrams: typeof import("../../grammar/railroad/diagrams.ts").buildRuleDiagrams;
let createRefResolver: typeof import("../../grammar/railroad/diagrams.ts").createRefResolver;
let diagramAtLine: typeof import("../../grammar/railroad/diagrams.ts").diagramAtLine;
let renderRulesHtml: typeof import("../../grammar/railroad/page.ts").renderRulesHtml;

beforeAll(async () => {
  ({ parseGrammar } = await import("../../grammar/grammar.ts"));
  ({ buildRuleDiagrams, createRefResolver, diagramAtLine } = await import(
    "../../grammar/railroad/diagrams.ts"
  ));
  ({ renderRulesHtml } = await import("../../grammar/railroad/page.ts"));
});

const nt = (name: string): RailNode => ({ kind: "nonterminal", name });
const term = (text: string): RailNode => ({
  kind: "terminal",
  terminal: "string",
  text,
});

function diagrams(text: string, dialect: GrammarDialect): RuleDiagram[] {
  return buildRuleDiagrams(parseGrammar(text, dialect), dialect);
}

function html(text: string, dialect: GrammarDialect): string {
  const list = diagrams(text, dialect);
  return renderRulesHtml(list, {
    resolveRef: createRefResolver(list, dialect, () => false),
  });
}

const ABNF_CONSTRUCTS = [
  'r = a / "lit" / %s"Case" / %i"Ins" / %x41-5A / %d65 / %b1010 / %x41.42',
  "    / <prose text> / [opt] / (g1 g2) / *star / 1*plus / 2*5counted / 3exact / *4upto",
].join("\n");

const EBNF_CONSTRUCTS =
  "Name ::= Letter ( Letter | Digit )* ( '.' Letter )? ( Char - '-' )+ [a-zA-Z] #x20 'x' \"y\" [#x41-#x5A]\n";

describe("railroad ABNF constructs", () => {
  test("draws every ABNF construct without an error", () => {
    const [diagram] = diagrams(ABNF_CONSTRUCTS, "abnf");

    expect(diagram?.error).toBeUndefined();
  });

  test.each([
    ["a reference", "r = a\n", "rr-nt", "a"],
    ["a case-insensitive string", 'r = "lit"\n', "rr-term-string", '"lit"'],
    [
      "a case-sensitive string",
      'r = %s"Case"\n',
      "rr-term-string-sensitive",
      '%s"Case"',
    ],
    ["a numeric range", "r = %x41-5A\n", "rr-term-range", "%x41-5A"],
    ["a numeric value", "r = %d65\n", "rr-term-numeric", "%d65"],
    ["a numeric concatenation", "r = %x41.42\n", "rr-term-numeric", "%x41.42"],
    ["a prose value", "r = <prose text>\n", "rr-term-prose", "<prose text>"],
  ])("draws %s with its own box style", (_name, source, cssClass, label) => {
    const out = html(source, "abnf");

    expect(out).toContain(cssClass);
    expect(labelsOf(out)).toEqual([label]);
  });

  test.each([
    ["an optional", "r = [a]\n"],
    ["a zero-or-more repeat", "r = *a\n"],
    ["a one-or-more repeat", "r = 1*a\n"],
  ])("draws %s with a bypass or return path and no label", (_name, source) => {
    const plain = html("r = a\n", "abnf");

    const out = html(source, "abnf");

    expect(heightOf(out)).toBeGreaterThan(heightOf(plain));
    expect(labelsOf(out)).toEqual(["a"]);
  });

  test.each([
    ["2*5a", "2–5×"],
    ["3a", "3×"],
    ["*4a", "0–4×"],
    ["2*a", "2+×"],
  ])("labels the repeat %s as %s", (repeat, label) => {
    const out = html(`r = ${repeat}\n`, "abnf");

    expect(labelsOf(out)).toEqual(["a", label]);
  });

  test("groups parenthesised elements into one sequence", () => {
    const out = html("r = (g1 g2)\n", "abnf");

    const { y: y1 } = positionOf(out, "g1");
    const { y: y2 } = positionOf(out, "g2");
    expect(y1).toBe(y2);
  });

  test("stacks alternatives vertically", () => {
    const out = html('r = a / "b" / c\n', "abnf");

    const ys = ["a", '"b"', "c"].map((label) => positionOf(out, label).y);
    expect(ys[0]).toBeLessThan(ys[1] as number);
    expect(ys[1]).toBeLessThan(ys[2] as number);
  });

  test.each(["U+0041 – U+005A", "%d65 — U+0041"])(
    "shows numeric values as characters in a tooltip: %s",
    (tooltip) => {
      const out = html("r = %x41-5A %d65 %x41.42\n", "abnf");

      expect(out).toContain(tooltip);
    },
  );

  test("merges =/ parts into one choice at the base rule", () => {
    const list = diagrams('a = "x"\nb = "y"\na =/ "z"\na =/ c / d\n', "abnf");

    const a = list[0] as RuleDiagram;
    expect(list.map((d) => d.name)).toEqual(["a", "b"]);
    expect(a.parts).toBe(3);
    expect([a.startLine, a.endLine]).toEqual([0, 3]);
  });

  test("draws the parts of a merged rule as stacked alternatives", () => {
    const out = html('a = "x"\na =/ "z"\na =/ c / d\n', "abnf");

    const labels = ['"x"', '"z"', "c", "d"];
    const ys = labels.map((label) => positionOf(out, label).y);
    expect(ys).toEqual([...ys].sort((l, r) => l - r));
    expect(new Set(ys).size).toBe(4);
  });

  test("labels a merged rule with its number of parts", () => {
    const out = html('a = "x"\na =/ "z"\n', "abnf");

    expect(out).toContain("2 parts merged");
  });

  test("merges =/ parts regardless of name case", () => {
    const list = diagrams('Foo = "x"\nfoo =/ "y"\n', "abnf");

    expect(list).toHaveLength(1);
    expect(list[0]?.parts).toBe(2);
  });

  test("still draws a =/ part that has no base rule", () => {
    const list = diagrams('a =/ "x"\n', "abnf");

    expect(list).toHaveLength(1);
  });

  test("focuses the rule between the parts of an interleaved =/ rule", () => {
    const list = diagrams('a = "x"\nb = "y"\na =/ "z"\n', "abnf");

    expect(diagramAtLine(list, 1)?.name).toBe("b");
    expect(diagramAtLine(list, 0)?.name).toBe("a");
    expect(diagramAtLine(list, 2)?.name).toBe("a");
  });

  test("keeps a broken rule's error off the rule it interleaves with", () => {
    const list = diagrams('a = "x"\nb = ("y"\na =/ "z"\n', "abnf");

    const [a, b] = list as [RuleDiagram, RuleDiagram];
    expect(b.error).toBe('Group opened with "(" has no closing ")"');
    expect(a.error).toBeUndefined();
  });

  test("draws a =/ before its base rule as one flagged diagram", () => {
    const list = diagrams('a =/ "z"\na = "x"\na =/ "w"\n', "abnf");

    expect(list).toHaveLength(1);
    expect(list[0]?.parts).toBe(3);
    expect(list[0]?.warning).toBe(
      'Rule "a" is extended with "=/" before any base definition',
    );
  });

  test("names a =/ before its base rule after the base definition", () => {
    const list = diagrams('A =/ "z"\n; the base\na = "x"\n', "abnf");

    expect(list[0]?.name).toBe("a");
    expect(list[0]?.comment).toBe("the base");
    expect(list[0]?.warning).toBe(
      'Rule "a" is extended with "=/" before any base definition',
    );
  });

  test("keeps the parts of a =/ before its base rule in source order", () => {
    const list = diagrams('a =/ "z"\na = "x"\na =/ "w"\n', "abnf");

    expect(list[0]?.spans).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
  });

  test("lists the base definition first in a diagram merged from a leading =/", () => {
    const out = html('a =/ "z"\na = "x"\n', "abnf");

    expect(positionOf(out, '"x"').y).toBeLessThan(positionOf(out, '"z"').y);
  });

  test("badges a diagram whose =/ comes before its base rule", () => {
    const out = html('a =/ "z"\na = "x"\n', "abnf");

    expect(out).toContain("=/ without an earlier definition");
  });

  test("does not flag a =/ that follows its base rule", () => {
    const list = diagrams('a = "x"\na =/ "z"\n', "abnf");

    expect(list[0]?.warning).toBeUndefined();
  });

  test("draws core rules distinctly and not as links", () => {
    const out = html("r = ALPHA DIGIT other\n", "abnf");

    expect(out).toContain("rr-nt-core");
    expect(out).toContain("rr-nt-undefined");
    expect(out).not.toContain('data-rule="ALPHA"');
    expect(out).not.toContain('data-rule="other"');
  });

  test("links references to rules in the same file", () => {
    const out = html('r = s\ns = "x"\n', "abnf");

    expect(out).toContain('data-rule="s"');
    expect(out).toContain('role="link"');
    expect(out).toContain('id="rule-0"');
    expect(out).toContain('id="rule-1"');
  });

  test.each([
    ["a name defined elsewhere", "other", "external"],
    ["a name defined nowhere", "nowhere", "undefined"],
    ["a core rule in any case", "alpha", "core"],
    ["a local rule in any case", "R", "local"],
  ] as const)("resolves %s in ABNF", (_name, ref, kind) => {
    const list = diagrams("r = other\n", "abnf");
    const resolve = createRefResolver(list, "abnf", (n) => n === "other");

    const resolved = resolve(ref);

    expect(resolved).toBe(kind);
  });

  test.each([
    ["a core rule name", "ALPHA", "undefined"],
    ["a local name in another case", "R", "undefined"],
    ["a local name in the same case", "r", "local"],
  ] as const)("resolves %s as in a non-ABNF dialect", (_name, ref, kind) => {
    const list = diagrams("r ::= ALPHA\n", "bnf");
    const resolve = createRefResolver(list, "bnf", () => false);

    const resolved = resolve(ref);

    expect(resolved).toBe(kind);
  });

  test("keeps the rules around a broken rule error free", () => {
    const list = diagrams('good = "a"\nbad = x ( y "unterminated\n', "abnf");

    expect(list[0]?.error).toBeUndefined();
    expect(list[1]?.error).toBe("Unterminated string: missing closing '\"'");
  });

  test("shows what parsed of a broken rule with an error badge", () => {
    const out = html('good = "a"\nbad = x ( y "unterminated\n', "abnf");

    expect(out).toContain("rr-badge-error");
    expect(labelsOf(out)).toContain("x");
    expect(labelsOf(out)).toContain("y");
  });

  test("draws a placeholder for an empty rule body", () => {
    const out = html("r =\n", "abnf");

    expect(out).toContain("(empty)");
  });

  test("escapes hostile strings", () => {
    const out = html(
      'r = "</script><script>alert(1)</script>" s\ns = %x41\n',
      "abnf",
    );

    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;/script&gt;");
    expect(labelsOf(out)).toContain('"</script><script>alert(1)</script>"');
  });

  test("escapes hostile comments", () => {
    const out = html('; <img src=x onerror=alert(1)>\nr = "a"\n', "abnf");

    expect(out).not.toContain("<img");
  });

  test.each([
    ["the first line of a rule", 0, "a"],
    ["a continuation line of a rule", 1, "a"],
    ["the line of the next rule", 2, "b"],
    ["a line past the end", 9, undefined],
  ])("finds the rule at %s", (_name, line, rule) => {
    const list = diagrams('a = "x"\n    / "y"\nb = "z"\n', "abnf");

    const found = diagramAtLine(list, line);

    expect(found?.name).toBe(rule);
  });

  test("says there are no rules for an empty document", () => {
    const out = renderRulesHtml([]);

    expect(out).toContain("no rules");
  });
});

describe("railroad production dialects", () => {
  test("draws BNF constructs without an error", () => {
    const [diagram] = diagrams(
      "<expr> ::= <term> | <expr> '+' <term> | ( <a> | <b> ) [ <c> ] { <d> } <e> ... \n",
      "bnf",
    );

    expect(diagram?.error).toBeUndefined();
  });

  test("shows BNF references and strings as labelled boxes", () => {
    const out = html("<expr> ::= <term> '+' <term>\n", "bnf");

    expect(labelsOf(out)).toEqual(["<term>", "'+'", "<term>"]);
    expect(out).toContain("rr-term-string");
  });

  test.each([
    ["an optional", "<r> ::= [ <c> ]\n"],
    ["a repeat", "<r> ::= { <c> }\n"],
  ])("draws BNF %s taller than the plain item", (_name, source) => {
    const plain = html("<r> ::= <c>\n", "bnf");

    const out = html(source, "bnf");

    expect(heightOf(out)).toBeGreaterThan(heightOf(plain));
    expect(labelsOf(out)).toEqual(["<c>"]);
  });

  test("draws W3C EBNF constructs without an error", () => {
    const [diagram] = diagrams(EBNF_CONSTRUCTS, "ebnf");

    expect(diagram?.error).toBeUndefined();
  });

  test("draws an EBNF exclusion as a labelled group", () => {
    const out = html("A ::= Char - '-'\n", "ebnf");

    expect(labelsOf(out)).toEqual(["Char", "not", "'-'"]);
    expect(out).toContain("rr-group");
  });

  test.each([
    ["B - C*", repeatOf(nt("C"), 0, null)],
    ["B - C+", repeatOf(nt("C"), 1, null)],
    ["B - 'x'?", optionalOf(term("'x'"))],
  ])(
    "applies the postfix of %s to the excluded operand",
    (source, excluded) => {
      const { node } = buildProductionBody(source, "ebnf");

      expect(node).toEqual({ kind: "except", base: nt("B"), excluded });
    },
  );

  test("applies a postfix after a parenthesised exclusion to the whole exclusion", () => {
    const { node } = buildProductionBody("(B - C)*", "ebnf");

    expect(node).toEqual(
      repeatOf({ kind: "except", base: nt("B"), excluded: nt("C") }, 0, null),
    );
  });

  test.each([
    ["a character class", "A ::= [a-zA-Z]\n", "rr-term-class", "[a-zA-Z]"],
    ["a character code", "A ::= #x20\n", "rr-term-charcode", "#x20"],
  ])("draws %s with its own box style", (_name, source, cssClass, label) => {
    const out = html(source, "ebnf");

    expect(out).toContain(cssClass);
    expect(labelsOf(out)).toEqual([label]);
  });

  test.each([
    ["an optional", "A ::= B?\n"],
    ["a zero-or-more repeat", "A ::= B*\n"],
    ["a one-or-more repeat", "A ::= B+\n"],
  ])("draws an EBNF %s taller than the plain item", (_name, source) => {
    const plain = html("A ::= B\n", "ebnf");

    const out = html(source, "ebnf");

    expect(heightOf(out)).toBeGreaterThan(heightOf(plain));
    expect(labelsOf(out)).toEqual(["B"]);
  });

  test("draws a zero-or-more repeat taller than a one-or-more repeat", () => {
    const star = html("A ::= B*\n", "ebnf");

    const plus = html("A ::= B+\n", "ebnf");

    expect(heightOf(star)).toBeGreaterThan(heightOf(plus));
  });

  test("leaves EBNF comments out of the diagram", () => {
    const out = html("A ::= B /* secret */ C\n", "ebnf");

    expect(labelsOf(out)).toEqual(["B", "C"]);
    expect(out).not.toContain("secret");
  });

  const RBNF_CONSTRUCTS =
    '<msg> ::= <hdr> [ <opt> ] ( <a> | <b> ) <item> ... "lit" word\n';

  test("draws RBNF constructs without an error", () => {
    const [diagram] = diagrams(RBNF_CONSTRUCTS, "rbnf");

    expect(diagram?.error).toBeUndefined();
  });

  test("draws RBNF references, bare words and repeats", () => {
    const out = html(RBNF_CONSTRUCTS, "rbnf");

    expect(labelsOf(out)).toEqual([
      "<hdr>",
      "<opt>",
      "<a>",
      "<b>",
      "<item>",
      '"lit"',
      "word",
    ]);
    expect(out).toContain("rr-term-word");
  });

  test("draws an RBNF ... repeat taller than the plain item", () => {
    const plain = html("<m> ::= <item>\n", "rbnf");

    const out = html("<m> ::= <item> ...\n", "rbnf");

    expect(heightOf(out)).toBeGreaterThan(heightOf(plain));
  });

  test("keeps names that differ only in case as separate rules in EBNF", () => {
    const list = diagrams("A ::= x\na ::= y\n", "ebnf");

    expect(list.map((d) => d.name)).toEqual(["A", "a"]);
  });

  test.each([
    ["the same case", "A", "local"],
    ["another name", "B", "undefined"],
  ] as const)("resolves an EBNF reference with %s", (_name, ref, kind) => {
    const list = diagrams("A ::= x\na ::= y\n", "ebnf");
    const resolve = createRefResolver(list, "ebnf", () => false);

    const resolved = resolve(ref);

    expect(resolved).toBe(kind);
  });

  test("keeps duplicate definitions separate in production dialects", () => {
    const list = diagrams("a ::= x\na ::= y\n", "bnf");

    expect(list).toHaveLength(2);
  });

  test("flags only the unbalanced EBNF rule", () => {
    const list = diagrams("Ok ::= A\nBad ::= ( B | C\n", "ebnf");

    expect(list[0]?.error).toBeUndefined();
    expect(list[1]?.error).toBe("The rule body is incomplete or malformed");
  });

  test("draws an unbalanced EBNF rule with an error badge and what parsed", () => {
    const out = html("Ok ::= A\nBad ::= ( B | C\n", "ebnf");

    expect(out).toContain("rr-badge-error");
    expect(out).toContain(">C</text>");
  });

  test("escapes hostile names in BNF", () => {
    const out = html(
      "<a\"b> ::= <x&y> '</script><script>alert(1)</script>'\n",
      "bnf",
    );

    expect(out).not.toContain("<script");
    expect(out).not.toContain('"b>');
  });
});

describe("railroad rendering limits", () => {
  const examples = [
    "examples/json.abnf",
    "examples/json.bnf",
    "examples/json.ebnf",
    "examples/json.rbnf",
  ];

  test.each(examples)("renders the example %s safely", (file) => {
    const dialect = file.split(".").pop() as GrammarDialect;
    const source = repoText(file);

    const out = html(source, dialect);

    const ruleCount = diagrams(source, dialect).length;
    expect(ruleCount).toBeGreaterThan(0);
    expect(out.split('<section class="rr-rule"')).toHaveLength(ruleCount + 1);
    expect(out).not.toContain("<script");
  });

  test("renders a rule with 3000 alternatives", () => {
    const body = Array.from({ length: 3000 }, (_, i) => `'t${i}'`).join(" | ");

    const out = html(`r ::= ${body}\n`, "bnf");

    expect(out).toContain("t2999");
  });

  test("renders deeply nested BNF groups", () => {
    const depth = 3000;

    const out = html(
      `r ::= ${"( ".repeat(depth)}a${" )".repeat(depth)}\n`,
      "bnf",
    );

    expect(out).toContain("<svg");
  });

  test("renders deeply nested ABNF groups", () => {
    const depth = 3000;

    const out = html(`r = ${"(".repeat(depth)}a${")".repeat(depth)}\n`, "abnf");

    expect(out).toContain("<svg");
  });
});
