import { AbnfDiagnosticCode } from "./diagnostic-codes.ts";
import { isTriviaKind } from "./regions.ts";
import type { AbnfExpression, AbnfToken } from "./types.ts";
import { AbnfTokenKind } from "./types.ts";

/**
 * Severity of one rule-body issue.
 */
export type BodyIssueSeverity = "error" | "warning" | "hint";

/**
 * Problem found while parsing one rule body, anchored to a token span.
 */
export interface BodyIssue {
  message: string;
  severity: BodyIssueSeverity;
  start: AbnfToken;
  end: AbnfToken;
  code?: string;
}

/**
 * Rule reference found in a rule body.
 */
export interface BodyReference {
  name: string;
  token: AbnfToken;
}

/**
 * Result of parsing one rule body.
 */
export interface ParsedBody {
  expression: AbnfExpression;
  issues: BodyIssue[];
  references: BodyReference[];
}

const BASE_NAMES = { x: "hexadecimal", d: "decimal", b: "binary" } as const;
const BASE_RADIX = { x: 16, d: 10, b: 2 } as const;

function emptyExpression(): AbnfExpression {
  return { kind: "concatenation", elements: [] };
}

function isElementStart(token: AbnfToken): boolean {
  switch (token.kind) {
    case AbnfTokenKind.Rulename:
    case AbnfTokenKind.ParenOpen:
    case AbnfTokenKind.BracketOpen:
    case AbnfTokenKind.String:
    case AbnfTokenKind.CaseSensitiveString:
    case AbnfTokenKind.CaseInsensitiveString:
    case AbnfTokenKind.NumericValue:
    case AbnfTokenKind.ProseValue:
    case AbnfTokenKind.Integer:
    case AbnfTokenKind.Asterisk:
      return true;
    default:
      return false;
  }
}

function isTerminalStart(token: AbnfToken): boolean {
  return (
    isElementStart(token) &&
    token.kind !== AbnfTokenKind.Integer &&
    token.kind !== AbnfTokenKind.Asterisk
  );
}

function isAdjacent(first: AbnfToken, second: AbnfToken): boolean {
  return first.offset + first.text.length === second.offset;
}

/**
 * Returns the problem with a numeric value token, if any.
 */
function numericProblem(
  text: string,
): { message: string; code: string } | undefined {
  const base = text.charAt(1).toLowerCase() as "x" | "d" | "b";
  const body = text.slice(2);
  if (body.length === 0) {
    return {
      message: `Numeric value "${text}" has no digits`,
      code: AbnfDiagnosticCode.InvalidNumeric,
    };
  }
  if (body.endsWith("-")) {
    return {
      message: `Range "${text}" is missing its upper bound`,
      code: AbnfDiagnosticCode.RangeIncomplete,
    };
  }
  const dash = body.indexOf("-");
  if (dash >= 0) {
    const low = Number.parseInt(body.slice(0, dash), BASE_RADIX[base]);
    const high = Number.parseInt(body.slice(dash + 1), BASE_RADIX[base]);
    if (low > high) {
      return {
        message: `Range "${text}" has a lower bound greater than its upper bound`,
        code: AbnfDiagnosticCode.RangeOrder,
      };
    }
  }
  return undefined;
}

function hasCharOutside(
  value: string,
  allowed: (code: number) => boolean,
): boolean {
  for (const ch of value) {
    if (!allowed(ch.codePointAt(0) ?? 0)) {
      return true;
    }
  }
  return false;
}

function isPrintableAscii(code: number): boolean {
  return code >= 0x20 && code <= 0x7e;
}

/**
 * Parses the tokens of one rule body (after "=" or "=/") without any editor
 * dependency, so both diagnostics and the formatter can rely on it.
 */
export function parseRuleBody(tokens: readonly AbnfToken[]): ParsedBody {
  const parser = new BodyParser(tokens);
  const expression = parser.parse();
  return {
    expression,
    issues: parser.issues,
    references: parser.references,
  };
}

class BodyParser {
  readonly issues: BodyIssue[] = [];
  readonly references: BodyReference[] = [];
  readonly #tokens: readonly AbnfToken[];
  #pos = 0;

  constructor(tokens: readonly AbnfToken[]) {
    this.#tokens = tokens;
  }

  parse(): AbnfExpression {
    const expression = this.#parseAlternation();
    // Keep going after stray tokens so later references are still collected.
    while (true) {
      const stray = this.#peek();
      if (!stray) {
        break;
      }
      this.#consume();
      this.#reportStray(stray);
      this.#parseAlternation();
    }
    return expression;
  }

  #report(
    severity: BodyIssueSeverity,
    message: string,
    start: AbnfToken,
    end: AbnfToken = start,
    code?: string,
  ): void {
    this.issues.push(
      code === undefined
        ? { message, severity, start, end }
        : { message, severity, start, end, code },
    );
  }

  #reportStray(stray: AbnfToken): void {
    const previous = this.#tokens[this.#pos - 2];
    if (stray.kind === AbnfTokenKind.Unknown && stray.text === "%") {
      const next = this.#tokens[this.#pos];
      if (next && isAdjacent(stray, next)) {
        this.#pos++;
        this.#report(
          "error",
          `Invalid numeric value "%${next.text}": expected %b, %d, %x, %s"..." or %i"..."`,
          stray,
          next,
          AbnfDiagnosticCode.InvalidNumeric,
        );
        return;
      }
    }
    if (
      previous &&
      !isTriviaKind(previous.kind) &&
      isAdjacent(previous, stray) &&
      isElementStart(stray)
    ) {
      this.#report(
        "error",
        `Unexpected "${stray.text}": elements must be separated by whitespace`,
        stray,
        stray,
        AbnfDiagnosticCode.MissingSeparator,
      );
      return;
    }
    this.#report(
      "error",
      `Unexpected "${stray.text}"`,
      stray,
      stray,
      AbnfDiagnosticCode.UnexpectedToken,
    );
  }

  #peek(): AbnfToken | undefined {
    while (this.#pos < this.#tokens.length) {
      const t = this.#tokens[this.#pos];
      if (t === undefined) {
        break;
      }
      if (isTriviaKind(t.kind)) {
        this.#pos++;
        continue;
      }
      return t;
    }
    return undefined;
  }

  #consume(): AbnfToken | undefined {
    const t = this.#peek();
    if (t) {
      this.#pos++;
    }
    return t;
  }

  #parseAlternation(): AbnfExpression {
    const first = this.#parseConcatenation();
    const alternatives: AbnfExpression[] = [first];

    while (true) {
      const next = this.#peek();
      if (!next || next.kind !== AbnfTokenKind.Alternation) {
        break;
      }
      this.#consume();
      alternatives.push(this.#parseConcatenation());
    }

    if (alternatives.length === 1) {
      return alternatives[0] as AbnfExpression;
    }
    return { kind: "alternation", alternatives };
  }

  #parseConcatenation(): AbnfExpression {
    const elements: AbnfExpression[] = [];

    while (true) {
      const savedPos = this.#pos;
      const hadWhitespace = this.#skipTrivia();

      const next = this.#tokens[this.#pos];
      if (!(next && isElementStart(next))) {
        this.#pos = savedPos;
        break;
      }

      // Require whitespace between elements (after the first).
      if (elements.length > 0 && !hadWhitespace) {
        this.#pos = savedPos;
        break;
      }

      elements.push(this.#parseRepetition());
    }

    if (elements.length === 1) {
      return elements[0] as AbnfExpression;
    }
    return { kind: "concatenation", elements };
  }

  #skipTrivia(): boolean {
    let skipped = false;
    while (this.#pos < this.#tokens.length) {
      const raw = this.#tokens[this.#pos];
      if (raw === undefined || !isTriviaKind(raw.kind)) {
        break;
      }
      skipped = true;
      this.#pos++;
    }
    return skipped;
  }

  #parseRepetition(): AbnfExpression {
    const next = this.#peek();
    if (!next) {
      return emptyExpression();
    }
    if (next.kind !== AbnfTokenKind.Integer) {
      if (next.kind === AbnfTokenKind.Asterisk) {
        this.#consume();
        return this.#finishRepetition(next, null, next);
      }
      return this.#parseElement();
    }

    this.#consume();
    const min = Number.parseInt(next.text, 10);
    let spaced = this.#atTrivia();
    const star = this.#peek();
    if (star && star.kind === AbnfTokenKind.Asterisk) {
      this.#consume();
      return this.#finishRepetition(next, min, star, false, spaced);
    }
    spaced = this.#atTrivia() || spaced;
    return this.#finishRepetition(next, min, next, true, spaced);
  }

  #atTrivia(): boolean {
    const raw = this.#tokens[this.#pos];
    return raw !== undefined && isTriviaKind(raw.kind);
  }

  #finishRepetition(
    first: AbnfToken,
    min: number | null,
    last: AbnfToken,
    exact = false,
    spacedBefore = false,
  ): AbnfExpression {
    let end = last;
    let max: number | null = null;
    let spaced = spacedBefore;
    if (exact) {
      max = min;
    } else {
      spaced = this.#atTrivia() || spaced;
      const maxToken = this.#peek();
      if (maxToken && maxToken.kind === AbnfTokenKind.Integer) {
        this.#consume();
        max = Number.parseInt(maxToken.text, 10);
        end = maxToken;
      }
    }
    const lower = min ?? 0;
    this.#checkRepetitionBounds(first, end, lower, max, exact);

    spaced = this.#atTrivia() || spaced;
    const elementStart = this.#peek();
    if (!(elementStart && isTerminalStart(elementStart))) {
      this.#report(
        "error",
        "Repetition has no element to repeat",
        first,
        end,
        AbnfDiagnosticCode.RepetitionNoElement,
      );
      return {
        kind: "repetition",
        min: lower,
        max,
        element: emptyExpression(),
      };
    }
    if (spaced) {
      this.#report(
        "error",
        'Whitespace is not allowed inside a repetition: write it as one unit, such as 3*"x"',
        first,
        end,
        AbnfDiagnosticCode.RepetitionWhitespace,
      );
    }
    return {
      kind: "repetition",
      min: lower,
      max,
      element: this.#parseElement(),
    };
  }

  #checkRepetitionBounds(
    first: AbnfToken,
    end: AbnfToken,
    min: number,
    max: number | null,
    exact: boolean,
  ): void {
    if (max !== null && min > max) {
      this.#report(
        "error",
        `Repetition minimum ${min} is greater than its maximum ${max}`,
        first,
        end,
        AbnfDiagnosticCode.RepetitionBounds,
      );
    } else if (max === 1 && min === 1 && !exact) {
      this.#report(
        "hint",
        "Repetition 1*1 is the same as the element itself",
        first,
        end,
        AbnfDiagnosticCode.RepetitionRedundant,
      );
    } else if (max === 0) {
      this.#report(
        "hint",
        "Repetition of zero times never matches the element",
        first,
        end,
        AbnfDiagnosticCode.RepetitionRedundant,
      );
    }
  }

  /** RFC 5234 groups and options need an alternation inside. */
  #checkEmptyGroup(
    open: AbnfToken,
    closeKind: AbnfTokenKind,
    name: string,
  ): void {
    const closing = this.#peek();
    if (closing && closing.kind === closeKind) {
      this.#report(
        "error",
        `Empty ${name}: "${open.text}${closing.text}" has nothing inside`,
        open,
        closing,
        AbnfDiagnosticCode.EmptyGroup,
      );
    }
  }

  #closeGroup(
    open: AbnfToken,
    closeKind: AbnfTokenKind,
    label: string,
    code: string,
  ): void {
    const closing = this.#peek();
    if (!closing || closing.kind !== closeKind) {
      this.#report("error", label, open, open, code);
    } else {
      this.#consume();
    }
  }

  #parseElement(): AbnfExpression {
    const token = this.#peek();
    if (!token) {
      return emptyExpression();
    }
    this.#consume();

    switch (token.kind) {
      case AbnfTokenKind.ParenOpen: {
        this.#checkEmptyGroup(token, AbnfTokenKind.ParenClose, "group");
        const inner = this.#parseAlternation();
        this.#closeGroup(
          token,
          AbnfTokenKind.ParenClose,
          `Group opened with "(" has no closing ")"`,
          AbnfDiagnosticCode.UnclosedGroup,
        );
        return { kind: "group", expression: inner };
      }
      case AbnfTokenKind.BracketOpen: {
        this.#checkEmptyGroup(token, AbnfTokenKind.BracketClose, "option");
        const inner = this.#parseAlternation();
        this.#closeGroup(
          token,
          AbnfTokenKind.BracketClose,
          `Optional group opened with "[" has no closing "]"`,
          AbnfDiagnosticCode.UnclosedOption,
        );
        return { kind: "optional", expression: inner };
      }
      case AbnfTokenKind.Rulename:
        this.references.push({ name: token.text, token });
        return { kind: "rulename", name: token.text, token };
      case AbnfTokenKind.String:
        return this.#stringElement(token, 1, false);
      case AbnfTokenKind.CaseInsensitiveString:
        return this.#stringElement(token, 3, false);
      case AbnfTokenKind.CaseSensitiveString:
        return this.#stringElement(token, 3, true);
      case AbnfTokenKind.NumericValue:
        return this.#numericElement(token);
      case AbnfTokenKind.ProseValue:
        return this.#proseElement(token);
      default:
        return emptyExpression();
    }
  }

  #stringElement(
    token: AbnfToken,
    openLength: number,
    caseSensitive: boolean,
  ): AbnfExpression {
    const terminated =
      token.text.length > openLength && token.text.endsWith('"');
    const value = token.text.slice(openLength, terminated ? -1 : undefined);
    if (!terminated) {
      this.#report(
        "error",
        "Unterminated string: missing closing '\"'",
        token,
        token,
        AbnfDiagnosticCode.UnterminatedString,
      );
    }
    if (hasCharOutside(value, isPrintableAscii)) {
      this.#report(
        "warning",
        "String contains characters outside printable ASCII (%x20-21 / %x23-7E)",
        token,
        token,
        AbnfDiagnosticCode.NonAsciiString,
      );
    }
    return { kind: "string", value, caseSensitive };
  }

  #proseElement(token: AbnfToken): AbnfExpression {
    const terminated = token.text.length > 1 && token.text.endsWith(">");
    const text = token.text.slice(1, terminated ? -1 : undefined);
    if (!terminated) {
      this.#report(
        "error",
        "Unterminated prose value: missing closing '>'",
        token,
        token,
        AbnfDiagnosticCode.UnterminatedProse,
      );
    }
    if (hasCharOutside(text, isPrintableAscii)) {
      this.#report(
        "warning",
        "Prose value contains characters outside printable ASCII (%x20-3D / %x3F-7E)",
        token,
        token,
        AbnfDiagnosticCode.NonAsciiProse,
      );
    }
    return { kind: "prose", text };
  }

  /**
   * Reports one error for junk glued to a numeric value (`%x41..42`,
   * `%x41-42.43`) and consumes it. Returns true when it reported.
   */
  #reportNumericTail(token: AbnfToken): boolean {
    let last = token;
    let tail = "";
    while (true) {
      const raw = this.#tokens[this.#pos];
      if (
        !(raw && isAdjacent(last, raw)) ||
        !(
          (raw.kind === AbnfTokenKind.Unknown &&
            (raw.text === "." || raw.text === "-")) ||
          (tail !== "" &&
            (raw.kind === AbnfTokenKind.Integer ||
              raw.kind === AbnfTokenKind.Rulename))
        )
      ) {
        break;
      }
      tail += raw.text;
      last = raw;
      this.#pos++;
    }
    if (last === token) {
      return false;
    }
    const whole = `${token.text}${tail}`;
    let message: string;
    if (tail.startsWith("-") && token.text.includes("-")) {
      message = `Invalid numeric value "${whole}": a range takes exactly one "-"`;
    } else if (token.text.includes("-")) {
      message = `Invalid numeric value "${whole}": a range cannot be combined with "." concatenation`;
    } else {
      message = `Invalid numeric value "${whole}": expected "." followed by digits between values`;
    }
    this.#report(
      "error",
      message,
      token,
      last,
      AbnfDiagnosticCode.InvalidNumeric,
    );
    return true;
  }

  #numericElement(token: AbnfToken): AbnfExpression {
    const base = token.text.charAt(1).toLowerCase() as "d" | "x" | "b";
    const baseName = BASE_NAMES[base];
    const raw = this.#tokens[this.#pos];
    if (
      raw &&
      isAdjacent(token, raw) &&
      (raw.kind === AbnfTokenKind.Rulename ||
        raw.kind === AbnfTokenKind.Integer)
    ) {
      this.#pos++;
      this.#report(
        "error",
        `Invalid ${baseName} digit in numeric value "${token.text}${raw.text}"`,
        token,
        raw,
        AbnfDiagnosticCode.InvalidNumeric,
      );
    } else if (!this.#reportNumericTail(token)) {
      const problem = numericProblem(token.text);
      if (problem) {
        this.#report("error", problem.message, token, token, problem.code);
      }
    }
    return { kind: "numeric", base, text: token.text.slice(2) };
  }
}
