import type { AbnfExpression } from "../../abnf/types.ts";
import type { GrammarDialect } from "../dialects.ts";
import {
  lexProductionGrammar,
  type ProductionDialect,
  type ScanToken,
} from "../scanner.ts";
import {
  choiceOf,
  EMPTY_NODE,
  optionalOf,
  type RailNode,
  repeatOf,
  seqOf,
  type TerminalKind,
} from "./model.ts";

/** Nesting level after which groups are flattened and a note is shown. */
export const MAX_NESTING = 100;

/**
 * Result of building one rule body.
 */
export interface BuiltBody {
  node: RailNode;
  /** True when the body is incomplete or malformed. */
  broken: boolean;
}

const TOO_DEEP: RailNode = {
  kind: "terminal",
  terminal: "note",
  text: "…",
  title: `Nesting deeper than ${MAX_NESTING} levels is flattened`,
};

const RADIX = { x: 16, d: 10, b: 2 } as const;
const MAX_CODE_POINT = 0x10ffff;

function codePointLabel(value: number): string {
  return `U+${value.toString(16).toUpperCase().padStart(4, "0")}`;
}

function numericTitle(base: "x" | "d" | "b", text: string): string | undefined {
  const parts = text.split("-");
  if (parts.length > 2 || text.includes(".")) {
    return undefined;
  }
  const values = parts.map((part) => Number.parseInt(part, RADIX[base]));
  if (values.some((v) => Number.isNaN(v) || v > MAX_CODE_POINT || v < 0)) {
    return undefined;
  }
  return values.map(codePointLabel).join(" – ");
}

function fromAbnf(expression: AbnfExpression, depth: number): RailNode {
  if (depth > MAX_NESTING) {
    return TOO_DEEP;
  }
  switch (expression.kind) {
    case "alternation":
      return choiceOf(
        expression.alternatives.map((alt) => fromAbnf(alt, depth + 1)),
      );
    case "concatenation":
      return seqOf(
        expression.elements.map((element) => fromAbnf(element, depth + 1)),
      );
    case "repetition":
      return repeatOf(
        fromAbnf(expression.element, depth + 1),
        expression.min,
        expression.max,
      );
    case "group":
      return fromAbnf(expression.expression, depth + 1);
    case "optional":
      return optionalOf(fromAbnf(expression.expression, depth + 1));
    case "rulename":
      return { kind: "nonterminal", name: expression.name };
    case "string":
      return expression.caseSensitive
        ? {
            kind: "terminal",
            terminal: "string-sensitive",
            text: `%s"${expression.value}"`,
            title: "Case-sensitive string (%s)",
          }
        : {
            kind: "terminal",
            terminal: "string",
            text: `"${expression.value}"`,
            title: "Case-insensitive string",
          };
    case "numeric": {
      const isRange = expression.text.includes("-");
      const title = numericTitle(expression.base, expression.text);
      return {
        kind: "terminal",
        terminal: isRange ? "range" : "numeric",
        text: `%${expression.base}${expression.text}`,
        ...(title === undefined ? {} : { title }),
      };
    }
    case "prose":
      return {
        kind: "terminal",
        terminal: "prose",
        text: `<${expression.text}>`,
        title: "Prose description",
      };
    default:
      return EMPTY_NODE;
  }
}

/**
 * Builds the railroad node of a parsed ABNF rule body. `undefined` means the
 * parser kept no expression for the rule.
 */
export function buildAbnfBody(
  expression: AbnfExpression | undefined,
): BuiltBody {
  if (!expression) {
    return { node: EMPTY_NODE, broken: true };
  }
  return { node: fromAbnf(expression, 0), broken: false };
}

interface Frame {
  open: string;
  branches: RailNode[];
  items: RailNode[];
  /** True right after `-`: the next operand is the excluded one. */
  excluding: boolean;
  /** True while the last item is an exclusion built from the last operand. */
  exceptTail: boolean;
}

const CLOSER_FOR: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

function closeFrame(frame: Frame): RailNode {
  const inner = choiceOf([...frame.branches, seqOf(frame.items)]);
  switch (frame.open) {
    case "[":
      return optionalOf(inner);
    case "{":
      return repeatOf(inner, 0, null);
    default:
      return inner;
  }
}

function applyRepeat(node: RailNode, suffix: string): RailNode {
  if (suffix === "?") {
    return optionalOf(node);
  }
  return repeatOf(node, suffix === "*" ? 0 : 1, null);
}

function terminalFor(token: ScanToken): RailNode {
  const kinds: Partial<Record<ScanToken["kind"], TerminalKind>> = {
    string: "string",
    charClass: "class",
    charCode: "charcode",
    punct: "punct",
    name: "word",
  };
  const terminal = kinds[token.kind] ?? "punct";
  return {
    kind: "terminal",
    terminal,
    text: token.text,
    ...(terminal === "class" ? { title: "Character class" } : {}),
    ...(terminal === "charcode" ? { title: "Character code" } : {}),
  };
}

/**
 * Builds the railroad node of a BNF, EBNF, or RBNF rule body from its text
 * (comments already removed). Iterative, so nesting depth cannot overflow
 * the stack.
 */
export function buildProductionBody(
  body: string,
  dialect: GrammarDialect,
): BuiltBody {
  const tokens = lexProductionGrammar(body, dialect as ProductionDialect);
  let broken = false;
  let overflow = 0;
  const stack: Frame[] = [
    { open: "", branches: [], items: [], excluding: false, exceptTail: false },
  ];
  const top = (): Frame => stack[stack.length - 1] as Frame;
  const add = (node: RailNode): void => {
    const frame = top();
    if (frame.excluding) {
      frame.excluding = false;
      const base = frame.items.pop();
      if (base) {
        frame.items.push({ kind: "except", base, excluded: node });
        frame.exceptTail = true;
        return;
      }
      broken = true;
    }
    frame.exceptTail = false;
    frame.items.push(node);
  };
  for (const token of tokens) {
    switch (token.kind) {
      case "annotation":
      case "comment":
      case "productionNumber":
        break;
      case "alternative":
        if (top().excluding) {
          broken = true;
          top().excluding = false;
        }
        top().branches.push(seqOf(top().items));
        top().items = [];
        break;
      case "exclusion":
        if (top().excluding || top().items.length === 0) {
          broken = true;
        } else {
          top().excluding = true;
        }
        break;
      case "repeat": {
        const frame = top();
        const last = frame.items.pop();
        if (!last) {
          broken = true;
        } else if (frame.exceptTail && last.kind === "except") {
          // Postfix binds tighter than "-": it applies to the excluded operand.
          frame.items.push({
            ...last,
            excluded: applyRepeat(last.excluded, token.text),
          });
        } else {
          frame.items.push(applyRepeat(last, token.text));
        }
        break;
      }
      case "group": {
        if (token.text in CLOSER_FOR) {
          if (stack.length >= MAX_NESTING) {
            if (overflow === 0) {
              top().items.push(TOO_DEEP);
            }
            broken = true;
            overflow++;
            break;
          }
          stack.push({
            open: token.text,
            branches: [],
            items: [],
            excluding: false,
            exceptTail: false,
          });
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
        if (frame.excluding) {
          broken = true;
        }
        if (CLOSER_FOR[frame.open] !== token.text) {
          broken = true;
        }
        add(closeFrame(frame));
        break;
      }
      case "string":
        if (token.unterminated) {
          broken = true;
        }
        add(terminalFor(token));
        break;
      case "name":
        add(
          dialect === "rbnf"
            ? terminalFor(token)
            : { kind: "nonterminal", name: token.text },
        );
        break;
      case "angleName":
        add({ kind: "nonterminal", name: token.text });
        break;
      case "assignment":
        broken = true;
        add({ kind: "error", text: token.text });
        break;
      case "punct":
        if (token.text !== "," && token.text !== ";") {
          add(terminalFor(token));
        }
        break;
      default:
        add(terminalFor(token));
    }
  }
  while (stack.length > 1) {
    broken = true;
    const frame = stack.pop() as Frame;
    add(closeFrame(frame));
  }
  return {
    node: closeFrame(top()),
    broken: broken || stack.some((f) => f.excluding),
  };
}
