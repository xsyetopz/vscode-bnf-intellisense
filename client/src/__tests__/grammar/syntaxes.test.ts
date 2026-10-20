import { describe, expect, test } from "bun:test";
import { repoText } from "../repo-file.ts";

type Rule = {
  name?: string;
  match?: string;
  begin?: string;
  end?: string;
  patterns?: Array<{ name?: string; match?: string }>;
};
type Language = "abnf" | "bnf" | "ebnf" | "rbnf";

const DOLLAR = "$";

function repository(language: Language): Record<string, Rule> {
  return JSON.parse(repoText(`syntaxes/${language}.tmLanguage.json`))
    .repository;
}

function ruleOf(language: Language, name: string): Rule {
  const rule = repository(language)[name];
  if (!rule) {
    throw new Error(`${language} grammar has no "${name}" rule`);
  }
  return rule;
}

/**
 * What a rule's `match` captures from a line of source, or null when it does
 * not apply there.
 */
function matchedBy(
  language: Language,
  name: string,
  text: string,
): string | null {
  const pattern = ruleOf(language, name).match;
  if (pattern === undefined) {
    throw new Error(`${language} "${name}" is not a match rule`);
  }
  return new RegExp(pattern).exec(text)?.[0] ?? null;
}

/**
 * What a nested pattern of a rule (for example one numeric base) captures.
 */
function matchedByNested(
  language: Language,
  name: string,
  index: number,
  text: string,
): string | null {
  const pattern = ruleOf(language, name).patterns?.[index]?.match;
  if (pattern === undefined) {
    throw new Error(`${language} "${name}"[${index}] is not a match rule`);
  }
  return new RegExp(pattern).exec(text)?.[0] ?? null;
}

describe("TextMate grammar files", () => {
  test.each(["abnf", "bnf", "ebnf", "rbnf"] as const)(
    "%s grammar is valid JSON with a scope name",
    (language) => {
      const grammar = JSON.parse(
        repoText(`syntaxes/${language}.tmLanguage.json`),
      );

      expect(grammar.scopeName).toContain(language);
    },
  );
});

describe("ABNF grammar", () => {
  test.each([
    ["hex value", 0, "x = %x41", "%x41"],
    ["hex range", 0, "x = %x30-39", "%x30-39"],
    ["hex concatenation", 0, "x = %x0D.0A", "%x0D.0A"],
    ["decimal value", 1, "x = %d13", "%d13"],
    ["decimal range", 1, "x = %d48-57 y", "%d48-57"],
    ["binary value", 2, "x = %b0101", "%b0101"],
    ["binary concatenation", 2, "x = %b1.0", "%b1.0"],
  ])("tokenizes a %s as one numeric value", (_label, index, text, expected) => {
    expect(matchedByNested("abnf", "numeric-value", index, text)).toBe(
      expected,
    );
  });

  test.each([
    ["%x", 0],
    ["%b2", 2],
  ])(
    "a numeric prefix without digits (%s) is not a numeric value",
    (text, index) => {
      const matched = matchedByNested("abnf", "numeric-value", index, text);

      expect(matched).toBeNull();
    },
  );

  test.each([
    ["repetition-bounded", "x = 2*5y", "2*5"],
    ["repetition-min-only", "x = 3*y", "3*"],
    ["repetition-max-only", "x = *4y", "*4"],
    ["repetition-star", "x = *y", "*"],
  ])("%s matches %j", (rule, text, expected) => {
    expect(matchedBy("abnf", rule, text)).toBe(expected);
  });

  test.each(["3*", "*4"])(
    "a bounded repetition needs both counts: %s",
    (text) => {
      const matched = matchedBy("abnf", "repetition-bounded", text);

      expect(matched).toBeNull();
    },
  );

  test("a comment runs to the end of the line and nothing further", () => {
    expect(
      matchedBy("abnf", "comment", 'a = b ; note ()|*[]{} "x"\nnext'),
    ).toBe('; note ()|*[]{} "x"');
    expect(ruleOf("abnf", "comment").patterns).toBeUndefined();
  });

  test.each([
    ["a plain rule", "rule-name = x", "rule-name ="],
    ["an incremental rule", "rule =/ x", "rule =/"],
    ["a rule without spaces", "a=b", "a="],
  ])("rule definition matches %s", (_label, text, expected) => {
    expect(matchedBy("abnf", "rule-definition", text)).toBe(expected);
  });

  test("an indented or non-assigning line is not a rule definition", () => {
    expect(matchedBy("abnf", "rule-definition", "  rule = x")).toBeNull();
    expect(matchedBy("abnf", "rule-definition", "rule x")).toBeNull();
    expect(matchedBy("abnf", "rule-definition", "1rule = x")).toBeNull();
  });

  test("case-sensitive and case-insensitive strings keep their prefix", () => {
    expect(matchedBy("abnf", "string-case-sensitive", 'a = %s"Abc"')).toBe(
      '%s"Abc"',
    );
    expect(matchedBy("abnf", "string-case-insensitive", 'a = %i"Abc"')).toBe(
      '%i"Abc"',
    );
    expect(
      matchedBy("abnf", "string-case-sensitive", 'a = %i"Abc"'),
    ).toBeNull();
  });

  test("a plain string starts at a double quote and prose at an angle bracket", () => {
    expect(
      new RegExp(ruleOf("abnf", "string-plain").begin ?? "").test('"x"'),
    ).toBe(true);
    expect(
      new RegExp(ruleOf("abnf", "prose-value").begin ?? "").test("<x>"),
    ).toBe(true);
    expect(
      new RegExp(ruleOf("abnf", "string-plain").begin ?? "").test("'x'"),
    ).toBe(false);
  });

  test("an unterminated string or prose value ends at the line break", () => {
    for (const name of ["string-plain", "prose-value"]) {
      expect(new RegExp(ruleOf("abnf", name).end ?? "").test("\nnext")).toBe(
        true,
      );
    }
  });

  test("rule names may contain digits and hyphens but not start with them", () => {
    expect(matchedBy("abnf", "identifier", "a-b1 c")).toBe("a-b1");
    expect(matchedBy("abnf", "identifier", "9a")).toBe("a");
  });

  test("alternation is a slash", () => {
    expect(matchedBy("abnf", "alternation", "a / b")).toBe("/");
    expect(matchedBy("abnf", "alternation", "a | b")).toBeNull();
  });

  test("groups and options have separate open and close scopes", () => {
    const scopes = (ruleOf("abnf", "brackets").patterns ?? []).map((p) => [
      p.name,
      new RegExp(p.match ?? "").exec("( ) [ ]")?.[0],
    ]);

    expect(scopes).toEqual([
      ["punctuation.definition.group.begin.abnf", "("],
      ["punctuation.definition.group.end.abnf", ")"],
      ["punctuation.definition.optional.begin.abnf", "["],
      ["punctuation.definition.optional.end.abnf", "]"],
    ]);
  });
});

describe("BNF grammar", () => {
  test.each([
    ["an angle-bracket rule", "<expr> ::= x", "<expr> ::="],
    ["a bare rule", "expr ::= x", "expr ::="],
    ["an indented rule", "  <a b> ::= x", "  <a b> ::="],
    ["a dotted bare rule", "a.b:c-d ::= x", "a.b:c-d ::="],
  ])("rule definition matches %s", (_label, text, expected) => {
    expect(matchedBy("bnf", "rule-definition", text)).toBe(expected);
  });

  test("a line without ::= is not a rule definition", () => {
    expect(matchedBy("bnf", "rule-definition", "expr = x")).toBeNull();
    expect(matchedBy("bnf", "rule-definition", "<> ::= x")).toBeNull();
  });

  test("a comment runs from a semicolon to the end of the line", () => {
    expect(matchedBy("bnf", "comment", "<a> ::= b ; note ()|*\nnext")).toBe(
      "; note ()|*",
    );
    expect(ruleOf("bnf", "comment").patterns).toBeUndefined();
  });

  test("alternation is a vertical bar", () => {
    expect(matchedBy("bnf", "alternation", "a | b")).toBe("|");
    expect(matchedBy("bnf", "alternation", "a / b")).toBeNull();
  });

  test.each(["?", "+", "*"])("%s is a suffix repetition operator", (op) => {
    expect(matchedBy("bnf", "suffix-repetition", `a${op}`)).toBe(op);
  });

  test("a repetition prefix is the count before a star", () => {
    expect(matchedBy("bnf", "repetition-prefix", "3*a")).toBe("3");
    expect(matchedBy("bnf", "repetition-prefix", "3a")).toBeNull();
    expect(matchedBy("bnf", "repetition-range", "2*5")).toBe("2*5");
  });

  test("every bracket kind is a group delimiter", () => {
    for (const bracket of ["(", ")", "[", "]", "{", "}"]) {
      expect(matchedBy("bnf", "group-delimiter", bracket)).toBe(bracket);
    }
    expect(matchedBy("bnf", "group-delimiter", "<")).toBeNull();
  });

  test.each([
    ["an angle-bracket name with spaces", "<a rule> x", "<a rule>"],
    ["a bare name", "name x", "name"],
    ["a dotted name", "a.b:c x", "a.b:c"],
  ])("identifier matches %s", (_label, text, expected) => {
    expect(matchedBy("bnf", "identifier", text)).toBe(expected);
  });

  test("a bare name does not swallow trailing punctuation", () => {
    expect(matchedBy("bnf", "identifier", "name- x")).toBe("name");
    expect(matchedBy("bnf", "identifier", "name. x")).toBe("name");
  });
});

describe("EBNF grammar", () => {
  test("a comment is delimited by slash-star and star-slash", () => {
    const comment = ruleOf("ebnf", "comment");

    expect(new RegExp(comment.begin ?? "").test("a /* note")).toBe(true);
    expect(new RegExp(comment.end ?? "").test("note */ b")).toBe(true);
    expect(new RegExp(comment.begin ?? "").test("a ; note")).toBe(false);
    expect(comment.name).toBe("comment.block.ebnf");
    expect(comment.patterns).toBeUndefined();
  });

  test.each([
    ["a rule", "Name ::= x", "Name ::="],
    ["a numbered rule", "[1] Name ::= x", "[1] Name ::="],
    ["an indented rule", "  Name ::= x", "  Name ::="],
  ])("rule definition matches %s", (_label, text, expected) => {
    expect(matchedBy("ebnf", "rule-definition", text)).toBe(expected);
  });

  test("an ISO-style assignment is not a rule definition", () => {
    expect(matchedBy("ebnf", "rule-definition", "Name = x ;")).toBeNull();
  });

  test.each([
    ["a range", "x [#x20-#x21] y", "[#x20-#x21]"],
    ["a negated set", "x [^a-z] y", "[^a-z]"],
    ["a set of characters", "x [abc] y", "[abc]"],
  ])("character class matches %s", (_label, text, expected) => {
    expect(matchedBy("ebnf", "character-class", text)).toBe(expected);
  });

  test("a character code is #x followed by hex digits", () => {
    expect(matchedBy("ebnf", "character-code", "x #x9 y")).toBe("#x9");
    expect(matchedBy("ebnf", "character-code", "#x1F600")).toBe("#x1F600");
    expect(matchedBy("ebnf", "character-code", "#xZZ")).toBeNull();
  });

  test("operators are scoped in EBNF", () => {
    expect(matchedBy("ebnf", "alternation", 'a ("b" | c)')).toBe("|");
    expect(matchedBy("ebnf", "suffix-repetition", 'token ::= ("a")+')).toBe(
      "+",
    );
  });

  test("strings open at either quote kind", () => {
    expect(
      new RegExp(ruleOf("ebnf", "double-string").begin ?? "").test('"x"'),
    ).toBe(true);
    expect(
      new RegExp(ruleOf("ebnf", "single-string").begin ?? "").test("'x'"),
    ).toBe(true);
    expect(
      new RegExp(ruleOf("ebnf", "single-string").begin ?? "").test('"x"'),
    ).toBe(false);
  });

  test("identifiers allow angle-bracket names", () => {
    expect(matchedBy("ebnf", "identifier", "<a name> x")).toBe("<a name>");
    expect(matchedBy("ebnf", "identifier", "Name x")).toBe("Name");
  });

  test("gives EBNF annotations and exclusion their own scopes", () => {
    const expression = JSON.stringify(ruleOf("ebnf", "expression"));
    const annotation = (text: string) => matchedBy("ebnf", "annotation", text);
    const exclusion = (text: string) => matchedBy("ebnf", "exclusion", text);

    expect(annotation("[ wfc: Legal Character ]")).toBe(
      "[ wfc: Legal Character ]",
    );
    expect(annotation("[ VC: Proper Group/PE Nesting ]")).toBe(
      "[ VC: Proper Group/PE Nesting ]",
    );
    expect(annotation("[a-z]")).toBeNull();
    expect(exclusion("Name - 'x'")).toBe("-");
    expect(exclusion("b-c")).toBeNull();
    expect(expression.indexOf("annotation")).toBeLessThan(
      expression.indexOf("character-class"),
    );
  });

  test("matches EBNF exclusion with a dash glued to the right operand", () => {
    const exclusion = (text: string) => matchedBy("ebnf", "exclusion", text);

    expect(exclusion("A -B")).toBe("-");
    expect(exclusion("A - B")).toBe("-");
    expect(exclusion("'a'-B")).toBe("-");
    expect(exclusion("A-B")).toBeNull();
  });
});

describe("RBNF grammar", () => {
  test("rule definitions need an angle-bracket name", () => {
    expect(matchedBy("rbnf", "rule-definition", "<A rule> ::= x")).toBe(
      "<A rule> ::=",
    );
    expect(matchedBy("rbnf", "rule-definition", "rule ::= x")).toBeNull();
  });

  test("a comment runs from a semicolon to the end of the line", () => {
    expect(matchedBy("rbnf", "comment", "<a> ::= <b> ; note ()|*\nnext")).toBe(
      "; note ()|*",
    );
    expect(ruleOf("rbnf", "comment").patterns).toBeUndefined();
  });

  test("an ellipsis is three dots", () => {
    expect(matchedBy("rbnf", "ellipsis", "<a> ...")).toBe("...");
    expect(matchedBy("rbnf", "ellipsis", "<a> ..")).toBeNull();
  });

  test("has no ABNF-style repetition prefixes", () => {
    expect(repository("rbnf")["repetition-prefix"]).toBeUndefined();
    expect(repository("rbnf")["repetition-range"]).toBeUndefined();
  });

  test("alternation is a vertical bar", () => {
    expect(matchedBy("rbnf", "alternation", '[<other>] ... | "x"')).toBe("|");
  });

  test("identifiers are angle-bracket names that may contain spaces", () => {
    expect(matchedBy("rbnf", "identifier", "[<other name>] ...")).toBe(
      "<other name>",
    );
  });
});

describe("comments in every grammar", () => {
  test.each([
    ["abnf", "; comment ()|*[]{}"],
    ["bnf", "; comment ()|*[]{}"],
    ["ebnf", "/* comment ()|*[]{} */"],
    ["rbnf", "; comment ()|*[]{}"],
  ] as const)(
    "%s comment consumes operators as plain comment text",
    (language, sample) => {
      const comment = ruleOf(language, "comment");

      expect(comment.name).toContain("comment");
      expect(comment.patterns).toBeUndefined();
      if (comment.match) {
        expect(new RegExp(`^(?:${comment.match})$`).test(sample)).toBe(true);
      } else {
        expect(new RegExp(comment.begin ?? "").test(sample)).toBe(true);
        expect(new RegExp(comment.end ?? "").test(sample)).toBe(true);
      }
      expect(JSON.stringify(comment)).not.toContain("keyword.operator");
      expect(JSON.stringify(comment)).not.toContain(
        "punctuation.definition.group",
      );
    },
  );
});

describe("snippets, markdown injections, and language configuration", () => {
  test("RBNF snippets use RFC 5511 optional and ellipsis, not ABNF repeats", () => {
    const snippets = JSON.parse(repoText("snippets/rbnf.json")) as {
      [name: string]: { body: string[] };
    };
    const bodies = Object.values(snippets).map((snippet) =>
      snippet.body.join("\n"),
    );
    expect(bodies).toContain(`[${DOLLAR}{1:element}]`);
    expect(bodies).toContain(`${DOLLAR}{1:element} ...`);
    expect(bodies.some((body) => body.includes("*("))).toBe(false);
  });

  test("matches markdown fences with extra info text", () => {
    for (const language of ["bnf", "ebnf", "rbnf"] as const) {
      const injection = JSON.parse(
        repoText(`syntaxes/${language}-markdown.tmLanguage.json`),
      ) as { patterns: Array<{ begin: string }> };
      const begin = new RegExp(injection.patterns[0]?.begin ?? "");
      expect(begin.test(`\`\`\`${language}`)).toBe(true);
      expect(begin.test(`\`\`\`${language} title="grammar"`)).toBe(true);
      expect(begin.test(`\`\`\`${language}x`)).toBe(false);
    }
  });

  test("advertises only the comment styles each language supports", () => {
    const pkg = JSON.parse(repoText("package.json"));
    const configOf = (id: string) =>
      pkg.contributes.languages.find((l: { id: string }) => l.id === id)
        .configuration as string;
    expect(configOf("ebnf")).toBe("ebnf-language-configuration.json");
    const ebnf = JSON.parse(repoText(configOf("ebnf")));
    expect(ebnf.comments.lineComment).toBeUndefined();
    expect(ebnf.comments.blockComment).toEqual(["/*", "*/"]);
    for (const id of ["bnf", "rbnf"]) {
      const config = JSON.parse(repoText(configOf(id)));
      expect(config.comments.blockComment).toBeUndefined();
      expect(config.comments.lineComment).toBe(";");
    }
  });
});
