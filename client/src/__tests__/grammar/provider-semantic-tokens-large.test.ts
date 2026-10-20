import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  closeListenerCount,
  fireCloseTextDocument,
  resetConfigurationValues,
  setConfigurationValue,
} from "../vscode-mock.ts";
import {
  asTextDocument,
  createDocument,
  loadGrammarTestCore,
} from "./provider-test-utils.ts";

let GrammarWorkspace: typeof import("../../grammar/workspace.ts").GrammarWorkspace;
let GrammarSemanticTokensProvider: typeof import("../../grammar/semantic-tokens.ts").GrammarSemanticTokensProvider;

beforeAll(async () => {
  await loadGrammarTestCore();
  ({ GrammarWorkspace } = await import("../../grammar/workspace.ts"));
  ({ GrammarSemanticTokensProvider } = await import(
    "../../grammar/semantic-tokens.ts"
  ));
});

afterEach(() => {
  resetConfigurationValues();
});

function abnfRules(count: number, prefix = "rule"): string {
  return Array.from(
    { length: count },
    (_, i) =>
      `${prefix}${i} = "x" ${prefix}${i + 1} / "y" ${prefix}${i + 2} ; c`,
  ).join("\n");
}

/** Token types of rule names, references, and core-rule references. */
const RULE_AND_REFERENCE_TYPES = new Set(["type", "parameter", "variable"]);

interface EmittedToken {
  tokenType: string;
}

function emittedTokens(
  provider: InstanceType<typeof GrammarSemanticTokensProvider>,
  mock: ReturnType<typeof createDocument>,
): readonly EmittedToken[] {
  const result = provider.provideDocumentSemanticTokens(
    asTextDocument(mock),
    {} as never,
  ) as unknown as { data: readonly EmittedToken[] };
  return result.data;
}

function tokenCount(
  provider: InstanceType<typeof GrammarSemanticTokensProvider>,
  mock: ReturnType<typeof createDocument>,
): number {
  return emittedTokens(provider, mock).length;
}

function tokenTypes(tokens: readonly EmittedToken[]): Set<string> {
  return new Set(tokens.map((token) => token.tokenType));
}

function documentOf(path: string, text: string, version: number) {
  const mock = createDocument(path, text, "abnf");
  mock.version = version;
  return mock;
}

describe("semantic tokens on large files in the default mode", () => {
  test("a 3000 rule ABNF file gets exactly its rule and reference tokens", () => {
    const provider = new GrammarSemanticTokensProvider(new GrammarWorkspace());
    const mock = documentOf("/w/large.abnf", abnfRules(3000), 1);

    const count = tokenCount(provider, mock);

    // One definition and two references per rule.
    expect(count).toBe(3000 * 3);
  });

  test("past the token limit no operator, string, or comment tokens remain", () => {
    const provider = new GrammarSemanticTokensProvider(new GrammarWorkspace());
    const mock = documentOf("/w/large.abnf", abnfRules(3000), 1);

    const types = tokenTypes(emittedTokens(provider, mock));

    expect(types.size).toBeGreaterThan(0);
    for (const type of types) {
      expect(RULE_AND_REFERENCE_TYPES.has(type)).toBe(true);
    }
  });
});

describe("tokens stay correct across requests", () => {
  test("two documents requested alternately keep their own tokens", () => {
    const provider = new GrammarSemanticTokensProvider(new GrammarWorkspace());
    const small = documentOf("/w/a.abnf", abnfRules(3, "a"), 1);
    const big = documentOf("/w/b.abnf", abnfRules(40, "b"), 1);
    const smallFirst = tokenCount(provider, small);
    const bigFirst = tokenCount(provider, big);

    const smallAgain = tokenCount(provider, small);
    const bigAgain = tokenCount(provider, big);

    expect(bigFirst).toBeGreaterThan(smallFirst);
    expect(smallAgain).toBe(smallFirst);
    expect(bigAgain).toBe(bigFirst);
  });

  test("a new version of a document gets fresh tokens", () => {
    const provider = new GrammarSemanticTokensProvider(new GrammarWorkspace());
    const before = documentOf("/w/c.abnf", abnfRules(3, "c"), 1);
    const after = documentOf("/w/c.abnf", abnfRules(30, "c"), 2);
    const countBefore = tokenCount(provider, before);

    const countAfter = tokenCount(provider, after);

    expect(countAfter).toBeGreaterThan(countBefore);
  });

  test("changing the setting for the same version changes the tokens", () => {
    const provider = new GrammarSemanticTokensProvider(new GrammarWorkspace());
    const mock = documentOf("/w/d.abnf", abnfRules(10, "d"), 1);
    const full = tokenCount(provider, mock);

    setConfigurationValue("bnf.semanticHighlighting.maxTokens", 5);
    const reduced = tokenCount(provider, mock);

    expect(reduced).toBeGreaterThan(0);
    expect(reduced).toBeLessThan(full);
  });
});

describe("tokens after a document is closed and reopened", () => {
  test("a reopened document with the same version gets tokens for its new text", () => {
    const grammarWorkspace = new GrammarWorkspace();
    const provider = new GrammarSemanticTokensProvider(grammarWorkspace);
    const original = documentOf("/w/e.abnf", abnfRules(3, "e"), 1);
    const countBefore = tokenCount(provider, original);
    fireCloseTextDocument(original);
    const reopened = documentOf("/w/e.abnf", abnfRules(30, "e"), 1);

    const countAfter = tokenCount(provider, reopened);

    expect(countAfter).toBeGreaterThan(countBefore);
  });

  test("a disposed provider stops listening for closed documents", () => {
    const listenersBefore = closeListenerCount();
    const provider = new GrammarSemanticTokensProvider(new GrammarWorkspace());
    const listening = closeListenerCount();

    provider.dispose();

    expect(listening).toBeGreaterThan(listenersBefore);
    expect(closeListenerCount()).toBe(listening - 1);
  });
});
