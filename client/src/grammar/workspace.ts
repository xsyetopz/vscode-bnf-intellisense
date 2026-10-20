import {
  type Disposable,
  EventEmitter,
  type FileSystemWatcher,
  RelativePattern,
  type TextDocument,
  type Uri,
  type WorkspaceFolder,
  workspace,
} from "vscode";
import type { GrammarDocument, Rule, SymbolTable } from "../types.ts";
import {
  buildGrammarSymbolTable,
  type GrammarDialect,
  grammarDialectFromLanguageId,
  grammarDialectFromPath,
  isGrammarLanguage,
  normalizeSymbolName,
  parseGrammar,
} from "./grammar.ts";
import { type GrammarToken, tokenizeGrammar } from "./tokenizer.ts";
import {
  createExclusionMatcher,
  type ExclusionMatcher,
  excludeGlob,
} from "./workspace-exclude.ts";

/**
 * Workspace index entry for a grammar rule definition.
 */
export interface IndexedRule {
  uri: Uri;
  dialect: GrammarDialect;
  rule: Rule;
}

interface CachedParse {
  version: number;
  dialect: GrammarDialect;
  document: GrammarDocument;
  symbolTable: SymbolTable;
  /** Lexical tokens of this version, produced on first use. */
  tokens?: readonly GrammarToken[];
}

interface IndexedFile {
  uri: Uri;
  dialect: GrammarDialect;
  rules: Rule[];
  symbolTable: SymbolTable;
}

/**
 * Filters indexed rules whose own name contains the query (case-insensitive).
 * The index key is "dialect:name", so it must not be matched against.
 */
export function matchSymbolsByName(
  entries: readonly IndexedRule[],
  query: string,
): IndexedRule[] {
  const lowerQuery = query.toLowerCase();
  return entries.filter((entry) =>
    entry.rule.name.toLowerCase().includes(lowerQuery),
  );
}

/**
 * Owns parse caches and workspace-wide grammar indexes.
 */
export class GrammarWorkspace implements Disposable {
  readonly #parseCache = new Map<string, CachedParse>();
  readonly #debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #index = new Map<string, IndexedRule[]>();
  readonly #fileToNames = new Map<string, Set<string>>();
  readonly #fileData = new Map<string, IndexedFile>();
  /** Open grammar documents whose current text is what the index holds. */
  readonly #openDocuments = new Map<string, TextDocument>();
  /** Open grammar documents hidden by `files.exclude`, kept for when it changes. */
  readonly #excludedOpenDocuments = new Map<string, TextDocument>();
  #isExcluded: ExclusionMatcher = createExclusionMatcher();
  /**
   * Stamp of the latest change to a file's index entry; stale reads check it.
   * Stamps come from one counter, so they stay unique after an entry is
   * dropped.
   */
  readonly #generations = new Map<string, number>();
  #lastGeneration = 0;
  readonly #subscriptions: Disposable[];
  /** Counts workspace folder changes, so reads can tell one happened. */
  #folderEpoch = 0;
  #disposed = false;
  #flatIndex: IndexedRule[] | undefined;
  readonly #indexChanged = new EventEmitter<void>();
  #watcher: FileSystemWatcher | undefined;
  /** Fires after a file was added to, changed in, or removed from the index. */
  readonly onDidChangeIndex = this.#indexChanged.event;

  constructor() {
    this.#subscriptions = [
      workspace.onDidCloseTextDocument((doc) =>
        this.removeDocument(doc.uri.toString()),
      ),
      workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("files.exclude")) {
          this.#isExcluded = createExclusionMatcher();
        }
      }),
      workspace.onDidChangeWorkspaceFolders((event) => {
        this.#folderEpoch++;
        this.#applyFolderChange(event.added).catch((error: unknown) => {
          console.error("BNF workspace indexing failed:", error);
        });
      }),
    ];
  }

  /**
   * Starts watching grammar files and indexes the workspace. Resolves when
   * the initial scan is done; callers that must not wait can ignore the
   * promise, and lookups fill in as files are indexed.
   */
  async initialize(): Promise<void> {
    this.#watcher = workspace.createFileSystemWatcher(FILE_GLOB);
    this.#watcher.onDidCreate((uri) => {
      if (!this.#isExcluded(uri) && !this.#outsideWorkspace(uri)) {
        void this.#indexFile(uri);
      }
    });
    this.#watcher.onDidChange((uri) => this.#reindexFile(uri));
    this.#watcher.onDidDelete((uri) => this.#forgetFile(uri));
    const files = await this.#scan();
    await Promise.all(files.map((uri) => this.#indexFile(uri)));
  }

  /**
   * Applies the current `files.exclude` setting: files it now hides leave the
   * index and files it no longer hides are indexed.
   */
  async refreshExclusions(): Promise<void> {
    this.#isExcluded = createExclusionMatcher();
    for (const file of Array.from(this.#fileData.values())) {
      if (this.#isExcluded(file.uri)) {
        const open = this.#openDocuments.get(file.uri.toString());
        if (open) {
          this.#openDocuments.delete(file.uri.toString());
          this.#excludedOpenDocuments.set(file.uri.toString(), open);
        }
        this.#forgetFile(file.uri);
      }
    }
    // Open documents the setting no longer hides show their buffer text.
    for (const doc of Array.from(this.#excludedOpenDocuments.values())) {
      if (!this.#isExcluded(doc.uri)) {
        this.#excludedOpenDocuments.delete(doc.uri.toString());
        this.syncOpenDocument(doc);
      }
    }
    const files = await this.#scan();
    await Promise.all(
      files
        .filter((uri) => !this.#fileData.has(uri.toString()))
        .map((uri) => this.#indexFile(uri)),
    );
  }

  /**
   * Scans added workspace folders and drops files that no remaining folder
   * holds; open documents keep their buffer text.
   */
  async #applyFolderChange(added: readonly WorkspaceFolder[]): Promise<void> {
    for (const file of Array.from(this.#fileData.values())) {
      if (!workspace.getWorkspaceFolder(file.uri)) {
        this.#forgetFile(file.uri);
      }
    }
    if (added.length === 0) {
      return;
    }
    const files = await this.#scan(added);
    await Promise.all(
      files
        .filter((uri) => !this.#fileData.has(uri.toString()))
        .map((uri) => this.#indexFile(uri)),
    );
  }

  /**
   * Finds the grammar files of workspace folders, each file once. Files of a
   * folder removed while the search ran are left out.
   */
  async #scan(
    folders: readonly WorkspaceFolder[] = workspace.workspaceFolders ?? [],
  ): Promise<Uri[]> {
    const epoch = this.#folderEpoch;
    const scans = folders.map((folder) =>
      workspace.findFiles(
        new RelativePattern(folder, FILE_GLOB),
        excludeGlob(folder),
      ),
    );
    const found = new Map<string, Uri>();
    // A folder nested in another is scanned by both; its own exclusions apply.
    for (const uri of (await Promise.all(scans)).flat()) {
      if (
        !this.#isExcluded(uri) &&
        (this.#folderEpoch === epoch || workspace.getWorkspaceFolder(uri))
      ) {
        found.set(uri.toString(), uri);
      }
    }
    return Array.from(found.values());
  }

  /**
   * Makes the index reflect the current text of an open grammar document,
   * including unsaved edits, until the document is closed.
   */
  syncOpenDocument(doc: TextDocument): void {
    if (
      this.#disposed ||
      !isGrammarLanguage(doc.languageId) ||
      !isWorkspaceScheme(doc.uri.scheme)
    ) {
      return;
    }
    const uriStr = doc.uri.toString();
    const { dialect, document, symbolTable } = this.get(doc);
    if (this.#isExcluded(doc.uri)) {
      // Parsed for diagnostics, but never offered to other files.
      this.#excludedOpenDocuments.set(uriStr, doc);
      this.#openDocuments.delete(uriStr);
      this.#forgetFile(doc.uri);
      return;
    }
    this.#excludedOpenDocuments.delete(uriStr);
    this.#bumpGeneration(uriStr);
    this.#openDocuments.set(uriStr, doc);
    this.#removeIndexedFile(doc.uri, false);
    this.#addIndexedFile(doc.uri, dialect, document, symbolTable);
    this.#indexChanged.fire();
  }

  get(doc: TextDocument): {
    dialect: GrammarDialect;
    document: GrammarDocument;
    symbolTable: SymbolTable;
  } {
    const uri = doc.uri.toString();
    const dialect = grammarDialectFromLanguageId(doc.languageId);
    const cached = this.#parseCache.get(uri);
    if (
      cached &&
      cached.version === doc.version &&
      cached.dialect === dialect
    ) {
      return {
        dialect: cached.dialect,
        document: cached.document,
        symbolTable: cached.symbolTable,
      };
    }
    const document = parseGrammar(doc.getText(), dialect);
    const symbolTable = buildGrammarSymbolTable(document, dialect);
    this.#parseCache.set(uri, {
      version: doc.version,
      dialect,
      document,
      symbolTable,
    });
    return { dialect, document, symbolTable };
  }

  /**
   * Lexical tokens of the document, computed once per document version and
   * dropped together with the parse when the version changes.
   */
  getTokens(doc: TextDocument): readonly GrammarToken[] {
    const { dialect } = this.get(doc);
    const cached = this.#parseCache.get(doc.uri.toString());
    if (!cached) {
      return tokenizeGrammar(doc.getText(), dialect);
    }
    cached.tokens ??= tokenizeGrammar(doc.getText(), dialect);
    return cached.tokens;
  }

  scheduleReparse(
    doc: TextDocument,
    callback: (doc: TextDocument) => void,
  ): void {
    const uri = doc.uri.toString();
    const existing = this.#debounceTimers.get(uri);
    if (existing) {
      clearTimeout(existing);
    }
    this.#debounceTimers.set(
      uri,
      setTimeout(() => {
        this.#debounceTimers.delete(uri);
        callback(doc);
      }, 200),
    );
  }

  removeDocument(uri: string): void {
    this.#parseCache.delete(uri);
    this.#excludedOpenDocuments.delete(uri);
    const open = this.#openDocuments.get(uri);
    if (open) {
      this.#openDocuments.delete(uri);
      if (workspace.getWorkspaceFolder(open.uri)) {
        // Back to the saved text on disk.
        void this.#reindexFile(open.uri);
      } else {
        // Nothing watches files outside the workspace folders.
        this.#forgetFile(open.uri);
      }
    }
    const timer = this.#debounceTimers.get(uri);
    if (timer) {
      clearTimeout(timer);
      this.#debounceTimers.delete(uri);
    }
  }

  findDefinitions(name: string, dialect: GrammarDialect): IndexedRule[] {
    return (
      this.#index.get(
        this.#indexKey(dialect, normalizeSymbolName(name, dialect)),
      ) ?? []
    );
  }

  getAllFiles(dialect?: GrammarDialect): IndexedFile[] {
    const files = Array.from(this.#fileData.values());
    return dialect ? files.filter((file) => file.dialect === dialect) : files;
  }

  searchSymbols(query: string): IndexedRule[] {
    this.#flatIndex ??= Array.from(this.#index.values()).flat();
    return matchSymbolsByName(this.#flatIndex, query);
  }

  dispose(): void {
    for (const subscription of this.#subscriptions) {
      subscription.dispose();
    }
    this.#watcher?.dispose();
    for (const timer of this.#debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.#debounceTimers.clear();
    this.#parseCache.clear();
    this.#index.clear();
    this.#fileToNames.clear();
    this.#fileData.clear();
    this.#openDocuments.clear();
    this.#excludedOpenDocuments.clear();
    this.#generations.clear();
    this.#flatIndex = undefined;
    this.#disposed = true;
    this.#indexChanged.dispose();
  }

  #bumpGeneration(uriStr: string): number {
    const generation = ++this.#lastGeneration;
    this.#generations.set(uriStr, generation);
    return generation;
  }

  async #indexFile(uri: Uri): Promise<void> {
    if (this.#disposed) {
      return;
    }
    const uriStr = uri.toString();
    const generation = this.#bumpGeneration(uriStr);
    const folderEpoch = this.#folderEpoch;
    try {
      const dialect = grammarDialectFromPath(uri.path);
      if (!dialect) {
        // Not a grammar file (an untitled buffer, say): nothing to index.
        this.#abandonRead(uri, generation);
        return;
      }
      const text = new TextDecoder().decode(await workspace.fs.readFile(uri));
      // A newer read, a removal, an open document's text, a new exclusion or
      // a removed folder outranks this read.
      if (
        this.#disposed ||
        this.#generations.get(uriStr) !== generation ||
        this.#openDocuments.has(uriStr) ||
        this.#isExcluded(uri) ||
        this.#outsideWorkspace(uri) ||
        (this.#folderEpoch !== folderEpoch &&
          !workspace.getWorkspaceFolder(uri))
      ) {
        this.#abandonRead(uri, generation);
        return;
      }
      const document = parseGrammar(text, dialect);
      const symbolTable = buildGrammarSymbolTable(document, dialect);
      this.#removeIndexedFile(uri, false);
      this.#addIndexedFile(uri, dialect, document, symbolTable);
      this.#indexChanged.fire();
    } catch {
      // The file is gone or unreadable: drop what the index holds of it,
      // unless a newer change already replaced this read.
      this.#abandonRead(uri, generation);
    }
  }

  /**
   * Drops what the index holds of a file when no newer change replaced the
   * read that gave up on it, which also frees the read's stamp.
   */
  #abandonRead(uri: Uri, generation: number): void {
    if (
      !this.#disposed &&
      this.#generations.get(uri.toString()) === generation
    ) {
      this.#forgetFile(uri);
    }
  }

  #addIndexedFile(
    uri: Uri,
    dialect: GrammarDialect,
    document: GrammarDocument,
    symbolTable: SymbolTable,
  ): void {
    if (this.#disposed) {
      return;
    }
    const uriStr = uri.toString();
    const names = new Set<string>();
    for (const rule of document.rules) {
      const key = this.#indexKey(
        dialect,
        normalizeSymbolName(rule.name, dialect),
      );
      names.add(key);
      const existing = this.#index.get(key) ?? [];
      existing.push({ uri, dialect, rule });
      this.#index.set(key, existing);
    }
    this.#fileToNames.set(uriStr, names);
    this.#fileData.set(uriStr, {
      uri,
      dialect,
      rules: document.rules,
      symbolTable,
    });
    this.#flatIndex = undefined;
  }

  async #reindexFile(uri: Uri): Promise<void> {
    if (this.#openDocuments.has(uri.toString())) {
      return;
    }
    if (this.#isExcluded(uri) || this.#outsideWorkspace(uri)) {
      this.#forgetFile(uri);
      return;
    }
    await this.#indexFile(uri);
  }

  /**
   * Whether the workspace has folders and none of them holds the file. A
   * window without folders has no such boundary.
   */
  #outsideWorkspace(uri: Uri): boolean {
    return (
      (workspace.workspaceFolders?.length ?? 0) > 0 &&
      !workspace.getWorkspaceFolder(uri)
    );
  }

  #forgetFile(uri: Uri): void {
    const uriStr = uri.toString();
    if (this.#openDocuments.has(uriStr)) {
      // The buffer still holds the rules; only reads in flight are outranked.
      this.#bumpGeneration(uriStr);
      return;
    }
    this.#removeIndexedFile(uri);
    // The removal outranks reads in flight: a missing stamp never matches.
    this.#generations.delete(uriStr);
  }

  #removeIndexedFile(uri: Uri, notify = true): void {
    const uriStr = uri.toString();
    if (!this.#fileData.has(uriStr)) {
      return;
    }
    const names = this.#fileToNames.get(uriStr);
    if (names) {
      for (const name of names) {
        const entries = this.#index.get(name);
        const filtered =
          entries?.filter((entry) => entry.uri.toString() !== uriStr) ?? [];
        if (filtered.length > 0) {
          this.#index.set(name, filtered);
        } else {
          this.#index.delete(name);
        }
      }
      this.#fileToNames.delete(uriStr);
    }
    this.#fileData.delete(uriStr);
    this.#flatIndex = undefined;
    if (notify) {
      this.#indexChanged.fire();
    }
  }

  #indexKey(dialect: GrammarDialect, name: string): string {
    return `${dialect}:${name}`;
  }
}

const FILE_GLOB = "**/*.{abnf,bnf,ebnf,rbnf}";
/**
 * Whether open documents of a URI scheme belong to the workspace: local files,
 * untitled buffers and the schemes of the workspace folders (virtual
 * workspaces). Diff, git and output views are left out.
 */
function isWorkspaceScheme(scheme: string): boolean {
  return (
    scheme === "file" ||
    scheme === "untitled" ||
    (workspace.workspaceFolders ?? []).some(
      (folder) => folder.uri.scheme === scheme,
    )
  );
}
