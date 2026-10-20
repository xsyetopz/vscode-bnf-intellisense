import { beforeAll, describe, expect, test } from "bun:test";
import { growthForFourfoldInput, MAX_LINEAR_GROWTH } from "../scaling.ts";
import {
  RangeMock,
  resetConfigurationValues,
  setLanguageConfigurationValue,
  type WorkspaceEditMock,
} from "../vscode-mock.ts";
import {
  type Dialect,
  diagnose,
  diagnostics,
  diagnosticsWithCode,
  grammar,
  loadCodeActionCore,
  quickFixes,
  REMOVE_DUPLICATE_TITLE,
  REMOVE_EMPTY_TITLE,
  rawCodeActions,
} from "./code-action-test-utils.ts";
import {
  applyWorkspaceEdit,
  asTextDocument,
  createDocument,
} from "./provider-test-utils.ts";

beforeAll(async () => {
  await loadCodeActionCore();
});

function removeDuplicate(text: string, dialect: Dialect) {
  return quickFixes(text, dialect).find(
    (f) => f.title === REMOVE_DUPLICATE_TITLE,
  )?.text;
}

describe("removing alternatives keeps comments", () => {
  test("an ABNF comment between the separator and the duplicate stays", () => {
    const text = 'a = "x" / "y" / ; keep\n    "x"\n';

    expect(removeDuplicate(text, "abnf")).toBe('a = "x" / "y" ; keep\n');
  });

  test("a block comment in a production dialect stays", () => {
    const text = "a ::= 'x' | 'y' /* mid */ | 'x'\n";

    expect(removeDuplicate(text, "ebnf")).toBe("a ::= 'x' | 'y' /* mid */\n");
  });

  test("a leading empty alternative is removed", () => {
    const fix = quickFixes("a ::= | 'y'\n", "ebnf").find(
      (f) => f.title === REMOVE_EMPTY_TITLE,
    );

    expect(fix?.text).toBe("a ::= 'y'\n");
  });
});

describe("duplicates across =/ extensions", () => {
  test("a repeated alternative in an extension is reported and removed", () => {
    const text = 'a = "x" / "y"\na =/ "z" / "x"\n';

    const found = diagnosticsWithCode(
      text,
      "abnf",
      "bnf.duplicate-alternative",
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.range.start.line).toBe(1);
    expect(removeDuplicate(text, "abnf")).toBe('a = "x" / "y"\na =/ "z"\n');
  });

  test("an extension that only duplicates is removed as a rule", () => {
    const text = 'a = "x" / "y"\nb = "q"\na =/ "X"\n';

    const found = diagnosticsWithCode(text, "abnf", "bnf.duplicate-extension");
    const fix = quickFixes(text, "abnf").find((f) =>
      f.title.startsWith("Remove this"),
    );

    expect(found).toHaveLength(1);
    expect(fix?.text).toBe('a = "x" / "y"\nb = "q"\n');
  });

  test("the first alternative of an extension can be removed", () => {
    const text = 'a = "x"\na =/ "x" / "z"\n';

    expect(removeDuplicate(text, "abnf")).toBe('a = "x"\na =/ "z"\n');
  });
});

describe("core rule name suggestions", () => {
  test("a misspelled core rule is corrected to its canonical name", () => {
    const text = "a = DIGT\n";

    const message = diagnosticsWithCode(
      text,
      "abnf",
      "bnf.undefined-reference",
    )[0]?.message;
    const fix = quickFixes(text, "abnf").find((f) =>
      f.title.startsWith("Change"),
    );

    expect(message).toContain('"DIGIT"');
    expect(fix?.text).toBe("a = DIGIT\n");
  });
});

describe("empty alternatives", () => {
  test.each([
    ["a ::= |\n", "ebnf"],
    ["a ::= ( | )\n", "ebnf"],
    ["a = /\n", "abnf"],
  ] as const)(
    "a lone separator in %j is reported once and offers no removal",
    (text, dialect) => {
      const found = diagnosticsWithCode(text, dialect, "bnf.empty-alternative");

      const removals = quickFixes(text, dialect).filter(
        (f) => f.title === REMOVE_EMPTY_TITLE,
      );

      expect(found).toHaveLength(1);
      expect(removals).toHaveLength(0);
    },
  );
});

describe("which diagnostics get fixes", () => {
  test("a foreign diagnostic with a matching message offers no fix", () => {
    const foreign = {
      message: 'Rule reference "x" has no definition in this file',
      range: new RangeMock(0, 6, 0, 7),
    };

    const fixes = quickFixes("a ::= x\n", "ebnf", { diagnostics: [foreign] });

    expect(fixes).toHaveLength(0);
  });
});

describe("creating a missing rule", () => {
  const text = 'a = "x"\n    / missing';

  test("an indented last line gets a plain insert at column 0", () => {
    const create = rawCodeActions(
      text,
      "abnf",
      diagnose(text, "abnf", { unusedRules: false }),
    ).find((a) => a.title.startsWith("Create missing"));

    expect(create?.edit?.snippetEdits).toHaveLength(0);
    expect(applyWorkspaceEdit(text, create?.edit as WorkspaceEditMock)).toBe(
      'a = "x"\n    / missing\n\nmissing = "TODO"\n',
    );
  });

  test("the inserted rule body leaves the document free of errors", () => {
    const create = rawCodeActions(
      text,
      "abnf",
      diagnose(text, "abnf", { unusedRules: false }),
    ).find((a) => a.title.startsWith("Create missing"));

    const out = applyWorkspaceEdit(text, create?.edit as WorkspaceEditMock);

    expect(
      diagnose(out, "abnf", { unusedRules: false }).filter(
        (d) => d.severity <= 1,
      ),
    ).toHaveLength(0);
  });

  test("line breaks follow the document's CRLF", () => {
    const create = quickFixes("a ::= nothing\r\n", "ebnf").find((f) =>
      f.title.startsWith("Create missing rule"),
    );

    expect(create?.text).toBe(
      "a ::= nothing\r\n\r\nnothing ::= definition\r\n",
    );
  });
});

describe("rename suggestions come from the diagnostic", () => {
  const text = "start ::= Expr\nexpr ::= 'x'\n";

  test("a diagnostic computed without a suggestion offers no rename", () => {
    const found = diagnose(text, "ebnf", {
      unusedRules: false,
      didYouMean: false,
    });

    const titles = quickFixes(text, "ebnf", { diagnostics: found }).map(
      (f) => f.title,
    );

    expect(
      titles.some((t) => t.startsWith("Rename") || t.startsWith("Change")),
    ).toBe(false);
    expect(titles.some((t) => t.startsWith("Create missing"))).toBe(true);
  });

  test("copies of stored diagnostics keep their suggestion", () => {
    const sets: unknown[][] = [];
    const doc = createDocument("/w/n7.ebnf", text, "ebnf");
    const workspace = {
      get: () => {
        const document = grammar.parseGrammar(text, "ebnf");
        return {
          dialect: "ebnf" as const,
          document,
          symbolTable: grammar.buildGrammarSymbolTable(document, "ebnf"),
        };
      },
    };
    diagnostics.updateGrammarDiagnostics(
      asTextDocument(doc),
      workspace as never,
      { set: (_u: unknown, list: unknown[]) => sets.push(list) } as never,
    );
    const copies = (sets[0] as Array<Record<string, unknown>>).map((d) => ({
      ...d,
    }));

    const titles = quickFixes(text, "ebnf", { diagnostics: copies }).map(
      (f) => f.title,
    );

    expect(titles.some((t) => t.startsWith("Rename"))).toBe(true);
  });

  test("foreign diagnostics honour bnf.diagnostics.didYouMean", () => {
    const foreign = diagnose(text, "ebnf", { unusedRules: false }).map((d) => ({
      code: d.code,
      message: d.message,
      range: d.range,
    }));
    setLanguageConfigurationValue("ebnf", "bnf.diagnostics.didYouMean", false);
    const off = quickFixes(text, "ebnf", { diagnostics: foreign }).map(
      (f) => f.title,
    );
    resetConfigurationValues();

    const on = quickFixes(text, "ebnf", { diagnostics: foreign }).map(
      (f) => f.title,
    );

    expect(off.some((t) => t.startsWith("Rename"))).toBe(false);
    expect(on.some((t) => t.startsWith("Rename"))).toBe(true);
  });

  test("a diagnostic that moved never picks up another reference's suggestion", () => {
    const before = 'a ::= fooo\nb ::= barr\nfood ::= "x"\nbark ::= "y"\n';
    const doc = createDocument("/w/f1.ebnf", before, "ebnf");
    const workspace = {
      get: () => {
        const document = grammar.parseGrammar(before, "ebnf");
        return {
          dialect: "ebnf" as const,
          document,
          symbolTable: grammar.buildGrammarSymbolTable(document, "ebnf"),
        };
      },
    };
    diagnostics.updateGrammarDiagnostics(
      asTextDocument(doc),
      workspace as never,
      { set: () => undefined } as never,
    );
    const after = `\n${before}`;
    const moved = {
      code: "bnf.undefined-reference",
      message: "x",
      range: new RangeMock(1, 6, 1, 10),
    };

    const titles = quickFixes(after, "ebnf", { diagnostics: [moved] }).map(
      (f) => f.title,
    );

    expect(titles.some((t) => t.includes('"bark"'))).toBe(false);
    expect(titles.some((t) => t.includes('"fooo" to "food"'))).toBe(true);
  });
});

describe("fixes for very large documents", () => {
  const SIZE = 1000;
  const fixGrowth = (build: (count: number) => string, dialect: Dialect) =>
    growthForFourfoldInput((count) => {
      const text = build(count);
      const found = diagnose(text, dialect, { unusedRules: false });
      return () => rawCodeActions(text, dialect, found);
    }, SIZE);

  test("ISO productions are offered conversions in near-linear time", () => {
    const build = (count: number) =>
      Array.from({ length: count }, (_, i) => `r${i} = "x" ;\n`).join("");
    const text = build(SIZE * 4);
    const found = diagnose(text, "ebnf", { unusedRules: false });

    const result = rawCodeActions(text, "ebnf", found);

    expect(result.length).toBeGreaterThan(SIZE * 4);
    expect(fixGrowth(build, "ebnf")).toBeLessThan(MAX_LINEAR_GROWTH);
  });

  test("undefined references are offered fixes in near-linear time", () => {
    const build = (count: number) =>
      Array.from({ length: count }, (_, i) => `r${i} ::= m${i}\n`).join("");
    const text = build(SIZE * 4);
    const found = diagnose(text, "ebnf", { unusedRules: false });

    const result = rawCodeActions(text, "ebnf", found);

    expect(result.length).toBeGreaterThan(SIZE * 4);
    expect(fixGrowth(build, "ebnf")).toBeLessThan(MAX_LINEAR_GROWTH);
  });

  test("duplicate alternatives are offered removals in near-linear time", () => {
    const build = (count: number) =>
      `a ::= ${Array.from({ length: count }, () => "'x'").join(" | ")}\n`;
    const text = build(SIZE * 4);
    const found = diagnose(text, "ebnf", { unusedRules: false });

    const result = rawCodeActions(text, "ebnf", found);

    expect(
      found.filter((d) => d.code === "bnf.duplicate-alternative"),
    ).toHaveLength(SIZE * 4 - 1);
    expect(result.length).toBe(SIZE * 4 - 1);
    expect(fixGrowth(build, "ebnf")).toBeLessThan(MAX_LINEAR_GROWTH);
  });
});
