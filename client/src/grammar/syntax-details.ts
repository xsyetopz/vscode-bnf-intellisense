import { Hover, InlayHint, InlayHintKind, MarkdownString, Range } from "vscode";
import { tokenize } from "../abnf/tokenizer.ts";
import { type AbnfToken, AbnfTokenKind } from "../abnf/types.ts";
import type { GrammarDialect } from "./dialects.ts";

const EBNF_CHAR_CLASS_RE = /\[(?:\^)?[^\]\r\n]*\]/g;
const EBNF_CHAR_CODE_RE = /#x[0-9A-Fa-f]+/g;
const SUFFIX_REPEAT_RE = /[?+*]/g;
const OPTIONAL_SUFFIX_RE = /\?/;
const ZERO_OR_MORE_SUFFIX_RE = /\*/;
const ONE_OR_MORE_SUFFIX_RE = /\+/;

interface SyntaxMatch {
  range: Range;
  markdown: string;
}

type SyntaxLabelMatcher = {
  label: string;
  pattern: RegExp;
};

const PRODUCTION_SYNTAX_LABELS: readonly SyntaxLabelMatcher[] = [
  { label: "optional", pattern: OPTIONAL_SUFFIX_RE },
  { label: "zero-or-more", pattern: ZERO_OR_MORE_SUFFIX_RE },
  { label: "one-or-more", pattern: ONE_OR_MORE_SUFFIX_RE },
] as const;

function groupDelimiterMarkdown(
  dialect: GrammarDialect,
  delimiter: string,
  label: string,
  detail: string,
): string {
  return `**${dialect.toUpperCase()} ${label}**\n\n\`${delimiter}\` ${detail}`;
}

const DIALECT_GROUP_MARKDOWN: Record<
  GrammarDialect,
  Partial<Record<string, string>>
> = {
  abnf: {
    "(": groupDelimiterMarkdown(
      "abnf",
      "(",
      "group delimiter",
      "starts a grouped subexpression.",
    ),
    ")": groupDelimiterMarkdown(
      "abnf",
      ")",
      "group delimiter",
      "ends a grouped subexpression.",
    ),
    "[": groupDelimiterMarkdown(
      "abnf",
      "[",
      "optional group delimiter",
      "starts an optional subexpression.",
    ),
    "]": groupDelimiterMarkdown(
      "abnf",
      "]",
      "optional group delimiter",
      "ends an optional subexpression.",
    ),
  },
  bnf: {
    "(": groupDelimiterMarkdown(
      "bnf",
      "(",
      "group delimiter",
      "starts a grouped expression.",
    ),
    ")": groupDelimiterMarkdown(
      "bnf",
      ")",
      "group delimiter",
      "ends a grouped expression.",
    ),
    "[": groupDelimiterMarkdown(
      "bnf",
      "[",
      "group delimiter",
      "starts an optional expression.",
    ),
    "]": groupDelimiterMarkdown(
      "bnf",
      "]",
      "group delimiter",
      "ends an optional expression.",
    ),
    "{": groupDelimiterMarkdown(
      "bnf",
      "{",
      "group delimiter",
      "starts a repeated expression.",
    ),
    "}": groupDelimiterMarkdown(
      "bnf",
      "}",
      "group delimiter",
      "ends a repeated expression.",
    ),
  },
  ebnf: {
    "(": groupDelimiterMarkdown(
      "ebnf",
      "(",
      "group delimiter",
      "starts a grouped expression before a suffix operator.",
    ),
    ")": groupDelimiterMarkdown(
      "ebnf",
      ")",
      "group delimiter",
      "ends a grouped expression before a suffix operator.",
    ),
    "[": groupDelimiterMarkdown(
      "ebnf",
      "[",
      "character class delimiter",
      "starts a W3C XML EBNF character class.",
    ),
    "]": groupDelimiterMarkdown(
      "ebnf",
      "]",
      "character class delimiter",
      "ends a W3C XML EBNF character class.",
    ),
    "{": groupDelimiterMarkdown(
      "ebnf",
      "{",
      "group delimiter",
      "starts a grouped expression.",
    ),
    "}": groupDelimiterMarkdown(
      "ebnf",
      "}",
      "group delimiter",
      "ends a grouped expression.",
    ),
  },
  rbnf: {
    "(": groupDelimiterMarkdown(
      "rbnf",
      "(",
      "group delimiter",
      "starts a grouped expression.",
    ),
    ")": groupDelimiterMarkdown(
      "rbnf",
      ")",
      "group delimiter",
      "ends a grouped expression.",
    ),
    "[": groupDelimiterMarkdown(
      "rbnf",
      "[",
      "group delimiter",
      "starts an optional expression.",
    ),
    "]": groupDelimiterMarkdown(
      "rbnf",
      "]",
      "group delimiter",
      "ends an optional expression.",
    ),
    "{": groupDelimiterMarkdown(
      "rbnf",
      "{",
      "group delimiter",
      "starts a repeated expression.",
    ),
    "}": groupDelimiterMarkdown(
      "rbnf",
      "}",
      "group delimiter",
      "ends a repeated expression.",
    ),
  },
};

/**
 * Returns syntax hover details for lexical grammar constructs.
 */
export function getSyntaxHover(
  text: string,
  line: number,
  character: number,
  dialect: GrammarDialect,
): Hover | undefined {
  for (const match of collectSyntaxMatches(text, line, dialect)) {
    if (
      character >= match.range.start.character &&
      character <= match.range.end.character
    ) {
      return new Hover(new MarkdownString(match.markdown), match.range);
    }
  }
  return undefined;
}

/**
 * Returns sparse syntax-detail inlays for one rule definition.
 */
export function getSyntaxDetailInlays(
  line: number,
  character: number,
  body: string,
  dialect: GrammarDialect,
): InlayHint[] {
  const labels = syntaxDetailLabels(body, dialect);
  if (labels.length === 0) {
    return [];
  }
  const hint = new InlayHint(
    new Range(line, character, line, character).end,
    ` ${labels.join(", ")}`,
    InlayHintKind.Parameter,
  );
  hint.paddingLeft = true;
  return [hint];
}

function syntaxDetailLabels(body: string, dialect: GrammarDialect): string[] {
  if (dialect === "abnf") {
    return abnfSyntaxLabels(body);
  }
  const labels = new Set<string>(
    PRODUCTION_SYNTAX_LABELS.filter(({ pattern }) => pattern.test(body)).map(
      ({ label }) => label,
    ),
  );
  if (dialect === "ebnf" && EBNF_CHAR_CLASS_RE.test(body)) {
    labels.add("character-class");
    EBNF_CHAR_CLASS_RE.lastIndex = 0;
  }
  return Array.from(labels);
}

function abnfSyntaxLabels(body: string): string[] {
  const kinds = new Set<AbnfTokenKind>();
  const bases = new Set<string>();
  let range = false;
  let sequence = false;
  for (const token of tokenize(body)) {
    kinds.add(token.kind);
    if (token.kind === AbnfTokenKind.NumericValue) {
      bases.add(token.text.charAt(1).toLowerCase());
      range ||= token.text.includes("-");
      sequence ||= token.text.includes(".");
    }
  }
  const checks: [boolean, string][] = [
    [bases.has("x"), "hex"],
    [bases.has("d"), "decimal"],
    [bases.has("b"), "binary"],
    [kinds.has(AbnfTokenKind.CaseSensitiveString), "case-sensitive"],
    [kinds.has(AbnfTokenKind.CaseInsensitiveString), "case-insensitive"],
    [kinds.has(AbnfTokenKind.BracketOpen), "optional"],
    [kinds.has(AbnfTokenKind.Asterisk), "repetition"],
    [range, "range"],
    [sequence, "sequence"],
  ];
  return checks.filter(([present]) => present).map(([, label]) => label);
}

function collectSyntaxMatches(
  text: string,
  line: number,
  dialect: GrammarDialect,
): SyntaxMatch[] {
  if (dialect === "abnf") {
    return collectAbnfMatches(text, line);
  }
  return [
    ...collectMatches(
      text,
      line,
      SUFFIX_REPEAT_RE,
      (match) => repetitionMarkdown(match, dialect),
      true,
    ),
    ...collectMatches(
      text,
      line,
      EBNF_CHAR_CLASS_RE,
      (match) =>
        `**W3C XML EBNF character class**\n\n\`${match}\` is terminal character syntax, not a rule reference.`,
      dialect === "ebnf",
    ),
    ...collectMatches(
      text,
      line,
      EBNF_CHAR_CODE_RE,
      (match) =>
        `**W3C XML EBNF character code**\n\n\`${match}\` is terminal character syntax, not a rule reference.`,
      dialect === "ebnf",
    ),
    ...collectGroupMatches(text, line, dialect),
  ];
}

/**
 * Collects ABNF hover matches from lexer tokens, so comments and strings
 * never produce matches.
 */
function collectAbnfMatches(text: string, line: number): SyntaxMatch[] {
  const matches: SyntaxMatch[] = [];
  const tokens = tokenize(text);
  const groups = DIALECT_GROUP_MARKDOWN.abnf;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as AbnfToken;
    if (token.kind === AbnfTokenKind.NumericValue) {
      matches.push(tokenMatch(line, token, abnfNumericMarkdown(token.text)));
      continue;
    }
    const group = groups[token.text];
    if (group && isGroupDelimiter(token)) {
      matches.push(tokenMatch(line, token, group));
      continue;
    }
    if (
      token.kind === AbnfTokenKind.Integer ||
      token.kind === AbnfTokenKind.Asterisk
    ) {
      const end = repetitionEnd(tokens, i);
      if (end >= 0) {
        const prefix = tokens.slice(i, end + 1);
        const value = prefix.map((t) => t.text).join("");
        const last = prefix[prefix.length - 1] as AbnfToken;
        matches.push({
          range: new Range(
            line,
            token.column,
            line,
            last.column + last.text.length,
          ),
          markdown: repetitionMarkdown(value, "abnf"),
        });
        i = end;
      }
    }
  }
  return matches;
}

function isGroupDelimiter(token: AbnfToken): boolean {
  return (
    token.kind === AbnfTokenKind.ParenOpen ||
    token.kind === AbnfTokenKind.ParenClose ||
    token.kind === AbnfTokenKind.BracketOpen ||
    token.kind === AbnfTokenKind.BracketClose
  );
}

function tokenMatch(
  line: number,
  token: AbnfToken,
  markdown: string,
): SyntaxMatch {
  return {
    range: new Range(
      line,
      token.column,
      line,
      token.column + token.text.length,
    ),
    markdown,
  };
}

/**
 * Returns the index of the last token of a repetition prefix
 * (`n*m`, `n*`, `*m` or `*`) starting at `start`, or -1 if none.
 */
function repetitionEnd(tokens: AbnfToken[], start: number): number {
  let i = start;
  if (tokens[i]?.kind === AbnfTokenKind.Integer) {
    i++;
  }
  if (tokens[i]?.kind !== AbnfTokenKind.Asterisk) {
    return -1;
  }
  if (tokens[i + 1]?.kind === AbnfTokenKind.Integer) {
    i++;
  }
  return i;
}

function collectMatches(
  text: string,
  line: number,
  pattern: RegExp,
  render: (match: string) => string,
  enabled: boolean,
): SyntaxMatch[] {
  if (!enabled) {
    return [];
  }
  const matches: SyntaxMatch[] = [];
  for (const match of text.matchAll(pattern)) {
    const value = match[0] ?? "";
    const start = match.index ?? 0;
    matches.push({
      range: new Range(line, start, line, start + value.length),
      markdown: render(value),
    });
  }
  pattern.lastIndex = 0;
  return matches;
}

function collectGroupMatches(
  text: string,
  line: number,
  dialect: GrammarDialect,
): SyntaxMatch[] {
  const matches: SyntaxMatch[] = [];
  for (let i = 0; i < text.length; i++) {
    const markdown = DIALECT_GROUP_MARKDOWN[dialect][text[i] ?? ""];
    if (!markdown) {
      continue;
    }
    matches.push({
      range: new Range(line, i, line, i + 1),
      markdown,
    });
  }
  return matches;
}

function abnfNumericMarkdown(match: string): string {
  const base = match[1]?.toLowerCase();
  const baseName =
    base === "x" ? "hexadecimal" : base === "d" ? "decimal" : "binary";
  const body = match.slice(2);
  if (body.includes("-")) {
    return `**ABNF ${baseName} range**\n\n\`${match}\` matches a numeric terminal range.`;
  }
  if (body.includes(".")) {
    return `**ABNF ${baseName} sequence**\n\n\`${match}\` matches a dotted numeric terminal sequence.`;
  }
  return `**ABNF ${baseName} terminal**\n\n\`${match}\` matches one numeric terminal value.`;
}

function repetitionMarkdown(match: string, dialect: GrammarDialect): string {
  if (dialect === "abnf") {
    const [minText, maxText] = match.split("*");
    if (minText && maxText) {
      return `**ABNF bounded repetition**\n\n\`${match}\` repeats from ${minText} to ${maxText} times.`;
    }
    if (minText) {
      return `**ABNF minimum repetition**\n\n\`${match}\` repeats ${minText} or more times.`;
    }
    if (maxText) {
      return `**ABNF maximum repetition**\n\n\`${match}\` repeats up to ${maxText} times.`;
    }
    return `**ABNF repetition**\n\n\`${match}\` repeats zero or more times.`;
  }
  if (match === "?") {
    return `**Optional suffix**\n\n\`${match}\` marks zero or one occurrence.`;
  }
  if (match === "+") {
    return `**One-or-more suffix**\n\n\`${match}\` marks one or more occurrences.`;
  }
  return `**Zero-or-more suffix**\n\n\`${match}\` marks zero or more occurrences.`;
}
