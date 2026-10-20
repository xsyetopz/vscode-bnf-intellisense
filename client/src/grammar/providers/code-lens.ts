import {
  type CancellationToken,
  CodeLens,
  type CodeLensProvider,
  type Disposable,
  EventEmitter,
  type TextDocument,
  workspace,
} from "vscode";
import { readGrammarConfig } from "../config.ts";
import { isGrammarLanguage, normalizeSymbolName } from "../grammar.ts";
import type { GrammarWorkspace } from "../workspace.ts";
import {
  collectWorkspaceReferenceCount,
  collectWorkspaceSymbolLocations,
} from "./symbol-locations.ts";

interface LensTarget {
  doc: TextDocument;
  name: string;
}

/**
 * Title of a reference-count lens: "1 reference", "2 references".
 */
export function referenceLensTitle(count: number): string {
  return `${count} ${count === 1 ? "reference" : "references"}`;
}

/**
 * VS Code code lens provider: a "N references" lens above each rule. Lenses
 * are cheap to create; the count is computed when VS Code resolves a visible
 * lens, so large files do not pay for the whole workspace up front.
 */
export class GrammarCodeLensProvider implements CodeLensProvider {
  readonly #grammarWorkspace: GrammarWorkspace;
  readonly #targets = new WeakMap<CodeLens, LensTarget>();
  readonly #changed = new EventEmitter<void>();
  readonly #subscriptions: Disposable[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #delay: number;
  /**
   * Fires when a `bnf.*` setting changed, or (debounced) when a grammar
   * document was edited or the workspace index changed, so VS Code
   * re-requests lenses and their cross-file counts are fresh.
   */
  readonly onDidChangeCodeLenses = this.#changed.event;

  /**
   * @param delay Milliseconds to wait after an edit or index change before
   * lenses are re-requested, so typing does not recount on every key.
   */
  constructor(grammarWorkspace: GrammarWorkspace, delay = 300) {
    this.#grammarWorkspace = grammarWorkspace;
    this.#delay = delay;
    this.#subscriptions.push(
      workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("bnf")) {
          this.#changed.fire();
        }
      }),
      // Counts include other files, so an edit anywhere can change a lens.
      workspace.onDidChangeTextDocument((event) => {
        // Dirty-state and save events carry no content change.
        if (
          event.contentChanges.length > 0 &&
          isGrammarLanguage(event.document.languageId)
        ) {
          this.#refreshLater();
        }
      }),
    );
    const indexEvent = grammarWorkspace.onDidChangeIndex;
    if (indexEvent) {
      this.#subscriptions.push(indexEvent(() => this.#refreshLater()));
    }
  }

  dispose(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
    }
    for (const subscription of this.#subscriptions) {
      subscription.dispose();
    }
    this.#changed.dispose();
  }

  #refreshLater(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#changed.fire();
    }, this.#delay);
  }

  provideCodeLenses(doc: TextDocument, token?: CancellationToken): CodeLens[] {
    const enabled = readGrammarConfig<boolean>("codeLens.references", true, {
      uri: doc.uri,
      languageId: doc.languageId,
    });
    if (!enabled) {
      return [];
    }
    const { document } = this.#grammarWorkspace.get(doc);
    const lenses: CodeLens[] = [];
    for (const rule of document.rules) {
      if (token?.isCancellationRequested) {
        break;
      }
      // An ABNF `=/` extends a rule declared elsewhere: one lens per rule.
      if (rule.isIncremental) {
        continue;
      }
      const lens = new CodeLens(rule.nameRange);
      this.#targets.set(lens, { doc, name: rule.name });
      lenses.push(lens);
    }
    return lenses;
  }

  resolveCodeLens(lens: CodeLens, token?: CancellationToken): CodeLens {
    const target = this.#targets.get(lens);
    if (!target || token?.isCancellationRequested) {
      return lens;
    }
    const { doc, name } = target;
    const { dialect, symbolTable } = this.#grammarWorkspace.get(doc);
    const key = normalizeSymbolName(name, dialect);
    const uri = doc.uri.toString();
    const count = collectWorkspaceReferenceCount(
      this.#grammarWorkspace,
      key,
      dialect,
      uri,
      symbolTable,
    );
    // With nothing to show, an empty command id keeps the title as plain
    // text instead of opening an empty peek view.
    if (count === 0) {
      lens.command = { title: referenceLensTitle(count), command: "" };
      return lens;
    }
    const locations = collectWorkspaceSymbolLocations(
      this.#grammarWorkspace,
      key,
      dialect,
      uri,
      symbolTable,
      doc.uri,
      false,
    );
    lens.command = {
      title: referenceLensTitle(count),
      command: "editor.action.showReferences",
      arguments: [doc.uri, lens.range.start, locations],
    };
    return lens;
  }
}
