import { parseAbnf, ruleExpressions } from "../../abnf/parser.ts";
import type { AbnfExpression } from "../../abnf/types.ts";
import type { GrammarDialect } from "../../grammar/dialects.ts";
import {
  type ProductionDialect,
  type ScanToken,
  scanProductionGrammar,
} from "../../grammar/scanner.ts";

/**
 * Independent reference for what a grammar means. It reads grammar text with
 * the extension's lexers and a small evaluator written for the tests, and
 * shares no code with the dialect converter.
 */

export type Lang = Set<string>;

type Node =
  | { t: "lit"; value: string; fold: boolean }
  | { t: "set"; chars: ReadonlySet<number>; negate: boolean }
  | { t: "ref"; key: string }
  | { t: "seq"; items: Node[] }
  | { t: "alt"; items: Node[] }
  | { t: "rep"; min: number; max: number | null; item: Node }
  | { t: "minus"; left: Node; right: Node }
  | { t: "none" };

interface Options {
  alphabet: ReadonlySet<string>;
  maxLength: number;
}

const RADIX = { x: 16, d: 10, b: 2 } as const;
const HEX2_RE = /^x([0-9A-Fa-f]{2})/;
const FIXPOINT_ROUNDS = 12;

function cp(base: "x" | "d" | "b", digits: string): number {
  return Number.parseInt(digits, RADIX[base]);
}

function abnfNode(expr: AbnfExpression): Node {
  switch (expr.kind) {
    case "alternation":
      return { t: "alt", items: expr.alternatives.map(abnfNode) };
    case "concatenation":
      return { t: "seq", items: expr.elements.map(abnfNode) };
    case "repetition":
      return {
        t: "rep",
        min: expr.min,
        max: expr.max,
        item: abnfNode(expr.element),
      };
    case "group":
      return abnfNode(expr.expression);
    case "optional":
      return { t: "rep", min: 0, max: 1, item: abnfNode(expr.expression) };
    case "rulename":
      return { t: "ref", key: expr.name.toLowerCase() };
    case "string":
      return { t: "lit", value: expr.value, fold: !expr.caseSensitive };
    case "numeric": {
      const dash = expr.text.indexOf("-");
      if (dash >= 0) {
        const lo = cp(expr.base, expr.text.slice(0, dash));
        const hi = cp(expr.base, expr.text.slice(dash + 1));
        const chars = new Set<number>();
        for (let c = lo; c <= hi && c < 0x200; c++) {
          chars.add(c);
        }
        return { t: "set", chars, negate: false };
      }
      const value = String.fromCodePoint(
        ...expr.text.split(".").map((part) => cp(expr.base, part)),
      );
      return { t: "lit", value, fold: false };
    }
    case "prose":
      return { t: "none" };
  }
}

function unescapeString(inner: string): string {
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i] as string;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = inner[i + 1] ?? "";
    const hex = HEX2_RE.exec(inner.slice(i + 1, i + 4));
    if (hex) {
      out += String.fromCharCode(Number.parseInt(hex[1] as string, 16));
      i += 3;
    } else {
      out += { n: "\n", r: "\r", t: "\t" }[next] ?? next;
      i++;
    }
  }
  return out;
}

function classNode(text: string): Node {
  const inner = text.slice(1, -1);
  const negate = inner.startsWith("^");
  const body = negate ? inner.slice(1) : inner;
  // each item is a code point; a dash between two items makes a range
  const items: Array<number | "-"> = [];
  for (let i = 0; i < body.length; ) {
    if (body.startsWith("#x", i)) {
      const digits = /^[0-9A-Fa-f]+/.exec(body.slice(i + 2))?.[0] ?? "";
      items.push(Number.parseInt(digits, 16));
      i += 2 + digits.length;
    } else if (body[i] === "-") {
      items.push("-");
      i++;
    } else {
      items.push(body.codePointAt(i) as number);
      i++;
    }
  }
  const chars = new Set<number>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as number | "-";
    const lo = item === "-" ? 45 : item; // a leading or trailing dash is literal
    if (
      item !== "-" &&
      items[i + 1] === "-" &&
      typeof items[i + 2] === "number"
    ) {
      for (let c = lo; c <= (items[i + 2] as number); c++) {
        chars.add(c);
      }
      i += 2;
    } else {
      chars.add(lo);
    }
  }
  return { t: "set", chars, negate };
}

class ProductionParser {
  #pos = 0;
  readonly #tokens: ScanToken[];
  readonly #dialect: ProductionDialect;

  constructor(tokens: ScanToken[], dialect: ProductionDialect) {
    this.#tokens = tokens;
    this.#dialect = dialect;
  }

  parse(): Node {
    return this.#alternatives();
  }

  #peek(): ScanToken | undefined {
    return this.#tokens[this.#pos];
  }

  #alternatives(): Node {
    const items = [this.#sequence()];
    while (this.#peek()?.kind === "alternative") {
      this.#pos++;
      items.push(this.#sequence());
    }
    return items.length === 1 ? (items[0] as Node) : { t: "alt", items };
  }

  #sequence(): Node {
    const items: Node[] = [];
    for (;;) {
      const token = this.#peek();
      if (
        !token ||
        token.kind === "alternative" ||
        (token.kind === "group" && ")]}".includes(token.text))
      ) {
        return { t: "seq", items };
      }
      items.push(this.#minus());
    }
  }

  #minus(): Node {
    let left = this.#counted();
    while (this.#peek()?.kind === "exclusion") {
      this.#pos++;
      left = { t: "minus", left, right: this.#counted() };
    }
    return left;
  }

  /** RBNF `n*m` prefixes. */
  #counted(): Node {
    const number = (token: ScanToken | undefined): boolean =>
      token?.kind === "punct" && /^[0-9]+$/.test(token.text);
    if (this.#dialect === "rbnf") {
      const first = this.#peek();
      if (number(first) || (first?.kind === "repeat" && first.text === "*")) {
        let min = 0;
        let max: number | null = null;
        let star = false;
        if (number(first)) {
          min = Number(first?.text);
          this.#pos++;
        }
        if (this.#peek()?.text === "*") {
          star = true;
          this.#pos++;
          if (number(this.#peek())) {
            max = Number(this.#peek()?.text);
            this.#pos++;
          }
        } else {
          max = min;
        }
        return { t: "rep", min, max: star ? max : min, item: this.#postfix() };
      }
    }
    return this.#postfix();
  }

  #postfix(): Node {
    let node = this.#primary();
    for (;;) {
      const token = this.#peek();
      if (token?.kind !== "repeat") {
        return node;
      }
      if (
        this.#dialect === "rbnf" &&
        token.text === "*" &&
        this.#startsOperand(this.#tokens[this.#pos + 1])
      ) {
        // in RBNF a "*" before an operand starts the next item's prefix
        return node;
      }
      this.#pos++;
      if (token.text === "?") {
        node = { t: "rep", min: 0, max: 1, item: node };
      } else if (token.text === "+") {
        node = { t: "rep", min: 1, max: null, item: node };
      } else if (token.text === "*") {
        node = { t: "rep", min: 0, max: null, item: node };
      } else {
        // RBNF "..." repeats the operand one or more times
        node = { t: "rep", min: 1, max: null, item: node };
      }
    }
  }

  #startsOperand(token: ScanToken | undefined): boolean {
    if (!token) {
      return false;
    }
    if (token.kind === "group") {
      return "([{".includes(token.text);
    }
    return ["string", "charClass", "charCode", "name", "angleName"].includes(
      token.kind,
    );
  }

  #primary(): Node {
    const token = this.#peek() as ScanToken;
    this.#pos++;
    switch (token.kind) {
      case "string": {
        const inner = token.text.slice(1, -1);
        const value = this.#dialect === "ebnf" ? inner : unescapeString(inner);
        return { t: "lit", value, fold: false };
      }
      case "charCode":
        return {
          t: "lit",
          value: String.fromCodePoint(Number.parseInt(token.text.slice(2), 16)),
          fold: false,
        };
      case "charClass":
        return classNode(token.text);
      case "name":
      case "angleName":
        return {
          t: "ref",
          key: token.text.replace(/^<|>$/g, ""),
        };
      case "group":
        return this.#group(token.text);
      default:
        return { t: "none" };
    }
  }

  #group(open: string): Node {
    const inner = this.#alternatives();
    this.#pos++;
    if (open === "(") {
      return inner;
    }
    if (open === "[") {
      return { t: "rep", min: 0, max: 1, item: inner };
    }
    return { t: "rep", min: 0, max: null, item: inner };
  }
}

function productionRules(
  text: string,
  dialect: ProductionDialect,
): Array<[string, Node]> {
  return scanProductionGrammar(text, dialect).productions.map((production) => [
    production.nameToken.text.replace(/^<|>$/g, ""),
    new ProductionParser(production.bodyTokens, dialect).parse(),
  ]);
}

function abnfRules(text: string): Array<[string, Node]> {
  return parseAbnf(text).rules.map((rule) => {
    const expression = ruleExpressions.get(rule);
    return [
      rule.name.toLowerCase(),
      expression ? abnfNode(expression) : { t: "seq", items: [] },
    ];
  });
}

function join(a: Lang, b: Lang, max: number): Lang {
  const out: Lang = new Set();
  for (const x of a) {
    for (const y of b) {
      if (x.length + y.length <= max) {
        out.add(x + y);
      }
    }
  }
  return out;
}

/**
 * Strings of at most `maxLength` characters over `alphabet` that the first
 * rule of `text` matches.
 */
export function referenceLanguage(
  text: string,
  dialect: GrammarDialect,
  options: Options,
): Lang {
  const rules =
    dialect === "abnf" ? abnfRules(text) : productionRules(text, dialect);
  const { alphabet, maxLength } = options;
  const bodies = new Map<string, Node[]>();
  for (const [name, body] of rules) {
    bodies.set(name, [...(bodies.get(name) ?? []), body]);
  }
  let sets = new Map<string, Lang>(
    [...bodies.keys()].map((k) => [k, new Set()]),
  );

  const chars = (set: ReadonlySet<number>, negate: boolean): Lang =>
    new Set(
      [...alphabet].filter(
        (ch) => set.has(ch.codePointAt(0) as number) !== negate,
      ),
    );

  const evaluate = (node: Node): Lang => {
    switch (node.t) {
      case "lit": {
        if (
          ![...node.value].every(
            (ch) => alphabet.has(ch.toLowerCase()) || alphabet.has(ch),
          )
        ) {
          return new Set();
        }
        if (!node.fold) {
          return new Set([node.value]);
        }
        let all: Lang = new Set([""]);
        for (const ch of node.value) {
          all = join(
            all,
            new Set([ch.toLowerCase(), ch.toUpperCase()]),
            maxLength,
          );
        }
        return all;
      }
      case "set":
        return chars(node.chars, node.negate);
      case "ref":
        return sets.get(node.key) ?? new Set();
      case "seq":
        return node.items.reduce<Lang>(
          (all, item) => join(all, evaluate(item), maxLength),
          new Set([""]),
        );
      case "alt":
        return new Set(node.items.flatMap((item) => [...evaluate(item)]));
      case "rep": {
        const once = evaluate(node.item);
        const out: Lang = new Set();
        let power: Lang = new Set([""]);
        const top = node.max ?? maxLength + node.min;
        for (let k = 0; k <= top; k++) {
          if (k >= node.min) {
            for (const value of power) {
              out.add(value);
            }
          }
          power = join(power, once, maxLength);
        }
        return out;
      }
      case "minus": {
        const right = evaluate(node.right);
        return new Set([...evaluate(node.left)].filter((v) => !right.has(v)));
      }
      case "none":
        return new Set();
    }
  };

  for (let round = 0; round < FIXPOINT_ROUNDS; round++) {
    const next = new Map<string, Lang>();
    for (const [key, list] of bodies) {
      next.set(key, new Set(list.flatMap((body) => [...evaluate(body)])));
    }
    sets = next;
  }
  const start = rules[0];
  return sets.get(start?.[0] ?? "") ?? new Set();
}
