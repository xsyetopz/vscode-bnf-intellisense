import { beforeAll, describe, expect, test } from "bun:test";
import "./vscode-mock.ts";
import { repoText } from "./repo-file.ts";

type SyntaxDetails = typeof import("../grammar/syntax-details.ts");
let details: SyntaxDetails;

beforeAll(async () => {
  details = await import("../grammar/syntax-details.ts");
});

function hover(text: string, character: number): string | undefined {
  const result = details.getSyntaxHover(text, 0, character, "abnf");
  return (result as { contents?: { value: string } } | undefined)?.contents
    ?.value;
}

function labels(body: string): string {
  const hints = details.getSyntaxDetailInlays(0, 0, body, "abnf");
  return (hints[0]?.label as string | undefined) ?? "";
}

describe("ABNF syntax details", () => {
  test("describes %d values as decimal, not hex", () => {
    expect(hover("a = %d1F", 5)).toContain("decimal terminal");
    expect(hover("a = %d1F", 5)).toContain("`%d1`");
  });

  test("labels ranges and sequences only for numeric values", () => {
    expect(labels('rule-name "." %x41')).toBe(" hex");
    expect(labels("%x41-5A")).toBe(" hex, range");
    expect(labels("%x41.42")).toBe(" hex, sequence");
    expect(labels('"a-b" "c.d"')).toBe("");
  });

  test("shows no delimiter hover inside comments and strings", () => {
    expect(hover("a = b ; see (RFC)", 14)).toBeUndefined();
    expect(hover('a = "(" (b)', 5)).toBeUndefined();
    expect(hover("a = (b)", 4)).toContain("group delimiter");
    expect(hover("a = [b]", 4)).toContain("optional group delimiter");
  });

  test("ignores asterisks inside strings for repetition hover", () => {
    expect(hover('a = "*"', 5)).toBeUndefined();
    expect(hover("a = 2*3b", 5)).toContain("bounded repetition");
    expect(hover("a = *b", 4)).toContain("repetition");
  });
});

describe("ABNF language configuration", () => {
  const pkg = JSON.parse(repoText("package.json"));

  test("gives the abnf language its own language configuration", () => {
    const abnf = pkg.contributes.languages.find(
      (l: { id: string }) => l.id === "abnf",
    );
    expect(abnf.configuration).toBe("abnf-language-configuration.json");
    const config = JSON.parse(repoText("abnf-language-configuration.json"));
    expect(config.comments.blockComment).toBeUndefined();
    expect(JSON.stringify(config.autoClosingPairs)).not.toContain('"open":"{"');
  });

  test("requires continuationIndent to be at least 1", () => {
    const setting =
      pkg.contributes.configuration.properties[
        "bnf.formatting.continuationIndent"
      ];
    expect(setting.minimum).toBe(1);
  });
});
