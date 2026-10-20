import type { Disposable, Range, TextDocument, Uri, ViewColumn } from "vscode";
import type { GrammarDocument, SymbolTable } from "../../types.ts";
import type { GrammarDialect } from "../dialects.ts";
import { normalizeSymbolName } from "../symbol-table.ts";
import {
  buildRuleDiagrams,
  createRefResolver,
  diagramAtLine,
  type RuleDiagram,
} from "./diagrams.ts";
import type { PanelLike, RailroadHost } from "./host.ts";
import { parseWebviewMessage } from "./messages.ts";
import { renderPage, renderRulesHtml, ruleDomId } from "./page.ts";

/**
 * Command ID of the preview.
 */
export const SHOW_RAILROAD_COMMAND = "bnf.showRailroadDiagram";

/**
 * The part of `GrammarWorkspace` the preview uses.
 */
export interface RailroadWorkspace {
  get(doc: TextDocument): {
    dialect: GrammarDialect;
    document: GrammarDocument;
    symbolTable: SymbolTable;
  };
  findDefinitions(
    name: string,
    dialect: GrammarDialect,
  ): Array<{ uri: Uri; rule: { nameRange: Range } }>;
  onDidChangeIndex(listener: () => void): Disposable;
}

/**
 * Timer functions the panel uses to debounce updates.
 */
export interface Scheduler {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/**
 * Tuning options for the preview.
 */
export interface RailroadOptions {
  /** Delay before re-rendering after edits. */
  debounceMs?: number;
  /** Delay before following the cursor. */
  focusDebounceMs?: number;
  scheduler?: Scheduler;
}

const DEFAULT_SCHEDULER: Scheduler = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const NO_FILE_HTML =
  '<p class="rr-empty">Open an ABNF, BNF, EBNF, or RBNF file to see its railroad diagrams.</p>';
const FAILED_HTML =
  '<p class="rr-empty">The diagrams could not be drawn for this document.</p>';

interface Rendered {
  title: string;
  html: string;
  focusId: string | undefined;
}

function baseName(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/**
 * The railroad preview: one webview panel that follows the active grammar
 * editor. Create it once; `show()` opens or reveals the panel.
 */
export class RailroadPreview implements Disposable {
  readonly #workspace: RailroadWorkspace;
  readonly #host: RailroadHost;
  readonly #debounceMs: number;
  readonly #focusDebounceMs: number;
  readonly #scheduler: Scheduler;
  #panel: PanelLike | undefined;
  #listeners: Disposable[] = [];
  #doc: TextDocument | undefined;
  #line = 0;
  #column: ViewColumn | undefined;
  #refreshTimer: unknown;
  #focusTimer: unknown;
  #lastHtml = "";
  #lastFocus: string | undefined;
  #diagrams: { uri: string; version: number; list: RuleDiagram[] } | undefined;

  constructor(
    workspace: RailroadWorkspace,
    host: RailroadHost,
    options: RailroadOptions = {},
  ) {
    this.#workspace = workspace;
    this.#host = host;
    this.#debounceMs = options.debounceMs ?? 250;
    this.#focusDebounceMs = options.focusDebounceMs ?? 100;
    this.#scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
  }

  /** True while a panel is open. */
  get isOpen(): boolean {
    return this.#panel !== undefined;
  }

  /**
   * Opens the panel beside the editor, or reveals and updates it.
   */
  show(): void {
    const editor = this.#host.activeGrammarEditor();
    if (!(editor || this.#doc)) {
      this.#host.showMessage(
        "Open an ABNF, BNF, EBNF, or RBNF file to show its railroad diagram.",
      );
      return;
    }
    if (editor) {
      this.#doc = editor.document;
      this.#line = editor.line;
      this.#column = editor.viewColumn;
    }
    if (this.#panel) {
      this.#panel.reveal(undefined, true);
      this.#refreshNow();
      return;
    }
    this.#open();
  }

  dispose(): void {
    const panel = this.#panel;
    this.#teardown();
    panel?.dispose();
  }

  #open(): void {
    const rendered = this.#render();
    const panel = this.#host.createPanel(rendered.title);
    this.#panel = panel;
    this.#lastHtml = rendered.html;
    this.#lastFocus = rendered.focusId;
    panel.webview.html = renderPage({
      nonce: this.#host.createNonce(),
      title: rendered.title,
      bodyHtml: rendered.html,
      focusId: rendered.focusId,
    });
    this.#listeners.push(
      panel.onDidDispose(() => this.#teardown()),
      panel.webview.onDidReceiveMessage((raw) => this.#onMessage(raw)),
      this.#host.onDidChangeActiveEditor(() => this.#onActiveEditor()),
      this.#host.onDidChangeSelection((doc, line) =>
        this.#onSelection(doc, line),
      ),
      this.#host.onDidChangeDocument((doc) => {
        if (this.#isCurrent(doc)) {
          this.#scheduleRefresh();
        }
      }),
      this.#host.onDidCloseDocument((doc) => {
        if (this.#isCurrent(doc)) {
          this.#doc = undefined;
          this.#diagrams = undefined;
          this.#refreshNow();
        }
      }),
      this.#workspace.onDidChangeIndex(() => this.#scheduleRefresh()),
    );
  }

  #teardown(): void {
    this.#clearTimers();
    for (const listener of this.#listeners) {
      listener.dispose();
    }
    this.#listeners = [];
    this.#panel = undefined;
    this.#doc = undefined;
    this.#diagrams = undefined;
    this.#lastHtml = "";
    this.#lastFocus = undefined;
  }

  #clearTimers(): void {
    if (this.#refreshTimer !== undefined) {
      this.#scheduler.clear(this.#refreshTimer);
      this.#refreshTimer = undefined;
    }
    if (this.#focusTimer !== undefined) {
      this.#scheduler.clear(this.#focusTimer);
      this.#focusTimer = undefined;
    }
  }

  #isCurrent(doc: TextDocument): boolean {
    return (
      this.#doc !== undefined && doc.uri.toString() === this.#doc.uri.toString()
    );
  }

  #onActiveEditor(): void {
    const editor = this.#host.activeGrammarEditor();
    if (!editor) {
      return;
    }
    this.#column = editor.viewColumn;
    if (this.#isCurrent(editor.document)) {
      this.#onSelection(editor.document, editor.line);
      return;
    }
    this.#doc = editor.document;
    this.#line = editor.line;
    this.#diagrams = undefined;
    this.#refreshNow();
  }

  #onSelection(doc: TextDocument, line: number): void {
    if (!this.#isCurrent(doc)) {
      return;
    }
    this.#line = line;
    if (this.#focusTimer !== undefined) {
      this.#scheduler.clear(this.#focusTimer);
    }
    this.#focusTimer = this.#scheduler.set(() => {
      this.#focusTimer = undefined;
      this.#followCursor();
    }, this.#focusDebounceMs);
  }

  #followCursor(): void {
    const panel = this.#panel;
    const cached = this.#diagrams;
    if (!(panel && this.#doc && cached)) {
      return;
    }
    if (cached.version !== this.#doc.version) {
      // Stale cache: the pending refresh will focus the right rule.
      return;
    }
    const focusId = this.#focusFor(cached.list);
    if (focusId !== undefined && focusId !== this.#lastFocus) {
      this.#lastFocus = focusId;
      this.#post({ type: "focus", id: focusId });
    }
  }

  #focusFor(list: readonly RuleDiagram[]): string | undefined {
    const found = diagramAtLine(list, this.#line);
    return found ? ruleDomId(found.id) : undefined;
  }

  #scheduleRefresh(): void {
    if (this.#refreshTimer !== undefined) {
      this.#scheduler.clear(this.#refreshTimer);
    }
    this.#refreshTimer = this.#scheduler.set(() => {
      this.#refreshTimer = undefined;
      this.#refreshNow();
    }, this.#debounceMs);
  }

  #refreshNow(): void {
    const panel = this.#panel;
    if (!panel) {
      return;
    }
    if (this.#refreshTimer !== undefined) {
      this.#scheduler.clear(this.#refreshTimer);
      this.#refreshTimer = undefined;
    }
    const rendered = this.#render();
    panel.title = rendered.title;
    if (rendered.html !== this.#lastHtml) {
      this.#lastHtml = rendered.html;
      this.#lastFocus = rendered.focusId;
      this.#post({
        type: "render",
        html: rendered.html,
        focus: rendered.focusId,
      });
    } else if (rendered.focusId !== this.#lastFocus && rendered.focusId) {
      this.#lastFocus = rendered.focusId;
      this.#post({ type: "focus", id: rendered.focusId });
    }
  }

  #post(message: unknown): void {
    try {
      this.#panel?.webview.postMessage(message)?.then(undefined, () => {});
    } catch {
      // The panel was disposed while a message was being sent.
    }
  }

  #render(): Rendered {
    const doc = this.#doc;
    if (!doc) {
      return {
        title: "Railroad diagram",
        html: NO_FILE_HTML,
        focusId: undefined,
      };
    }
    const title = `Railroad: ${baseName(doc.uri.path)}`;
    try {
      const parsed = this.#workspace.get(doc);
      const list = buildRuleDiagrams(parsed.document, parsed.dialect);
      this.#diagrams = {
        uri: doc.uri.toString(),
        version: doc.version,
        list,
      };
      const resolveRef = createRefResolver(
        list,
        parsed.dialect,
        (name) =>
          this.#workspace.findDefinitions(name, parsed.dialect).length > 0,
      );
      return {
        title,
        html: renderRulesHtml(list, { resolveRef }),
        focusId: this.#focusFor(list),
      };
    } catch {
      this.#diagrams = undefined;
      return { title, html: FAILED_HTML, focusId: undefined };
    }
  }

  #lookup(name: string): { uri: Uri; range: Range } | undefined {
    const doc = this.#doc;
    if (!doc) {
      return undefined;
    }
    try {
      const { dialect, symbolTable } = this.#workspace.get(doc);
      const local = symbolTable.definitions.get(
        normalizeSymbolName(name, dialect),
      )?.[0];
      if (local) {
        return { uri: doc.uri, range: local.nameRange };
      }
      const other = this.#workspace.findDefinitions(name, dialect)[0];
      return other
        ? { uri: other.uri, range: other.rule.nameRange }
        : undefined;
    } catch {
      return undefined;
    }
  }

  #onMessage(raw: unknown): void {
    if (!this.#panel) {
      return;
    }
    const message = parseWebviewMessage(
      raw,
      (name) => this.#lookup(name) !== undefined,
    );
    if (!message) {
      return;
    }
    const target = this.#lookup(message.rule);
    if (target) {
      this.#host
        .revealRange(target.uri, target.range, this.#column)
        .then(undefined, () => {});
    }
  }
}
