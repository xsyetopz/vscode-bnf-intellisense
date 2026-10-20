import {
  type CancellationToken,
  type LinkedEditingRangeProvider,
  LinkedEditingRanges,
  type Position,
  Range,
  type TextDocument,
} from "vscode";
import { CORE_RULES } from "../../abnf/core-rules.ts";
import type { GrammarDialect } from "../dialects.ts";
import type { GrammarWorkspace } from "../workspace.ts";
import { getWordLookup } from "./word-at-position.ts";

/** Names written between angle brackets: BNF `<expr>` and every RBNF name. */
const ANGLE_WORD_PATTERN = /[^<>\r\n]+/;
const WORD_PATTERNS: Record<GrammarDialect, RegExp> = {
  abnf: /[A-Za-z][A-Za-z0-9-]*/,
  bnf: /[A-Za-z_][A-Za-z0-9_.:-]*/,
  ebnf: /[A-Za-z_][A-Za-z0-9_.:-]*/,
  rbnf: ANGLE_WORD_PATTERN,
};

function isAngleName(text: string): boolean {
  return text.startsWith("<") && text.endsWith(">") && text.length > 2;
}

/**
 * The editable part of a name occurrence: angle names exclude the brackets.
 */
function nameRange(range: Range, text: string): Range {
  return isAngleName(text)
    ? new Range(
        range.start.line,
        range.start.character + 1,
        range.end.line,
        range.end.character - 1,
      )
    : range;
}

function contains(range: Range, position: Position): boolean {
  const afterStart =
    position.line > range.start.line ||
    (position.line === range.start.line &&
      position.character >= range.start.character);
  const beforeEnd =
    position.line < range.end.line ||
    (position.line === range.end.line &&
      position.character <= range.end.character);
  return afterStart && beforeEnd;
}

/**
 * VS Code linked editing provider: renaming a rule name in place updates its
 * definition and every reference in the same document.
 *
 * ABNF names are case-insensitive, so `Rule` and `rule` are one rule. Only
 * occurrences spelled exactly like the one under the cursor are linked:
 * linking all of them would rewrite the spelling of the others while typing.
 * References to the built-in ABNF core rules (`ALPHA`, `DIGIT`, ...) are not
 * linked. Name patterns are ASCII on purpose: they match what the scanners
 * accept as a name, so a pattern never allows text the parser would reject.
 */
export class GrammarLinkedEditingRangeProvider
  implements LinkedEditingRangeProvider
{
  readonly #grammarWorkspace: GrammarWorkspace;

  constructor(grammarWorkspace: GrammarWorkspace) {
    this.#grammarWorkspace = grammarWorkspace;
  }

  provideLinkedEditingRanges(
    doc: TextDocument,
    position: Position,
    _token?: CancellationToken,
  ): LinkedEditingRanges | undefined {
    const lookup = getWordLookup(doc, position, this.#grammarWorkspace);
    if (!lookup) {
      return undefined;
    }
    // A core-rule name is only off limits while it means the built-in rule;
    // a rule the user defines with that name is an ordinary rule.
    if (
      lookup.dialect === "abnf" &&
      CORE_RULES.has(lookup.word) &&
      !lookup.symbolTable.definitions.has(lookup.word)
    ) {
      return undefined;
    }
    // The cursor must touch the name itself, not an angle bracket around it.
    if (!contains(nameRange(lookup.wordRange, lookup.text), position)) {
      return undefined;
    }
    const ranges: Range[] = [];
    for (const rule of lookup.symbolTable.definitions.get(lookup.word) ?? []) {
      if (rule.name === lookup.text) {
        ranges.push(nameRange(rule.nameRange, rule.name));
      }
    }
    for (const ref of lookup.symbolTable.references.get(lookup.word) ?? []) {
      if (ref.name === lookup.text) {
        ranges.push(nameRange(ref.range, ref.name));
      }
    }
    if (ranges.length === 0) {
      return undefined;
    }
    ranges.sort(
      (a, b) =>
        a.start.line - b.start.line || a.start.character - b.start.character,
    );
    return new LinkedEditingRanges(
      ranges,
      isAngleName(lookup.text)
        ? ANGLE_WORD_PATTERN
        : WORD_PATTERNS[lookup.dialect],
    );
  }
}
