import { beforeAll, describe, expect, test } from "bun:test";
import { repoText } from "../repo-file.ts";
import { growthForFourfoldInput, MAX_LINEAR_GROWTH } from "../scaling.ts";
import {
  RangeMock,
  resetConfigurationValues,
  setConfigurationValue,
  type WorkspaceEditMock,
} from "../vscode-mock.ts";
import {
  applyWorkspaceEdit,
  asTextDocument,
  createDocument,
  loadGrammarTestCore,
} from "./provider-test-utils.ts";

type Dialect = "abnf" | "bnf" | "ebnf" | "rbnf";
let grammar: typeof import("../../grammar/grammar.ts");
let diagnostics: typeof import("../../grammar/diagnostics.ts");
let actions: typeof import("../../grammar/code-actions.ts");
let suggestions: typeof import("../../grammar/suggestions.ts");

beforeAll(async () => {
  await loadGrammarTestCore();
  grammar = await import("../../grammar/grammar.ts");
  diagnostics = await import("../../grammar/diagnostics.ts");
  actions = await import("../../grammar/code-actions.ts");
  suggestions = await import("../../grammar/suggestions.ts");
});

type Options = Parameters<typeof diagnostics.collectGrammarDiagnostics>[2];

function run(text: string, dialect: Dialect, options: Options = {}) {
  const document = grammar.parseGrammar(text, dialect);
  const symbolTable = grammar.buildGrammarSymbolTable(document, dialect);
  return diagnostics.collectGrammarDiagnostics(
    { dialect, document, symbolTable },
    text,
    options,
  );
}

function withCode(text: string, dialect: Dialect, code: string) {
  return run(text, dialect, { unusedRules: false }).filter(
    (d) => d.code === code,
  );
}

const LEFT_RECURSION = "bnf.left-recursion";
const UNPRODUCTIVE = "bnf.unproductive-rule";
const UNREACHABLE = "bnf.unreachable-rule";
const DUPLICATE_ALT = "bnf.duplicate-alternative";
const EMPTY_ALT = "bnf.empty-alternative";
const UNDEFINED_REF = "bnf.undefined-reference";

describe("left recursion", () => {
  test.each([
    ["bnf", "<e> ::= <e> '+' <t> | <t>\n<t> ::= 'x'\n"],
    ["ebnf", "e ::= e '+' t | t\nt ::= 'x'\n"],
    ["rbnf", "<e> ::= <e> '+' <t> | <t>\n<t> ::= 'x'\n"],
    ["abnf", 'e = e "+" t / t\nt = "x"\n'],
  ] as const)(
    "reports direct left recursion as a hint in %s",
    (dialect, text) => {
      const found = withCode(text, dialect, LEFT_RECURSION);

      expect(found).toHaveLength(1);
      expect(found[0]?.message).toContain("directly left-recursive");
      expect(found[0]?.severity).toBe(3);
      expect(found[0]?.source).toBe(dialect);
    },
  );

  test("shows the path of an indirect cycle", () => {
    const found = withCode(
      'a ::= b "x"\nb ::= c\nc ::= a | "y"\n',
      "ebnf",
      LEFT_RECURSION,
    );

    expect(found).toHaveLength(3);
    expect(found[0]?.message).toContain("a -> b -> c -> a");
    expect(found[1]?.message).toContain("b -> c -> a -> b");
  });

  test.each([
    ["sees through a nullable prefix", 'a ::= n a "x" | "y"\nn ::= "p"?\n', 1],
    ["does not see through a terminal", 'a ::= "p" a | "y"\n', 0],
    [
      "does not see through a non-nullable rule",
      'a ::= n a "x" | "y"\nn ::= "p"\n',
      0,
    ],
  ] as const)("%s", (_name, text, count) => {
    const found = withCode(text, "ebnf", LEFT_RECURSION);

    expect(found).toHaveLength(count);
  });

  test.each([
    ["treats an ABNF star repetition as nullable", 'a = *"p" a / "y"\n', 1],
    [
      "does not treat an ABNF 1* repetition as nullable",
      'a = 1*"p" a / "y"\n',
      0,
    ],
    ["treats an ABNF optional as nullable", 'a = ["p"] a / "y"\n', 1],
  ] as const)("%s", (_name, text, count) => {
    const found = withCode(text, "abnf", LEFT_RECURSION);

    expect(found).toHaveLength(count);
  });

  test("can be turned off by setting", () => {
    const found = run("a ::= a 'x' | 'y'\n", "bnf", { leftRecursion: "off" });

    expect(found.some((d) => d.code === LEFT_RECURSION)).toBe(false);
  });

  test("can be raised to an error by setting", () => {
    const found = run("a ::= a 'x' | 'y'\n", "bnf", { leftRecursion: "error" });

    expect(found.find((d) => d.code === LEFT_RECURSION)?.severity).toBe(0);
  });
});

describe("non-terminating rules", () => {
  test("flags self and mutual recursion without a base case", () => {
    const found = withCode(
      'a ::= a "x"\nb ::= c\nc ::= b "y"\nd ::= "z"\n',
      "ebnf",
      UNPRODUCTIVE,
    );

    expect(found.map((d) => d.message.match(/"(\w)"/)?.[1])).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test.each([
    ["is fixed by a terminating alternative", 'a ::= a "x" | "y"\n', 0],
    ["is fixed by an optional", 'a ::= (a "x")?\n', 0],
    ["is fixed by a star", 'a ::= (a "x")*\n', 0],
    ["is not fixed by a plus", 'a ::= (a "x")+\n', 1],
  ] as const)("recursion without a base case %s", (_name, text, count) => {
    const found = withCode(text, "ebnf", UNPRODUCTIVE);

    expect(found).toHaveLength(count);
  });

  test("does not cascade from undefined references", () => {
    const found = withCode("a ::= missing\n", "ebnf", UNPRODUCTIVE);

    expect(found).toHaveLength(0);
  });

  test.each([
    ["abnf", 'a = a "x"\n', 1],
    ["bnf", "<a> ::= <a> 'x'\n", 1],
    ["rbnf", "<a> ::= <a> 'x'\n", 1],
    ["rbnf", "<a> ::= <b> 'x'\n<b> ::= 'y'\n", 0],
  ] as const)(
    "detects non-terminating rules in %s: %p",
    (dialect, text, count) => {
      const found = withCode(text, dialect, UNPRODUCTIVE);

      expect(found).toHaveLength(count);
    },
  );

  test("does not make a rule unproductive because of an excluded rule", () => {
    const found = withCode(
      'a ::= [a-z]+ - b\nb ::= b "x"\n',
      "ebnf",
      UNPRODUCTIVE,
    );

    expect(found.map((d) => d.message)).toEqual([
      expect.stringContaining('"b"'),
    ]);
  });
});

describe("unreachable rules", () => {
  // x and y reference each other, but nothing outside the pair reaches them.
  const text = 'start ::= a\na ::= "x"\nx ::= y\ny ::= x | "q"\n';

  test("reports rules in cycles no entry point reaches, once", () => {
    const found = run(text, "ebnf").filter((d) => d.code === UNREACHABLE);

    expect(found.map((d) => d.message.match(/Rule "(\w+)"/)?.[1])).toEqual([
      "x",
      "y",
    ]);
  });

  test("does not also report those rules as unused", () => {
    const found = run(text, "ebnf");

    expect(
      found.some(
        (d) => d.code === "bnf.unused-rule" && /"[xy]"/.test(d.message),
      ),
    ).toBe(false);
  });

  test("accepts rules reached only from other top-level rules", () => {
    const found = run(
      'start ::= a\nother ::= helper\nhelper ::= "h"\na ::= "x"\n',
      "ebnf",
    ).filter((d) => d.code === UNREACHABLE);

    expect(found).toHaveLength(0);
  });

  test("reports the same cycles with the unused-rule hint off", () => {
    const found = run(text, "ebnf", { unusedRules: false }).filter(
      (d) => d.code === UNREACHABLE,
    );

    expect(found).toHaveLength(2);
  });

  test("does not count self use as reachability or use", () => {
    const found = run(
      'start ::= "s"\nloop ::= loop "x" | "y"\n',
      "ebnf",
    ).filter((d) => d.code === UNREACHABLE);

    expect(found).toHaveLength(0);
  });

  test("matches ABNF names case-insensitively and ignores core rules", () => {
    const found = run('Start = Foo DIGIT\nfoo = "x"\n', "abnf").filter(
      (d) => d.code === UNREACHABLE,
    );

    expect(found).toHaveLength(0);
  });

  test.each([
    ["examples/json.abnf", "abnf"],
    ["examples/json.bnf", "bnf"],
    ["examples/json.ebnf", "ebnf"],
    ["examples/json.rbnf", "rbnf"],
  ] as const)("reports no unreachable rules in %s", async (file, dialect) => {
    const body = repoText(file);

    const found = run(body, dialect).filter((d) => d.code === UNREACHABLE);

    expect(found).toHaveLength(0);
  });

  test("reports no unreachable rules in the RFC 3986 grammar", () => {
    const rfc = `URI = scheme ":" hier-part
hier-part = "//" authority / path-absolute / path-empty
relative-ref = relative-part
relative-part = "//" authority / path-noscheme / path-empty
path-noscheme = segment-nz-nc *( "/" segment )
segment-nz-nc = 1*unreserved
segment = *unreserved
scheme = ALPHA
authority = 1*ALPHA
path-absolute = "/" segment
path-empty = ""
unreserved = ALPHA / DIGIT
gen-delims = ":" / "/"
`;

    const found = run(rfc, "abnf").filter((d) => d.code === UNREACHABLE);

    expect(found).toHaveLength(0);
  });

  test("can be turned off by setting", () => {
    const found = run(text, "ebnf", { unreachableRules: "off" });

    expect(found.some((d) => d.code === UNREACHABLE)).toBe(false);
  });
});

describe("alternatives", () => {
  test.each([
    ["ebnf", "a ::= 'x' | 'y' | 'x'\n", 1],
    ["bnf", "<a> ::= 'x' | 'y' | 'x' | 'x'\n", 2],
    ["rbnf", "<a> ::= <b> | <b>\n<b> ::= 'q'\n", 1],
    ["ebnf", "a ::= ('x' | 'y' | 'y') 'z'\n", 1],
    ["abnf", 'a = "x" / "y" / "x"\n', 1],
    ["abnf", 'a = "x" / "X"\n', 1],
    ["abnf", 'a = %s"x" / %s"X"\n', 0],
    ["ebnf", "a ::= 'x' | 'y'\n", 0],
  ] as const)(
    "finds duplicate alternatives in %s: %p",
    (dialect, text, count) => {
      const found = withCode(text, dialect, DUPLICATE_ALT);

      expect(found).toHaveLength(count);
    },
  );

  test("points multi-line duplicates at the repeated branch", () => {
    const found = withCode(
      "a ::= 'x'\n  | 'y'\n  | 'x'\n",
      "ebnf",
      DUPLICATE_ALT,
    );

    expect(found[0]?.range.start.line).toBe(2);
  });

  test.each([
    ["bnf", "<a> ::= 'x' | | 'y'\n", 1],
    ["rbnf", "<a> ::= | 'y'\n", 1],
    ["ebnf", "a ::= 'y' |\n", 1],
    ["abnf", 'a = "y" / ""\n', 1],
    ["abnf", 'a = ""\n', 0],
    ["ebnf", "a ::= 'y' | 'z'\n", 0],
  ] as const)("finds empty alternatives in %s: %p", (dialect, text, count) => {
    const found = withCode(text, dialect, EMPTY_ALT);

    expect(found).toHaveLength(count);
  });

  test("can disable duplicate-alternative findings by setting", () => {
    const found = run("a ::= 'x' | 'x'\n", "ebnf", {
      duplicateAlternatives: "off",
    });

    expect(found.some((d) => d.code === DUPLICATE_ALT)).toBe(false);
  });
});

describe("robustness", () => {
  const brokenInputs = [
    "a ::= ( 'x'\n",
    "a ::= 'x' )\n",
    "a ::= 'x\n",
    "a ::= | | ( [ {\n",
    "a ::=\n",
    "?? ::= 'x'\n",
  ];

  test.each(
    brokenInputs.flatMap((text) =>
      (["bnf", "ebnf", "rbnf", "abnf"] as const).map(
        (dialect) => [dialect, text] as const,
      ),
    ),
  )("does not throw on syntax errors in %s: %p", (dialect, text) => {
    expect(() => run(text, dialect)).not.toThrow();
  });

  test("gives no derivation findings for an unclosed group", () => {
    const found = withCode("a ::= ( a\n", "ebnf", UNPRODUCTIVE);

    expect(found).toHaveLength(0);
  });

  test("handles very deep nesting without throwing", () => {
    const deep = `a ::= ${"(".repeat(5000)} 'x' ${")".repeat(5000)}\n`;

    expect(() => run(deep, "ebnf")).not.toThrow();
  });

  test("a long rule chain is analyzed in near-linear time", () => {
    const growth = growthForFourfoldInput((count) => {
      const lines = Array.from(
        { length: count },
        (_, i) => `r${i} ::= r${i + 1} 'x'\n`,
      );
      const chain = `${lines.join("")}r${count} ::= 'y'\n`;
      return () => run(chain, "ebnf");
    }, 1250);

    expect(growth).toBeLessThan(MAX_LINEAR_GROWTH);
  });

  test("reports every rule of a long cycle as left-recursive", () => {
    const cycle = Array.from(
      { length: 5000 },
      (_, i) => `r${i} ::= r${(i + 1) % 5000} 'x'\n`,
    ).join("");

    const found = withCode(cycle, "ebnf", LEFT_RECURSION);

    expect(found).toHaveLength(5000);
  });

  test.each(["bnf", "ebnf", "rbnf"] as const)(
    "gives every %s diagnostic a source and a code",
    (dialect) => {
      const text = "a ::= b c\nb ::= b | ( \nc ::= 'x' | 'x' | |\n??? bad\n";

      const found = run(text, dialect);

      for (const d of found) {
        expect(d.source).toBeTruthy();
        expect(d.code).toBeTruthy();
      }
    },
  );
});

describe("did you mean", () => {
  const text = "start ::= Expr expresion\nexpr ::= 'x'\nexpression ::= 'y'\n";

  test("suggests the name that differs only by case", () => {
    const found = withCode(text, "ebnf", UNDEFINED_REF);

    expect(found[0]?.message).toContain('Did you mean "expr"?');
  });

  test("suggests the name closest to a typo", () => {
    const found = withCode(text, "ebnf", UNDEFINED_REF);

    expect(found[1]?.message).toContain('Did you mean "expression"?');
  });

  test("gives no suggestion when didYouMean is off", () => {
    const off = run(text, "ebnf", { didYouMean: false }).filter(
      (d) => d.code === UNDEFINED_REF,
    );

    expect(off[0]?.message).not.toContain("Did you mean");
  });

  test("suggests the angle-bracket form of a defined name", () => {
    const found = withCode(
      "<a> ::= b <zzzz>\n<b> ::= 'x'\n",
      "bnf",
      UNDEFINED_REF,
    );

    expect(found[0]?.message).toContain('Did you mean "<b>"?');
  });

  test("gives no suggestion for an unrelated name", () => {
    const found = withCode(
      "<a> ::= b <zzzz>\n<b> ::= 'x'\n",
      "bnf",
      UNDEFINED_REF,
    );

    expect(found[1]?.message).not.toContain("Did you mean");
  });

  test("offers ABNF core rules as candidates", () => {
    const found = withCode("a = DIGT\n", "abnf", UNDEFINED_REF);

    expect(found[0]?.message).toContain("DIGIT");
  });

  test("computes a bounded edit distance", () => {
    expect(suggestions.boundedEditDistance("abc", "acb", 2)).toBe(1);
    expect(suggestions.boundedEditDistance("abcdef", "uvwxyz", 2)).toBe(3);
  });

  test("suggests nothing when every candidate is too far away", () => {
    expect(suggestions.suggestName("ab", ["ac"])).toBeUndefined();
  });
});

describe("ISO detection", () => {
  test("finds ISO productions anywhere in the document", () => {
    const text = "a ::= 'x'\nb = 'y' , a ;\n  c ::= 'z'\nd = a ;\n";

    const found = run(text, "ebnf").filter((d) => d.code === "bnf.iso-ebnf");

    expect(found).toHaveLength(2);
    expect(found[0]?.range.start.line).toBe(1);
  });
});

const apply = applyWorkspaceEdit;

function fixes(text: string, dialect: Dialect, options: Options = {}) {
  const doc = createDocument(`/w/t.${dialect}`, text, dialect);
  const found = run(text, dialect, { unusedRules: false, ...options });
  const provider = new actions.GrammarCodeActionProvider();
  const result = provider.provideCodeActions(
    asTextDocument(doc),
    new RangeMock(0, 0, 0, 0) as never,
    { diagnostics: found } as never,
    {} as never,
  ) as unknown as Array<{ title: string; edit: WorkspaceEditMock }> | undefined;
  return (result ?? []).map((action) => ({
    title: action.title,
    text: apply(text, action.edit),
  }));
}

describe("quick fixes", () => {
  test.each([
    ["ebnf", "a ::= nothing\n", "nothing ::= definition"],
    ["abnf", "a = nothing\n", "nothing = definition"],
    ["rbnf", "<a> ::= <nothing>\n", "<nothing> ::= definition"],
    ["bnf", "<a> ::= <nothing>\n", "<nothing> ::= definition"],
    ["bnf", "a ::= nothing\n", "nothing ::= definition"],
    ["bnf", "<a> ::= nothing\n", "<nothing> ::= definition"],
  ] as const)(
    "creates a missing %s rule in the dialect's name shape: %p",
    (dialect, text, tail) => {
      const create = fixes(text, dialect).find((f) =>
        f.title.startsWith("Create missing rule"),
      );

      expect(create?.text).toBe(`${text}\n${tail}\n`);
    },
  );

  test("creates the missing rule with the document's line ending", () => {
    const text = "a ::= nothing";
    const doc = createDocument("/w/t.ebnf", text, "ebnf");
    (doc as unknown as { eol: number }).eol = 2;
    const found = run(text, "ebnf", { unusedRules: false });

    const result = new actions.GrammarCodeActionProvider().provideCodeActions(
      asTextDocument(doc),
      new RangeMock(0, 0, 0, 0) as never,
      { diagnostics: found } as never,
      {} as never,
    ) as unknown as Array<{ edit: WorkspaceEditMock }>;

    const snippet = result[0]?.edit.snippetEdits[0]?.edits[0] as {
      snippet: { value: string };
    };
    expect(snippet.snippet.value).toBe(
      `\r\n\r\nnothing ::= \${1:definition}\r\n`,
    );
  });

  test("rewrites a case-mismatched reference", () => {
    const text = "start ::= Expr\nexpr ::= 'x'\n";

    const fix = fixes(text, "ebnf").find((f) =>
      f.title.includes("case-sensitive"),
    );

    expect(fix?.text).toBe("start ::= expr\nexpr ::= 'x'\n");
  });

  test("rewrites a misspelled reference to the suggested name", () => {
    const typo = fixes("s ::= expresion\nexpression ::= 'y'\n", "ebnf").find(
      (f) => f.title.startsWith("Change"),
    );

    expect(typo?.text).toBe("s ::= expression\nexpression ::= 'y'\n");
  });

  test("rewrites a reference to the angle-bracket form", () => {
    const shape = fixes("<a> ::= b\n<b> ::= 'x'\n", "bnf").find((f) =>
      f.title.startsWith("Change"),
    );

    expect(shape?.text).toBe("<a> ::= <b>\n<b> ::= 'x'\n");
  });

  test.each([
    ["ebnf", "a ::= 'x' | 'y' | 'x'\n", "a ::= 'x' | 'y'\n"],
    ["ebnf", "a ::= 'x'\n  | 'y'\n  | 'x'\n", "a ::= 'x'\n  | 'y'\n"],
    ["ebnf", "a ::= ('x' | 'x') 'z'\n", "a ::= ('x') 'z'\n"],
    ["bnf", "<a> ::= 'x' | 'x' | 'y'\n", "<a> ::= 'x' | 'y'\n"],
    ["abnf", 'a = "x" / "y" / "X"\n', 'a = "x" / "y"\n'],
  ] as const)(
    "removes a duplicate alternative in %s: %p",
    (dialect, text, expected) => {
      const fix = fixes(text, dialect).find(
        (f) => f.title === "Remove duplicate alternative",
      );

      expect(fix?.text).toBe(expected);
    },
  );

  test.each([
    ["bnf", "<a> ::= 'x' | | 'y'\n", "<a> ::= 'x' | 'y'\n"],
    ["bnf", "<a> ::= | 'y'\n", "<a> ::= 'y'\n"],
    ["ebnf", "a ::= 'y' |\n", "a ::= 'y'\n"],
    ["abnf", 'a = "y" / ""\n', 'a = "y"\n'],
  ] as const)(
    "removes an empty alternative in %s: %p",
    (dialect, text, expected) => {
      const fix = fixes(text, dialect).find(
        (f) => f.title === "Remove empty alternative",
      );

      expect(fix?.text).toBe(expected);
    },
  );

  describe("ISO to W3C conversion", () => {
    const text =
      "a = b , 'c' ;\nw ::= 'ok'\nd = { a , 'x' } ;\ne = a ,\n  'z' ;\n";

    test("converts the whole file at once", () => {
      const fix = fixes(text, "ebnf").find((f) =>
        f.title.startsWith("Convert every"),
      );

      expect(fix?.text).toBe(
        "a ::= b 'c'\nw ::= 'ok'\nd ::= ( a 'x' )*\ne ::= a\n  'z'\n",
      );
    });

    test("offers one per-production fix for each ISO production", () => {
      const single = fixes(text, "ebnf").filter((f) =>
        f.title.startsWith('Use "::="'),
      );

      expect(single).toHaveLength(3);
    });
  });

  test("offers the ABNF quick fixes for ABNF documents", () => {
    const text = 'a = "x"\na = "y"\n';

    const offered = fixes(text, "abnf");

    expect(offered).toEqual([
      {
        title: 'Change to "=/" (add an alternative to "a")',
        text: 'a = "x"\na =/ "y"\n',
      },
    ]);
  });

  test("offers the ABNF refactors for a string under the range", () => {
    const doc = createDocument("/w/t.abnf", 'a = "Foo"\n', "abnf");

    const refactors =
      new actions.GrammarCodeActionProvider().provideCodeActions(
        asTextDocument(doc),
        new RangeMock(0, 5, 0, 6) as never,
        { diagnostics: [] } as never,
        {} as never,
      );

    const offered = (
      (refactors ?? []) as unknown as Array<{
        title: string;
        edit: WorkspaceEditMock;
      }>
    ).map((action) => ({
      title: action.title,
      text: apply('a = "Foo"\n', action.edit),
    }));
    expect(offered).toEqual([
      {
        title: 'Make case-sensitive: %s"Foo" (RFC 7405)',
        text: 'a = %s"Foo"\n',
      },
      {
        title: 'Convert "Foo" to %x46.6F.6F (makes it case-sensitive)',
        text: "a = %x46.6F.6F\n",
      },
    ]);
  });

  describe("context.only filtering", () => {
    type Kinds = {
      QuickFix: unknown;
      RefactorRewrite: { value: string; contains(o: unknown): boolean };
    };
    const text = 'a = "Foo"\na = "y"\n';

    async function kinds(): Promise<Kinds> {
      const vscode = (await import("vscode")) as unknown as {
        CodeActionKind: Kinds;
      };
      return vscode.CodeActionKind;
    }

    function call(only: unknown) {
      const doc = createDocument("/w/t.abnf", text, "abnf");
      const found = run(text, "abnf");
      const provider = new actions.GrammarCodeActionProvider();
      return (provider.provideCodeActions(
        asTextDocument(doc),
        new RangeMock(0, 5, 0, 6) as never,
        { diagnostics: found, only } as never,
        {} as never,
      ) ?? []) as unknown as Array<{ kind: { value: string } }>;
    }

    test("RefactorRewrite returns only rewrite refactors", async () => {
      const { RefactorRewrite } = await kinds();

      const refactors = call(RefactorRewrite);

      expect(refactors.length).toBeGreaterThan(0);
      expect(
        refactors.every((a) => a.kind.value.startsWith("refactor.rewrite")),
      ).toBe(true);
    });

    test("QuickFix returns only quick fixes", async () => {
      const { QuickFix } = await kinds();

      const quick = call(QuickFix);

      expect(quick.every((a) => a.kind.value === "quickfix")).toBe(true);
    });

    test("no filter returns at least as many actions as either kind", async () => {
      const { QuickFix, RefactorRewrite } = await kinds();

      const all = call(undefined);

      expect(all.length).toBeGreaterThanOrEqual(
        Math.max(call(RefactorRewrite).length, call(QuickFix).length),
      );
    });

    test("RefactorRewrite returns nothing for a non-ABNF document", async () => {
      const { RefactorRewrite } = await kinds();
      const ebnf = createDocument("/w/t.ebnf", "a ::= x\n", "ebnf");
      const ebnfFound = run("a ::= x\n", "ebnf");

      const result = new actions.GrammarCodeActionProvider().provideCodeActions(
        asTextDocument(ebnf),
        new RangeMock(0, 0, 0, 0) as never,
        { diagnostics: ebnfFound, only: RefactorRewrite } as never,
        {} as never,
      );

      expect(result).toBeUndefined();
    });
  });

  test("leaves the ABNF case hint out of diagnostics by default", () => {
    const found = run('a = "Foo"\n', "abnf");

    expect(found.some((d) => String(d.code).startsWith("abnf.case"))).toBe(
      false,
    );
  });

  test("includes the ABNF case hint when caseSensitiveStrings is on", () => {
    const found = run('a = "Foo"\n', "abnf", { caseSensitiveStrings: true });

    expect(found.some((d) => d.code === "abnf.case-insensitive-string")).toBe(
      true,
    );
  });

  test("passes the ABNF duplicate-definition code through unchanged", () => {
    const found = run('a = "x"\na = "y"\n', "abnf");

    expect(found.some((d) => d.code === "abnf.duplicate-definition")).toBe(
      true,
    );
  });

  test("passes ABNF parser codes through unchanged", () => {
    const bad = run("a = (\n", "abnf");

    expect(bad.some((d) => String(d.code).startsWith("abnf."))).toBe(true);
  });
});

describe("settings", () => {
  test("updateGrammarDiagnostics reads bnf.diagnostics.* settings", () => {
    const set: Array<unknown[]> = [];
    const collection = { set: (_u: unknown, d: unknown[]) => set.push(d) };
    const doc = createDocument(
      "/w/a.ebnf",
      "a ::= a 'x' | 'y' | 'y'\n",
      "ebnf",
    );
    const ws = {
      get: () => {
        const document = grammar.parseGrammar(doc.getText(), "ebnf");
        return {
          dialect: "ebnf" as const,
          document,
          symbolTable: grammar.buildGrammarSymbolTable(document, "ebnf"),
        };
      },
    };
    setConfigurationValue("bnf.diagnostics.leftRecursion", "error");
    setConfigurationValue("bnf.diagnostics.duplicateAlternatives", "off");

    diagnostics.updateGrammarDiagnostics(
      asTextDocument(doc),
      ws as never,
      collection as never,
    );
    resetConfigurationValues();

    const codes = (set[0] as Array<{ code: string; severity: number }>).map(
      (d) => [d.code, d.severity],
    );
    expect(codes).toContainEqual(["bnf.left-recursion", 0]);
    expect(codes.some(([c]) => c === "bnf.duplicate-alternative")).toBe(false);
  });
});
