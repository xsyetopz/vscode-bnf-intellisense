import {
  type CancellationToken,
  CompletionItem,
  CompletionItemKind,
  type CompletionItemProvider,
  type Position,
  Range,
  SnippetString,
  type TextDocument,
} from "vscode";
import { CORE_RULES } from "../abnf/core-rules.ts";
import { getGrammarDialectDescriptor, normalizeSymbolName } from "./grammar.ts";
import { type ScanToken, scanProductionGrammar } from "./scanner.ts";
import { tokenizeGrammar } from "./tokenizer.ts";
import type { GrammarWorkspace } from "./workspace.ts";

/**
 * Completion trigger characters per dialect: "%" is ABNF-only, "#" is
 * EBNF-only, and "<" belongs to the angle-bracket dialects.
 */
export const COMPLETION_TRIGGERS: ReadonlyArray<{
  language: string;
  triggers: readonly string[];
}> = [
  { language: "abnf", triggers: ["%"] },
  { language: "bnf", triggers: ["<"] },
  { language: "ebnf", triggers: ["#"] },
  { language: "rbnf", triggers: ["<"] },
];

/**
 * VS Code completion provider for grammar rule names.
 */
export class GrammarCompletionProvider implements CompletionItemProvider {
  readonly #manager: GrammarWorkspace;

  constructor(manager: GrammarWorkspace) {
    this.#manager = manager;
  }

  provideCompletionItems(
    doc: TextDocument,
    position: Position,
    _token: CancellationToken,
  ): CompletionItem[] {
    const result = this.#manager.get(doc);
    // Never complete inside comments, strings, or character classes.
    if (isInsideNonCode(doc.getText(), position, result.dialect)) {
      return [];
    }
    const items = [
      ...ruleCompletions(result, this.#manager),
      ...coreRuleCompletions(result.dialect),
      ...dialectSnippetCompletions(result.dialect),
    ];
    applyAngleReplaceRange(items, doc, position, result.dialect);
    return items;
  }
}

function isInsideToken(token: ScanToken, offset: number): boolean {
  if (token.kind === "comment" || token.unterminated) {
    // Typing at the end of a line comment or of an open token is still inside.
    return token.start < offset && offset <= token.end;
  }
  const delimited =
    token.kind === "string" ||
    token.kind === "charClass" ||
    token.kind === "annotation";
  return delimited && token.start < offset && offset < token.end;
}

function isInsideNonCode(
  text: string,
  position: Position,
  dialect: ManagerResult["dialect"],
): boolean {
  if (dialect === "abnf") {
    return tokenizeGrammar(text, dialect).some(
      (token) =>
        token.line === position.line &&
        (token.kind === "comment" || token.kind === "literal") &&
        token.column < position.character &&
        position.character <=
          token.column + token.text.length - (token.kind === "comment" ? 0 : 1),
    );
  }
  const scan = scanProductionGrammar(text, dialect);
  const offset =
    (scan.lineIndex.starts[position.line] ?? text.length) + position.character;
  return scan.tokens.some(
    (token) => token.start < offset && isInsideToken(token, offset),
  );
}

const OPEN_ANGLE_RE = /<[^<>\r\n]*$/;

/**
 * BNF and RBNF names include their angle brackets. After the user typed "<",
 * replace the partial name so that completing does not produce "<<name>".
 */
function applyAngleReplaceRange(
  items: CompletionItem[],
  doc: TextDocument,
  position: Position,
  dialect: ManagerResult["dialect"],
): void {
  if (dialect !== "bnf" && dialect !== "rbnf") {
    return;
  }
  const line = doc.lineAt(position.line).text;
  const before = line.slice(0, position.character);
  const open = OPEN_ANGLE_RE.exec(before);
  if (!open) {
    return;
  }
  const end = line[position.character] === ">" ? 1 : 0;
  const range = new Range(
    position.line,
    open.index,
    position.line,
    position.character + end,
  );
  for (const item of items) {
    if (item.kind === CompletionItemKind.Function) {
      const label =
        typeof item.label === "string" ? item.label : item.label.label;
      if (label.startsWith("<")) {
        item.range = range;
        item.filterText = label;
      }
    }
  }
}

type ManagerResult = ReturnType<GrammarWorkspace["get"]>;

function ruleCompletions(
  result: ManagerResult,
  workspace: GrammarWorkspace,
): CompletionItem[] {
  const { assignmentOperator: operator } = getGrammarDialectDescriptor(
    result.dialect,
  );
  const seen = new Set<string>();
  const items: CompletionItem[] = [];
  for (const rules of result.symbolTable.definitions.values()) {
    addRuleCompletion(items, seen, rules[0], result.dialect, operator, false);
  }
  for (const file of workspace.getAllFiles(result.dialect)) {
    for (const rule of file.rules) {
      addRuleCompletion(items, seen, rule, result.dialect, operator, true);
    }
  }
  return items;
}

function addRuleCompletion(
  items: CompletionItem[],
  seen: Set<string>,
  rule: ManagerResult["document"]["rules"][number] | undefined,
  dialect: ManagerResult["dialect"],
  operator: string,
  workspaceRule: boolean,
): void {
  if (!rule || rule.isCoreRule) {
    return;
  }
  const key = normalizeSymbolName(rule.name, dialect);
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  const item = new CompletionItem(rule.name, CompletionItemKind.Function);
  item.detail = `${rule.name} ${operator} ${rule.definitionText}`;
  if (rule.precedingComment) {
    item.documentation = rule.precedingComment;
  }
  if (workspaceRule) {
    item.detail = `${item.detail} (workspace)`;
  }
  items.push(item);
}

function coreRuleCompletions(
  dialect: ManagerResult["dialect"],
): CompletionItem[] {
  if (dialect !== "abnf") {
    return [];
  }
  return Array.from(CORE_RULES.values(), (rule) => {
    const item = new CompletionItem(rule.name, CompletionItemKind.Constant);
    item.detail = `${rule.name} = ${rule.definitionText}`;
    item.documentation = "Built-in ABNF core rule from RFC 5234 Appendix B.";
    return item;
  });
}

function placeholder(value: string): string {
  return `\${${value}}`;
}

function snippet(label: string, body: string, detail: string): CompletionItem {
  const item = new CompletionItem(label, CompletionItemKind.Snippet);
  item.insertText = new SnippetString(body);
  item.detail = detail;
  return item;
}

function dialectSnippetCompletions(
  dialect: ManagerResult["dialect"],
): CompletionItem[] {
  switch (dialect) {
    case "abnf":
      return [
        snippet(
          "%x hex value",
          `%x${placeholder("1:20")}`,
          "ABNF hex terminal",
        ),
        snippet(
          "%d decimal value",
          `%d${placeholder("1:32")}`,
          "ABNF decimal terminal",
        ),
        snippet(
          "%b binary value",
          `%b${placeholder("1:01000001")}`,
          "ABNF binary terminal",
        ),
        snippet(
          "case-sensitive string",
          `%s"${placeholder("1:text")}"`,
          "RFC 7405 case-sensitive string",
        ),
        snippet(
          "case-insensitive string",
          `%i"${placeholder("1:text")}"`,
          "RFC 7405 case-insensitive string",
        ),
        snippet(
          "repetition",
          `${placeholder("1:min")}*${placeholder("2:max")}(${placeholder("3:element")})`,
          "ABNF repetition",
        ),
      ];
    case "ebnf":
      return [
        snippet(
          "production",
          `[${placeholder("1:1")}] ${placeholder("2:name")} ::= ${placeholder("3:expression")}`,
          "W3C XML EBNF production",
        ),
        snippet(
          "character code",
          `#x${placeholder("1:20")}`,
          "W3C XML EBNF character",
        ),
        snippet(
          "character range",
          `[#x${placeholder("1:20")}-#x${placeholder("2:7E")}]`,
          "W3C XML EBNF character class",
        ),
      ];
    case "rbnf":
      return [
        snippet(
          "RBNF rule",
          `<${placeholder("1:rule name")}> ::= ${placeholder("2:expression")}`,
          "RFC 5511 rule",
        ),
        snippet(
          "RBNF optional",
          `[${placeholder("1:element")}]`,
          "RFC 5511 optional element",
        ),
        snippet(
          "RBNF repetition",
          `${placeholder("1:element")} ...`,
          "RFC 5511 repeatable element",
        ),
      ];
    case "bnf":
      return [
        snippet(
          "BNF rule",
          `<${placeholder("1:rule-name")}> ::= ${placeholder("2:expression")}`,
          "BNF production",
        ),
        snippet(
          "BNF reference",
          `<${placeholder("1:rule-name")}>`,
          "BNF nonterminal reference",
        ),
      ];
    default:
      return [];
  }
}
