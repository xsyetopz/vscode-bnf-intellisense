import { describe, expect, test } from "bun:test";
import { repoText } from "./repo-file.ts";

describe("ABNF TextMate injection", () => {
  test("matches markdown abnf fences with extra info text", async () => {
    const injection = JSON.parse(
      repoText("syntaxes/abnf-markdown.tmLanguage.json"),
    ) as { patterns: Array<{ begin: string }> };
    const begin = new RegExp(injection.patterns[0]?.begin ?? "");
    expect(begin.test("```abnf")).toBe(true);
    expect(begin.test('```abnf title="grammar"')).toBe(true);
    expect(begin.test("```abnfx")).toBe(false);
  });
});
