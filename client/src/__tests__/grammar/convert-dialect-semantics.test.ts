import { beforeAll, describe, expect, test } from "bun:test";
import "../vscode-mock.ts";
import type { GrammarDialect } from "../../grammar/dialects.ts";

let convert: typeof import("../../grammar/commands/convert-dialect.ts");
let formatting: typeof import("../../grammar/commands/format-converted.ts");
let grammar: typeof import("../../grammar/grammar.ts");
let reference: typeof import("./reference-language.ts");

beforeAll(async () => {
  convert = await import("../../grammar/commands/convert-dialect.ts");
  formatting = await import("../../grammar/commands/format-converted.ts");
  grammar = await import("../../grammar/grammar.ts");
  reference = await import("./reference-language.ts");
});

const DIALECTS = ["abnf", "bnf", "ebnf", "rbnf"] as const;
const ALPHABET = new Set(`abcABC1 "'\\`);
const MAX_LEN = 5;

/** Strings the start rule matches, up to MAX_LEN characters over ALPHABET. */
function language(text: string, dialect: GrammarDialect) {
  return reference.referenceLanguage(text, dialect, {
    alphabet: ALPHABET,
    maxLength: MAX_LEN,
  });
}

function convertText(
  text: string,
  source: GrammarDialect,
  target: GrammarDialect,
  format: boolean,
  allowed?: RegExp,
): string {
  const result = convert.convertDialect(text, source, target, {
    ...(format
      ? { format: (out: string) => formatting.formatConverted(out, target) }
      : {}),
  });
  if (!result.ok) {
    throw new Error(result.reason);
  }
  expect(result.warnings.filter((warning) => !allowed?.test(warning))).toEqual(
    [],
  );
  return result.text;
}

const CASE_CLASH = /differ only by case/;

const ABNF_FIXTURES: Record<string, string> = {
  "exact repetition counts": 's = 2*3"a" "b"\n',
  "unbounded and bounded": 's = 3*"a" / 2*2"b" / *1"c"\n',
  "zero repetition": 's = 0*0"a" "b"\n',
  optional: 's = [%s"B" "c"] "a"\n',
  "case rules": 's = "aB" / %s"aB" / %i"ab"\n',
  "case-sensitive letters only": 's = %s"A" / %s"b"\n',
  "numeric ranges and groups": 's = 2%x61-62 *1x\nx = %x41-43 / "1"\n',
  "decimal and binary values": "s = %d97.98 / %b1100001 / %x41\n",
  star: 's = *("a" / "b") "c"\n',
  plus: 's = 1*("a" "b")\n',
  nested: 's = *2t\nt = ("a" / "b") "c" / %d49\n',
  "incremental alternatives": 's = "c"\ns =/ "a" s\n',
  recursion: 's = "a" s "b" / "c"\n',
  "name case": 'S = Item *Item\nitem = "a" / "b"\n',
  "empty group": 's = "a" [("b" / "c") "1"] "c"\n',
  "double quote in text": 's = "a" %x22 "b"\n',
  "quotes and backslash": "s = %x5C %x22 %x27 / %x22.27\n",
  "alternation inside repetition": 's = 1*2("a" / "b" "c")\n',
};

const EBNF_FIXTURES: Record<string, string> = {
  "class difference": 's ::= ([a-c] - "b")+\n',
  "class difference with codes":
    "s ::= ([#x61-#x63] - [#x62-#x62]) ([A-C] - #x42)?\n",
  "difference of single-character rules":
    "s ::= (b - c)+ a\nb ::= [a-c]\nc ::= [b]\na ::= #x41\n",
  "multi-range class": 's ::= [aA1-1]* "c"\n',
  suffixes: 's ::= "a"? ("b" | "c")* "A"+\n',
  "character codes": "s ::= #x61 #x41 [#x62-#x63]\n",
};

const RBNF_FIXTURES: Record<string, string> = {
  "optional and ellipsis":
    '<s> ::= [<x>] <y> ... "c"\n<x> ::= "a"\n<y> ::= "b"\n',
  "optional ellipsis": '<s> ::= [<y> ...] "c"\n<y> ::= "b"\n',
  "ABNF-style prefixes": '<s> ::= 2*3<y> *("a") 1*("b")\n<y> ::= "A"\n',
  "exact count": '<s> ::= 2<y> "c"\n<y> ::= "a"\n',
};

function pairs(): [GrammarDialect, GrammarDialect][] {
  return DIALECTS.flatMap((source) =>
    DIALECTS.filter((target) => target !== source).map(
      (target) => [source, target] as [GrammarDialect, GrammarDialect],
    ),
  );
}

const ABNF_ROWS = Object.entries(ABNF_FIXTURES).flatMap(([name, abnf]) =>
  [false, true].flatMap((format) =>
    pairs().map(
      ([source, target]) =>
        [
          `${name}${format ? " formatted" : ""}: ${source} to ${target}`,
          name,
          abnf,
          format,
          source,
          target,
        ] as const,
    ),
  ),
);

describe("conversion between dialect pairs", () => {
  test.each(ABNF_ROWS)(
    "keeps the language and stays error-free: %s",
    (_label, name, abnf, format, source, target) => {
      const allowed = name === "name case" ? CASE_CLASH : undefined;
      const expected = language(abnf, "abnf");
      const sourceText =
        source === "abnf"
          ? abnf
          : convertText(abnf, "abnf", source, format, allowed);

      const out = convertText(sourceText, source, target, format, allowed);

      const errors = grammar
        .parseGrammar(out, target)
        .diagnostics.filter((d) => d.severity <= 1);
      expect(expected.size).toBeGreaterThan(0);
      expect(errors).toEqual([]);
      expect(language(out, target)).toEqual(expected);
    },
  );
});

const EBNF_TARGETS = ["abnf", "bnf", "rbnf"] as const;

const EBNF_FIRST_HOP = Object.entries(EBNF_FIXTURES).flatMap(([name, ebnf]) =>
  EBNF_TARGETS.map(
    (target) => [`${name}: ebnf to ${target}`, ebnf, target] as const,
  ),
);

const EBNF_SECOND_HOP = Object.entries(EBNF_FIXTURES).flatMap(([name, ebnf]) =>
  EBNF_TARGETS.flatMap((target) =>
    DIALECTS.filter((next) => next !== target).map(
      (next) =>
        [`${name}: ebnf to ${target} to ${next}`, ebnf, target, next] as const,
    ),
  ),
);

describe("EBNF-only constructs", () => {
  test.each(EBNF_FIRST_HOP)(
    "keep the language when converted out of EBNF: %s",
    (_label, ebnf, target) => {
      const expected = language(ebnf, "ebnf");

      const out = convertText(ebnf, "ebnf", target, true);

      expect(expected.size).toBeGreaterThan(0);
      expect(language(out, target)).toEqual(expected);
    },
  );

  test.each(EBNF_SECOND_HOP)(
    "keep the language when converted onward again: %s",
    (_label, ebnf, target, next) => {
      const expected = language(ebnf, "ebnf");
      const out = convertText(ebnf, "ebnf", target, true);

      const again = convertText(out, target, next, true);

      expect(expected.size).toBeGreaterThan(0);
      expect(language(again, next)).toEqual(expected);
    },
  );

  test("a negated class keeps the language when converted to ABNF", () => {
    const ebnf = 's ::= [^a]* "c"\n';
    const expected = language(ebnf, "ebnf");

    const abnf = convertText(ebnf, "ebnf", "abnf", true);

    expect(expected.size).toBeGreaterThan(1);
    expect(language(abnf, "abnf")).toEqual(expected);
  });

  test("a negated class keeps the language on the EBNF to ABNF to EBNF round trip", () => {
    const ebnf = 's ::= [^a]* "c"\n';
    const expected = language(ebnf, "ebnf");
    const abnf = convertText(ebnf, "ebnf", "abnf", true);

    const back = convertText(abnf, "abnf", "ebnf", true);

    expect(language(back, "ebnf")).toEqual(expected);
  });
});

const RBNF_ROWS = Object.entries(RBNF_FIXTURES).flatMap(([name, rbnf]) =>
  (["abnf", "bnf", "ebnf"] as const).map(
    (target) => [`${name}: rbnf to ${target}`, rbnf, target] as const,
  ),
);

describe("RBNF forms", () => {
  test.each(RBNF_ROWS)(
    "keep the language when converted out of RBNF: %s",
    (_label, rbnf, target) => {
      const expected = language(rbnf, "rbnf");

      const out = convertText(rbnf, "rbnf", target, true);

      expect(expected.size).toBeGreaterThan(0);
      expect(language(out, target)).toEqual(expected);
    },
  );
});

describe("the reference language", () => {
  test("counts repetitions exactly", () => {
    const abnf = 's = 2*3%s"a" %s"b"\n';

    expect(language(abnf, "abnf")).toEqual(new Set(["aab", "aaab"]));
  });

  test("keeps case-sensitive strings apart", () => {
    const abnf = 's = %s"A" / %s"b"\n';

    expect(language(abnf, "abnf")).toEqual(new Set(["A", "b"]));
  });

  test("subtracts one class from another", () => {
    const ebnf = "s ::= [a-c] - [b]\n";

    expect(language(ebnf, "ebnf")).toEqual(new Set(["a", "c"]));
  });

  test("reads hexadecimal escapes in BNF strings", () => {
    const bnf = '<s> ::= "\\x61" | "\\x62\\x63"\n';

    expect(language(bnf, "bnf")).toEqual(new Set(["a", "bc"]));
  });
});
