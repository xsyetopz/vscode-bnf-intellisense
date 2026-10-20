import {
  type CancellationToken,
  type ConfigurationScope,
  type Disposable,
  type DocumentRangeSemanticTokensProvider,
  type DocumentSemanticTokensProvider,
  EventEmitter,
  Range,
  SemanticTokensBuilder,
  SemanticTokensLegend,
  type TextDocument,
  workspace,
} from "vscode";
import { CORE_RULE_NAMES } from "../abnf/core-rules.ts";
import { readGrammarConfig } from "./config.ts";
import { normalizeSymbolName } from "./grammar.ts";
import type { GrammarToken } from "./tokenizer.ts";
import type { GrammarWorkspace } from "./workspace.ts";

const TOKEN_TYPES = [
  "type",
  "parameter",
  "variable",
  "string",
  "comment",
  "number",
  "operator",
  "regexp",
] as const;

type SemanticHighlightingMode = "auto" | "on" | "off";

interface SemanticTokenCandidate {
  range: Range;
  tokenType: string;
  tokenModifiers: readonly string[];
  priority: number;
}

const SYMBOL_PRIORITY = 2;
const LEXICAL_PRIORITY = 1;
const DEFAULT_MAX_TOKENS = 20_000;
const MAX_MEMOIZED_DOCUMENTS = 8;

const TOKEN_MODIFIERS = [
  "declaration",
  "definition",
  "readonly",
  "defaultLibrary",
] as const;

/**
 * Semantic token legend used by grammar highlighting.
 */
export const GRAMMAR_SEMANTIC_TOKENS_LEGEND = new SemanticTokensLegend(
  [...TOKEN_TYPES],
  [...TOKEN_MODIFIERS],
);

/**
 * VS Code semantic token provider for grammar definitions and references.
 */
export class GrammarSemanticTokensProvider
  implements DocumentSemanticTokensProvider, DocumentRangeSemanticTokensProvider
{
  readonly #manager: GrammarWorkspace;
  readonly #changed = new EventEmitter<void>();
  readonly #subscriptions: Disposable[];
  readonly #memos = new Map<string, SelectionMemo>();
  /** Fires when a `bnf.*` setting changed, so VS Code re-requests tokens. */
  readonly onDidChangeSemanticTokens = this.#changed.event;

  constructor(manager: GrammarWorkspace) {
    this.#manager = manager;
    this.#subscriptions = [
      workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("bnf")) {
          this.#changed.fire();
        }
      }),
      // A reopened document restarts at version 1 and may hold other text.
      workspace.onDidCloseTextDocument((doc) => {
        this.#memos.delete(doc.uri.toString());
      }),
    ];
  }

  dispose(): void {
    for (const subscription of this.#subscriptions) {
      subscription.dispose();
    }
    this.#memos.clear();
    this.#changed.dispose();
  }

  provideDocumentSemanticTokens(doc: TextDocument, _token: CancellationToken) {
    return buildTokens(this.#selectedTokens(doc));
  }

  /**
   * Tokens that start inside `range`. A token belongs to exactly one range
   * by its start, so requests for neighbouring ranges never overlap, and the
   * result is the full-document token list cut to the range. The "auto"
   * token limit is judged on the whole document, never on the range, so a
   * range request cannot show tokens that the full request would hide.
   */
  provideDocumentRangeSemanticTokens(
    doc: TextDocument,
    range: Range,
    _token: CancellationToken,
  ) {
    return buildTokens(
      this.#selectedTokens(doc).filter((token) =>
        startsInside(token.range, range),
      ),
    );
  }

  /**
   * Selected tokens of the whole document. Overlap resolution and the "auto"
   * limit are global, so a range cannot be computed on its own without
   * changing the result; instead the full result is reused per document and
   * version, which is what VS Code's consecutive viewport requests need.
   */
  #selectedTokens(doc: TextDocument): SemanticTokenCandidate[] {
    const settings = semanticHighlightingSettings({
      uri: doc.uri,
      languageId: doc.languageId,
    });
    if (settings.mode === "off") {
      return [];
    }
    const key = doc.uri.toString();
    const memo = this.#memos.get(key);
    if (
      memo &&
      memo.version === doc.version &&
      memo.languageId === doc.languageId &&
      memo.mode === settings.mode &&
      memo.maxTokens === settings.maxTokens
    ) {
      return memo.tokens;
    }
    const tokens = this.#computeTokens(doc, settings);
    this.#memos.delete(key);
    this.#memos.set(key, {
      version: doc.version,
      languageId: doc.languageId,
      mode: settings.mode,
      maxTokens: settings.maxTokens,
      tokens,
    });
    if (this.#memos.size > MAX_MEMOIZED_DOCUMENTS) {
      const oldest = this.#memos.keys().next();
      if (!oldest.done) {
        this.#memos.delete(oldest.value);
      }
    }
    return tokens;
  }

  #computeTokens(
    doc: TextDocument,
    settings: { mode: SemanticHighlightingMode; maxTokens: number },
  ): SemanticTokenCandidate[] {
    const result = this.#manager.get(doc);
    const symbols = symbolSemanticTokenCandidates(result);
    const lexical = lexicalSemanticTokenCandidates(
      this.#manager.getTokens(doc),
    );
    // Past the limit, keep the rule names and references (the part only
    // semantic highlighting can provide) and leave operators, strings,
    // numbers, and comments to the TextMate grammar. Highlighting never
    // disappears.
    const overLimit =
      settings.mode === "auto" &&
      settings.maxTokens > 0 &&
      symbols.length + lexical.length > settings.maxTokens;
    return selectSemanticTokens(overLimit ? symbols : [...symbols, ...lexical]);
  }
}

interface SelectionMemo {
  version: number;
  languageId: string;
  mode: SemanticHighlightingMode;
  maxTokens: number;
  tokens: SemanticTokenCandidate[];
}

function buildTokens(tokens: readonly SemanticTokenCandidate[]) {
  const builder = new SemanticTokensBuilder(GRAMMAR_SEMANTIC_TOKENS_LEGEND);
  for (const token of tokens) {
    builder.push(token.range, token.tokenType, token.tokenModifiers);
  }
  return builder.build();
}

function startsInside(token: Range, range: Range): boolean {
  const afterStart =
    token.start.line > range.start.line ||
    (token.start.line === range.start.line &&
      token.start.character >= range.start.character);
  const beforeEnd =
    token.start.line < range.end.line ||
    (token.start.line === range.end.line &&
      token.start.character < range.end.character);
  return afterStart && beforeEnd;
}

type ManagerResult = ReturnType<GrammarWorkspace["get"]>;

function addCandidate(
  candidates: SemanticTokenCandidate[],
  range: Range,
  tokenType: string,
  tokenModifiers: readonly string[] = [],
  priority = LEXICAL_PRIORITY,
): void {
  if (isValidSingleLineRange(range)) {
    candidates.push({ range, tokenType, tokenModifiers, priority });
  }
}

function symbolSemanticTokenCandidates(
  result: ManagerResult,
): SemanticTokenCandidate[] {
  const candidates: SemanticTokenCandidate[] = [];
  for (const rule of result.document.rules) {
    addCandidate(
      candidates,
      rule.nameRange,
      "type",
      ["declaration", "definition"],
      SYMBOL_PRIORITY,
    );
    for (const ref of rule.references) {
      const key = normalizeSymbolName(ref.name, result.dialect);
      // A user definition wins over a core rule of the same name.
      if (result.symbolTable.definitions.has(key)) {
        addCandidate(candidates, ref.range, "parameter", [], SYMBOL_PRIORITY);
      } else if (result.dialect === "abnf" && CORE_RULE_NAMES.has(key)) {
        addCandidate(
          candidates,
          ref.range,
          "variable",
          ["readonly", "defaultLibrary"],
          SYMBOL_PRIORITY,
        );
      } else {
        addCandidate(candidates, ref.range, "type", [], SYMBOL_PRIORITY);
      }
    }
  }
  return candidates;
}

function lexicalSemanticTokenCandidates(
  tokens: readonly GrammarToken[],
): SemanticTokenCandidate[] {
  const candidates: SemanticTokenCandidate[] = [];
  for (const token of tokens) {
    const semantic = semanticTokenForGrammarToken(token);
    if (semantic) {
      addCandidate(
        candidates,
        tokenRange(token),
        semantic.type,
        semantic.modifiers,
      );
    }
  }
  return candidates;
}

function semanticHighlightingSettings(scope: ConfigurationScope): {
  mode: SemanticHighlightingMode;
  maxTokens: number;
} {
  const mode = readSemanticMode(
    readGrammarConfig<unknown>("semanticHighlighting.mode", "auto", scope),
  );
  const maxTokens = readGrammarConfig<number>(
    "semanticHighlighting.maxTokens",
    DEFAULT_MAX_TOKENS,
    scope,
  );
  return {
    mode,
    maxTokens: Number.isFinite(maxTokens) ? Math.max(0, maxTokens) : 0,
  };
}

function readSemanticMode(value: unknown): SemanticHighlightingMode {
  return value === "on" || value === "off" ? value : "auto";
}

/**
 * Greedy selection by priority, then position, then length. Accepted tokens
 * are disjoint, so each line keeps them sorted by start and a candidate only
 * has to be compared with its neighbour found by binary search.
 */
function selectSemanticTokens(
  candidates: readonly SemanticTokenCandidate[],
): SemanticTokenCandidate[] {
  const byLine = new Map<number, SemanticTokenCandidate[]>();
  for (const candidate of [...candidates].sort(compareByPriority)) {
    const line = candidate.range.start.line;
    let accepted = byLine.get(line);
    if (!accepted) {
      accepted = [];
      byLine.set(line, accepted);
    }
    const index = firstEndingAfter(accepted, candidate.range.start.character);
    const next = accepted[index];
    if (next && next.range.start.character < candidate.range.end.character) {
      continue;
    }
    accepted.splice(index, 0, candidate);
  }
  return [...byLine.entries()]
    .sort((a, b) => a[0] - b[0])
    .flatMap(([, tokens]) => tokens);
}

/** Index of the first disjoint, start-sorted token ending after `column`. */
function firstEndingAfter(
  tokens: readonly SemanticTokenCandidate[],
  column: number,
): number {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (
      (tokens[middle] as SemanticTokenCandidate).range.end.character > column
    ) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}

function tokenRange(token: GrammarToken): Range {
  return new Range(
    token.line,
    token.column,
    token.line,
    token.column + token.text.length,
  );
}

function isValidSingleLineRange(range: Range): boolean {
  return (
    range.start.line === range.end.line &&
    range.start.character < range.end.character &&
    range.start.character >= 0 &&
    range.end.character >= 0
  );
}

function compareByPriority(
  a: SemanticTokenCandidate,
  b: SemanticTokenCandidate,
): number {
  return (
    b.priority - a.priority ||
    compareRangeStart(a.range, b.range) ||
    rangeLength(b.range) - rangeLength(a.range)
  );
}

function compareRangeStart(a: Range, b: Range): number {
  return a.start.line - b.start.line || a.start.character - b.start.character;
}

function rangeLength(range: Range): number {
  return range.end.character - range.start.character;
}

function semanticTokenForGrammarToken(
  token: GrammarToken,
): { type: string; modifiers?: readonly string[] } | undefined {
  switch (token.kind) {
    case "assignment":
    case "alternative":
    case "repeat":
    case "group":
    case "operator":
      return { type: "operator" };
    case "literal":
      return { type: "string" };
    case "comment":
      return { type: "comment" };
    case "number":
    case "charCode":
      return { type: "number" };
    case "charClass":
      return { type: "regexp" };
    default:
      return undefined;
  }
}
