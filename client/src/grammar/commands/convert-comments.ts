import { appendAll } from "../../append-all.ts";
import type { GrammarDialect } from "../dialects.ts";
import { LineIndex } from "../line-index.ts";
import {
  type DocumentLayout,
  type LayoutToken,
  layoutGrammar,
} from "../rule-layout.ts";
import type { Paragraph } from "./convert-ast.ts";
import { isOwnLineComment } from "./rule-blocks.ts";

/**
 * Comments of a document, split by what they are attached to.
 */
export interface CommentMap {
  /** Paragraphs of own-line comments before each rule (after the previous). */
  leading: Paragraph[][];
  /** Comment after the last token of the rule's last line. */
  trailing: Array<string | undefined>;
  /** Paragraphs after the last rule. */
  tail: Paragraph[];
  /** Comments inside rule bodies; they are not carried over. */
  dropped: number;
}

/**
 * Plain text lines of one comment token, without its markers.
 */
export function commentLines(raw: string): string[] {
  if (raw.startsWith("/*")) {
    const inner = raw.slice(2, raw.endsWith("*/") ? -2 : undefined);
    const lines = inner.split(/\r\n|\n|\r/).map((line) => line.trim());
    while (lines.length > 0 && lines[0] === "") {
      lines.shift();
    }
    while (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    return lines.length === 0 ? [""] : lines;
  }
  return [raw.slice(1).trim()];
}

/**
 * Groups comments on adjacent lines. `nextLine` is the first line of the code
 * that follows, used to decide whether the last paragraph is attached to it.
 */
function paragraphsOf(
  comments: readonly LayoutToken[],
  nextLine: number | undefined,
): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let previous: LayoutToken | undefined;
  for (const comment of comments) {
    const lines = commentLines(comment.text);
    const last = paragraphs[paragraphs.length - 1];
    if (previous && last && comment.line <= previous.endLine + 1) {
      appendAll(last.lines, lines);
    } else {
      paragraphs.push({ lines: [...lines], attached: false });
    }
    previous = comment;
  }
  const last = paragraphs[paragraphs.length - 1];
  if (last && previous && nextLine !== undefined) {
    last.attached = previous.endLine + 1 === nextLine;
  }
  return paragraphs;
}

/**
 * Sorts every comment of a document into leading, trailing, tail, or dropped.
 */
export function collectComments(
  text: string,
  dialect: GrammarDialect,
  layout: DocumentLayout = layoutGrammar(text, dialect),
): CommentMap {
  const starts = new LineIndex(text).starts;
  const rules = layout.rules;
  const pending: LayoutToken[][] = rules.map(() => []);
  const tailComments: LayoutToken[] = [];
  const trailing: Array<string | undefined> = rules.map(() => undefined);
  let dropped = 0;
  let cursor = 0;
  for (const comment of layout.comments) {
    while (
      cursor < rules.length &&
      (rules[cursor] as { endLine: number }).endLine < comment.line
    ) {
      cursor++;
    }
    const rule = rules[cursor];
    const own = isOwnLineComment(text, starts, comment);
    if (rule && rule.startLine <= comment.line) {
      const lastToken = rule.bodyTokens[rule.bodyTokens.length - 1];
      const isTrailing =
        !own &&
        comment.line === rule.endLine &&
        comment.endLine === comment.line &&
        trailing[cursor] === undefined &&
        (lastToken === undefined || comment.start >= lastToken.end);
      if (isTrailing) {
        trailing[cursor] = commentLines(comment.text).join(" ");
      } else if (own && lastToken && comment.line > lastToken.endLine) {
        // an indented comment line after the rule documents what follows
        (pending[cursor + 1] ?? tailComments).push(comment);
      } else {
        dropped++;
      }
    } else if (!own) {
      dropped++;
    } else if (rule) {
      pending[cursor]?.push(comment);
    } else {
      tailComments.push(comment);
    }
  }
  return {
    leading: pending.map((list, index) =>
      paragraphsOf(list, (rules[index] as { startLine: number }).startLine),
    ),
    trailing,
    tail: paragraphsOf(tailComments, undefined),
    dropped,
  };
}
