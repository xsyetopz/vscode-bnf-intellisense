import { beforeAll, describe, expect, test } from "bun:test";
import { providerRegistrations } from "../vscode-mock.ts";
import { createWorkspace, loadGrammarTestCore } from "./provider-test-utils.ts";

beforeAll(async () => {
  await loadGrammarTestCore();
});

describe("provider registration", () => {
  test("registers every language provider once", async () => {
    const { registerGrammarProviders } = await import(
      "../../grammar/providers/index.ts"
    );
    providerRegistrations.length = 0;
    const disposables = registerGrammarProviders(
      [{ language: "abnf" }] as never,
      createWorkspace(),
      { dispose() {} } as never,
    );
    const kinds = providerRegistrations.map((entry) => entry.kind);
    for (const kind of [
      "selectionRange",
      "codeLens",
      "callHierarchy",
      "rangeFormatting",
      "onTypeFormatting",
      "linkedEditing",
      "documentLinks",
      "declaration",
      "rangeSemanticTokens",
      "semanticTokens",
      "formatting",
      "definition",
    ]) {
      expect(kinds.filter((k) => k === kind)).toHaveLength(1);
    }
    expect(disposables.length).toBeGreaterThan(10);
    const onType = providerRegistrations.find(
      (entry) => entry.kind === "onTypeFormatting",
    );
    expect(onType?.args).toEqual(["\n"]);
    // The semantic tokens provider serves both full and range requests.
    const semantic = providerRegistrations.find(
      (entry) => entry.kind === "semanticTokens",
    );
    const range = providerRegistrations.find(
      (entry) => entry.kind === "rangeSemanticTokens",
    );
    expect(range?.provider).toBe(semantic?.provider);
  });
});
