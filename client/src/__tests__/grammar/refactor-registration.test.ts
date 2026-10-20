import { beforeAll, describe, expect, test } from "bun:test";
import { providerRegistrations } from "../vscode-mock.ts";
import { createWorkspace, loadGrammarTestCore } from "./provider-test-utils.ts";

beforeAll(async () => {
  await loadGrammarTestCore();
});

async function registerRefactors() {
  const { registerGrammarRefactorProviders } = await import(
    "../../grammar/refactors/index.ts"
  );
  providerRegistrations.length = 0;
  registerGrammarRefactorProviders(
    [{ language: "abnf" }] as never,
    createWorkspace(),
  );
  return { registrations: [...providerRegistrations] };
}

describe("refactor provider registration", () => {
  test("advertises the extract and inline refactor kinds", async () => {
    const { registrations } = await registerRefactors();

    const metadata = registrations[0]?.args[0] as {
      providedCodeActionKinds: Array<{ value: string }>;
    };
    expect(metadata.providedCodeActionKinds.map((kind) => kind.value)).toEqual([
      "refactor.extract",
      "refactor.inline",
    ]);
  });
});
