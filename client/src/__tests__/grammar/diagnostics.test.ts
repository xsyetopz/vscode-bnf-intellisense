import { beforeAll, describe, expect, test } from "bun:test";
import "../vscode-mock.ts";
import { repoText } from "../repo-file.ts";

let grammar: typeof import("../../grammar/grammar.ts");
let diagnostics: typeof import("../../grammar/diagnostics.ts");

beforeAll(async () => {
  grammar = await import("../../grammar/grammar.ts");
  diagnostics = await import("../../grammar/diagnostics.ts");
});

describe("grammar diagnostics", () => {
  test("rejects ISO-style EBNF assignment", () => {
    const document = grammar.parseGrammar("syntax = rule ;\n", "ebnf");
    expect(
      document.diagnostics.some((diagnostic) =>
        diagnostic.message.includes("ISO/IEC 14977"),
      ),
    ).toBe(true);
  });

  test("reports undefined references", () => {
    const text = "root ::= missing\n";
    const document = grammar.parseGrammar(text, "ebnf");
    const symbolTable = grammar.buildGrammarSymbolTable(document, "ebnf");
    const result = { dialect: "ebnf" as const, document, symbolTable };
    expect(
      diagnostics
        .collectGrammarDiagnostics(result, text, { unusedRules: false })
        .some((diagnostic) => diagnostic.message.includes("missing")),
    ).toBe(true);
  });

  test("ignores W3C EBNF character literals in undefined references", async () => {
    const text = repoText("examples/json.ebnf");
    const document = grammar.parseGrammar(text, "ebnf");
    const symbolTable = grammar.buildGrammarSymbolTable(document, "ebnf");
    const result = { dialect: "ebnf" as const, document, symbolTable };
    const messages = diagnostics
      .collectGrammarDiagnostics(result, text, { unusedRules: false })
      .map((diagnostic) => diagnostic.message);

    expect(messages.some((message) => message.includes('"x20"'))).toBe(false);
    expect(messages.some((message) => message.includes('"x10FFFF"'))).toBe(
      false,
    );
  });

  test("still reports real EBNF undefined references", () => {
    const text = "root ::= [#x20-#x21] missing\n";
    const document = grammar.parseGrammar(text, "ebnf");
    const symbolTable = grammar.buildGrammarSymbolTable(document, "ebnf");
    const result = { dialect: "ebnf" as const, document, symbolTable };
    const messages = diagnostics
      .collectGrammarDiagnostics(result, text, { unusedRules: false })
      .map((diagnostic) => diagnostic.message);

    expect(messages.some((message) => message.includes('"missing"'))).toBe(
      true,
    );
    expect(messages.some((message) => message.includes('"x20"'))).toBe(false);
  });

  test("reports invalid EBNF character code and delimiters", () => {
    const text = "root ::= #xZZ (missing\n";
    const document = grammar.parseGrammar(text, "ebnf");
    const messages = document.diagnostics.map(
      (diagnostic) => diagnostic.message,
    );

    expect(messages.some((message) => message.includes("hexadecimal"))).toBe(
      true,
    );
    expect(
      messages.some((message) =>
        message.includes('Opening delimiter "(" has no matching closer'),
      ),
    ).toBe(true);
  });
});
