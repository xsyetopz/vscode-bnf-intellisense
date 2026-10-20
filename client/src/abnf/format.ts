import { parseRuleBody } from "./body-parser.ts";
import { formatRule } from "./format-renderer.ts";
import {
  findRegionEnd,
  isRuleStart,
  isTriviaKind,
  trimRegionEnd,
} from "./regions.ts";
import { tokenizeDocument } from "./tokenizer.ts";
import type { AbnfToken } from "./types.ts";
import { AbnfTokenKind } from "./types.ts";

/**
 * ABNF alternative indentation modes.
 */
export type AbnfAlternativeIndent = "align" | "indent";
/**
 * ABNF alternative line-break modes.
 */
export type AbnfBreakAlternatives = "always" | "auto" | "never";

/**
 * Formatting options for ABNF documents.
 */
export interface AbnfFormatterConfig {
  alignEquals: boolean;
  continuationIndent: number;
  alternativeIndent: AbnfAlternativeIndent;
  insertFinalNewline: boolean;
  blankLinesBetweenRules: number;
  breakAlternatives: AbnfBreakAlternatives;
  maxLineLength: number; // 0 disables
  preserveContinuationLineBreaks: boolean;
  spaceBeforeInlineComment: number;
}

export interface RuleBlock {
  kind: "rule";
  name: string;
  operator: "=" | "=/";
  bodyTokens: readonly AbnfToken[];
  /** Original source of a rule with parse errors; emitted unchanged. */
  verbatim?: string;
}

interface StandaloneComment {
  kind: "comment";
  text: string;
  /** Keep one blank line before this free-standing indented comment. */
  blankBefore?: boolean;
}

type DocumentItem = RuleBlock | StandaloneComment;

/**
 * Formats an ABNF document while preserving grammar structure.
 */
export function formatAbnfDocument(
  text: string,
  config: AbnfFormatterConfig,
): string {
  if (text.trim().length === 0) {
    return text;
  }

  const tokens = tokenizeDocument(text);
  const eol =
    tokens.find((t) => t.kind === AbnfTokenKind.Newline)?.text ?? "\n";
  const items = parseDocumentItems(text, tokens, eol);
  const formatted = formatItems(items, config, eol);

  if (config.insertFinalNewline && !/[\r\n]$/.test(formatted)) {
    return `${formatted}${eol}`;
  }
  return formatted;
}

function sourceBetween(
  text: string,
  tokens: readonly AbnfToken[],
  from: number,
  to: number,
  eol: string,
): string {
  const first = tokens[from];
  const last = tokens[to - 1];
  if (first === undefined || last === undefined) {
    return "";
  }
  return text
    .slice(first.offset, last.offset + last.text.length)
    .replace(/\r\n|\r|\n/g, eol);
}

function parseRuleItem(
  text: string,
  tokens: readonly AbnfToken[],
  ruleStart: number,
  eol: string,
): { item: DocumentItem; nextIndex: number } {
  const nameTok = tokens[ruleStart] as AbnfToken;
  let i = skipWhitespace(tokens, ruleStart + 1);
  const opTok = tokens[i] as AbnfToken;
  i++;

  const regionEnd = findRegionEnd(tokens, i);
  const bodyEnd = trimRegionEnd(tokens, i, regionEnd);
  const bodyTokens = tokens.slice(i, bodyEnd);
  const hasErrors = parseRuleBody(bodyTokens).issues.some(
    (issue) => issue.severity === "error",
  );
  const rule: RuleBlock = {
    kind: "rule",
    name: nameTok.text,
    operator: opTok.kind === AbnfTokenKind.IncrementalAs ? "=/" : "=",
    bodyTokens,
  };
  if (hasErrors) {
    rule.verbatim = sourceBetween(text, tokens, ruleStart, bodyEnd, eol);
  }
  return { item: rule, nextIndex: bodyEnd };
}

function parseDocumentItems(
  text: string,
  tokens: readonly AbnfToken[],
  eol: string,
): DocumentItem[] {
  const items: DocumentItem[] = [];
  let i = 0;

  while (i < tokens.length) {
    const tok = tokens[i] as AbnfToken;

    if (tok.kind === AbnfTokenKind.Newline) {
      i++;
      continue;
    }
    if (tok.kind === AbnfTokenKind.Comment) {
      items.push({ kind: "comment", text: tok.text });
      i++;
      continue;
    }
    const first = tok.kind === AbnfTokenKind.Whitespace ? i + 1 : i;
    const firstTok = tokens[first];
    if (
      first > i &&
      firstTok?.kind === AbnfTokenKind.Comment &&
      items.length > 0
    ) {
      // An indented comment after a blank line stays indented and keeps the
      // blank line, so it never becomes the next rule's doc comment.
      items.push({
        kind: "comment",
        text: `${tok.text}${firstTok.text}`,
        blankBefore: isBlankLineBefore(tokens, i),
      });
      i = first + 1;
      continue;
    }
    if (firstTok === undefined || isTriviaKind(firstTok.kind)) {
      i = first;
      continue;
    }

    if (first === i && isRuleStart(tokens, i)) {
      const result = parseRuleItem(text, tokens, i, eol);
      items.push(result.item);
      i = result.nextIndex;
      continue;
    }

    // Not a rule: keep the lines exactly as written, never drop tokens.
    const end = trimRegionEnd(tokens, i, findRegionEnd(tokens, i));
    items.push({
      kind: "comment",
      text: sourceBetween(text, tokens, i, end, eol),
    });
    i = end;
  }

  return items;
}

function isBlankLineBefore(
  tokens: readonly AbnfToken[],
  index: number,
): boolean {
  if (tokens[index - 1]?.kind !== AbnfTokenKind.Newline) {
    return false;
  }
  let k = index - 2;
  while (k >= 0 && tokens[k]?.kind === AbnfTokenKind.Whitespace) {
    k--;
  }
  return tokens[k]?.kind === AbnfTokenKind.Newline;
}

function skipWhitespace(tokens: readonly AbnfToken[], start: number): number {
  let pos = start;
  while (
    pos < tokens.length &&
    tokens[pos]?.kind === AbnfTokenKind.Whitespace
  ) {
    pos++;
  }
  return pos;
}

function formatItems(
  items: DocumentItem[],
  config: AbnfFormatterConfig,
  eol: string,
): string {
  const groups = groupConsecutiveRules(items);
  const outputParts: string[] = [];

  for (const group of groups) {
    const groupLines = formatGroup(group, config, eol);
    outputParts.push(groupLines);
  }

  return outputParts.join(eol);
}

type DocumentGroup = DocumentItem[];

function groupConsecutiveRules(items: DocumentItem[]): DocumentGroup[] {
  const groups: DocumentGroup[] = [];
  let currentGroup: DocumentGroup = [];

  for (const item of items) {
    if (item.kind === "comment") {
      if (currentGroup.length > 0) {
        groups.push(currentGroup);
        currentGroup = [];
      }
      groups.push([item]);
    } else {
      currentGroup.push(item);
    }
  }

  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  return groups;
}

function calculateNameWidth(ruleBlocks: RuleBlock[]): number {
  let nameWidth = 0;
  for (const rule of ruleBlocks) {
    if (rule.name.length > nameWidth) {
      nameWidth = rule.name.length;
    }
  }
  return nameWidth;
}

function formatGroup(
  group: DocumentGroup,
  config: AbnfFormatterConfig,
  eol: string,
): string {
  const lines: string[] = [];

  const first = group[0];
  if (group.length === 1 && first?.kind === "comment") {
    if (first.blankBefore) {
      lines.push("");
    }
    lines.push(first.text);
    return lines.join(eol);
  }

  const ruleBlocks = group.filter(
    (item): item is RuleBlock => item.kind !== "comment",
  );

  const nameWidth = config.alignEquals
    ? calculateNameWidth(
        ruleBlocks.filter((rule) => rule.verbatim === undefined),
      )
    : 0;
  const blankLines = Math.max(0, Math.floor(config.blankLinesBetweenRules));

  for (let i = 0; i < ruleBlocks.length; i++) {
    const rule = ruleBlocks[i];
    if (rule === undefined) {
      continue;
    }

    const ruleText = rule.verbatim ?? formatRule(rule, nameWidth, config, eol);
    if (i > 0) {
      for (let b = 0; b < blankLines; b++) {
        lines.push("");
      }
    }
    lines.push(ruleText);
  }

  return lines.join(eol);
}
