import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  changeWorkspaceFolders,
  createExtensionContext,
  diskFiles,
  findFilesGate,
  fireCloseTextDocument,
  fireConfigurationChange,
  fireDocumentEdit,
  fireFileEvent,
  fireOpenTextDocument,
  fireTextDocumentChange,
  providerRegistrations,
  readFileGate,
  resetConfigurationValues,
  resetExtensionHost,
  setConfigurationValue,
} from "../vscode-mock.ts";
import {
  asTextDocument,
  createDocument,
  eventually,
  loadGrammarTestCore,
} from "./provider-test-utils.ts";

let GrammarWorkspace: typeof import("../../grammar/workspace.ts").GrammarWorkspace;

beforeAll(async () => {
  await loadGrammarTestCore();
  ({ GrammarWorkspace } = await import("../../grammar/workspace.ts"));
});

const spies: Array<{ mockRestore(): void }> = [];

afterEach(() => {
  for (const spy of spies.splice(0)) {
    spy.mockRestore();
  }
  resetExtensionHost();
  resetConfigurationValues();
});

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const toPaths = (workspace: InstanceType<typeof GrammarWorkspace>, q: string) =>
  workspace
    .searchSymbols(q)
    .map((entry) => `${entry.uri.path}:${entry.rule.name}`)
    .sort();

describe("workspace index scan", () => {
  test("skips dependency and build folders", async () => {
    diskFiles.set("/w/grammar.abnf", "kept = %x41\n");
    for (const folder of ["node_modules/pkg", ".git/hooks", "out", "dist"]) {
      diskFiles.set(`/w/${folder}/skipped.abnf`, "skipped = %x41\n");
    }
    const workspace = new GrammarWorkspace();

    await workspace.initialize();

    expect(toPaths(workspace, "kept")).toEqual(["/w/grammar.abnf:kept"]);
    expect(toPaths(workspace, "skipped")).toEqual([]);
    workspace.dispose();
  });

  test("skips folders hidden by files.exclude", async () => {
    setConfigurationValue("files.exclude", { "**/vendor/**": true });
    diskFiles.set("/w/vendor/lib.abnf", "vendored = %x41\n");
    diskFiles.set("/w/own.abnf", "owned = %x41\n");
    const workspace = new GrammarWorkspace();

    await workspace.initialize();

    expect(toPaths(workspace, "vendored")).toEqual([]);
    expect(toPaths(workspace, "owned")).toEqual(["/w/own.abnf:owned"]);
    workspace.dispose();
  });

  test("symbol search sees a file opened after the scan", async () => {
    diskFiles.set("/w/a.bnf", "<alpha> ::= 'a'\n");
    const workspace = new GrammarWorkspace();
    await workspace.initialize();
    const open = createDocument("/w/b.bnf", "<alpine> ::= 'b'\n", "bnf");

    workspace.syncOpenDocument(asTextDocument(open));

    expect(toPaths(workspace, "al")).toEqual([
      "/w/a.bnf:<alpha>",
      "/w/b.bnf:<alpine>",
    ]);
    workspace.dispose();
  });

  test("symbol search drops a file that is closed and gone from disk", async () => {
    diskFiles.set("/w/a.bnf", "<alpha> ::= 'a'\n");
    const workspace = new GrammarWorkspace();
    await workspace.initialize();
    const open = createDocument("/w/b.bnf", "<alpine> ::= 'b'\n", "bnf");
    workspace.syncOpenDocument(asTextDocument(open));

    workspace.removeDocument(open.uri.toString());

    await eventually(() => toPaths(workspace, "alpine").length === 0);
    expect(toPaths(workspace, "al")).toEqual(["/w/a.bnf:<alpha>"]);
    workspace.dispose();
  });
});

describe("unsaved documents", () => {
  test("workspace symbols follow the open text", async () => {
    diskFiles.set("/w/a.abnf", "saved = %x41\n");
    const workspace = new GrammarWorkspace();
    await workspace.initialize();
    const edited = createDocument("/w/a.abnf", "typed = %x41\n", "abnf");
    edited.version = 2;

    workspace.syncOpenDocument(asTextDocument(edited));

    expect(toPaths(workspace, "typed")).toEqual(["/w/a.abnf:typed"]);
    expect(toPaths(workspace, "saved")).toEqual([]);
    workspace.dispose();
  });

  test("workspace symbols revert to the saved text on close", async () => {
    diskFiles.set("/w/a.abnf", "saved = %x41\n");
    const workspace = new GrammarWorkspace();
    await workspace.initialize();
    const edited = createDocument("/w/a.abnf", "typed = %x41\n", "abnf");
    workspace.syncOpenDocument(asTextDocument(edited));

    workspace.removeDocument(edited.uri.toString());

    await eventually(() => toPaths(workspace, "saved").length === 1);
    expect(toPaths(workspace, "typed")).toEqual([]);
    workspace.dispose();
  });

  test("a scan finishing after the document opened keeps the open text", async () => {
    diskFiles.set("/w/a.abnf", "saved = %x41\n");
    const workspace = new GrammarWorkspace();
    const open = createDocument("/w/a.abnf", "typed = %x41\n", "abnf");
    workspace.syncOpenDocument(asTextDocument(open));

    await workspace.initialize();

    expect(toPaths(workspace, "typed")).toEqual(["/w/a.abnf:typed"]);
    expect(toPaths(workspace, "saved")).toEqual([]);
    workspace.dispose();
  });
});

/** Lets reads and scans that are already answered finish. */
const settle = () => new Promise<void>((done) => setTimeout(done, 0));

describe("extension activation", () => {
  async function activate() {
    const { activateGrammarExtension } = await import("../../extension.ts");
    const context = createExtensionContext();
    await activateGrammarExtension(context as never);
    return context;
  }

  test("activation completes while the workspace scan is pending", async () => {
    diskFiles.set("/w/late.abnf", "latecomer = %x41\n");
    let release = () => {};
    findFilesGate.until = new Promise<void>((resolve) => {
      release = resolve;
    });
    providerRegistrations.length = 0;

    await activate();

    const registration = providerRegistrations.find(
      (entry) => entry.kind === "workspaceSymbol",
    );
    const provider = registration?.provider as {
      provideWorkspaceSymbols(query: string): unknown[];
    };
    expect(provider.provideWorkspaceSymbols("late")).toEqual([]);
    release();
    await eventually(() => provider.provideWorkspaceSymbols("late").length > 0);
    expect(provider.provideWorkspaceSymbols("late")).toHaveLength(1);
  });

  test("edits in other languages schedule no re-parse", async () => {
    const schedule = spyOn(
      GrammarWorkspace.prototype,
      "scheduleReparse",
    ).mockImplementation(() => undefined);
    spies.push(schedule);
    await activate();

    fireTextDocumentChange("typescript");

    expect(schedule).not.toHaveBeenCalled();
  });

  test("grammar events without content changes schedule no re-parse", async () => {
    const schedule = spyOn(
      GrammarWorkspace.prototype,
      "scheduleReparse",
    ).mockImplementation(() => undefined);
    spies.push(schedule);
    await activate();

    fireTextDocumentChange("abnf", []);

    expect(schedule).not.toHaveBeenCalled();
  });

  async function activatedWithSavedRule() {
    diskFiles.set("/w/a.abnf", "saved = %x41\n");
    providerRegistrations.length = 0;
    await activate();
    const provider = providerRegistrations.find(
      (entry) => entry.kind === "workspaceSymbol",
    )?.provider as { provideWorkspaceSymbols(query: string): unknown[] };
    const count = (query: string) =>
      provider.provideWorkspaceSymbols(query).length;
    await eventually(() => count("saved") === 1);
    return count;
  }

  test("workspace symbols follow edits of an open document", async () => {
    const count = await activatedWithSavedRule();
    const opened = createDocument("/w/a.abnf", "saved = %x41\n", "abnf");
    const edited = createDocument(
      "/w/a.abnf",
      "saved = %x41\ntyped = %x42\n",
      "abnf",
    );
    edited.version = 2;

    fireOpenTextDocument(opened);
    fireDocumentEdit(edited);

    await eventually(() => count("typed") === 1);
    expect(count("saved")).toBe(1);
  });

  test("workspace symbols revert to the saved text when an edited document closes", async () => {
    const count = await activatedWithSavedRule();
    const opened = createDocument("/w/a.abnf", "saved = %x41\n", "abnf");
    const edited = createDocument(
      "/w/a.abnf",
      "saved = %x41\ntyped = %x42\n",
      "abnf",
    );
    edited.version = 2;
    fireOpenTextDocument(opened);
    fireDocumentEdit(edited);
    await eventually(() => count("typed") === 1);

    fireCloseTextDocument(edited);

    await eventually(() => count("typed") === 0);
    expect(count("saved")).toBe(1);
  });

  describe("workspace folder changes", () => {
    test("files of an added folder are indexed", async () => {
      diskFiles.set("/x/added.abnf", "addedRule = %x41\n");
      const count = await activatedWithSavedRule();

      changeWorkspaceFolders(["/w", "/x"]);

      await eventually(() => count("addedRule") === 1);
      expect(count("saved")).toBe(1);
    });

    test("files of a removed folder leave the index", async () => {
      diskFiles.set("/x/kept.abnf", "keptRule = %x41\n");
      changeWorkspaceFolders(["/w", "/x"]);
      const count = await activatedWithSavedRule();
      await eventually(() => count("keptRule") === 1);

      changeWorkspaceFolders(["/x"]);

      await eventually(() => count("saved") === 0);
      expect(count("keptRule")).toBe(1);
    });

    test("an open document of a removed folder keeps its text", async () => {
      const count = await activatedWithSavedRule();
      fireOpenTextDocument(
        createDocument("/w/a.abnf", "typed = %x41\n", "abnf"),
      );
      await eventually(() => count("typed") === 1);

      changeWorkspaceFolders(["/x"]);

      expect(count("saved")).toBe(0);
      expect(count("typed")).toBe(1);
    });

    test("a read in flight for a removed folder does not enter the index", async () => {
      const count = await activatedWithSavedRule();
      diskFiles.set("/x/b.abnf", "xb = %x41\n");
      const reading = deferred();
      const release = deferred();
      const returned = deferred();
      readFileGate.before = (path) => {
        if (path !== "/x/b.abnf") {
          return undefined;
        }
        reading.resolve();
        return release.promise.then(() => returned.resolve());
      };
      changeWorkspaceFolders(["/w", "/x"]);
      await reading.promise;

      changeWorkspaceFolders(["/w"]);
      release.resolve();
      await returned.promise;
      await settle();

      expect(count("xb")).toBe(0);
    });

    test("a folder removed before its scan finishes is not indexed", async () => {
      const count = await activatedWithSavedRule();
      diskFiles.set("/x/b.abnf", "xb = %x41\n");
      const scanning = deferred();
      findFilesGate.until = scanning.promise;
      changeWorkspaceFolders(["/w", "/x"]);

      changeWorkspaceFolders(["/w"]);
      scanning.resolve();
      await settle();

      expect(count("xb")).toBe(0);
    });

    test("an open document of a removed folder leaves the index when closed", async () => {
      const count = await activatedWithSavedRule();
      const open = createDocument("/w/a.abnf", "typed = %x41\n", "abnf");
      fireOpenTextDocument(open);
      await eventually(() => count("typed") === 1);
      changeWorkspaceFolders(["/x"]);

      fireCloseTextDocument(open);
      await settle();

      expect(count("typed")).toBe(0);
      expect(count("saved")).toBe(0);
    });

    test("a read in flight when the last folder is removed does not enter the index", async () => {
      const count = await activatedWithSavedRule();
      diskFiles.set("/w/b.abnf", "wb = %x41\n");
      const reading = deferred();
      const release = deferred();
      const returned = deferred();
      readFileGate.before = (path) => {
        if (path !== "/w/b.abnf") {
          return undefined;
        }
        reading.resolve();
        return release.promise.then(() => returned.resolve());
      };
      fireFileEvent("create", "/w/b.abnf");
      await reading.promise;

      changeWorkspaceFolders([]);
      release.resolve();
      await returned.promise;
      await settle();

      expect(count("wb")).toBe(0);
    });

    test("a file closed in a window without folders leaves the index", async () => {
      changeWorkspaceFolders([]);
      diskFiles.set("/y/o.abnf", "outside = %x41\n");
      providerRegistrations.length = 0;
      await activate();
      const provider = providerRegistrations.find(
        (entry) => entry.kind === "workspaceSymbol",
      )?.provider as { provideWorkspaceSymbols(query: string): unknown[] };
      const open = createDocument("/y/o.abnf", "typed = %x41\n", "abnf");
      fireOpenTextDocument(open);
      await eventually(
        () => provider.provideWorkspaceSymbols("typed").length === 1,
      );

      fireCloseTextDocument(open);
      await settle();

      expect(provider.provideWorkspaceSymbols("typed")).toEqual([]);
      expect(provider.provideWorkspaceSymbols("outside")).toEqual([]);
    });

    test("an initial scan in flight when the last folder is removed indexes nothing", async () => {
      diskFiles.set("/w/a.abnf", "wa = %x41\n");
      const scanning = deferred();
      findFilesGate.until = scanning.promise;
      const workspace = new GrammarWorkspace();
      const initial = workspace.initialize();

      changeWorkspaceFolders([]);
      scanning.resolve();
      await initial;

      expect(workspace.searchSymbols("wa")).toEqual([]);
      workspace.dispose();
    });

    test("an added folder's scan in flight when the last folder is removed indexes nothing", async () => {
      const count = await activatedWithSavedRule();
      diskFiles.set("/x/b.abnf", "xb = %x41\n");
      const scanning = deferred();
      findFilesGate.until = scanning.promise;
      changeWorkspaceFolders(["/w", "/x"]);

      changeWorkspaceFolders([]);
      scanning.resolve();
      await settle();

      expect(count("xb")).toBe(0);
    });

    test("a rescan after a files.exclude change in flight when the last folder is removed indexes nothing", async () => {
      const count = await activatedWithSavedRule();
      diskFiles.set("/w/late.abnf", "late = %x41\n");
      const scanning = deferred();
      findFilesGate.until = scanning.promise;
      setConfigurationValue("files.exclude", { "**/vendor/**": true });
      fireConfigurationChange("files.exclude");

      changeWorkspaceFolders([]);
      scanning.resolve();
      await settle();

      expect(count("late")).toBe(0);
    });

    test("a file outside the workspace leaves the index when closed", async () => {
      const count = await activatedWithSavedRule();
      diskFiles.set("/y/o.abnf", "outside = %x41\n");
      const open = createDocument("/y/o.abnf", "typed = %x41\n", "abnf");
      fireOpenTextDocument(open);
      await eventually(() => count("typed") === 1);

      fireCloseTextDocument(open);
      await settle();

      expect(count("typed")).toBe(0);
      expect(count("outside")).toBe(0);
    });
  });

  test("grammar edits schedule a re-parse", async () => {
    const schedule = spyOn(
      GrammarWorkspace.prototype,
      "scheduleReparse",
    ).mockImplementation(() => undefined);
    spies.push(schedule);
    await activate();

    fireTextDocumentChange("abnf");

    expect(schedule).toHaveBeenCalledTimes(1);
  });
});

describe("concurrent reads of one file", () => {
  test("a read overtaken by a newer read does not replace the newer text", async () => {
    diskFiles.set("/w/a.abnf", "old = %x41\n");
    const firstRead = deferred();
    const releaseFirst = deferred();
    let reads = 0;
    readFileGate.before = () => {
      reads++;
      if (reads > 1) {
        return undefined;
      }
      firstRead.resolve();
      return releaseFirst.promise;
    };
    const workspace = new GrammarWorkspace();
    const scan = workspace.initialize();
    await firstRead.promise;
    diskFiles.set("/w/a.abnf", "fresh = %x41\n");

    fireFileEvent("change", "/w/a.abnf");
    await eventually(() => toPaths(workspace, "fresh").length === 1);
    releaseFirst.resolve();
    await scan;

    expect(toPaths(workspace, "fresh")).toEqual(["/w/a.abnf:fresh"]);
    expect(toPaths(workspace, "old")).toEqual([]);
    workspace.dispose();
  });

  test("two change events at once leave one definition", async () => {
    diskFiles.set("/w/a.abnf", "dup = %x41\n");
    const workspace = new GrammarWorkspace();
    await workspace.initialize();
    let changes = 0;
    workspace.onDidChangeIndex(() => changes++);
    const release = deferred();
    readFileGate.before = () => release.promise;

    fireFileEvent("change", "/w/a.abnf");
    fireFileEvent("change", "/w/a.abnf");
    release.resolve();
    await eventually(() => changes > 0);

    expect(workspace.findDefinitions("dup", "abnf")).toHaveLength(1);
    expect(workspace.searchSymbols("dup")).toHaveLength(1);
    workspace.dispose();
  });

  test("a scan finishing after the close of an open document adds one definition", async () => {
    diskFiles.set("/w/d.abnf", "dup = %x41\n");
    const workspace = new GrammarWorkspace();
    const open = createDocument("/w/d.abnf", "dup = %x41\n", "abnf");
    workspace.syncOpenDocument(asTextDocument(open));
    const scanRead = deferred();
    const releaseScanRead = deferred();
    let reads = 0;
    readFileGate.before = () => {
      reads++;
      if (reads > 1) {
        return undefined;
      }
      scanRead.resolve();
      return releaseScanRead.promise;
    };
    const scan = workspace.initialize();
    await scanRead.promise;
    let changes = 0;
    workspace.onDidChangeIndex(() => changes++);

    workspace.removeDocument(open.uri.toString());
    await eventually(() => changes > 0);
    releaseScanRead.resolve();
    await scan;

    expect(workspace.findDefinitions("dup", "abnf")).toHaveLength(1);
    workspace.dispose();
  });

  test("a file deleted while it is read stays out of the index", async () => {
    diskFiles.set("/w/a.abnf", "gone = %x41\n");
    const reading = deferred();
    const release = deferred();
    readFileGate.before = () => {
      reading.resolve();
      return release.promise;
    };
    const workspace = new GrammarWorkspace();
    const scan = workspace.initialize();
    await reading.promise;

    fireFileEvent("delete", "/w/a.abnf");
    release.resolve();
    await scan;

    expect(toPaths(workspace, "gone")).toEqual([]);
    workspace.dispose();
  });

  test("a read finishing after dispose indexes nothing", async () => {
    diskFiles.set("/w/a.abnf", "late = %x41\n");
    const reading = deferred();
    const release = deferred();
    readFileGate.before = () => {
      reading.resolve();
      return release.promise;
    };
    const workspace = new GrammarWorkspace();
    const scan = workspace.initialize();
    await reading.promise;

    workspace.dispose();
    release.resolve();
    await scan;

    expect(toPaths(workspace, "late")).toEqual([]);
  });

  test("opening a document after dispose indexes nothing", async () => {
    const workspace = new GrammarWorkspace();
    await workspace.initialize();
    workspace.dispose();
    const open = createDocument("/w/a.abnf", "after = %x41\n", "abnf");

    workspace.syncOpenDocument(asTextDocument(open));

    expect(toPaths(workspace, "after")).toEqual([]);
  });
});

describe("failed background scan", () => {
  test("a failed scan of an added folder is logged", async () => {
    const log = spyOn(console, "error").mockImplementation(() => undefined);
    spies.push(log);
    const { activateGrammarExtension } = await import("../../extension.ts");
    await activateGrammarExtension(createExtensionContext() as never);
    findFilesGate.until = Promise.reject(new Error("folder scan exploded"));
    findFilesGate.until.catch(() => undefined);

    changeWorkspaceFolders(["/w", "/x"]);

    await eventually(() => log.mock.calls.length > 0);
    expect(String(log.mock.calls[0]?.[0])).toContain(
      "BNF workspace indexing failed:",
    );
    expect(String(log.mock.calls[0]?.[1])).toContain("folder scan exploded");
  });

  test("a failed rescan after a files.exclude change is logged", async () => {
    const log = spyOn(console, "error").mockImplementation(() => undefined);
    spies.push(log);
    const { activateGrammarExtension } = await import("../../extension.ts");
    await activateGrammarExtension(createExtensionContext() as never);
    findFilesGate.until = Promise.reject(new Error("rescan exploded"));
    findFilesGate.until.catch(() => undefined);

    setConfigurationValue("files.exclude", { "**/vendor/**": true });
    fireConfigurationChange("files.exclude");

    await eventually(() => log.mock.calls.length > 0);
    expect(String(log.mock.calls[0]?.[1])).toContain("rescan exploded");
  });

  test("the failure is logged", async () => {
    const log = spyOn(console, "error").mockImplementation(() => undefined);
    spies.push(log);
    findFilesGate.until = Promise.reject(new Error("scan exploded"));
    findFilesGate.until.catch(() => undefined);

    const { activateGrammarExtension } = await import("../../extension.ts");
    await activateGrammarExtension(createExtensionContext() as never);
    await eventually(() => log.mock.calls.length > 0);

    expect(String(log.mock.calls[0]?.[1])).toContain("scan exploded");
  });
});
