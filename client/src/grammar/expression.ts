import { Range } from "vscode";
import { ruleExpressions } from "../abnf/parser.ts";
import { isTriviaKind } from "../abnf/regions.ts";
import { tokenizeDocument } from "../abnf/tokenizer.ts";
import { type AbnfExpression, AbnfTokenKind } from "../abnf/types.ts";
import type { Rule } from "../types.ts";
import type { GrammarDialect } from "./dialects.ts";
import type { ScanToken } from "./scanner.ts";
import { normalizeSymbolName } from "./symbol-table.ts";

/**
 * Dialect-neutral rule body used by the graph analyses. Only the structure
 * that matters for derivation is kept.
 */
export type Expr =
  | { kind: "empty" }
  | { kind: "term" }
  | { kind: "ref"; key: string }
  | { kind: "seq"; items: Expr[] }
  | { kind: "alt"; branches: Expr[] }
  | { kind: "repeat"; min: 0 | 1; item: Expr };

const EMPTY: Expr = { kind: "empty" };
const TERM: Expr = { kind: "term" };
const MAX_DEPTH = 400;

/**
 * Expression of one rule; `broken` bodies are treated as opaque terminals so
 * a syntax error never yields a derivation finding.
 */
export interface RuleBody {
  expr: Expr;
  broken: boolean;
}

function seqOf(items: Expr[]): Expr {
  if (items.length === 0) {
    return EMPTY;
  }
  return items.length === 1 ? (items[0] as Expr) : { kind: "seq", items };
}

function altOf(branches: Expr[]): Expr {
  return branches.length === 1
    ? (branches[0] as Expr)
    : { kind: "alt", branches };
}

interface Frame {
  open: string;
  discard: boolean;
  branches: Expr[];
  items: Expr[];
}

const CLOSER_FOR: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/**
 * Builds the expression of a BNF, EBNF, or RBNF rule body from its scanner
 * tokens. Iterative, so deeply nested input cannot overflow the stack.
 */
export function parseProductionBody(
  tokens: readonly ScanToken[],
  dialect: GrammarDialect,
): RuleBody {
  let broken = false;
  let overflow = 0;
  let skipNext = false;
  let ignoreRepeat = false;
  const stack: Frame[] = [
    { open: "", discard: false, branches: [], items: [] },
  ];
  const top = (): Frame => stack[stack.length - 1] as Frame;
  const finish = (frame: Frame): Expr =>
    altOf([...frame.branches, seqOf(frame.items)]);
  const add = (expr: Expr): void => {
    if (skipNext) {
      skipNext = false;
      ignoreRepeat = true;
      return;
    }
    top().items.push(expr);
  };
  for (const token of tokens) {
    if (token.kind !== "repeat") {
      ignoreRepeat = token.kind === "exclusion" ? ignoreRepeat : false;
    }
    switch (token.kind) {
      case "annotation":
      case "comment":
        break;
      case "alternative":
        top().branches.push(seqOf(top().items));
        top().items = [];
        break;
      case "exclusion":
        skipNext = true;
        break;
      case "repeat": {
        const frame = top();
        const last = frame.items[frame.items.length - 1];
        if (ignoreRepeat) {
          break;
        }
        if (!last) {
          broken = true;
        } else if (token.text === "?" || token.text === "*") {
          frame.items[frame.items.length - 1] = {
            kind: "repeat",
            min: 0,
            item: last,
          };
        } else {
          frame.items[frame.items.length - 1] = {
            kind: "repeat",
            min: 1,
            item: last,
          };
        }
        break;
      }
      case "group": {
        if (token.text in CLOSER_FOR) {
          if (stack.length >= MAX_DEPTH) {
            broken = true;
            overflow++;
            break;
          }
          stack.push({
            open: token.text,
            discard: skipNext,
            branches: [],
            items: [],
          });
          skipNext = false;
          break;
        }
        if (overflow > 0) {
          overflow--;
          break;
        }
        if (stack.length === 1) {
          broken = true;
          break;
        }
        const frame = stack.pop() as Frame;
        if (CLOSER_FOR[frame.open] !== token.text) {
          broken = true;
        }
        if (frame.discard) {
          ignoreRepeat = true;
          break;
        }
        const inner = finish(frame);
        top().items.push(
          frame.open === "(" ? inner : { kind: "repeat", min: 0, item: inner },
        );
        break;
      }
      case "string":
        if (token.unterminated) {
          broken = true;
        }
        add(token.text.length <= 2 ? EMPTY : TERM);
        break;
      case "name":
        add(
          dialect === "rbnf"
            ? TERM
            : { kind: "ref", key: normalizeSymbolName(token.text, dialect) },
        );
        break;
      case "angleName":
        add({ kind: "ref", key: normalizeSymbolName(token.text, dialect) });
        break;
      case "assignment":
        broken = true;
        break;
      case "punct":
        if (token.text !== "," && token.text !== ";") {
          add(TERM);
        }
        break;
      default:
        add(TERM);
    }
  }
  while (stack.length > 1) {
    broken = true;
    const frame = stack.pop() as Frame;
    if (!frame.discard) {
      top().items.push(finish(frame));
    }
  }
  return { expr: finish(top()), broken };
}

function fromAbnf(expression: AbnfExpression, depth: number): Expr {
  if (depth > MAX_DEPTH) {
    return TERM;
  }
  switch (expression.kind) {
    case "alternation":
      return altOf(
        expression.alternatives.map((alt) => fromAbnf(alt, depth + 1)),
      );
    case "concatenation":
      return seqOf(
        expression.elements.map((element) => fromAbnf(element, depth + 1)),
      );
    case "repetition": {
      if (expression.max === 0) {
        return EMPTY;
      }
      const item = fromAbnf(expression.element, depth + 1);
      return { kind: "repeat", min: expression.min === 0 ? 0 : 1, item };
    }
    case "group":
      return fromAbnf(expression.expression, depth + 1);
    case "optional":
      return {
        kind: "repeat",
        min: 0,
        item: fromAbnf(expression.expression, depth + 1),
      };
    case "rulename":
      return { kind: "ref", key: expression.name.toLowerCase() };
    case "string":
      return expression.value === "" ? EMPTY : TERM;
    default:
      return TERM;
  }
}

/**
 * Expression of an ABNF rule produced by the ABNF parser, if known.
 */
export function abnfRuleBody(rule: Rule): RuleBody {
  const expression = ruleExpressions.get(rule);
  return expression
    ? { expr: fromAbnf(expression, 0), broken: false }
    : { expr: TERM, broken: true };
}

/**
 * Token view used to find alternation groups in any dialect.
 */
export interface BodyToken {
  key: string;
  role: "open" | "close" | "alt" | "other";
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

/**
 * One alternative of a choice.
 */
export interface AltBranch {
  /** Canonical text; equal keys are duplicate alternatives. */
  key: string;
  /** Highlight range; the separator next to it when the branch is empty. */
  range: Range;
  empty: boolean;
}

function tokenRange(token: BodyToken): Range {
  return new Range(token.line, token.column, token.endLine, token.endColumn);
}

interface PendingBranch {
  from: number;
  to: number;
  separator: number;
}

interface AltFrame {
  start: number;
  separator: number;
  branches: PendingBranch[];
}

function materialize(
  tokens: readonly BodyToken[],
  branches: readonly PendingBranch[],
): AltBranch[] {
  return branches.map((branch, index) => {
    const empty = branch.from === branch.to;
    const first = tokens[branch.from];
    const last = tokens[branch.to - 1];
    const separatorToken =
      branch.separator >= 0
        ? tokens[branch.separator]
        : tokens[branches[index + 1]?.separator ?? -1];
    const range =
      !empty && first && last
        ? new Range(first.line, first.column, last.endLine, last.endColumn)
        : tokenRange(separatorToken ?? (first as BodyToken));
    const key = tokens
      .slice(branch.from, branch.to)
      .map((token) => token.key)
      .join(" ");
    return { key, range, empty };
  });
}

/**
 * Alternatives of one rule body: the top-level choice, plus every nested
 * choice with two or more alternatives, in source order.
 */
export interface AltAnalysis {
  /** Top-level alternatives; empty for an empty body. */
  top: AltBranch[];
  /** Choices nested in groups that have at least two alternatives. */
  groups: AltBranch[][];
}

/**
 * Finds the top-level choice and every nested choice of a rule body.
 */
export function findAltGroups(tokens: readonly BodyToken[]): AltAnalysis {
  const groups: AltBranch[][] = [];
  let top: AltBranch[] = [];
  const stack: AltFrame[] = [{ start: 0, separator: -1, branches: [] }];
  const close = (frame: AltFrame, end: number, isRoot: boolean): void => {
    frame.branches.push({
      from: frame.start,
      to: end,
      separator: frame.separator,
    });
    if (frame.branches.length > 1) {
      const branches = materialize(tokens, frame.branches);
      if (isRoot) {
        top = branches;
      } else {
        groups.push(branches);
      }
    } else if (isRoot && end > frame.start) {
      top = materialize(tokens, frame.branches);
    }
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as BodyToken;
    const frame = stack[stack.length - 1] as AltFrame;
    if (token.role === "open") {
      stack.push({ start: i + 1, separator: -1, branches: [] });
    } else if (token.role === "alt") {
      frame.branches.push({
        from: frame.start,
        to: i,
        separator: frame.separator,
      });
      frame.start = i + 1;
      frame.separator = i;
    } else if (token.role === "close" && stack.length > 1) {
      stack.pop();
      close(frame, i, false);
    }
  }
  while (stack.length > 0) {
    close(stack.pop() as AltFrame, tokens.length, stack.length === 0);
  }
  return { top, groups };
}

const ANGLE_SPACE_RE = /\s+/g;

/**
 * Body tokens of a production-grammar rule for alternation analysis.
 */
export function productionBodyTokens(
  tokens: readonly ScanToken[],
): BodyToken[] {
  const out: BodyToken[] = [];
  for (const token of tokens) {
    if (token.kind === "annotation" || token.kind === "comment") {
      continue;
    }
    let role: BodyToken["role"] = "other";
    if (token.kind === "alternative") {
      role = "alt";
    } else if (token.kind === "group") {
      role = token.text in CLOSER_FOR ? "open" : "close";
    }
    out.push({
      key:
        token.kind === "angleName"
          ? token.text.replace(ANGLE_SPACE_RE, " ")
          : token.text,
      role,
      line: token.line,
      column: token.column,
      endLine: token.endLine,
      endColumn: token.endColumn,
    });
  }
  return out;
}

/**
 * Body tokens of every ABNF rule, in rule order, split by the line where each
 * rule starts. Tokens before the assignment operator are dropped.
 */
export function abnfBodyTokens(
  text: string,
  ruleStartLines: readonly number[],
): BodyToken[][] {
  const bodies: BodyToken[][] = ruleStartLines.map(() => []);
  const started: boolean[] = ruleStartLines.map(() => false);
  let ruleIndex = -1;
  for (const token of tokenizeDocument(text)) {
    while (
      ruleIndex + 1 < ruleStartLines.length &&
      (ruleStartLines[ruleIndex + 1] as number) <= token.line
    ) {
      ruleIndex++;
    }
    if (ruleIndex < 0 || isTriviaKind(token.kind)) {
      continue;
    }
    if (!started[ruleIndex]) {
      started[ruleIndex] =
        token.kind === AbnfTokenKind.DefinedAs ||
        token.kind === AbnfTokenKind.IncrementalAs;
      continue;
    }
    let role: BodyToken["role"] = "other";
    let key = token.text;
    switch (token.kind) {
      case AbnfTokenKind.Alternation:
        role = "alt";
        break;
      case AbnfTokenKind.ParenOpen:
      case AbnfTokenKind.BracketOpen:
        role = "open";
        break;
      case AbnfTokenKind.ParenClose:
      case AbnfTokenKind.BracketClose:
        role = "close";
        break;
      case AbnfTokenKind.CaseSensitiveString:
        break;
      case AbnfTokenKind.CaseInsensitiveString:
        // %i"abc" is the same string as "abc".
        key = token.text.slice(2).toLowerCase();
        break;
      default:
        key = token.text.toLowerCase();
    }
    bodies[ruleIndex]?.push({
      key,
      role,
      line: token.line,
      column: token.column,
      endLine: token.line,
      endColumn: token.column + token.text.length,
    });
  }
  return bodies;
}
