import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { growthForFourfoldInput, MAX_LINEAR_GROWTH } from "../scaling.ts";
import {
  createExtensionContext,
  diagnosticCollections,
  fireConfigurationChange,
  openTextDocuments,
  resetConfigurationValues,
  resetExtensionHost,
  setConfigurationValue,
  setLanguageConfigurationValue,
} from "../vscode-mock.ts";
import {
  diagnose,
  diagnostics,
  diagnosticsWithCode,
  grammar,
  loadCodeActionCore,
} from "./code-action-test-utils.ts";
import { asTextDocument, createDocument } from "./provider-test-utils.ts";

beforeAll(async () => {
  await loadCodeActionCore();
});

afterEach(() => {
  resetExtensionHost();
});

describe("did-you-mean suggestions", () => {
  test("undefined references are reported in near-linear time", () => {
    const build = (count: number) =>
      Array.from({ length: count }, (_, i) => `rule${i} ::= rulx${i}\n`).join(
        "",
      );
    const text = build(8000);

    const growth = growthForFourfoldInput((count) => {
      const input = build(count);
      return () => diagnose(input, "ebnf");
    }, 2000);
    const found = diagnose(text, "ebnf");

    expect(
      found.filter((d) => d.code === "bnf.undefined-reference"),
    ).toHaveLength(8000);
    expect(growth).toBeLessThan(MAX_LINEAR_GROWTH);
  });

  test("case mismatches are still suggested among hundreds of rules", () => {
    const defs = Array.from({ length: 300 }, (_, i) => `r${i} ::= 'x'\n`);
    const refs = Array.from({ length: 300 }, (_, i) => `q${i}`).join(" ");

    const found = diagnose(`${defs.join("")}start ::= ${refs} R5\n`, "ebnf");

    const last = found
      .filter((d) => d.code === "bnf.undefined-reference")
      .pop();
    expect(last?.message).toContain('Did you mean "r5"?');
  });
});

describe("left recursion", () => {
  test("is reported once per rule, with the real path for indirect recursion", () => {
    const found = diagnosticsWithCode(
      'a ::= b | a "x"\nb ::= a "y"\n',
      "ebnf",
      "bnf.left-recursion",
    );

    expect(found.map((d) => d.message)).toEqual([
      expect.stringContaining("directly left-recursive"),
      expect.stringContaining("b -> a -> b"),
    ]);
  });

  test("a cycle of three reports each rule once", () => {
    const found = diagnosticsWithCode(
      'a ::= b\nb ::= c\nc ::= a | "x"\n',
      "ebnf",
      "bnf.left-recursion",
    );

    expect(found).toHaveLength(3);
    expect(new Set(found.map((d) => d.range.start.line)).size).toBe(3);
  });

  test.each([
    ["a nullable core rule does not hide it", 'a = LWSP a "x" / "y"\n', 1],
    ["a non-nullable core rule hides it", 'a = DIGIT a "x" / "y"\n', 0],
    [
      "a user rule redefining LWSP can make it non-nullable",
      'LWSP = "w"\na = LWSP a "x" / "y"\n',
      0,
    ],
  ])("ABNF: %s", (_name, text, expected) => {
    const found = diagnosticsWithCode(text, "abnf", "bnf.left-recursion");

    expect(found).toHaveLength(expected);
  });
});

describe("duplicate alternatives", () => {
  test('%i"abc" duplicates "abc"', () => {
    const found = diagnosticsWithCode(
      'a = "abc" / %i"abc"\n',
      "abnf",
      "bnf.duplicate-alternative",
    );

    expect(found).toHaveLength(1);
  });

  test('%s"abc" does not duplicate "abc"', () => {
    const found = diagnosticsWithCode(
      'a = "abc" / %s"abc"\n',
      "abnf",
      "bnf.duplicate-alternative",
    );

    expect(found).toHaveLength(0);
  });
});

describe("duplicate definitions and incremental alternatives", () => {
  test("duplicate definitions are errors even with =/ present", () => {
    const found = diagnose('a = "x"\na = "y"\na =/ "z"\n', "abnf").filter((d) =>
      d.message.includes("more than one definition"),
    );

    expect(found).toHaveLength(2);
    expect(found.every((d) => d.severity === 0)).toBe(true);
  });

  test("a definition with a valid =/ extension is clean", () => {
    const found = diagnose('a = "x"\na =/ "z"\n', "abnf");

    expect(found.some((d) => d.message.includes("more than one"))).toBe(false);
    expect(found.some((d) => d.message.includes("before any"))).toBe(false);
  });

  test("an orphan =/ is a warning", () => {
    const found = diagnose('a =/ "z"\n', "abnf").filter((d) =>
      d.message.includes("before any"),
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe(1);
  });

  test("an =/ before its base definition is reported", () => {
    const found = diagnose('a =/ "z"\na = "x"\n', "abnf");

    expect(found.some((d) => d.message.includes("before any"))).toBe(true);
  });

  test("duplicate EBNF definitions are errors", () => {
    const found = diagnose("a ::= 'x'\na ::= 'y'\n", "ebnf").filter((d) =>
      d.message.includes("more than one"),
    );

    expect(found.every((d) => d.severity === 0)).toBe(true);
  });
});

describe("unused rules", () => {
  test("a rule that only refers to itself is reported unused", () => {
    const messages = diagnose(
      'root ::= item\nitem ::= "x"\nloop ::= loop "y"\n',
      "ebnf",
    ).map((d) => d.message);

    expect(messages).toContain('Rule "loop" is not referenced by another rule');
    expect(messages).not.toContain(
      'Rule "item" is not referenced by another rule',
    );
  });

  test("a user rule that redefines a core name is reported when unused", () => {
    const messages = diagnose('root = "x"\nALPHA = "y"\n', "abnf").map(
      (d) => d.message,
    );

    expect(messages).toContain(
      'Rule "ALPHA" is not referenced by another rule',
    );
  });
});

describe("diagnostic settings", () => {
  test("language overrides apply per document", () => {
    const abnf = createDocument("/w/a.abnf", 'a = a "x" / "y"\n', "abnf");
    const ebnf = createDocument("/w/a.ebnf", "a ::= a 'x' | 'y'\n", "ebnf");
    setLanguageConfigurationValue(
      "abnf",
      "bnf.diagnostics.leftRecursion",
      "error",
    );
    const read = (doc: typeof abnf) =>
      diagnostics.readDiagnosticOptions({
        uri: doc.uri as never,
        languageId: doc.languageId,
      }).leftRecursion;

    expect(read(abnf)).toBe("error");
    expect(read(ebnf)).toBe("hint");
    resetConfigurationValues();
  });

  test("refreshing updates every grammar document and skips others", () => {
    const sets: Array<[string, number]> = [];
    const collection = {
      set: (uri: { path: string }, list: unknown[]) =>
        sets.push([uri.path, list.length]),
    };
    const docs = [
      createDocument("/w/a.ebnf", "a ::= a 'x'\n", "ebnf"),
      createDocument("/w/b.abnf", 'b = b "x"\n', "abnf"),
      createDocument("/w/c.txt", "x", "plaintext" as never),
    ];
    const workspace = {
      get: (doc: (typeof docs)[number]) => {
        const document = grammar.parseGrammar(doc.getText(), doc.languageId);
        return {
          dialect: doc.languageId,
          document,
          symbolTable: grammar.buildGrammarSymbolTable(
            document,
            doc.languageId,
          ),
        };
      },
    };

    diagnostics.refreshGrammarDiagnostics(
      docs.map(asTextDocument),
      workspace as never,
      collection as never,
    );

    expect(sets.map(([path]) => path)).toEqual(["/w/a.ebnf", "/w/b.abnf"]);
    expect(sets.every(([, count]) => count > 0)).toBe(true);
  });

  test("open documents get fresh diagnostics when a bnf setting changes", async () => {
    resetExtensionHost();
    resetConfigurationValues();
    const { activateGrammarExtension } = await import("../../extension.ts");
    const doc = createDocument("/w/a.ebnf", "a ::= b\n", "ebnf");
    openTextDocuments.push(doc);
    await activateGrammarExtension(createExtensionContext() as never);
    const collection = diagnosticCollections[0];
    const shown = () => collection?.entries.get(doc.uri.toString()) ?? [];
    const before = shown().length;

    setConfigurationValue("bnf.diagnostics.enable", false);
    fireConfigurationChange("bnf.diagnostics.enable");

    expect(before).toBeGreaterThan(0);
    expect(shown()).toHaveLength(0);
    resetConfigurationValues();
  });

  test("open documents keep their diagnostics when a foreign setting changes", async () => {
    resetExtensionHost();
    resetConfigurationValues();
    const { activateGrammarExtension } = await import("../../extension.ts");
    const doc = createDocument("/w/a.ebnf", "a ::= b\n", "ebnf");
    openTextDocuments.push(doc);
    await activateGrammarExtension(createExtensionContext() as never);
    const collection = diagnosticCollections[0];
    const shown = () => collection?.entries.get(doc.uri.toString()) ?? [];
    const before = shown().length;

    setConfigurationValue("bnf.diagnostics.enable", false);
    fireConfigurationChange("editor.fontSize");

    expect(before).toBeGreaterThan(0);
    expect(shown()).toHaveLength(before);
    resetConfigurationValues();
  });
});
