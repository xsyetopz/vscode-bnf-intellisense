import { beforeAll, describe, expect, test } from "bun:test";
import type { GrammarDialect } from "../../grammar/dialects.ts";
import { PositionMock } from "../vscode-mock.ts";
import {
  asTextDocument,
  createDocument,
  createWorkspace,
  loadGrammarTestCore,
} from "./provider-test-utils.ts";

let GrammarDeclarationProvider: typeof import("../../grammar/providers/declaration.ts").GrammarDeclarationProvider;
let GrammarDefinitionProvider: typeof import("../../grammar/providers/definition.ts").GrammarDefinitionProvider;

beforeAll(async () => {
  await loadGrammarTestCore();
  ({ GrammarDeclarationProvider } = await import(
    "../../grammar/providers/declaration.ts"
  ));
  ({ GrammarDefinitionProvider } = await import(
    "../../grammar/providers/definition.ts"
  ));
});

type Files = Array<{ path: string; text: string; dialect: GrammarDialect }>;
type Located = Array<{
  uri: { path: string; toString(): string };
  range: { start: { line: number; character: number } };
}>;

function both(
  text: string,
  dialect: GrammarDialect,
  line: number,
  character: number,
  files: Files = [],
) {
  const workspace = createWorkspace(files);
  const doc = asTextDocument(
    createDocument(`/workspace/main.${dialect}`, text, dialect),
  );
  const position = new PositionMock(line, character) as never;
  return {
    declaration: new GrammarDeclarationProvider(workspace).provideDeclaration(
      doc,
      position,
      {} as never,
    ) as Located | undefined,
    definition: new GrammarDefinitionProvider(workspace).provideDefinition(
      doc,
      position,
      {} as never,
    ) as Located | undefined,
  };
}

describe("declaration provider", () => {
  test("ABNF goes to the first = and skips =/ increments", () => {
    const text = 'a = b\na =/ c\nb = "x"\nc = "y"\nd = a\n';
    const { declaration, definition } = both(text, "abnf", 4, 4);
    expect(definition).toHaveLength(2);
    expect(declaration).toHaveLength(1);
    expect(declaration?.[0]?.range.start.line).toBe(0);
    // From the increment itself and from a case-variant reference.
    expect(both(text, "abnf", 1, 0).declaration?.[0]?.range.start.line).toBe(0);
    expect(
      both('A = x\nb = a\nx = "x"\n', "abnf", 1, 4).declaration?.[0]?.range
        .start.line,
    ).toBe(0);
  });

  test("ABNF skips an =/ that comes before the = and falls back when alone", () => {
    expect(
      both('a =/ x\na = y\nx = "x"\n', "abnf", 0, 5).declaration,
    ).toHaveLength(1);
    expect(
      both('a =/ x\na = y\nx = "x"\n', "abnf", 0, 5).declaration?.[0]?.range
        .start.line,
    ).toBe(2);
    const onlyIncrement = both("b = a\na =/ c\n", "abnf", 0, 4);
    expect(onlyIncrement.declaration?.[0]?.range.start.line).toBe(1);
  });

  test("ABNF prefers the current document, then other files", () => {
    const other: Files = [
      { path: "/workspace/other.abnf", text: 'a = "x"\n', dialect: "abnf" },
    ];
    expect(
      both("b = a\na = c\n", "abnf", 0, 4, other).declaration?.[0]?.uri.path,
    ).toBe("/workspace/main.abnf");
    // Only an increment here: the real = lives in the other file.
    expect(
      both("b = a\na =/ c\n", "abnf", 0, 4, other).declaration?.[0]?.uri.path,
    ).toBe("/workspace/other.abnf");
    expect(
      both("b = a\n", "abnf", 0, 4, other).declaration?.[0]?.uri.path,
    ).toBe("/workspace/other.abnf");
  });

  test("ABNF core rules resolve like definition", () => {
    const { declaration, definition } = both("a = ALPHA\n", "abnf", 0, 6);
    expect(declaration).toHaveLength(1);
    expect(declaration?.[0]?.uri.toString()).toBe(
      definition?.[0]?.uri.toString() ?? "",
    );
    expect(declaration?.[0]?.uri.toString()).toContain("bnf-core:");
  });

  test("other dialects behave exactly like definition", () => {
    const cases: Array<[string, GrammarDialect, number, number]> = [
      ["A ::= B\nB ::= 'x'\n", "ebnf", 0, 6],
      ["<a> ::= <b>\n<b> ::= 'x'\n", "bnf", 0, 9],
      ["<a> ::= <b>\n<b> ::= 'x'\n", "rbnf", 0, 9],
      ["<a> ::= <b>\n<b> ::= 'x'\n<b> ::= 'y'\n", "bnf", 0, 9],
    ];
    for (const [text, dialect, line, character] of cases) {
      const { declaration, definition } = both(text, dialect, line, character);
      expect(declaration).toEqual(definition);
      expect(declaration?.length).toBeGreaterThan(0);
    }
  });

  test("returns nothing off names, for undefined names, and for empty documents", () => {
    expect(both("a = b\n", "abnf", 0, 2).declaration).toBeUndefined();
    expect(both("a = b\n", "abnf", 0, 4).declaration).toBeUndefined();
    expect(both("A ::= B\n", "ebnf", 0, 6).declaration).toBeUndefined();
    expect(both("", "abnf", 0, 0).declaration).toBeUndefined();
  });
});
