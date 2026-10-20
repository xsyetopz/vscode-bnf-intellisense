import { RECENT_DOCUMENTS, RecentCache } from "../recent-cache.ts";
import type { AbnfToken } from "./types.ts";
import { AbnfTokenKind } from "./types.ts";

function isAlpha(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isAlphaNumOrHyphen(ch: string): boolean {
  return isAlpha(ch) || isDigit(ch) || ch === "-";
}

function isHexDigit(ch: string): boolean {
  return isDigit(ch) || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F");
}

function isBinDigit(ch: string): boolean {
  return ch === "0" || ch === "1";
}

interface ScanResult {
  token: AbnfToken;
  nextIndex: number;
  nextColumn: number;
  nextLine?: number;
}

function makeToken(
  kind: AbnfTokenKind,
  text: string,
  offset: number,
  line: number,
  column: number,
): AbnfToken {
  return { kind, text, offset, line, column };
}

function scanNewline(
  text: string,
  i: number,
  line: number,
  column: number,
): ScanResult {
  const start = i;
  let pos = i;
  if (text.charAt(pos) === "\r" && text.charAt(pos + 1) === "\n") {
    pos += 2;
  } else {
    pos++;
  }
  return {
    token: makeToken(
      AbnfTokenKind.Newline,
      text.slice(start, pos),
      start,
      line,
      column,
    ),
    nextIndex: pos,
    nextColumn: 0,
    nextLine: line + 1,
  };
}

function scanWhitespace(
  text: string,
  i: number,
  line: number,
  column: number,
): ScanResult {
  const start = i;
  let pos = i;
  while (
    pos < text.length &&
    (text.charAt(pos) === "\x20" || text.charAt(pos) === "\x09")
  ) {
    pos++;
  }
  const tokenText = text.slice(start, pos);
  return {
    token: makeToken(AbnfTokenKind.Whitespace, tokenText, start, line, column),
    nextIndex: pos,
    nextColumn: column + tokenText.length,
  };
}

function scanComment(
  text: string,
  i: number,
  line: number,
  column: number,
): ScanResult {
  const start = i;
  let pos = i;
  while (
    pos < text.length &&
    text.charAt(pos) !== "\r" &&
    text.charAt(pos) !== "\n"
  ) {
    pos++;
  }
  const tokenText = text.slice(start, pos);
  return {
    token: makeToken(AbnfTokenKind.Comment, tokenText, start, line, column),
    nextIndex: pos,
    nextColumn: column + tokenText.length,
  };
}

function scanAssignment(
  text: string,
  i: number,
  line: number,
  column: number,
): ScanResult {
  if (text.charAt(i + 1) === "/") {
    return {
      token: makeToken(AbnfTokenKind.IncrementalAs, "=/", i, line, column),
      nextIndex: i + 2,
      nextColumn: column + 2,
    };
  }
  return {
    token: makeToken(AbnfTokenKind.DefinedAs, "=", i, line, column),
    nextIndex: i + 1,
    nextColumn: column + 1,
  };
}

function scanRulename(
  text: string,
  i: number,
  line: number,
  column: number,
): ScanResult {
  const start = i;
  let pos = i;
  while (pos < text.length && isAlphaNumOrHyphen(text.charAt(pos))) {
    pos++;
  }
  const tokenText = text.slice(start, pos);
  return {
    token: makeToken(AbnfTokenKind.Rulename, tokenText, start, line, column),
    nextIndex: pos,
    nextColumn: column + tokenText.length,
  };
}

function scanInteger(
  text: string,
  i: number,
  line: number,
  column: number,
): ScanResult {
  const start = i;
  let pos = i;
  while (pos < text.length && isDigit(text.charAt(pos))) {
    pos++;
  }
  const tokenText = text.slice(start, pos);
  return {
    token: makeToken(AbnfTokenKind.Integer, tokenText, start, line, column),
    nextIndex: pos,
    nextColumn: column + tokenText.length,
  };
}

function scanQuotedString(
  text: string,
  startIndex: number,
  openLen: number,
): number {
  let j = startIndex + openLen;
  while (
    j < text.length &&
    text.charAt(j) !== '"' &&
    text.charAt(j) !== "\r" &&
    text.charAt(j) !== "\n"
  ) {
    j++;
  }
  if (j < text.length && text.charAt(j) === '"') {
    j++;
  }
  return j;
}

function scanString(
  text: string,
  i: number,
  line: number,
  column: number,
): ScanResult {
  const end = scanQuotedString(text, i, 1);
  const tokenText = text.slice(i, end);
  return {
    token: makeToken(AbnfTokenKind.String, tokenText, i, line, column),
    nextIndex: end,
    nextColumn: column + tokenText.length,
  };
}

function scanProseValue(
  text: string,
  i: number,
  line: number,
  column: number,
): ScanResult {
  let j = i + 1;
  while (
    j < text.length &&
    text.charAt(j) !== ">" &&
    text.charAt(j) !== "\r" &&
    text.charAt(j) !== "\n"
  ) {
    j++;
  }
  if (j < text.length && text.charAt(j) === ">") {
    j++;
  }
  const tokenText = text.slice(i, j);
  return {
    token: makeToken(AbnfTokenKind.ProseValue, tokenText, i, line, column),
    nextIndex: j,
    nextColumn: column + tokenText.length,
  };
}

function scanCasedString(
  text: string,
  i: number,
  line: number,
  column: number,
  kind: AbnfTokenKind,
): ScanResult {
  const end = scanQuotedString(text, i, 3);
  const tokenText = text.slice(i, end);
  return {
    token: makeToken(kind, tokenText, i, line, column),
    nextIndex: end,
    nextColumn: column + tokenText.length,
  };
}

function scanNumericRange(
  text: string,
  j: number,
  isValidDigit: (ch: string) => boolean,
): number {
  let pos = j + 1;
  while (pos < text.length && isValidDigit(text.charAt(pos))) {
    pos++;
  }
  return pos;
}

function scanNumericConcatenation(
  text: string,
  j: number,
  isValidDigit: (ch: string) => boolean,
): number {
  let pos = j;
  while (pos < text.length && text.charAt(pos) === ".") {
    const dotPos = pos;
    pos++;
    const beforeDigits = pos;
    while (pos < text.length && isValidDigit(text.charAt(pos))) {
      pos++;
    }
    if (pos === beforeDigits) {
      return dotPos;
    }
  }
  return pos;
}

function scanNumericValue(
  text: string,
  i: number,
  line: number,
  column: number,
  isValidDigit: (ch: string) => boolean,
): ScanResult {
  let j = i + 2;

  while (j < text.length && isValidDigit(text.charAt(j))) {
    j++;
  }

  const hasDigits = j > i + 2;

  if (hasDigits) {
    if (j < text.length && text.charAt(j) === "-") {
      j = scanNumericRange(text, j, isValidDigit);
    } else {
      j = scanNumericConcatenation(text, j, isValidDigit);
    }
  }

  const tokenText = text.slice(i, j);
  return {
    token: makeToken(AbnfTokenKind.NumericValue, tokenText, i, line, column),
    nextIndex: j,
    nextColumn: column + tokenText.length,
  };
}

function scanPercentSequence(
  text: string,
  i: number,
  line: number,
  column: number,
): ScanResult {
  const next = text.charAt(i + 1).toLowerCase();

  if (next === "s" && text.charAt(i + 2) === '"') {
    return scanCasedString(
      text,
      i,
      line,
      column,
      AbnfTokenKind.CaseSensitiveString,
    );
  }

  if (next === "i" && text.charAt(i + 2) === '"') {
    return scanCasedString(
      text,
      i,
      line,
      column,
      AbnfTokenKind.CaseInsensitiveString,
    );
  }

  if (next === "x") {
    return scanNumericValue(text, i, line, column, isHexDigit);
  }

  if (next === "d") {
    return scanNumericValue(text, i, line, column, isDigit);
  }

  if (next === "b") {
    return scanNumericValue(text, i, line, column, isBinDigit);
  }

  return {
    token: makeToken(AbnfTokenKind.Unknown, "%", i, line, column),
    nextIndex: i + 1,
    nextColumn: column + 1,
  };
}

function scanSingleChar(
  text: string,
  i: number,
  line: number,
  column: number,
): ScanResult {
  const ch = text.charAt(i);
  const kindMap: Record<string, AbnfTokenKind> = {
    "/": AbnfTokenKind.Alternation,
    "(": AbnfTokenKind.ParenOpen,
    ")": AbnfTokenKind.ParenClose,
    "[": AbnfTokenKind.BracketOpen,
    "]": AbnfTokenKind.BracketClose,
    "*": AbnfTokenKind.Asterisk,
  };
  return {
    token: makeToken(kindMap[ch] ?? AbnfTokenKind.Unknown, ch, i, line, column),
    nextIndex: i + 1,
    nextColumn: column + 1,
  };
}

function scanToken(
  text: string,
  i: number,
  line: number,
  column: number,
): ScanResult {
  const ch = text.charAt(i);

  if (ch === "\r" || ch === "\n") {
    return scanNewline(text, i, line, column);
  }
  if (ch === "\x20" || ch === "\x09") {
    return scanWhitespace(text, i, line, column);
  }
  if (ch === ";") {
    return scanComment(text, i, line, column);
  }
  if (ch === "=") {
    return scanAssignment(text, i, line, column);
  }
  if (ch === "%") {
    return scanPercentSequence(text, i, line, column);
  }
  if (ch === '"') {
    return scanString(text, i, line, column);
  }
  if (ch === "<") {
    return scanProseValue(text, i, line, column);
  }
  if (isDigit(ch)) {
    return scanInteger(text, i, line, column);
  }
  if (isAlpha(ch)) {
    return scanRulename(text, i, line, column);
  }
  return scanSingleChar(text, i, line, column);
}

/**
 * Tokenizes RFC ABNF source text.
 */
export function tokenize(text: string): AbnfToken[] {
  const tokens: AbnfToken[] = [];
  let i = 0;
  let line = 0;
  let column = 0;

  while (i < text.length) {
    const result = scanToken(text, i, line, column);
    tokens.push(result.token);
    i = result.nextIndex;
    column = result.nextColumn;
    if (result.nextLine !== undefined) {
      line = result.nextLine;
    }
  }

  return tokens;
}

const recentTokenizations = new RecentCache<readonly AbnfToken[]>(
  RECENT_DOCUMENTS,
);

/**
 * Tokenizes a whole document, remembering recent results per text so parse,
 * analysis, formatting, hints, and highlighting of one version share a single
 * pass. The returned array is shared and must not be mutated; use `tokenize`
 * for sub-texts.
 */
export function tokenizeDocument(text: string): readonly AbnfToken[] {
  return recentTokenizations.get("abnf", text, () => tokenize(text));
}
