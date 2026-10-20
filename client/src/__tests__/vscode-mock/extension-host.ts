import { openTextDocuments } from "./providers.ts";

type Disposable = { dispose(): void };
type DocumentLike = { uri: { toString(): string }; languageId: string };

/**
 * Diagnostics collection double that records what was set per document.
 */
export class DiagnosticCollectionMock {
  readonly entries = new Map<string, unknown[]>();

  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  set(uri: { toString(): string }, diagnostics: unknown[]): void {
    this.entries.set(uri.toString(), diagnostics);
  }

  delete(uri: { toString(): string }): void {
    this.entries.delete(uri.toString());
  }

  dispose(): void {
    this.entries.clear();
  }
}

const createdContexts: Array<{ subscriptions: Disposable[] }> = [];

export const diagnosticCollections: DiagnosticCollectionMock[] = [];
export const registeredCommands = new Map<string, (...args: never[]) => void>();
export const contentProviderSchemes: string[] = [];

/**
 * Arguments of every `createWebviewPanel` call.
 */
export const createdWebviewPanels: Array<{
  viewType: string;
  title: string;
  showOptions: unknown;
  options: unknown;
}> = [];

/**
 * Grammar files on the mocked disk, by path.
 */
export const diskFiles = new Map<string, string>();

/**
 * While set, `findFiles` waits for this promise before answering.
 */
export const findFilesGate: { until: Promise<void> | undefined } = {
  until: undefined,
};

/**
 * Called by `fs.readFile` after it captured the file text and before it
 * answers, so tests can hold back individual reads.
 */
export const readFileGate: {
  before: ((path: string) => Promise<void> | undefined) | undefined;
} = { before: undefined };

type MockUri = { scheme: string; path: string; toString(): string };
type MockFolder = { uri: MockUri; name: string; index: number };

/**
 * Builds a URI that stringifies like the URIs of the document doubles.
 */
export function mockUri(path: string, scheme = "file"): MockUri {
  return {
    scheme,
    path,
    toString: () =>
      scheme === "file" ? `file://${path}` : `${scheme}://${path}`,
  };
}

const DEFAULT_FOLDERS = ["/w"];

/**
 * Workspace folders reported by the mocked workspace.
 */
export let workspaceFolders: MockFolder[] | undefined =
  foldersOf(DEFAULT_FOLDERS);

function foldersOf(paths: string[], scheme = "file"): MockFolder[] {
  return paths.map((path, index) => ({
    uri: mockUri(path, scheme),
    name: path,
    index,
  }));
}

/**
 * Replaces the workspace folders; an empty list means no folder is open.
 */
export function setWorkspaceFolders(paths: string[], scheme = "file"): void {
  workspaceFolders = paths.length > 0 ? foldersOf(paths, scheme) : undefined;
}

type FolderChange = { added: MockFolder[]; removed: MockFolder[] };
const folderListeners = new Set<(event: FolderChange) => void>();

/**
 * Replaces the workspace folders and notifies listeners of the folders that
 * came and went, as VS Code does.
 */
export function changeWorkspaceFolders(paths: string[]): void {
  const before = workspaceFolders ?? [];
  setWorkspaceFolders(paths);
  const after = workspaceFolders ?? [];
  const has = (list: MockFolder[], folder: MockFolder) =>
    list.some((entry) => entry.uri.path === folder.uri.path);
  const event = {
    added: after.filter((folder) => !has(before, folder)),
    removed: before.filter((folder) => !has(after, folder)),
  };
  for (const listener of folderListeners) {
    listener(event);
  }
}

/**
 * Pattern relative to a base folder, as `vscode.RelativePattern`.
 */
export class RelativePatternMock {
  readonly baseUri: MockUri;
  readonly pattern: string;

  constructor(base: MockFolder | MockUri | string, pattern: string) {
    this.baseUri =
      typeof base === "string"
        ? mockUri(base)
        : "uri" in base
          ? base.uri
          : base;
    this.pattern = pattern;
  }
}

type WatcherHandlers = {
  create: Set<(uri: MockUri) => void>;
  change: Set<(uri: MockUri) => void>;
  delete: Set<(uri: MockUri) => void>;
};
const watchers = new Set<WatcherHandlers>();

/**
 * Simulates a file system event for every live file system watcher.
 */
export function fireFileEvent(
  kind: "create" | "change" | "delete",
  path: string,
): void {
  for (const watcher of [...watchers]) {
    for (const handler of watcher[kind]) {
      handler(mockUri(path));
    }
  }
}

/**
 * Converts the glob subset used by `findFiles` (`**`, `*`, `{a,b}`) into a
 * regular expression. Nested `{}` groups throw, as VS Code globs reject them.
 */
function globToRegExp(glob: string): RegExp {
  let source = "";
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const char = glob.charAt(i);
    if (glob.startsWith("**/", i)) {
      source += "(?:.*/)?";
      i += 2;
    } else if (glob.startsWith("/**", i)) {
      source += "/.*";
      i += 2;
    } else if (char === "\\" && i + 1 < glob.length) {
      i++;
      source += glob.charAt(i).replace(/[.+?^${}()|[\]\\*]/g, "\\$&");
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "{") {
      if (depth > 0) {
        throw new Error(`nested alternates are not supported: ${glob}`);
      }
      depth++;
      source += "(?:";
    } else if (char === "}") {
      depth--;
      source += ")";
    } else if (char === "," && depth > 0) {
      source += "|";
    } else {
      source += char.replace(/[.+?^$()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^/?${source}$`);
}

const openListeners = new Set<(doc: DocumentLike) => void>();
const closeListeners = new Set<(doc: DocumentLike) => void>();

function listen<T>(listeners: Set<T>) {
  return (listener: T): Disposable => {
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) };
  };
}

const noopDisposable = (): Disposable => ({ dispose: () => undefined });
const noopEvent = () => noopDisposable();

/**
 * Members of `vscode.languages` the extension activation needs.
 */
export const languagesHostMock = {
  createDiagnosticCollection: (name: string) => {
    const collection = new DiagnosticCollectionMock(name);
    diagnosticCollections.push(collection);
    return collection;
  },
};

/**
 * Members of `vscode.workspace` the extension activation needs.
 */
export const workspaceHostMock = {
  onDidChangeWorkspaceFolders: (listener: (event: FolderChange) => void) => {
    folderListeners.add(listener);
    return { dispose: () => folderListeners.delete(listener) };
  },
  getWorkspaceFolder: (uri: { path: string; scheme: string }) =>
    workspaceFolders
      ?.filter(
        (folder) =>
          folder.uri.scheme === uri.scheme &&
          uri.path.startsWith(`${folder.uri.path}/`),
      )
      // The innermost folder wins, as in VS Code.
      .sort((a, b) => b.uri.path.length - a.uri.path.length)[0],
  findFiles: async (
    include: string | RelativePatternMock,
    exclude?: string,
  ) => {
    await findFilesGate.until;
    // VS Code builds a plain glob search from the workspace folders.
    if (typeof include === "string" && !workspaceFolders?.length) {
      return [];
    }
    const included = globToRegExp(
      typeof include === "string" ? include : include.pattern,
    );
    const excluded = exclude ? globToRegExp(exclude) : undefined;
    // Relative patterns match paths below their base folder.
    const base = typeof include === "string" ? "" : `${include.baseUri.path}/`;
    return [...diskFiles.keys()]
      .filter((path) => path.startsWith(base))
      .filter((path) => {
        const relative = base ? path.slice(base.length) : path;
        return included.test(relative) && !excluded?.test(relative);
      })
      .map((path) =>
        mockUri(
          path,
          typeof include === "string" ? "file" : include.baseUri.scheme,
        ),
      );
  },
  fs: {
    readFile: async (uri: { path: string }) => {
      const text = diskFiles.get(uri.path);
      if (text === undefined) {
        throw new Error(`no such file: ${uri.path}`);
      }
      await readFileGate.before?.(uri.path);
      return new TextEncoder().encode(text);
    },
  },
  createFileSystemWatcher: () => {
    const handlers: WatcherHandlers = {
      create: new Set(),
      change: new Set(),
      delete: new Set(),
    };
    watchers.add(handlers);
    const on =
      (kind: keyof WatcherHandlers) => (handler: (uri: MockUri) => void) => {
        handlers[kind].add(handler);
        return noopDisposable();
      };
    return {
      onDidCreate: on("create"),
      onDidChange: on("change"),
      onDidDelete: on("delete"),
      dispose: () => watchers.delete(handlers),
    };
  },
  registerTextDocumentContentProvider: (scheme: string) => {
    contentProviderSchemes.push(scheme);
    return noopDisposable();
  },
  onDidOpenTextDocument: listen(openListeners),
  onDidCloseTextDocument: listen(closeListeners),
};

/**
 * `vscode.commands` double that records registered command handlers.
 */
export const commandsHostMock = {
  registerCommand: (id: string, handler: (...args: never[]) => void) => {
    if (registeredCommands.has(id)) {
      throw new Error(`command '${id}' already exists`);
    }
    registeredCommands.set(id, handler);
    return { dispose: () => registeredCommands.delete(id) };
  },
};

/**
 * `vscode.window` double with inert editor events and webview creation.
 */
export const windowHostMock = {
  activeTextEditor: undefined,
  onDidChangeActiveTextEditor: noopEvent,
  onDidChangeTextEditorSelection: noopEvent,
  createWebviewPanel: (
    viewType: string,
    title: string,
    showOptions: unknown,
    options: unknown,
  ) => {
    createdWebviewPanels.push({ viewType, title, showOptions, options });
    return {
      webview: {
        html: "",
        postMessage: async () => true,
        onDidReceiveMessage: noopEvent,
      },
      title,
      reveal: () => undefined,
      dispose: () => undefined,
      onDidDispose: noopEvent,
    };
  },
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showQuickPick: async () => undefined,
  showTextDocument: async () => undefined,
};

/**
 * Simulates VS Code opening a document.
 */
export function fireOpenTextDocument(doc: DocumentLike): void {
  for (const listener of openListeners) {
    listener(doc);
  }
}

/**
 * Simulates VS Code closing a document.
 */
export function fireCloseTextDocument(doc: DocumentLike): void {
  for (const listener of closeListeners) {
    listener(doc);
  }
}

/**
 * Number of listeners currently registered for closed documents.
 */
export function closeListenerCount(): number {
  return closeListeners.size;
}

/**
 * Minimal `ExtensionContext` whose subscriptions can be disposed.
 */
export function createExtensionContext(): {
  subscriptions: Disposable[];
} {
  const context = { subscriptions: [] as Disposable[] };
  createdContexts.push(context);
  return context;
}

/**
 * Disposes the subscriptions of every context created so far, then forgets
 * everything recorded by the extension host doubles.
 */
export function resetExtensionHost(): void {
  for (const context of createdContexts.splice(0)) {
    for (const subscription of context.subscriptions) {
      subscription.dispose();
    }
  }
  diagnosticCollections.length = 0;
  registeredCommands.clear();
  contentProviderSchemes.length = 0;
  createdWebviewPanels.length = 0;
  openListeners.clear();
  closeListeners.clear();
  openTextDocuments.length = 0;
  diskFiles.clear();
  folderListeners.clear();
  findFilesGate.until = undefined;
  readFileGate.before = undefined;
  watchers.clear();
  workspaceFolders = foldersOf(DEFAULT_FOLDERS);
}
