import { Position, Range } from "vscode";
import { parseAbnf } from "../abnf/parser.ts";
import type { GrammarDialect } from "./dialects.ts";
import {
  abnfBodyTokens,
  type BodyToken,
  productionBodyTokens,
} from "./expression.ts";
import { scanProductionGrammar } from "./scanner.ts";

/**
 * Finds the comment-free body tokens of the rule that contains a range. The
 * document is parsed once; rules are found by binary search on their line.
 */
export interface RemovalIndex {
  tokensAt(range: Range): BodyToken[] | undefined;
}

function lastAtOrBefore(lines: readonly number[], line: number): number {
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if ((lines[mid] as number) <= line) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/**
 * Builds a {@link RemovalIndex} for one document text.
 */
export function createRemovalIndex(
  text: string,
  dialect: GrammarDialect,
): RemovalIndex {
  if (dialect === "abnf") {
    let lines: number[] | undefined;
    let bodies: BodyToken[][] | undefined;
    return {
      tokensAt(range) {
        lines ??= parseAbnf(text).rules.map(
          (rule) => rule.nameRange.start.line,
        );
        bodies ??= abnfBodyTokens(text, lines);
        const index = lastAtOrBefore(lines, range.start.line);
        return index < 0 ? undefined : bodies[index];
      },
    };
  }
  const productions = scanProductionGrammar(text, dialect).productions;
  const lines = productions.map((production) => production.nameToken.line);
  const cache = new Map<number, BodyToken[]>();
  return {
    tokensAt(range) {
      const index = lastAtOrBefore(lines, range.start.line);
      const production = productions[index];
      if (!production) {
        return undefined;
      }
      const last = production.bodyTokens[production.bodyTokens.length - 1];
      if ((last?.endLine ?? production.nameToken.line) < range.end.line) {
        return undefined;
      }
      let tokens = cache.get(index);
      if (!tokens) {
        tokens = productionBodyTokens(production.bodyTokens);
        cache.set(index, tokens);
      }
      return tokens;
    },
  };
}

interface Span {
  start: Position;
  end: Position;
}

function tokenIndexAt(
  tokens: readonly BodyToken[],
  line: number,
  column: number,
): number {
  let low = 0;
  let high = tokens.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const t = tokens[mid] as BodyToken;
    if (t.line === line && t.column === column) {
      return mid;
    }
    if (t.line < line || (t.line === line && t.column < column)) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return -1;
}

function startOf(token: BodyToken): Position {
  return new Position(token.line, token.column);
}

function endOf(token: BodyToken): Position {
  return new Position(token.endLine, token.endColumn);
}

function isBlank(ch: string | undefined): boolean {
  return ch === " " || ch === "\t";
}

function before(a: Position, b: Position): boolean {
  return a.line < b.line || (a.line === b.line && a.character < b.character);
}

/**
 * Computes the edits that remove one alternative and one separator. The
 * range is either the alternative itself or, for an empty alternative, the
 * separator next to it. Only tokens are deleted, so comments stay in place.
 * Returns undefined when removal would leave an empty group or rule body.
 */
export function alternativeRemovalSpans(
  index: RemovalIndex,
  range: Range,
  lineAt: (line: number) => string,
  lineCount: number,
): Range[] | undefined {
  const tokens = index.tokensAt(range);
  if (!tokens) {
    return undefined;
  }
  const from = tokenIndexAt(tokens, range.start.line, range.start.character);
  if (from < 0) {
    return undefined;
  }
  let to = -1;
  for (let i = from; i < tokens.length; i++) {
    const t = tokens[i] as BodyToken;
    if (t.endLine === range.end.line && t.endColumn === range.end.character) {
      to = i;
      break;
    }
  }
  if (to < 0) {
    return undefined;
  }
  const spans: Array<Span & { side: "left" | "right" }> = [];
  const cover = (a: number, b: number, side: "left" | "right"): void => {
    spans.push({
      start: startOf(tokens[a] as BodyToken),
      end: endOf(tokens[b] as BodyToken),
      side,
    });
  };
  const previous = tokens[from - 1];
  if (from === to && (tokens[from] as BodyToken).role === "alt") {
    // Empty alternative: drop its separator.
    const next = tokens[from + 1];
    if (!previous || previous.role === "open") {
      if (!next || next.role === "close") {
        return undefined;
      }
    }
    cover(from, from, !previous || previous.role === "open" ? "right" : "left");
  } else if (previous?.role === "alt") {
    cover(from - 1, from - 1, "left");
    cover(from, to, "left");
  } else {
    const after = tokens[to + 1];
    if (after?.role !== "alt") {
      return undefined;
    }
    cover(from, to, "right");
    cover(to + 1, to + 1, "right");
  }
  return mergeSpans(spans, lineAt, lineCount);
}

function mergeSpans(
  spans: Array<Span & { side: "left" | "right" }>,
  lineAt: (line: number) => string,
  lineCount: number,
): Range[] {
  const widened = spans.map((span) => {
    const text = lineAt(span.side === "left" ? span.start.line : span.end.line);
    let { start, end } = span;
    if (span.side === "left") {
      let col = start.character;
      while (col > 0 && isBlank(text[col - 1])) {
        col--;
      }
      start = new Position(start.line, col);
    } else {
      let col = end.character;
      while (col < text.length && isBlank(text[col])) {
        col++;
      }
      end = new Position(end.line, col);
    }
    return { start, end };
  });
  widened.sort((a, b) => (before(a.start, b.start) ? -1 : 1));
  const merged: Span[] = [];
  for (const span of widened) {
    const last = merged[merged.length - 1];
    if (last && !before(last.end, span.start)) {
      if (before(last.end, span.end)) {
        last.end = span.end;
      }
    } else {
      merged.push({ ...span });
    }
  }
  return merged.map((span) => {
    let { start } = span;
    // A deletion that empties its whole line takes the line break with it.
    if (
      start.character === 0 &&
      start.line > 0 &&
      span.end.line < lineCount &&
      span.end.character >= lineAt(span.end.line).length
    ) {
      start = new Position(start.line - 1, lineAt(start.line - 1).length);
    }
    return new Range(start, span.end);
  });
}
