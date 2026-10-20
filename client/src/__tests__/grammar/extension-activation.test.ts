import { afterEach, describe, expect, test } from "bun:test";
import { repoText } from "../repo-file.ts";
import {
  commandsHostMock,
  contentProviderSchemes,
  createdWebviewPanels,
  createExtensionContext,
  diagnosticCollections,
  registeredCommands,
  resetExtensionHost,
} from "../vscode-mock.ts";

function contributedCommandIds(): string[] {
  const pkg = JSON.parse(repoText("package.json")) as {
    contributes: { commands: Array<{ command: string }> };
  };
  return pkg.contributes.commands.map((entry) => entry.command);
}

afterEach(() => {
  resetExtensionHost();
});

describe("extension activation", () => {
  test("activating registers disposables without throwing", async () => {
    resetExtensionHost();
    const { activateGrammarExtension } = await import("../../extension.ts");
    const context = createExtensionContext();

    await activateGrammarExtension(context as never);

    expect(context.subscriptions).toContain(diagnosticCollections[0] as never);
    expect(diagnosticCollections).toHaveLength(1);
    expect(contentProviderSchemes).toHaveLength(1);
  });

  test("every command contributed in package.json is registered", async () => {
    resetExtensionHost();
    const { activateGrammarExtension } = await import("../../extension.ts");

    await activateGrammarExtension(createExtensionContext() as never);

    const contributed = contributedCommandIds();
    expect(contributed.length).toBeGreaterThan(0);
    expect([...registeredCommands.keys()].sort()).toEqual(
      [...contributed].sort(),
    );
  });
});

describe("railroad host", () => {
  test("creates nonces of 48 hex characters", async () => {
    const { createNonce } = await import("../../grammar/railroad/host.ts");

    const nonce = createNonce();

    expect(nonce).toMatch(/^[0-9a-f]{48}$/);
  });

  test("creates a different nonce every time", async () => {
    const { createNonce } = await import("../../grammar/railroad/host.ts");

    const nonces = new Set(Array.from({ length: 100 }, () => createNonce()));

    expect(nonces.size).toBe(100);
  });

  test("opens a script-enabled webview that cannot read local files", async () => {
    const { createVscodeHost } = await import("../../grammar/railroad/host.ts");

    createVscodeHost().createPanel("Railroad: g.abnf");

    expect(createdWebviewPanels).toHaveLength(1);
    expect(createdWebviewPanels[0]?.options).toEqual({
      enableScripts: true,
      enableFindWidget: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    });
  });
});

describe("command registration double", () => {
  test("rejects a duplicate command id like VS Code", () => {
    commandsHostMock.registerCommand("bnf.duplicate", () => undefined);

    const register = () =>
      commandsHostMock.registerCommand("bnf.duplicate", () => undefined);

    expect(register).toThrow("already exists");
  });
});
