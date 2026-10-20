import { beforeAll, describe, expect, test } from "bun:test";
import { repoText } from "../repo-file.ts";
import {
  fireConfigurationChange,
  RangeMock,
  resetConfigurationValues,
  setLanguageConfigurationValue,
} from "../vscode-mock.ts";
import {
  asTextDocument,
  createDocument,
  createWorkspace,
  loadGrammarTestCore,
} from "./provider-test-utils.ts";

type Dialect = "abnf" | "bnf" | "ebnf" | "rbnf";

beforeAll(async () => {
  await loadGrammarTestCore();
});

describe("[language] setting overrides reach every provider", () => {
  test("formatting honours the override", async () => {
    const { GrammarFormattingProvider } = await import(
      "../../grammar/formatting-provider.ts"
    );
    setLanguageConfigurationValue(
      "abnf",
      "bnf.formatting.insertFinalNewline",
      false,
    );
    const format = (path: string, text: string, dialect: Dialect) => {
      const doc = createDocument(path, text, dialect);
      const edits =
        new GrammarFormattingProvider().provideDocumentFormattingEdits(
          asTextDocument(doc),
          {} as never,
          {} as never,
        ) as unknown as Array<{ newText?: string; text?: string }>;
      return edits[0]?.newText ?? edits[0]?.text;
    };

    const overridden = format("/w/a.abnf", 'a = "x"', "abnf");
    const other = format("/w/a.ebnf", "a ::= 'x'", "ebnf");

    expect(overridden).toBeUndefined();
    expect(other).toBe("a ::= 'x'\n");
    resetConfigurationValues();
  });

  test("semantic tokens honour the override", async () => {
    const { GrammarSemanticTokensProvider } = await import(
      "../../grammar/semantic-tokens.ts"
    );
    setLanguageConfigurationValue(
      "abnf",
      "bnf.semanticHighlighting.mode",
      "off",
    );
    const provider = new GrammarSemanticTokensProvider(createWorkspace());
    const tokenCount = (path: string, text: string, dialect: Dialect) =>
      (
        provider.provideDocumentSemanticTokens(
          asTextDocument(createDocument(path, text, dialect)),
          {} as never,
        ) as unknown as { data: unknown[] }
      ).data.length;

    const overridden = tokenCount("/w/a.abnf", 'a = "x"\nb = a\n', "abnf");
    const other = tokenCount("/w/a.ebnf", "a ::= 'x'\nb ::= a\n", "ebnf");

    expect(overridden).toBe(0);
    expect(other).toBeGreaterThan(0);
    resetConfigurationValues();
  });

  test("inlay hints honour the override", async () => {
    const { GrammarInlayHintsProvider } = await import(
      "../../grammar/providers/inlay-hints.ts"
    );
    setLanguageConfigurationValue(
      "abnf",
      "bnf.inlayHints.referenceCount",
      true,
    );
    const provider = new GrammarInlayHintsProvider(createWorkspace());
    const hintCount = (path: string, text: string, dialect: Dialect) =>
      provider.provideInlayHints(
        asTextDocument(createDocument(path, text, dialect)),
        new RangeMock(0, 0, 5, 0) as never,
        {} as never,
      ).length;

    const overridden = hintCount("/w/a.abnf", 'a = "x"\nb = a\n', "abnf");
    const other = hintCount("/w/a.ebnf", "a ::= 'x'\nb ::= a\n", "ebnf");

    expect(overridden).toBeGreaterThan(0);
    expect(other).toBe(0);
    resetConfigurationValues();
    provider.dispose();
  });
});

describe("refreshing on settings changes", () => {
  test("semantic tokens and inlay hints refresh for bnf settings only", async () => {
    const { GrammarSemanticTokensProvider } = await import(
      "../../grammar/semantic-tokens.ts"
    );
    const { GrammarInlayHintsProvider } = await import(
      "../../grammar/providers/inlay-hints.ts"
    );
    const semantic = new GrammarSemanticTokensProvider(createWorkspace());
    const inlay = new GrammarInlayHintsProvider(createWorkspace());
    let fired = 0;
    semantic.onDidChangeSemanticTokens(() => fired++);
    inlay.onDidChangeInlayHints(() => fired++);

    fireConfigurationChange("editor.fontSize");
    const afterForeign = fired;
    fireConfigurationChange("bnf.inlayHints.recursion");
    const afterBnf = fired;
    semantic.dispose();
    inlay.dispose();
    fireConfigurationChange("bnf.inlayHints.recursion");

    expect(afterForeign).toBe(0);
    expect(afterBnf).toBe(2);
    expect(fired).toBe(2);
  });
});

describe("setting scopes", () => {
  test("every bnf.* setting is language-overridable", async () => {
    const pkg = JSON.parse(repoText("package.json")) as {
      contributes: {
        configuration: { properties: Record<string, { scope?: string }> };
      };
    };

    const entries = Object.entries(pkg.contributes.configuration.properties);

    expect(entries.length).toBeGreaterThan(20);
    for (const [key, value] of entries) {
      expect(`${key}:${value.scope}`).toBe(`${key}:language-overridable`);
    }
  });
});
