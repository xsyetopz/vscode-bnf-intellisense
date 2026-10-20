import { LineIndex } from "../line-index.ts";
import type { DocumentLayout, LayoutToken } from "../rule-layout.ts";

/**
 * Text span of one rule: the rule lines plus the comment lines that sit
 * directly above it (no blank line in between).
 */
export interface RuleBlock {
  /** Index of the rule in `layout.rules`. */
  index: number;
  /** First line, including attached comment lines. */
  startLine: number;
  /** First line of the rule itself. */
  ruleStartLine: number;
  endLine: number;
  /** Offset of the start of `startLine`. */
  start: number;
  /** Offset after the last character of `endLine`, before its line break. */
  end: number;
}

/**
 * Offset after the content of `line`, before its line break.
 */
export function lineContentEnd(
  text: string,
  starts: readonly number[],
  line: number,
): number {
  const next = starts[line + 1];
  if (next === undefined) {
    return text.length;
  }
  let end = next;
  if (text[end - 1] === "\n") {
    end--;
  }
  if (text[end - 1] === "\r") {
    end--;
  }
  return end;
}

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

/**
 * True when the comment is the only thing on all of its lines.
 */
export function isOwnLineComment(
  text: string,
  starts: readonly number[],
  comment: LayoutToken,
): boolean {
  const lineStart = starts[comment.line] ?? 0;
  const lineEnd = lineContentEnd(text, starts, comment.endLine);
  return (
    isBlank(text.slice(lineStart, comment.start)) &&
    isBlank(text.slice(comment.end, lineEnd))
  );
}

/**
 * Computes the block of every rule, in rule order. Returns undefined when two
 * rules touch the same line, because their blocks cannot be separated.
 */
export function computeRuleBlocks(
  text: string,
  layout: DocumentLayout,
): RuleBlock[] | undefined {
  const lines = new LineIndex(text);
  const starts = lines.starts;
  const commentByEndLine = new Map<number, LayoutToken[]>();
  for (const comment of layout.comments) {
    const list = commentByEndLine.get(comment.endLine);
    if (list) {
      list.push(comment);
    } else {
      commentByEndLine.set(comment.endLine, [comment]);
    }
  }
  const commentByStartLine = new Map<number, LayoutToken>();
  for (const comment of layout.comments) {
    commentByStartLine.set(comment.line, comment);
  }
  const blocks: RuleBlock[] = [];
  let previousEnd = -1;
  for (const [index, rule] of layout.rules.entries()) {
    if (rule.startLine <= previousEnd) {
      return undefined;
    }
    // Indented comment lines right after a rule continue that rule.
    let endLine = rule.endLine;
    for (;;) {
      const next = commentByStartLine.get(endLine + 1);
      if (
        !next ||
        next.column === 0 ||
        !isOwnLineComment(text, starts, next) ||
        layout.rules[index + 1]?.startLine === next.line
      ) {
        break;
      }
      endLine = next.endLine;
    }
    let startLine = rule.startLine;
    for (;;) {
      const above = startLine - 1;
      if (above <= previousEnd) {
        break;
      }
      const comment = commentByEndLine
        .get(above)
        ?.find((candidate) => isOwnLineComment(text, starts, candidate));
      if (comment?.column !== 0 || comment.line <= previousEnd) {
        break;
      }
      startLine = comment.line;
    }
    blocks.push({
      index,
      startLine,
      ruleStartLine: rule.startLine,
      endLine,
      start: starts[startLine] ?? 0,
      end: lineContentEnd(text, starts, endLine),
    });
    previousEnd = endLine;
  }
  return blocks;
}
