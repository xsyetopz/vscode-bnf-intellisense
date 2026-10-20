import {
  type CancellationToken,
  type Position,
  Range,
  SelectionRange,
  type SelectionRangeProvider,
  type TextDocument,
} from "vscode";
import { grammarDialectFromLanguageId } from "../grammar.ts";
import { LineIndex } from "../line-index.ts";
import { rangeFromLineIndex } from "../ranges.ts";
import {
  type DocumentLayout,
  type LayoutToken,
  layoutGrammar,
  type RuleLayout,
} from "../rule-layout.ts";

/**
 * A source span with offsets for ordering and line/column for ranges.
 */
interface Span {
  start: number;
  end: number;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

interface Frame {
  open: LayoutToken | undefined;
  /** Where the element that owns this frame starts (includes ABNF prefix). */
  elementStart: Span | undefined;
  first: Span | undefined;
  last: Span | undefined;
  altFirst: Span | undefined;
  altLast: Span | undefined;
}

const CLOSER_FOR: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

function span(a: Span, b: Span): Span {
  return {
    start: a.start,
    end: b.end,
    line: a.line,
    column: a.column,
    endLine: b.endLine,
    endColumn: b.endColumn,
  };
}

function newFrame(open?: LayoutToken, elementStart?: Span): Frame {
  return {
    open,
    elementStart,
    first: undefined,
    last: undefined,
    altFirst: undefined,
    altLast: undefined,
  };
}

function addElement(frame: Frame, element: Span): void {
  frame.first ??= element;
  frame.last = element;
  frame.altFirst ??= element;
  frame.altLast = element;
}

function endAlternative(frame: Frame, out: Span[]): void {
  if (frame.altFirst && frame.altLast) {
    out.push(span(frame.altFirst, frame.altLast));
  }
  frame.altFirst = undefined;
  frame.altLast = undefined;
}

function isAdjacent(a: Span | undefined, b: Span | undefined): boolean {
  return a !== undefined && b !== undefined && a.end === b.start;
}

/**
 * Collects the nested spans of one rule: tokens, elements with their repeat
 * affixes, alternatives, group contents, groups, the whole body, and the
 * whole definition. Delimiters that do not pair up are plain terms.
 */
function ruleSpans(rule: RuleLayout): Span[] {
  const out: Span[] = [rule.nameToken, rule.assignToken];
  if (rule.numberToken) {
    out.push(rule.numberToken);
  }
  const body = rule.bodyTokens;
  const stack: Frame[] = [newFrame()];
  const top = (): Frame => stack[stack.length - 1] as Frame;
  let prefixStart: LayoutToken | undefined;
  const flushPrefix = (end: LayoutToken): void => {
    if (prefixStart) {
      const run = span(prefixStart, end);
      out.push(run);
      addElement(top(), run);
      prefixStart = undefined;
    }
  };
  for (let i = 0; i < body.length; i++) {
    const token = body[i] as LayoutToken;
    const next = body[i + 1];
    const wasPrefixStart = prefixStart;
    if (token.kind === "prefix") {
      prefixStart ??= token;
      if (
        !(
          isAdjacent(token, next) &&
          next !== undefined &&
          (next.kind === "prefix" ||
            next.kind === "term" ||
            next.kind === "open")
        )
      ) {
        flushPrefix(token);
      }
      continue;
    }
    const startToken = wasPrefixStart ?? token;
    prefixStart = undefined;
    if (token.kind === "alt") {
      endAlternative(top(), out);
      out.push(token);
    } else if (token.kind === "open") {
      stack.push(newFrame(token, startToken));
    } else if (
      token.kind === "close" &&
      stack.length > 1 &&
      CLOSER_FOR[top().open?.text ?? ""] === token.text
    ) {
      const frame = stack.pop() as Frame;
      endAlternative(frame, out);
      if (frame.first && frame.last) {
        out.push(span(frame.first, frame.last));
      }
      let group: Span = span(frame.elementStart as Span, token);
      out.push(span(frame.open as LayoutToken, token));
      while (body[i + 1]?.kind === "suffix" && isAdjacent(group, body[i + 1])) {
        group = span(group, body[i + 1] as LayoutToken);
        i++;
      }
      out.push(group);
      addElement(top(), group);
    } else {
      // A term, or a stray suffix or closer.
      let element: Span = span(startToken, token);
      out.push(token);
      while (
        body[i + 1]?.kind === "suffix" &&
        isAdjacent(element, body[i + 1])
      ) {
        element = span(element, body[i + 1] as LayoutToken);
        i++;
      }
      out.push(element);
      addElement(top(), element);
    }
  }
  // Unclosed openers: fold their content into the parent alternative.
  while (stack.length > 1) {
    const frame = stack.pop() as Frame;
    const open = frame.open as LayoutToken;
    const folded = span(frame.elementStart ?? open, frame.last ?? open);
    addElement(top(), folded);
  }
  const root = top();
  endAlternative(root, out);
  const definitionStart: Span = rule.numberToken ?? rule.nameToken;
  const lastBody = root.last;
  if (root.first && lastBody) {
    out.push(span(root.first, lastBody));
  }
  out.push(span(definitionStart, lastBody ?? rule.assignToken));
  return out;
}

function toRange(s: Span): Range {
  return new Range(s.line, s.column, s.endLine, s.endColumn);
}

function ruleTokens(rule: RuleLayout): readonly LayoutToken[] {
  return [
    rule.nameToken,
    rule.assignToken,
    ...(rule.numberToken ? [rule.numberToken] : []),
    ...rule.bodyTokens,
  ];
}

function ruleRegion(rule: RuleLayout): { start: number; end: number } {
  const last = rule.bodyTokens[rule.bodyTokens.length - 1] ?? rule.assignToken;
  return { start: (rule.numberToken ?? rule.nameToken).start, end: last.end };
}

/**
 * Picks the token under the offset (or ending at it). Comments are the first
 * group, so the result says whether it came from there.
 */
function chooseAtom(
  groups: ReadonlyArray<readonly Span[]>,
  offset: number,
): { atom: Span; group: number } | undefined {
  for (let group = 0; group < groups.length; group++) {
    const atom = groups[group]?.find(
      (candidate) => candidate.start <= offset && offset < candidate.end,
    );
    if (atom) {
      return { atom, group };
    }
  }
  for (let group = 0; group < groups.length; group++) {
    const atom = groups[group]?.find(
      (candidate) =>
        candidate.end === offset && candidate.end > candidate.start,
    );
    if (atom) {
      return { atom, group };
    }
  }
  return undefined;
}

function lineSpan(
  text: string,
  lines: LineIndex,
  offset: number,
): Span | undefined {
  const line = lines.lineAt(offset);
  const lineStart = lines.starts[line] ?? 0;
  const raw = text.slice(lineStart, lines.starts[line + 1] ?? text.length);
  const content = raw.replace(/[\r\n]+$/, "");
  const start = lineStart + (content.length - content.trimStart().length);
  const end = lineStart + content.trimEnd().length;
  if (end <= start || offset < start || offset > end) {
    return undefined;
  }
  const range = rangeFromLineIndex(lines, start, end);
  return {
    start,
    end,
    line: range.start.line,
    column: range.start.character,
    endLine: range.end.line,
    endColumn: range.end.character,
  };
}

function offsetOf(text: string, lines: LineIndex, position: Position): number {
  const line = Math.max(0, Math.min(position.line, lines.starts.length - 1));
  const lineStart = lines.starts[line] ?? 0;
  const nextStart = lines.starts[line + 1];
  const lineEnd =
    nextStart === undefined
      ? text.length
      : lineStart +
        text.slice(lineStart, nextStart).replace(/[\r\n]+$/, "").length;
  return Math.min(lineStart + Math.max(0, position.character), lineEnd);
}

/**
 * Orders candidate spans from the smallest to the largest. Only spans that
 * strictly contain the previous one survive, so the chain nests strictly.
 */
function nestingChain(
  candidates: readonly Span[],
  anchorStart: number,
  anchorEnd: number,
): Span[] {
  const containing = candidates
    .filter(
      (s) => s.end > s.start && s.start <= anchorStart && s.end >= anchorEnd,
    )
    .sort((a, b) => a.end - a.start - (b.end - b.start));
  const chain: Span[] = [];
  for (const s of containing) {
    const last = chain[chain.length - 1];
    if (
      !last ||
      (s.start <= last.start &&
        s.end >= last.end &&
        s.end - s.start > last.end - last.start)
    ) {
      chain.push(s);
    }
  }
  return chain;
}

/**
 * VS Code selection range provider: word or name, enclosing group, option or
 * repetition, alternative, rule body, whole rule definition, document.
 */
export class GrammarSelectionRangeProvider implements SelectionRangeProvider {
  provideSelectionRanges(
    doc: TextDocument,
    positions: readonly Position[],
    token?: CancellationToken,
  ): SelectionRange[] {
    const text = doc.getText();
    const dialect = grammarDialectFromLanguageId(doc.languageId);
    const layout = layoutGrammar(text, dialect);
    const lines = new LineIndex(text);
    const docRange = rangeFromLineIndex(lines, 0, text.length);
    const documentSpan: Span = {
      start: 0,
      end: text.length,
      line: docRange.start.line,
      column: docRange.start.character,
      endLine: docRange.end.line,
      endColumn: docRange.end.character,
    };
    const cache = new Map<RuleLayout, Span[]>();
    const results: SelectionRange[] = [];
    for (const position of positions) {
      if (token?.isCancellationRequested) {
        break;
      }
      const offset = offsetOf(text, lines, position);
      const chain = this.#chainAt(text, lines, layout, cache, offset);
      let parent = new SelectionRange(toRange(documentSpan));
      const unique = chain.filter(
        (s) => !(s.start === 0 && s.end === text.length),
      );
      for (let i = unique.length - 1; i >= 0; i--) {
        parent = new SelectionRange(toRange(unique[i] as Span), parent);
      }
      results.push(parent);
    }
    return results;
  }

  #chainAt(
    text: string,
    lines: LineIndex,
    layout: DocumentLayout,
    cache: Map<RuleLayout, Span[]>,
    offset: number,
  ): Span[] {
    const rule = layout.rules.find((candidate) => {
      const region = ruleRegion(candidate);
      return region.start <= offset && offset <= region.end;
    });
    const candidates = rule ? (cache.get(rule) ?? ruleSpans(rule)) : [];
    if (rule) {
      cache.set(rule, candidates);
    }
    const found = chooseAtom(
      rule ? [layout.comments, ruleTokens(rule)] : [layout.comments],
      offset,
    );
    if (found) {
      const { atom } = found;
      const isComment = found.group === 0;
      return nestingChain(
        // A comment inside a rule still sits in that rule's alternatives,
        // body, and definition.
        isComment ? [atom, ...candidates] : candidates,
        atom.start,
        atom.end,
      );
    }
    if (rule) {
      return nestingChain(candidates, offset, offset);
    }
    const line = lineSpan(text, lines, offset);
    return line ? [line] : [];
  }
}
