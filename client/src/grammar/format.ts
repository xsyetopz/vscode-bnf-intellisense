import type {
  AbnfAlternativeIndent,
  AbnfBreakAlternatives,
} from "../abnf/format.ts";
import {
  lexProductionGrammar,
  type Production,
  type ProductionDialect,
  productionHasErrors,
  type ScanResult,
  type ScanToken,
  scanProductionGrammar,
} from "./scanner.ts";

/**
 * Shared formatting options for grammar documents.
 */
export interface SharedGrammarFormatterConfig {
  alignEquals: boolean;
  alternativeIndent: AbnfAlternativeIndent;
  blankLinesBetweenRules: number;
  breakAlternatives: AbnfBreakAlternatives;
  continuationIndent: number;
  insertFinalNewline: boolean;
  maxLineLength: number;
  preserveCommentSpacing: boolean;
  trimTrailingBlankLines: boolean;
}

/**
 * Formatting options shared by BNF, EBNF, and RBNF documents.
 */
export interface GenericGrammarFormatterConfig
  extends SharedGrammarFormatterConfig {
  alignProductionNumbers: boolean;
  spaceBeforeInlineComment: number;
}

interface Item {
  kind: "rule" | "blank" | "other";
  lines: string[];
}

interface Layout {
  nameWidth: number;
  numberWidth: number;
}

const EOL_RE = /\r\n|\n|\r/;
const LINE_BREAK_RE = /[ \t]*(?:\r\n|\n|\r)[ \t]*/g;
const OPERATOR = "::=";

function detectEol(text: string): string {
  return EOL_RE.exec(text)?.[0] ?? "\n";
}

function normalizeBreaks(text: string): string {
  return text.replace(LINE_BREAK_RE, " ");
}

function productionStartLine(production: Production): number {
  return (production.numberToken ?? production.nameToken).line;
}

function productionEndLine(production: Production): number {
  const last = production.bodyTokens[production.bodyTokens.length - 1];
  let end = (last ?? production.assignToken).endLine;
  for (const comment of production.trailingComments) {
    end = Math.max(end, comment.endLine);
  }
  return end;
}

/**
 * Lines that begin inside a multi-line comment. They are never reformatted.
 */
function commentInteriorLines(scan: ScanResult): Set<number> {
  const interior = new Set<number>();
  for (const token of scan.tokens) {
    if (token.kind === "comment") {
      for (let line = token.line + 1; line <= token.endLine; line++) {
        interior.add(line);
      }
    }
  }
  return interior;
}

function computeLayout(
  productions: readonly Production[],
  config: GenericGrammarFormatterConfig,
): Layout {
  let nameWidth = 0;
  let numberWidth = 0;
  for (const production of productions) {
    nameWidth = Math.max(nameWidth, production.nameToken.text.length);
    numberWidth = Math.max(
      numberWidth,
      production.numberToken?.text.length ?? 0,
    );
  }
  return {
    nameWidth: config.alignEquals ? nameWidth : 0,
    numberWidth:
      config.alignEquals && config.alignProductionNumbers ? numberWidth : 0,
  };
}

function headText(production: Production, layout: Layout): string {
  const number = production.numberToken?.text;
  let prefix = "";
  if (number) {
    prefix = `${number.padEnd(layout.numberWidth)} `;
  } else if (layout.numberWidth > 0) {
    prefix = " ".repeat(layout.numberWidth + 1);
  }
  return `${prefix}${production.nameToken.text.padEnd(layout.nameWidth)}`;
}

function continuationPrefix(
  head: string,
  config: GenericGrammarFormatterConfig,
): string {
  if (config.alternativeIndent === "indent") {
    return " ".repeat(Math.max(1, Math.floor(config.continuationIndent) || 1));
  }
  return " ".repeat(head.length + OPERATOR.length + 2);
}

function joinTokens(text: string, tokens: readonly ScanToken[]): string {
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  return first && last
    ? normalizeBreaks(text.slice(first.start, last.end))
    : "";
}

/**
 * Splits a body into top-level alternatives. Delimiters inside character
 * classes, strings, and angle names are single tokens, so only real groups
 * change the depth.
 */
function topLevelAlternatives(text: string, production: Production): string[] {
  const alternatives: string[] = [];
  let current: ScanToken[] = [];
  let depth = 0;
  for (const token of production.bodyTokens) {
    if (token.kind === "group") {
      depth =
        token.text === "(" || token.text === "[" || token.text === "{"
          ? depth + 1
          : Math.max(0, depth - 1);
    } else if (token.kind === "alternative" && depth === 0) {
      alternatives.push(joinTokens(text, current));
      current = [];
      continue;
    }
    current.push(token);
  }
  alternatives.push(joinTokens(text, current));
  return alternatives;
}

function shouldBreakAlternatives(
  rendered: string,
  alternatives: readonly string[],
  config: GenericGrammarFormatterConfig,
): boolean {
  if (alternatives.length <= 1) {
    return false;
  }
  if (config.breakAlternatives === "always") {
    return true;
  }
  if (config.breakAlternatives === "never" || config.maxLineLength <= 0) {
    return false;
  }
  return rendered.length > config.maxLineLength;
}

function trailingComment(
  text: string,
  production: Production,
  config: GenericGrammarFormatterConfig,
): string {
  const first = production.trailingComments[0];
  const last =
    production.trailingComments[production.trailingComments.length - 1];
  if (!(first && last)) {
    return "";
  }
  const spaces = " ".repeat(Math.max(0, config.spaceBeforeInlineComment));
  return `${spaces}${text.slice(first.start, last.end)}`;
}

function isSimple(production: Production): boolean {
  return (
    production.innerComments.length === 0 &&
    production.trailingComments.every(
      (comment) => comment.line === comment.endLine,
    )
  );
}

function formatSimple(
  scan: ScanResult,
  production: Production,
  head: string,
  config: GenericGrammarFormatterConfig,
): string[] {
  const alternatives = topLevelAlternatives(scan.text, production);
  const body = joinTokens(scan.text, production.bodyTokens);
  const comment = trailingComment(scan.text, production, config);
  const rendered = `${head} ${OPERATOR}${body ? ` ${body}` : ""}${comment}`;
  if (!shouldBreakAlternatives(rendered, alternatives, config)) {
    return [rendered];
  }
  const prefix = continuationPrefix(head, config);
  const [first = "", ...rest] = alternatives;
  const lines = [
    first ? `${head} ${OPERATOR} ${first}` : `${head} ${OPERATOR}`,
    ...rest.map((alternative) =>
      alternative ? `${prefix}| ${alternative}` : `${prefix}|`,
    ),
  ];
  lines[lines.length - 1] = `${lines[lines.length - 1]}${comment}`;
  return lines;
}

function formatWithComments(
  lines: readonly string[],
  production: Production,
  head: string,
  interior: ReadonlySet<number>,
  config: GenericGrammarFormatterConfig,
): string[] {
  const startLine = productionStartLine(production);
  const rest = (lines[startLine] ?? "")
    .slice(production.assignToken.endColumn)
    .trim();
  const out = [rest ? `${head} ${OPERATOR} ${rest}` : `${head} ${OPERATOR}`];
  const prefix = continuationPrefix(head, config);
  for (
    let line = startLine + 1;
    line <= productionEndLine(production);
    line++
  ) {
    const raw = lines[line] ?? "";
    if (interior.has(line)) {
      out.push(config.preserveCommentSpacing ? raw : raw.trimEnd());
      continue;
    }
    const content = raw.trim();
    if (content === "") {
      out.push("");
    } else if (content.startsWith("|")) {
      out.push(`${prefix}${content}`);
    } else {
      out.push(`${prefix}  ${content}`);
    }
  }
  return out;
}

function tokenSignature(text: string, dialect: ProductionDialect): string {
  return lexProductionGrammar(text, dialect)
    .map((token) => `${token.kind}\u0000${token.text}`)
    .join("\u0001");
}

/**
 * Productions whose comments or tokens cannot be re-laid-out safely.
 */
function leadingCommentProductions(
  scan: ScanResult,
  byStart: ReadonlyMap<number, Production>,
): Set<Production> {
  const marked = new Set<Production>();
  for (const token of scan.tokens) {
    if (token.kind !== "comment") {
      continue;
    }
    const production = byStart.get(token.endLine);
    if (production && token.end <= production.startOffset) {
      marked.add(production);
    }
  }
  return marked;
}

function formatProduction(
  scan: ScanResult,
  lines: readonly string[],
  production: Production,
  layout: Layout,
  interior: ReadonlySet<number>,
  config: GenericGrammarFormatterConfig,
): string[] | undefined {
  const head = headText(production, layout);
  const formatted = isSimple(production)
    ? formatSimple(scan, production, head, config)
    : formatWithComments(lines, production, head, interior, config);
  // Safety net: the token stream must survive formatting unchanged.
  const original = lines
    .slice(productionStartLine(production), productionEndLine(production) + 1)
    .join("\n");
  return tokenSignature(formatted.join("\n"), scan.dialect) ===
    tokenSignature(original, scan.dialect)
    ? formatted
    : undefined;
}

/**
 * Start of a chunk of non-blank lines that ends in a rule, such as a comment
 * attached to the rule below it.
 */
function startsRuleGroup(items: readonly Item[], index: number): boolean {
  let cursor = index;
  while (items[cursor]?.kind === "other") {
    cursor++;
  }
  return items[cursor]?.kind === "rule";
}

function normalizeRuleGaps(items: readonly Item[], blankLines: number): Item[] {
  const out: Item[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Item;
    out.push(item);
    if (item.kind !== "rule") {
      continue;
    }
    let next = i + 1;
    while (items[next]?.kind === "blank") {
      next++;
    }
    if (next < items.length && startsRuleGroup(items, next)) {
      for (let n = 0; n < blankLines; n++) {
        out.push({ kind: "blank", lines: [""] });
      }
      i = next - 1;
    }
  }
  return out;
}

function buildItems(
  scan: ScanResult,
  lines: readonly string[],
  config: GenericGrammarFormatterConfig,
): Item[] {
  const interior = commentInteriorLines(scan);
  const byStart = new Map<number, Production>();
  for (const production of scan.productions) {
    byStart.set(productionStartLine(production), production);
  }
  const leading = leadingCommentProductions(scan, byStart);
  const verbatim = (production: Production) =>
    leading.has(production) || productionHasErrors(production);
  const layout = computeLayout(
    scan.productions.filter((production) => !verbatim(production)),
    config,
  );
  const items: Item[] = [];
  let line = 0;
  while (line < lines.length) {
    const production = byStart.get(line);
    if (production) {
      const end = productionEndLine(production);
      const original = lines.slice(line, end + 1);
      items.push({
        kind: "rule",
        lines: verbatim(production)
          ? original
          : (formatProduction(
              scan,
              lines,
              production,
              layout,
              interior,
              config,
            ) ?? original),
      });
      line = end + 1;
      continue;
    }
    const raw = lines[line] ?? "";
    if (interior.has(line)) {
      items.push({
        kind: "other",
        lines: [config.preserveCommentSpacing ? raw : raw.trimEnd()],
      });
    } else if (raw.trim() === "") {
      items.push({ kind: "blank", lines: [""] });
    } else {
      items.push({ kind: "other", lines: [raw.trimEnd()] });
    }
    line++;
  }
  return items;
}

/**
 * Formats BNF, EBNF, and RBNF production grammars. The token stream is never
 * changed: only whitespace between tokens and between lines is touched.
 * Productions with unbalanced delimiters or unterminated tokens are copied
 * verbatim. The input's line-ending style is kept.
 */
export function formatProductionGrammarDocument(
  text: string,
  dialect: ProductionDialect,
  config: GenericGrammarFormatterConfig,
): string {
  const eol = detectEol(text);
  const scan = scanProductionGrammar(text, dialect);
  const lines = text.split(EOL_RE);
  const blankLines = Math.max(
    0,
    Math.floor(config.blankLinesBetweenRules) || 0,
  );
  const items = normalizeRuleGaps(buildItems(scan, lines, config), blankLines);
  const out = items.flatMap((item) => item.lines);
  if (config.trimTrailingBlankLines) {
    while (out.length > 0 && out[out.length - 1]?.trim() === "") {
      out.pop();
    }
  }
  let result = out.join(eol);
  if (config.insertFinalNewline && result.length > 0 && !result.endsWith(eol)) {
    result += eol;
  }
  return result;
}
