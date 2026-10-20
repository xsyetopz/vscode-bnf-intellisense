import { beforeAll, describe, expect, test } from "bun:test";
import { loadGrammarTestCore } from "./provider-test-utils.ts";

let matchSymbolsByName: typeof import("../../grammar/workspace.ts").matchSymbolsByName;

beforeAll(async () => {
  await loadGrammarTestCore();
  ({ matchSymbolsByName } = await import("../../grammar/workspace.ts"));
});

describe("workspace symbol search", () => {
  const rules = ["alpha", "beta"].map((name) => ({
    uri: { path: "/x.bnf" } as never,
    dialect: "bnf" as const,
    rule: { name } as never,
  }));
  const search = (query: string) =>
    matchSymbolsByName(rules, query).map((entry) => entry.rule.name);

  test.each([
    ["bnf", []],
    [":", []],
    ["ALP", ["alpha"]],
    ["a", ["alpha", "beta"]],
  ])("query %j matches rule names %j, not index keys", (query, expected) => {
    expect(search(query)).toEqual(expected);
  });
});
