import { beforeAll, describe, expect, test } from "bun:test";
import "../vscode-mock.ts";

let grammar: typeof import("../../grammar/grammar.ts");

beforeAll(async () => {
  grammar = await import("../../grammar/grammar.ts");
});

describe("grammar symbols", () => {
  test("keeps spaced RBNF names atomic", () => {
    const doc = grammar.parseGrammar(
      `<WF flow descriptor> ::= <FLOWSPEC>\n<SE flow descriptor> ::= <FLOWSPEC>\n<flow descriptor list> ::= <WF flow descriptor> <SE flow descriptor>\n<FLOWSPEC> ::= "token"\n`,
      "rbnf",
    );
    const symbols = grammar.buildGrammarSymbolTable(doc, "rbnf");
    expect(symbols.references.get("<WF flow descriptor>")?.[0]?.name).toBe(
      "<WF flow descriptor>",
    );
    expect(symbols.references.get("<SE flow descriptor>")?.[0]?.name).toBe(
      "<SE flow descriptor>",
    );
    expect(symbols.definitions.has("flow")).toBe(false);
  });

  test("builds dialect-local symbol table", () => {
    const doc = grammar.parseGrammar("root ::= value\nvalue ::= 'x'\n", "ebnf");
    const symbols = grammar.buildGrammarSymbolTable(doc, "ebnf");
    expect(symbols.definitions.has("value")).toBe(true);
    expect(symbols.references.get("value")?.length).toBe(1);
  });
});
