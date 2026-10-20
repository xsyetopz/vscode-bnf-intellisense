import { type ScanResult, scanProductionGrammar } from "./scanner.ts";

/**
 * One text replacement in document offsets.
 */
export interface OffsetEdit {
  start: number;
  end: number;
  text: string;
}

/**
 * One ISO/IEC 14977 production and the edits that turn it into W3C XML EBNF.
 */
export interface IsoStatement {
  start: number;
  end: number;
  /** False when the production uses syntax W3C EBNF cannot express. */
  convertible: boolean;
  /** Why conversion was refused. */
  reason?: string;
  edits: OffsetEdit[];
}

/**
 * A run of consecutive ISO productions found by the scanner.
 */
export interface IsoRun {
  start: number;
  end: number;
  statements: IsoStatement[];
  /** Edits outside any production, such as a leading `(* header *)`. */
  looseEdits: OffsetEdit[];
  /** Why a comment-only run cannot be converted. */
  refusal?: string;
  /**
   * Comment-only runs: the comment follows other code on its line, so it
   * belongs to that code's production, not to the production below it.
   */
  trailsCode?: true;
}

type TokenKind = "name" | "string" | "comment" | "number" | "punct" | "bad";

interface IsoToken {
  kind: TokenKind;
  text: string;
  start: number;
  end: number;
  reason?: string;
}

const NAME_START_RE = /[A-Za-z_]/;
const NAME_PART_RE = /[A-Za-z0-9_]/;
const DIGIT_RE = /[0-9]/;
const WS_RE = /\s/;

function lexIso(text: string, from: number, to: number): IsoToken[] {
  const tokens: IsoToken[] = [];
  const push = (kind: TokenKind, start: number, end: number, reason?: string) =>
    tokens.push({
      kind,
      text: text.slice(start, end),
      start,
      end,
      ...(reason ? { reason } : {}),
    });
  let i = from;
  while (i < to) {
    const ch = text[i] as string;
    const next = text[i + 1];
    if (WS_RE.test(ch)) {
      i++;
    } else if (ch === "(" && next === "*") {
      let depth = 1;
      let nested = false;
      let j = i + 2;
      while (j < to && depth > 0) {
        if (text[j] === "(" && text[j + 1] === "*") {
          depth++;
          nested = true;
          j += 2;
        } else if (text[j] === "*" && text[j + 1] === ")") {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      if (depth > 0) {
        push("bad", i, to, "unterminated comment");
        i = to;
      } else if (nested) {
        push("bad", i, j, "nested comment (W3C comments do not nest)");
        i = j;
      } else if (text.slice(i + 2, j - 2).includes("*/")) {
        push("bad", i, j, 'comment contains "*/"');
        i = j;
      } else {
        push("comment", i, j);
        i = j;
      }
    } else if (ch === "(" && (next === "/" || next === ":")) {
      push("bad", i, i + 2, `"(${next}" alternative brackets`);
      i += 2;
    } else if ((ch === "/" || ch === ":") && next === ")") {
      push("bad", i, i + 2, `"${ch})" alternative brackets`);
      i += 2;
    } else if (ch === "'" || ch === '"') {
      const close = text.indexOf(ch, i + 1);
      if (close < 0 || close >= to) {
        push("bad", i, to, "unterminated string");
        i = to;
      } else {
        push("string", i, close + 1);
        i = close + 1;
      }
    } else if (ch === "?") {
      const close = text.indexOf("?", i + 1);
      const end = close < 0 || close >= to ? to : close + 1;
      push("bad", i, end, "special sequence");
      i = end;
    } else if (NAME_START_RE.test(ch)) {
      let j = i + 1;
      while (j < to && NAME_PART_RE.test(text[j] as string)) {
        j++;
      }
      push("name", i, j);
      i = j;
    } else if (DIGIT_RE.test(ch)) {
      let j = i + 1;
      while (j < to && DIGIT_RE.test(text[j] as string)) {
        j++;
      }
      push("number", i, j);
      i = j;
    } else {
      push("punct", i, i + 1);
      i++;
    }
  }
  return tokens;
}

function isBlank(ch: string | undefined): boolean {
  return ch === " " || ch === "\t";
}

const MAX_REPETITION = 16;

interface Repetition {
  start: number;
  elementStart: number;
  elementEnd: number;
  count: number;
  wrap: boolean;
}

function commentEdits(token: IsoToken): OffsetEdit[] {
  return [
    { start: token.start, end: token.start + 2, text: "/*" },
    { start: token.end - 2, end: token.end, text: "*/" },
  ];
}

const OPENERS: Record<string, { close: string; open: string; after: string }> =
  {
    "(": { close: ")", open: "(", after: ")" },
    "{": { close: "}", open: "(", after: ")*" },
    "[": { close: "]", open: "(", after: ")?" },
  };

class Converter {
  readonly statements: IsoStatement[] = [];
  readonly #text: string;
  readonly #tokens: IsoToken[];
  #index = 0;

  readonly #eol: string;

  constructor(text: string, tokens: IsoToken[], eol: string) {
    this.#text = text;
    this.#tokens = tokens;
    this.#eol = eol;
  }

  run(): IsoStatement[] {
    while (this.#index < this.#tokens.length) {
      const token = this.#tokens[this.#index] as IsoToken;
      const previous = this.statements[this.statements.length - 1];
      if (token.kind === "comment" && previous) {
        // A comment between productions belongs to the production before it.
        this.#index++;
        previous.end = token.end;
        if (previous.convertible) {
          previous.edits.push(...commentEdits(token));
        }
      } else if (
        token.kind === "bad" &&
        previous &&
        token.reason?.includes("comment")
      ) {
        this.#index++;
        previous.convertible = false;
        previous.edits = [];
        previous.reason = token.reason ?? "unsupported comment";
      } else {
        this.#statement();
      }
    }
    return this.statements;
  }

  #commaEdit(token: IsoToken): OffsetEdit {
    const text = this.#text;
    const before = text[token.start - 1];
    const after = text[token.end];
    if (isBlank(before) && isBlank(after)) {
      return { start: token.start, end: token.end + 1, text: "" };
    }
    if (
      isBlank(before) &&
      (after === undefined || after === "\n" || after === "\r")
    ) {
      return { start: token.start - 1, end: token.end, text: "" };
    }
    return {
      start: token.start,
      end: token.end,
      text: isBlank(before) || isBlank(after) ? "" : " ",
    };
  }

  /**
   * Edits for a terminator. When another production follows on the same
   * line (possibly after comments), W3C EBNF needs a line break before it.
   */
  #terminatorEdits(token: IsoToken): OffsetEdit[] {
    const text = this.#text;
    let start = token.start;
    while (isBlank(text[start - 1])) {
      start--;
    }
    let after = this.#index;
    while (this.#tokens[after]?.kind === "comment") {
      after++;
    }
    const following = this.#tokens[after];
    const gap = following ? text.slice(token.end, following.start) : "\n";
    const sameLine = !(gap.includes("\n") || gap.includes("\r"));
    if (!(following && sameLine)) {
      return [{ start, end: token.end, text: "" }];
    }
    if (after === this.#index) {
      return [{ start, end: following.start, text: this.#eol }];
    }
    let breakStart = following.start;
    while (isBlank(text[breakStart - 1])) {
      breakStart--;
    }
    return [
      { start, end: token.end, text: "" },
      { start: breakStart, end: following.start, text: this.#eol },
    ];
  }

  #isEmptyGroup(index: number): boolean {
    const open = this.#tokens[index];
    const close = this.#tokens[index + 1];
    return (
      open?.kind === "punct" &&
      open.text in OPENERS &&
      close?.kind === "punct" &&
      close.text === OPENERS[open.text]?.close
    );
  }

  /** End offset of the single element that follows `n *`, if supported. */
  #elementEnd(index: number): { end: number; group: boolean } | undefined {
    const first = this.#tokens[index];
    if (first?.kind === "name" || first?.kind === "string") {
      return { end: first.end, group: false };
    }
    if (first?.kind !== "punct" || !(first.text in OPENERS)) {
      return undefined;
    }
    let depth = 0;
    for (let i = index; i < this.#tokens.length; i++) {
      const token = this.#tokens[i] as IsoToken;
      if (token.kind !== "punct") {
        continue;
      }
      if (token.text in OPENERS) {
        depth++;
      } else if (
        token.text === ")" ||
        token.text === "}" ||
        token.text === "]"
      ) {
        depth--;
        if (depth === 0) {
          return { end: token.end, group: true };
        }
      }
    }
    return undefined;
  }

  /**
   * Replaces each `n * x` by n copies of the converted element. Inner
   * repetitions are expanded first so outer copies include them.
   */
  #expandRepetitions(
    merged: OffsetEdit[] | undefined,
    repetitions: readonly Repetition[],
  ): OffsetEdit[] | undefined {
    if (!merged || repetitions.length === 0) {
      return merged;
    }
    let edits = merged;
    for (const rep of [...repetitions].sort((a, b) => b.start - a.start)) {
      const inside = edits.filter(
        (edit) => edit.start >= rep.elementStart && edit.end <= rep.elementEnd,
      );
      let converted = "";
      let cursor = rep.elementStart;
      for (const edit of inside) {
        converted += this.#text.slice(cursor, edit.start) + edit.text;
        cursor = edit.end;
      }
      converted += this.#text.slice(cursor, rep.elementEnd);
      const copies = Array.from({ length: rep.count }, () => converted).join(
        " ",
      );
      edits = [
        ...edits,
        {
          start: rep.start,
          end: rep.elementStart,
          text: rep.wrap && rep.count > 1 ? "(" : "",
        },
        {
          start: rep.elementEnd,
          end: rep.elementEnd,
          text: `${copies.slice(converted.length)}${rep.wrap && rep.count > 1 ? ")" : ""}`,
        },
      ].sort((a, b) => a.start - b.start || a.end - b.end);
    }
    return edits;
  }

  #statement(): void {
    const tokens = this.#tokens;
    const first = tokens[this.#index] as IsoToken;
    const edits: OffsetEdit[] = [];
    let reason: string | undefined;
    const fail = (why: string): void => {
      reason ??= why;
    };
    let end = first.end;
    const name = tokens[this.#index];
    const equals = tokens[this.#index + 1];
    if (
      name?.kind === "name" &&
      equals?.kind === "punct" &&
      equals.text === "="
    ) {
      edits.push({ start: equals.start, end: equals.end, text: "::=" });
      this.#index += 2;
    } else {
      fail("the production head is not a single-word name followed by =");
      this.#index += 1;
    }
    const stack: string[] = [];
    let term = false;
    let terminatorEnd = -1;
    const repetitions: Repetition[] = [];
    let previous: IsoToken | undefined = equals;
    let previousComma: OffsetEdit | undefined;
    while (this.#index < tokens.length) {
      const token = tokens[this.#index++] as IsoToken;
      end = token.end;
      const before = previous;
      if (token.kind !== "comment") {
        previous = token;
      }
      if (token.kind === "comment") {
        edits.push(...commentEdits(token));
      } else if (token.kind === "bad") {
        fail(token.reason ?? "unsupported syntax");
      } else if (token.kind === "number") {
        const star = tokens[this.#index];
        const count = Number(token.text);
        const element = this.#elementEnd(this.#index + 1);
        if (term) {
          fail("adjacent terms without a comma (multi-word names)");
        } else if (!(star?.kind === "punct" && star.text === "*")) {
          fail(`the number ${token.text} is not part of a repetition`);
        } else if (this.#isEmptyGroup(this.#index + 1)) {
          fail("empty group");
        } else if (count < 1 || count > MAX_REPETITION) {
          fail(
            `repetition count ${token.text} is not supported (use 1 to ${MAX_REPETITION})`,
          );
        } else if (element) {
          repetitions.push({
            start: token.start,
            elementStart: (tokens[this.#index + 1] as IsoToken).start,
            elementEnd: element.end,
            count,
            wrap: element.group,
          });
          this.#index++;
        } else {
          fail("repetition of an unsupported element");
        }
      } else if (token.kind === "name" || token.kind === "string") {
        if (term) {
          fail("adjacent terms without a comma (multi-word names)");
        }
        term = true;
      } else if (token.text === ";" || token.text === ".") {
        if (stack.length > 0) {
          fail("terminator inside a group");
        }
        edits.push(...this.#terminatorEdits(token));
        terminatorEnd = token.end;
        break;
      } else if (token.text === ",") {
        previousComma = this.#commaEdit(token);
        edits.push(previousComma);
        term = false;
      } else if (
        token.text === "|" ||
        token.text === "!" ||
        token.text === "/"
      ) {
        if (token.text !== "|") {
          edits.push({ start: token.start, end: token.end, text: "|" });
        }
        term = false;
      } else if (token.text in OPENERS) {
        const opener = OPENERS[token.text] as (typeof OPENERS)[string];
        if (term) {
          fail("group directly after a term without a comma");
        }
        const inner = tokens[this.#index];
        const close = tokens[this.#index + 1];
        if (inner?.kind === "punct" && inner.text === opener.close) {
          // An empty group matches only the empty string, so it is dropped
          // together with one adjacent comma. W3C EBNF has no empty group.
          const following = tokens[this.#index + 1];
          this.#index++;
          end = inner.end;
          previous = before;
          if (following?.kind === "punct" && following.text === ",") {
            this.#index++;
            let cut = following.end;
            while (isBlank(this.#text[cut])) {
              cut++;
            }
            edits.push({ start: token.start, end: cut, text: "" });
          } else if (
            before?.kind === "punct" &&
            before.text === "," &&
            previousComma
          ) {
            edits.splice(edits.indexOf(previousComma), 1);
            let cut = before.start;
            while (isBlank(this.#text[cut - 1])) {
              cut--;
            }
            edits.push({ start: cut, end: inner.end, text: "" });
            term = true;
          } else {
            fail("empty group");
          }
          continue;
        }
        if (
          (token.text === "{" || token.text === "[") &&
          (inner?.kind === "name" || inner?.kind === "string") &&
          close?.kind === "punct" &&
          close.text === opener.close
        ) {
          // `{ x }` and `[ x ]` around one term read better as `x*` and `x?`.
          const mark = token.text === "{" ? "*" : "?";
          edits.push({ start: token.start, end: inner.start, text: "" });
          edits.push({ start: inner.end, end: close.end, text: mark });
          this.#index += 2;
          end = close.end;
          term = true;
          continue;
        }
        stack.push(token.text);
        if (token.text !== "(") {
          edits.push({ start: token.start, end: token.end, text: opener.open });
        }
        term = false;
      } else if (
        token.text === ")" ||
        token.text === "}" ||
        token.text === "]"
      ) {
        const open = stack.pop();
        const opener = open ? OPENERS[open] : undefined;
        if (!opener || opener.close !== token.text) {
          fail(`unbalanced "${token.text}"`);
        } else if (token.text !== ")") {
          edits.push({
            start: token.start,
            end: token.end,
            text: opener.after,
          });
        }
        term = true;
      } else if (token.text === "-") {
        term = false;
      } else {
        fail(`"${token.text}" has no W3C equivalent`);
      }
    }
    const merged = reason
      ? undefined
      : this.#expandRepetitions(mergeEdits(edits), repetitions);
    for (const edit of merged ?? []) {
      // A deletion that ends at the terminator also takes the blanks before it.
      if (edit.text === "" && edit.end === terminatorEnd) {
        while (isBlank(this.#text[edit.start - 1])) {
          edit.start--;
        }
      }
    }
    if (!reason && !merged) {
      reason = "overlapping edits";
    }
    this.statements.push({
      start: first.start,
      end,
      convertible: !reason,
      ...(reason ? { reason } : {}),
      edits: reason ? [] : (merged ?? []),
    });
  }
}

/**
 * Sorts edits and unions overlapping deletions. Returns undefined when two
 * edits that insert text overlap.
 */
export function mergeEdits(
  edits: readonly OffsetEdit[],
): OffsetEdit[] | undefined {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: OffsetEdit[] = [];
  for (const edit of sorted) {
    const last = out[out.length - 1];
    if (last && edit.start < last.end) {
      if (last.text !== "" || edit.text !== "") {
        return undefined;
      }
      last.end = Math.max(last.end, edit.end);
    } else {
      out.push({ ...edit });
    }
  }
  return out;
}

/**
 * Splits `text[from, to)` into ISO productions at top-level terminators and
 * converts each independently. Productions that use anything W3C EBNF cannot
 * express are marked as not convertible and carry no edits.
 */
export function convertIsoText(
  text: string,
  from: number,
  to: number,
  eol = "\n",
): IsoStatement[] {
  return new Converter(text, lexIso(text, from, to), eol).run();
}

/** Why W3C EBNF cannot take this ISO comment, or undefined when it can. */
function commentRefusal(comment: string): string | undefined {
  const inner = comment.slice(2, -2);
  if (inner.includes("(*")) {
    return "nested comment (W3C comments do not nest)";
  }
  if (inner.includes("*/")) {
    return 'comment contains "*/"';
  }
  return undefined;
}

// ISO comments the scanner found outside the given ranges. The scanner has
// already skipped W3C strings, character classes and block comments, and
// matched nested comments. Comments that W3C cannot take (nested, or
// containing the block-comment terminator) get no edits and a refusal.
function looseComments(
  scan: ScanResult,
  covered: ReadonlyArray<{ start: number; end: number }>,
): IsoRun[] {
  const runs: IsoRun[] = [];
  let codeEndLine = -1;
  for (const token of scan.tokens) {
    if (!token.iso) {
      if (token.kind !== "comment") {
        codeEndLine = token.endLine;
      }
      continue;
    }
    if (covered.some((c) => token.start >= c.start && token.end <= c.end)) {
      continue;
    }
    const refusal = commentRefusal(token.text);
    runs.push({
      start: token.start,
      end: token.end,
      statements: [],
      looseEdits: refusal
        ? []
        : commentEdits({
            kind: "comment",
            text: "",
            start: token.start,
            end: token.end,
          }),
      ...(refusal ? { refusal } : {}),
      ...(codeEndLine === token.line ? { trailsCode: true as const } : {}),
    });
  }
  return runs;
}

/**
 * Finds every ISO production run in an EBNF document. ISO comments that sit
 * outside the runs are converted as well, and each one is reported as a run
 * of its own with no statements.
 */
export function collectIsoRuns(text: string, eol = "\n"): IsoRun[] {
  const scan = scanProductionGrammar(text, "ebnf");
  const runs: IsoRun[] = [];
  for (const stray of scan.strays) {
    const first = stray.tokens[0];
    const last = stray.tokens[stray.tokens.length - 1];
    if (stray.kind === "iso" && first && last) {
      runs.push({
        start: first.start,
        end: last.end,
        statements: convertIsoText(text, first.start, last.end, eol),
        looseEdits: [],
      });
    }
  }
  const comments = looseComments(scan, runs);
  return [...runs, ...comments];
}
