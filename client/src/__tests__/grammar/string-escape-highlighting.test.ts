import { describe, expect, test } from "bun:test";
import { repoText } from "../repo-file.ts";

interface TextMateRule {
  name?: string;
  begin?: string;
  end?: string;
  match?: string;
  include?: string;
  patterns?: TextMateRule[];
}

interface Grammar {
  patterns: TextMateRule[];
  repository: Record<string, TextMateRule>;
}

interface Token {
  /** Scope name of the rule that matched. */
  scope: string;
  /** Matched text; for a begin/end rule, from the begin to the end match. */
  text: string;
  /** For a begin/end rule: whether the end match was found. */
  closed: boolean;
  /** Names of rules matched inside a begin/end rule. */
  inner: Array<{ scope: string; text: string }>;
}

const grammars = new Map<string, Grammar>();

function grammarOf(dialect: string): Grammar {
  let grammar = grammars.get(dialect);
  if (!grammar) {
    grammar = JSON.parse(
      repoText(`syntaxes/${dialect}.tmLanguage.json`),
    ) as Grammar;
    grammars.set(dialect, grammar);
  }
  return grammar;
}

/** Flattens `include` references into the rules a pattern list can match. */
function expand(grammar: Grammar, patterns: TextMateRule[]): TextMateRule[] {
  return patterns.flatMap((pattern) => {
    if (!pattern.include) {
      return [pattern];
    }
    const target = grammar.repository[pattern.include.slice(1)];
    if (!target) {
      throw new Error(`unknown include ${pattern.include}`);
    }
    return target.patterns && !target.match && !target.begin
      ? expand(grammar, target.patterns)
      : [target];
  });
}

function firstMatch(
  rules: TextMateRule[],
  line: string,
  position: number,
): { rule: TextMateRule; hit: RegExpExecArray } | undefined {
  let best: { rule: TextMateRule; hit: RegExpExecArray } | undefined;
  for (const rule of rules) {
    const source = rule.match ?? rule.begin;
    if (!source) {
      continue;
    }
    const re = new RegExp(source, "g");
    re.lastIndex = position;
    const hit = re.exec(line);
    // The earliest match wins; the first rule in pattern order wins a tie.
    if (hit && (!best || hit.index < best.hit.index)) {
      best = { rule, hit };
    }
  }
  return best;
}

/**
 * Tokenizes one line the way TextMate does: from the top-level patterns of
 * the real grammar file, the earliest match wins (the first listed rule on a
 * tie), and inside a begin/end rule its `end` is tried before its patterns
 * on a tie. Like vscode-textmate, the line is given with a trailing "\n".
 */
function tokenize(dialect: string, source: string): Token[] {
  const grammar = grammarOf(dialect);
  const line = `${source}\n`;
  const tokens: Token[] = [];
  let position = 0;
  while (position < line.length) {
    const found = firstMatch(
      grammar.patterns.length ? expand(grammar, grammar.patterns) : [],
      line,
      position,
    );
    if (!found) {
      break;
    }
    const { rule, hit } = found;
    const scope = rule.name ?? "";
    if (!rule.begin) {
      tokens.push({ scope, text: hit[0], closed: true, inner: [] });
      position = hit.index + Math.max(hit[0].length, 1);
      continue;
    }
    const inside = expand(grammar, rule.patterns ?? []);
    const endRe = new RegExp(rule.end as string, "g");
    const token: Token = { scope, text: "", closed: false, inner: [] };
    let cursor = hit.index + hit[0].length;
    for (;;) {
      endRe.lastIndex = cursor;
      const end = endRe.exec(line);
      const nested = firstMatch(inside, line, cursor);
      if (nested && (!end || nested.hit.index < end.index)) {
        token.inner.push({
          scope: nested.rule.name ?? "",
          text: nested.hit[0],
        });
        cursor = nested.hit.index + Math.max(nested.hit[0].length, 1);
        continue;
      }
      token.closed = Boolean(end?.[1]);
      const stop = end ? end.index + (end[1]?.length ?? 0) : line.length;
      token.text = line.slice(hit.index, stop).replace(/\n$/, "");
      position = Math.max(stop, hit.index + 1);
      break;
    }
    tokens.push(token);
  }
  return tokens;
}

function strings(dialect: string, line: string): Token[] {
  return tokenize(dialect, line).filter((token) =>
    token.scope.startsWith("string.quoted"),
  );
}

function escapesOf(token: Token): string[] {
  return token.inner
    .filter((inner) => inner.scope.startsWith("constant.character.escape"))
    .map((inner) => inner.text);
}

describe.each(["bnf", "rbnf"])("%s string tokens", (dialect) => {
  test.each([
    ['<a> ::= "a\\"b" <x>', '"a\\"b"', ['\\"']],
    ["<a> ::= 'it\\'s' <x>", "'it\\'s'", ["\\'"]],
    ["<a> ::= '\\''", "'\\''", ["\\'"]],
    ['<a> ::= "\\\\" <x>', '"\\\\"', ["\\\\"]],
    ['<a> ::= "\\\\\\"" <x>', '"\\\\\\""', ["\\\\", '\\"']],
    ['<a> ::= "tab\\tend\\x41"', '"tab\\tend\\x41"', ["\\t", "\\x41"]],
    ['<a> ::= "plain" <x>', '"plain"', []],
    ['<a> ::= "it\'s" <x>', '"it\'s"', []],
  ] as const)(
    "in %s the token is delimited correctly",
    (line, text, escapes) => {
      const found = strings(dialect, line);

      expect(found.map((token) => token.text)).toEqual([text]);
      expect(escapesOf(found[0] as Token)).toEqual([...escapes]);
      expect(found[0]?.closed).toBe(true);
    },
  );

  test("an escaped quote does not close the string", () => {
    const found = strings(dialect, '<a> ::= "abc\\"');

    expect(found.map((token) => token.text)).toEqual(['"abc\\"']);
    expect(found[0]?.closed).toBe(false);
  });

  test("an unterminated string ends at the end of the line", () => {
    const found = strings(dialect, '<a> ::= "abc <x>');

    expect(found.map((token) => token.text)).toEqual(['"abc <x>']);
    expect(found[0]?.closed).toBe(false);
  });

  test("a quote after a semicolon is part of the comment", () => {
    const tokens = tokenize(dialect, `<a> ::= <x> ; it's "q"`);

    expect(tokens.some((token) => token.scope.startsWith("string"))).toBe(
      false,
    );
    expect(tokens.at(-1)?.text).toBe(`; it's "q"`);
  });

  test("a quote inside a rule name is part of the name", () => {
    const tokens = tokenize(dialect, `<a> ::= <it's> "x"`);

    expect(
      tokens
        .filter((token) => token.scope.startsWith("variable"))
        .map((t) => t.text),
    ).toEqual(["<it's>"]);
    expect(strings(dialect, `<a> ::= <it's> "x"`).map((t) => t.text)).toEqual([
      '"x"',
    ]);
  });

  test("a quote inside the defined name is part of the name", () => {
    const tokens = tokenize(dialect, `<a "b"> ::= <x>`);

    expect(tokens.some((token) => token.scope.startsWith("string"))).toBe(
      false,
    );
    expect(tokens[0]?.text).toBe(`<a "b"> ::=`);
  });
});

describe("EBNF strings", () => {
  test("a backslash ends nothing: the string stops at the quote after it", () => {
    const found = strings("ebnf", 'a ::= "a\\" b');

    expect(found.map((token) => token.text)).toEqual(['"a\\"']);
    expect(found[0]?.closed).toBe(true);
    expect(escapesOf(found[0] as Token)).toEqual([]);
  });

  test("the text after the closing quote is outside the string", () => {
    const tokens = tokenize("ebnf", `a ::= 'x\\' y`);

    expect(tokens.map((token) => token.text)).toEqual(["a ::=", "'x\\'", "y"]);
  });

  test("a quote in a block comment is part of the comment", () => {
    const tokens = tokenize("ebnf", `a ::= x /* it's "q" */ y`);

    expect(strings("ebnf", `a ::= x /* it's "q" */ y`)).toEqual([]);
    expect(tokens.map((token) => token.text)).toContain(`/* it's "q" */`);
  });

  test("a quote in a character class is part of the class", () => {
    const found = strings("ebnf", `a ::= ["'] "x"`);

    expect(found.map((token) => token.text)).toEqual(['"x"']);
  });
});
