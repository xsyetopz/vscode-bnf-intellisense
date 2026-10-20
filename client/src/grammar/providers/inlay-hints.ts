import {
  type CancellationToken,
  type Disposable,
  EventEmitter,
  InlayHint,
  InlayHintKind,
  type InlayHintsProvider,
  type Range,
  type TextDocument,
  workspace,
} from "vscode";
import { readGrammarConfig } from "../config.ts";
import { normalizeSymbolName } from "../grammar.ts";
import { externallyReferencedKeys } from "../symbol-table.ts";
import { getSyntaxDetailInlays } from "../syntax-details.ts";
import type { GrammarWorkspace } from "../workspace.ts";

/**
 * VS Code inlay hint provider for grammar rule metadata.
 */
export class GrammarInlayHintsProvider implements InlayHintsProvider {
  readonly #grammarWorkspace: GrammarWorkspace;

  readonly #changed = new EventEmitter<void>();
  readonly #subscription: Disposable;
  /** Fires when a `bnf.*` setting changed, so VS Code re-requests hints. */
  readonly onDidChangeInlayHints = this.#changed.event;

  constructor(grammarWorkspace: GrammarWorkspace) {
    this.#grammarWorkspace = grammarWorkspace;
    this.#subscription = workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("bnf")) {
        this.#changed.fire();
      }
    });
  }

  dispose(): void {
    this.#subscription.dispose();
    this.#changed.dispose();
  }

  provideInlayHints(
    doc: TextDocument,
    range: Range,
    _token: CancellationToken,
  ): InlayHint[] {
    const { dialect, document, symbolTable } = this.#grammarWorkspace.get(doc);
    const hints: InlayHint[] = [];
    const scope = { uri: doc.uri, languageId: doc.languageId };

    const showRefCount = readGrammarConfig<boolean>(
      "inlayHints.referenceCount",
      false,
      scope,
    );
    const showRecursion = readGrammarConfig<boolean>(
      "inlayHints.recursion",
      false,
      scope,
    );
    const showUnused = readGrammarConfig<boolean>(
      "inlayHints.unusedMarker",
      false,
      scope,
    );
    const showSyntaxDetails = readGrammarConfig<boolean>(
      "inlayHints.syntaxDetails",
      false,
      scope,
    );

    if (!(showRefCount || showRecursion || showUnused || showSyntaxDetails)) {
      return hints;
    }

    const used = externallyReferencedKeys(document, dialect);
    for (const rule of document.rules) {
      if (!range.intersection(rule.definitionRange)) {
        continue;
      }

      const parts = buildHintParts(
        rule,
        symbolTable,
        used,
        dialect,
        showRefCount,
        showRecursion,
        showUnused,
      );

      if (parts.length > 0) {
        const hint = new InlayHint(
          rule.nameRange.end,
          ` ${parts.join(", ")}`,
          InlayHintKind.Parameter,
        );
        hint.paddingLeft = true;
        hints.push(hint);
      }
      if (showSyntaxDetails) {
        hints.push(
          ...getSyntaxDetailInlays(
            rule.nameRange.end.line,
            rule.nameRange.end.character,
            rule.definitionText,
            dialect,
          ),
        );
      }
    }

    return hints;
  }
}

type ManagerResult = ReturnType<GrammarWorkspace["get"]>;
type GrammarRule = ManagerResult["document"]["rules"][number];

function buildHintParts(
  rule: GrammarRule,
  symbolTable: ManagerResult["symbolTable"],
  used: ReadonlySet<string>,
  dialect: ManagerResult["dialect"],
  showRefCount: boolean,
  showRecursion: boolean,
  showUnused: boolean,
): string[] {
  const parts: string[] = [];

  const key = normalizeSymbolName(rule.name, dialect);
  const refCount = symbolTable.references.get(key)?.length ?? 0;

  if (showRefCount) {
    parts.push(`${refCount} ref${refCount === 1 ? "" : "s"}`);
  }

  if (showRecursion) {
    const isRecursive = rule.references.some(
      (r) => normalizeSymbolName(r.name, dialect) === key,
    );
    if (isRecursive) {
      parts.push("recursive");
    }
  }

  // A rule that only refers to itself is still unused.
  if (showUnused && !used.has(key)) {
    parts.push("unused");
  }

  return parts;
}
