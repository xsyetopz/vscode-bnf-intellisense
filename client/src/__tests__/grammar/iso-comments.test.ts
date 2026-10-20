import { beforeAll, describe, expect, test } from "bun:test";
import { PositionMock } from "../vscode-mock.ts";
import {
  convertEveryProduction,
  diagnosticsWithCode,
  grammar,
  loadCodeActionCore,
  ONE_PRODUCTION_TITLE,
  quickFixes,
} from "./code-action-test-utils.ts";
import {
  asTextDocument,
  createDocument,
  createWorkspace,
  loadGrammarTestCore,
} from "./provider-test-utils.ts";

let GrammarHoverProvider: typeof import("../../grammar/providers/hover.ts").GrammarHoverProvider;

const ISO = "bnf.iso-ebnf";
const COMMENT_FIX = 'Use "/* ... */" for this EBNF comment';

beforeAll(async () => {
  await loadCodeActionCore();
  await loadGrammarTestCore();
  ({ GrammarHoverProvider } = await import("../../grammar/providers/hover.ts"));
});

function ruleNames(text: string): string[] {
  return grammar.parseGrammar(text, "ebnf").rules.map((r) => r.name);
}

function hoverOver(text: string, line: number, character: number): string {
  const provider = new GrammarHoverProvider(createWorkspace());
  const doc = createDocument("/w/t.ebnf", text, "ebnf");
  const hover = provider.provideHover(
    asTextDocument(doc),
    new PositionMock(line, character) as never,
    {} as never,
  );
  return (hover as unknown as { contents: { value: string } }).contents.value;
}

describe("ISO comment doc text", () => {
  test("hover shows the comment body without the (* and *) delimiters", () => {
    const text = "(* head\n   more *)\nb ::= y\n";

    const hover = hoverOver(text, 2, 0);

    expect(hover).toEndWith("head\nmore");
    expect(hover).not.toContain("*)");
    expect(hover).not.toContain("(*");
    expect(hover).not.toContain("* head");
  });
});

describe("ISO comment extent", () => {
  test("a stray (*) does not swallow the next rule", () => {
    const text = "a ::= (*) b\nc ::= (d*)\n";

    const names = ruleNames(text);
    const iso = diagnosticsWithCode(text, "ebnf", ISO);

    expect(names).toEqual(["a", "c"]);
    expect(iso).toHaveLength(0);
  });

  test("an unfinished (* while typing keeps later rules", () => {
    const text = "a ::= x (* note\nb ::= y*)\nc ::= z\n";

    const names = ruleNames(text);

    expect(names).toEqual(["a", "b", "c"]);
  });

  test("a closed multi-line comment on its own rule still converts", () => {
    const text = "a ::= x (* one\n two *) y\nb ::= z\n";

    const names = ruleNames(text);
    const iso = diagnosticsWithCode(text, "ebnf", ISO);
    const fix = quickFixes(text, "ebnf").find((f) => f.title === COMMENT_FIX);

    expect(names).toEqual(["a", "b"]);
    expect(iso).toHaveLength(1);
    expect(fix?.text).toBe("a ::= x /* one\n two */ y\nb ::= z\n");
  });
});

describe("nested ISO comments", () => {
  test("a nested comment is one comment with one warning and no stray tokens", () => {
    const text = "a ::= x (* (* n *) *) y\n";

    const iso = diagnosticsWithCode(text, "ebnf", ISO);
    const unbalanced = diagnosticsWithCode(
      text,
      "ebnf",
      "bnf.unbalanced-delimiter",
    );

    expect(iso).toHaveLength(1);
    expect(iso[0]?.range.start.character).toBe(8);
    expect(iso[0]?.range.end.character).toBe(21);
    expect(unbalanced).toHaveLength(0);
  });
});

describe("ISO comments W3C cannot take", () => {
  test("a comment containing */ gets a disabled action with the reason", () => {
    const text = "a ::= x (* has */ inside *)\n";

    const fixes = quickFixes(text, "ebnf");

    expect(fixes.some((f) => f.title === COMMENT_FIX)).toBe(false);
    const refused = fixes.find((f) => f.reason !== undefined);
    expect(refused?.reason).toBe('comment contains "*/"');
    expect(refused?.text).toBe(text);
  });

  test("a nested comment gets a disabled action with the reason", () => {
    const text = "a ::= x (* (* n *) *) y\n";

    const refused = quickFixes(text, "ebnf").find((f) => f.reason);

    expect(refused?.reason).toBe("nested comment (W3C comments do not nest)");
  });

  test("a plain comment gets the fix and no disabled action", () => {
    const text = "a ::= x (* ok *) y\n";

    const fixes = quickFixes(text, "ebnf");

    expect(fixes.find((f) => f.title === COMMENT_FIX)?.text).toBe(
      "a ::= x /* ok */ y\n",
    );
    expect(fixes.some((f) => f.reason !== undefined)).toBe(false);
  });
});

describe("unclosed ISO comments", () => {
  const UNCLOSED = "bnf.iso-comment-unclosed";

  test("a head-like line inside a comment is explained", () => {
    const text = "a ::= x (* eg:\nfoo ::= bar *)\n";

    const found = diagnosticsWithCode(text, "ebnf", UNCLOSED);

    expect(found).toHaveLength(1);
    expect(found[0]?.message).toBe(
      "ISO comment is not closed before the next production",
    );
    expect(found[0]?.range.start.line).toBe(0);
    expect(found[0]?.range.start.character).toBe(8);
    expect(found[0]?.range.end.character).toBe(10);
  });

  test("the opener is not also reported as an unbalanced delimiter", () => {
    const text = "a ::= x (* eg:\nfoo ::= bar\n";

    const unbalanced = diagnosticsWithCode(
      text,
      "ebnf",
      "bnf.unbalanced-delimiter",
    );

    expect(unbalanced).toHaveLength(0);
  });

  test("a comment left open at the end of the file says so", () => {
    const found = diagnosticsWithCode("a ::= x (* open\n", "ebnf", UNCLOSED);

    expect(found.map((d) => d.message)).toEqual([
      "ISO comment is not closed before the end of the file",
    ]);
  });

  test("a stray (*) and a closed comment are not reported", () => {
    const text = "a ::= (*) b\nc ::= d (* ok *)\n";

    const found = diagnosticsWithCode(text, "ebnf", UNCLOSED);

    expect(found).toHaveLength(0);
  });
});

describe("ISO comment ownership in single-production fixes", () => {
  test("a comment trailing another production is not converted", () => {
    const text = "a ::= x (* has */ *) (* ok *)\nb = 'y';\n";

    const one = quickFixes(text, "ebnf").find(
      (f) => f.title === ONE_PRODUCTION_TITLE,
    );

    expect(one?.text).toBe("a ::= x (* has */ *) (* ok *)\nb ::= 'y'\n");
  });

  test("a standalone comment above the production is still converted", () => {
    const text = "(* header *)\nexpr = 'y';\n";

    const one = quickFixes(text, "ebnf").find(
      (f) => f.title === ONE_PRODUCTION_TITLE,
    );

    expect(one?.text).toBe("/* header */\nexpr ::= 'y'\n");
  });

  test("converting every production still converts the trailing comment", () => {
    const text = "a ::= x (* ok *)\nb = 'y';\nc = 'z';\n";

    const all = convertEveryProduction(text);

    expect(all).toBe("a ::= x /* ok */\nb ::= 'y'\nc ::= 'z'\n");
  });
});
