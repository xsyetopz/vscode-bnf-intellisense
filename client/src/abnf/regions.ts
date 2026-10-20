import type { AbnfToken } from "./types.ts";
import { AbnfTokenKind } from "./types.ts";

/**
 * Returns true for whitespace, newline and comment tokens.
 */
export function isTriviaKind(kind: AbnfTokenKind): boolean {
  return (
    kind === AbnfTokenKind.Whitespace ||
    kind === AbnfTokenKind.Newline ||
    kind === AbnfTokenKind.Comment
  );
}

/**
 * Returns the index of the Newline that ends the region starting at `from`:
 * the Newline right before a line that starts with a non-trivia token at
 * column 0, or `tokens.length` when the region reaches the end of the text.
 */
export function findRegionEnd(
  tokens: readonly AbnfToken[],
  from: number,
): number {
  for (let i = from; i < tokens.length; i++) {
    if (tokens[i]?.kind !== AbnfTokenKind.Newline) {
      continue;
    }
    const next = tokens[i + 1];
    if (next !== undefined && !isTriviaKind(next.kind)) {
      return i;
    }
  }
  return tokens.length;
}

/**
 * Returns the index after the last non-trivia token in `[from, end)`, plus
 * a trailing comment on that same line and any indented comment-only lines
 * right after it (RFC 5234 Appendix B style continuation comments).
 * Returns `from` when none exists.
 */
export function trimRegionEnd(
  tokens: readonly AbnfToken[],
  from: number,
  end: number,
): number {
  let last = -1;
  for (let i = end - 1; i >= from; i--) {
    const kind = tokens[i]?.kind;
    if (kind !== undefined && !isTriviaKind(kind)) {
      last = i;
      break;
    }
  }
  if (last < 0) {
    return from;
  }
  let after = last + 1;
  while (after < end && tokens[after]?.kind === AbnfTokenKind.Whitespace) {
    after++;
  }
  let stop = last + 1;
  if (after < end && tokens[after]?.kind === AbnfTokenKind.Comment) {
    stop = after + 1;
  }
  let nl = stop;
  while (nl < end && tokens[nl]?.kind === AbnfTokenKind.Whitespace) {
    nl++;
  }
  while (
    nl + 2 < end &&
    tokens[nl]?.kind === AbnfTokenKind.Newline &&
    tokens[nl + 1]?.kind === AbnfTokenKind.Whitespace &&
    tokens[nl + 2]?.kind === AbnfTokenKind.Comment
  ) {
    stop = nl + 3;
    nl = stop;
  }
  return stop;
}

/**
 * Returns true if, starting at `idx`, a rule definition begins:
 *   Rulename (optional-whitespace) (DefinedAs | IncrementalAs)
 * with the name at column 0.
 */
export function isRuleStart(
  tokens: readonly AbnfToken[],
  idx: number,
): boolean {
  const t = tokens[idx];
  if (!t || t.kind !== AbnfTokenKind.Rulename || t.column !== 0) {
    return false;
  }
  let j = idx + 1;
  while (j < tokens.length && tokens[j]?.kind === AbnfTokenKind.Whitespace) {
    j++;
  }
  const after = tokens[j];
  return (
    after !== undefined &&
    (after.kind === AbnfTokenKind.DefinedAs ||
      after.kind === AbnfTokenKind.IncrementalAs)
  );
}
