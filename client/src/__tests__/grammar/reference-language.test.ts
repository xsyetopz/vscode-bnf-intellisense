import { describe, expect, test } from "bun:test";
import { referenceLanguage } from "./reference-language.ts";

function single(text: string): string[] {
  const matched = referenceLanguage(text, "ebnf", {
    alphabet: new Set("ab-z"),
    maxLength: 1,
  });
  return [...matched].sort();
}

describe("reference language character classes", () => {
  test.each([
    ["a trailing dash", "r ::= [a-]\n", ["-", "a"]],
    ["a leading dash", "r ::= [-a]\n", ["-", "a"]],
    ["a range", "r ::= [a-b]\n", ["a", "b"]],
    ["a negated trailing dash", "r ::= [^a-]\n", ["b", "z"]],
  ])(
    "treats %s as a literal where it is not a range",
    (_name, text, expected) => {
      const matched = single(text);

      expect(matched).toEqual(expected);
    },
  );
});
