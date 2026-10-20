import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  createExtensionContext,
  diskFiles,
  fireConfigurationChange,
  fireFileEvent,
  providerRegistrations,
  readFileGate,
  resetConfigurationValues,
  resetExtensionHost,
  setConfigurationValue,
  setFolderConfigurationValue,
  setWorkspaceFolders,
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

afterEach(() => {
  resetExtensionHost();
  resetConfigurationValues();
});

const toPaths = (workspace: InstanceType<typeof GrammarWorkspace>, q: string) =>
  workspace
    .searchSymbols(q)
    .map((entry) => `${entry.uri.path}:${entry.rule.name}`)
    .sort();

/**
 * Waits until the events fired so far are processed, by firing one more for a
 * file that is always indexed and waiting for it to show up.
 */
async function indexedAfterEvents(
  workspace: InstanceType<typeof GrammarWorkspace>,
): Promise<void> {
  diskFiles.set("/w/sentinel.abnf", "sentinel = %x41\n");
  fireFileEvent("create", "/w/sentinel.abnf");
  await eventually(() => toPaths(workspace, "sentinel").length === 1);
}

async function scanned() {
  const workspace = new GrammarWorkspace();
  await workspace.initialize();
  return workspace;
}

describe("build folder exclusion", () => {
  test("keeps grammar folders named out or dist below the root", async () => {
    diskFiles.set("/w/src/out/nested.abnf", "nested = %x41\n");
    diskFiles.set("/w/src/dist/deep.abnf", "deep = %x41\n");

    const workspace = await scanned();

    expect(toPaths(workspace, "nested")).toEqual([
      "/w/src/out/nested.abnf:nested",
    ]);
    expect(toPaths(workspace, "deep")).toEqual(["/w/src/dist/deep.abnf:deep"]);
    workspace.dispose();
  });

  test("skips out and dist at the workspace folder root", async () => {
    diskFiles.set("/w/out/built.abnf", "built = %x41\n");
    diskFiles.set("/w/dist/bundled.abnf", "bundled = %x41\n");

    const workspace = await scanned();

    expect(toPaths(workspace, "built")).toEqual([]);
    expect(toPaths(workspace, "bundled")).toEqual([]);
    workspace.dispose();
  });
});

describe("files.exclude patterns", () => {
  test("a pattern with braces hides every alternative", async () => {
    setConfigurationValue("files.exclude", { "**/gen/*.{abnf,bnf}": true });
    diskFiles.set("/w/gen/a.abnf", "genA = %x41\n");
    diskFiles.set("/w/gen/b.bnf", "<genB> ::= 'b'\n");
    diskFiles.set("/w/gen/c.ebnf", "genC ::= 'c'\n");

    const workspace = await scanned();

    expect(toPaths(workspace, "gen")).toEqual(["/w/gen/c.ebnf:genC"]);
    workspace.dispose();
  });

  test("an entry with a when clause does not hide anything", async () => {
    setConfigurationValue("files.exclude", {
      "**/vendor/**": { when: "$(basename).abnf" },
    });
    diskFiles.set("/w/vendor/lib.abnf", "vendored = %x41\n");

    const workspace = await scanned();

    expect(toPaths(workspace, "vendored")).toEqual([
      "/w/vendor/lib.abnf:vendored",
    ]);
    workspace.dispose();
  });

  test("an entry switched off does not hide anything", async () => {
    setConfigurationValue("files.exclude", { "**/vendor/**": false });
    diskFiles.set("/w/vendor/lib.abnf", "vendored = %x41\n");

    const workspace = await scanned();

    expect(toPaths(workspace, "vendored")).toEqual([
      "/w/vendor/lib.abnf:vendored",
    ]);
    workspace.dispose();
  });

  test("each workspace folder applies its own setting", async () => {
    setWorkspaceFolders(["/a", "/b"]);
    setFolderConfigurationValue("/a", "files.exclude", { "gen/**": true });
    diskFiles.set("/a/gen/x.abnf", "inA = %x41\n");
    diskFiles.set("/b/gen/y.abnf", "inB = %x41\n");

    const workspace = await scanned();

    expect(toPaths(workspace, "in")).toEqual(["/b/gen/y.abnf:inB"]);
    workspace.dispose();
  });

  test("a window without folders indexes nothing from disk", async () => {
    setWorkspaceFolders([]);
    diskFiles.set("/x/own.abnf", "owned = %x41\n");

    const workspace = await scanned();

    expect(toPaths(workspace, "owned")).toEqual([]);
    workspace.dispose();
  });
});

describe("nested workspace folders", () => {
  test("a file in both folders is read once", async () => {
    setWorkspaceFolders(["/w", "/w/sub"]);
    diskFiles.set("/w/sub/y.abnf", "yy = %x41\n");
    const reads: string[] = [];
    readFileGate.before = (path) => {
      reads.push(path);
      return undefined;
    };

    const workspace = await scanned();

    expect(reads).toEqual(["/w/sub/y.abnf"]);
    expect(workspace.findDefinitions("yy", "abnf")).toHaveLength(1);
    workspace.dispose();
  });
});

describe("file events in excluded folders", () => {
  test("a created file in node_modules is not indexed", async () => {
    const workspace = await scanned();
    diskFiles.set("/w/node_modules/pkg/g.abnf", "pkgRule = %x41\n");

    fireFileEvent("create", "/w/node_modules/pkg/g.abnf");
    await indexedAfterEvents(workspace);

    expect(toPaths(workspace, "pkgRule")).toEqual([]);
    workspace.dispose();
  });

  test("a changed file under a files.exclude folder is not indexed", async () => {
    setConfigurationValue("files.exclude", { "**/vendor": true });
    const workspace = await scanned();
    diskFiles.set("/w/vendor/lib.abnf", "vendored = %x41\n");

    fireFileEvent("change", "/w/vendor/lib.abnf");
    await indexedAfterEvents(workspace);

    expect(toPaths(workspace, "vendored")).toEqual([]);
    workspace.dispose();
  });

  test("a created file outside the exclusions is indexed", async () => {
    const workspace = await scanned();
    diskFiles.set("/w/new.abnf", "fresh = %x41\n");

    fireFileEvent("create", "/w/new.abnf");
    await eventually(() => toPaths(workspace, "fresh").length === 1);

    expect(toPaths(workspace, "fresh")).toEqual(["/w/new.abnf:fresh"]);
    workspace.dispose();
  });

  test("closing an excluded open document removes it from the index", async () => {
    setConfigurationValue("files.exclude", { "**/vendor/**": true });
    diskFiles.set("/w/vendor/lib.abnf", "vendored = %x41\n");
    const workspace = await scanned();
    const open = createDocument(
      "/w/vendor/lib.abnf",
      "vendored = %x41\n",
      "abnf",
    );
    workspace.syncOpenDocument(asTextDocument(open));

    workspace.removeDocument(open.uri.toString());
    await indexedAfterEvents(workspace);

    expect(toPaths(workspace, "vendored")).toEqual([]);
    workspace.dispose();
  });
});

describe("open documents by scheme", () => {
  test("files of a virtual workspace folder are indexed", async () => {
    setWorkspaceFolders(["/repo"], "vscode-vfs");
    diskFiles.set("/repo/a.abnf", "remote = %x41\n");

    const workspace = await scanned();

    expect(toPaths(workspace, "remote")).toEqual(["/repo/a.abnf:remote"]);
    workspace.dispose();
  });

  test("a document of a virtual workspace folder is indexed", async () => {
    setWorkspaceFolders(["/repo"], "vscode-vfs");
    const workspace = await scanned();
    const open = createDocument("/repo/a.abnf", "remote = %x41\n", "abnf");
    Object.assign(open.uri, { scheme: "vscode-vfs" });

    workspace.syncOpenDocument(asTextDocument(open));

    expect(toPaths(workspace, "remote")).toEqual(["/repo/a.abnf:remote"]);
    workspace.dispose();
  });

  test("a diff view of a grammar file is not indexed", async () => {
    const workspace = await scanned();
    const open = createDocument("/w/a.abnf", "history = %x41\n", "abnf");
    Object.assign(open.uri, { scheme: "git" });

    workspace.syncOpenDocument(asTextDocument(open));

    expect(toPaths(workspace, "history")).toEqual([]);
    workspace.dispose();
  });
});

describe("glob syntax in files.exclude", () => {
  test("a brace group with one alternative hides that folder and the scan completes", async () => {
    setConfigurationValue("files.exclude", { "**/{build}": true });
    diskFiles.set("/w/build/x.abnf", "built = %x41\n");
    diskFiles.set("/w/src/y.abnf", "kept = %x41\n");

    const workspace = await scanned();

    expect(toPaths(workspace, "built")).toEqual([]);
    expect(toPaths(workspace, "kept")).toEqual(["/w/src/y.abnf:kept"]);
    workspace.dispose();
  });

  test("escaped braces match a folder literally named with braces", async () => {
    setConfigurationValue("files.exclude", { "**/\\{a,b\\}/**": true });
    const workspace = await scanned();
    diskFiles.set("/w/{a,b}/x.abnf", "braced = %x41\n");
    diskFiles.set("/w/a/y.abnf", "plainA = %x41\n");

    fireFileEvent("create", "/w/{a,b}/x.abnf");
    fireFileEvent("create", "/w/a/y.abnf");

    await eventually(() => toPaths(workspace, "plainA").length === 1);
    expect(toPaths(workspace, "braced")).toEqual([]);
    workspace.dispose();
  });

  test("a character class hides the folders it names", async () => {
    setConfigurationValue("files.exclude", { "**/[ab]uild/**": true });
    const workspace = await scanned();
    diskFiles.set("/w/build/z.abnf", "inB = %x41\n");
    diskFiles.set("/w/auild/z.abnf", "inA = %x41\n");
    diskFiles.set("/w/cuild/z.abnf", "inC = %x41\n");

    for (const path of ["/w/build/z.abnf", "/w/auild/z.abnf"]) {
      fireFileEvent("create", path);
    }
    fireFileEvent("create", "/w/cuild/z.abnf");

    await eventually(() => toPaths(workspace, "inC").length === 1);
    expect(toPaths(workspace, "inB")).toEqual([]);
    expect(toPaths(workspace, "inA")).toEqual([]);
    workspace.dispose();
  });

  test("a negated character class hides the other folders", async () => {
    setConfigurationValue("files.exclude", { "**/[!ab]uild/**": true });
    const workspace = await scanned();
    diskFiles.set("/w/build/z.abnf", "inB = %x41\n");
    diskFiles.set("/w/cuild/z.abnf", "inC = %x41\n");

    fireFileEvent("create", "/w/build/z.abnf");
    fireFileEvent("create", "/w/cuild/z.abnf");

    await eventually(() => toPaths(workspace, "inB").length === 1);
    expect(toPaths(workspace, "inC")).toEqual([]);
    workspace.dispose();
  });
});

describe("nested workspace folders", () => {
  test("the inner folder applies its own root exclusions to the outer scan", async () => {
    setWorkspaceFolders(["/w", "/w/sub"]);
    diskFiles.set("/w/sub/out/x.abnf", "built = %x41\n");
    diskFiles.set("/w/sub/y.abnf", "kept = %x41\n");

    const workspace = await scanned();

    expect(toPaths(workspace, "built")).toEqual([]);
    expect(workspace.findDefinitions("kept", "abnf")).toHaveLength(1);
    workspace.dispose();
  });
});

describe("an excluded file that is open", () => {
  test("is parsed but not offered to other files", async () => {
    setConfigurationValue("files.exclude", { "**/vendor/**": true });
    const workspace = await scanned();
    const open = createDocument(
      "/w/vendor/lib.abnf",
      "vendored = %x41\n",
      "abnf",
    );

    workspace.syncOpenDocument(asTextDocument(open));

    expect(workspace.get(asTextDocument(open)).document.rules).toHaveLength(1);
    expect(toPaths(workspace, "vendored")).toEqual([]);
    expect(workspace.findDefinitions("vendored", "abnf")).toEqual([]);
    workspace.dispose();
  });
});

describe("changing files.exclude", () => {
  test("files the setting now hides leave the index and the others join it", async () => {
    setConfigurationValue("files.exclude", { "**/old/**": true });
    diskFiles.set("/w/old/a.abnf", "oldRule = %x41\n");
    diskFiles.set("/w/new/b.abnf", "newRule = %x41\n");
    const workspace = await scanned();

    setConfigurationValue("files.exclude", { "**/new/**": true });
    await workspace.refreshExclusions();

    expect(toPaths(workspace, "oldRule")).toEqual(["/w/old/a.abnf:oldRule"]);
    expect(toPaths(workspace, "newRule")).toEqual([]);
    workspace.dispose();
  });

  test("a file change after files.exclude changed follows the new setting", async () => {
    diskFiles.set("/w/vendor/v.abnf", "vend = %x41\n");
    const workspace = await scanned();

    setConfigurationValue("files.exclude", { "**/vendor/**": true });
    fireConfigurationChange("files.exclude");
    fireFileEvent("change", "/w/vendor/v.abnf");

    await eventually(() => toPaths(workspace, "vend").length === 0);
    workspace.dispose();
  });

  test("the extension applies the change without a reload", async () => {
    diskFiles.set("/w/vendor/lib.abnf", "vendored = %x41\n");
    providerRegistrations.length = 0;
    const { activateGrammarExtension } = await import("../../extension.ts");
    await activateGrammarExtension(createExtensionContext() as never);
    const provider = providerRegistrations.find(
      (entry) => entry.kind === "workspaceSymbol",
    )?.provider as { provideWorkspaceSymbols(query: string): unknown[] };
    await eventually(() => provider.provideWorkspaceSymbols("vend").length > 0);

    setConfigurationValue("files.exclude", { "**/vendor/**": true });
    fireConfigurationChange("files.exclude");

    await eventually(
      () => provider.provideWorkspaceSymbols("vend").length === 0,
    );
  });
});

describe("changing files.exclude while a scan reads files", () => {
  test("a file hidden meanwhile does not enter the index", async () => {
    diskFiles.set("/w/vendor/v.abnf", "vend = %x41\n");
    let reading = () => {};
    let release = () => {};
    const readStarted = new Promise<void>((resolve) => {
      reading = resolve;
    });
    readFileGate.before = () => {
      reading();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const workspace = new GrammarWorkspace();
    const scan = workspace.initialize();
    await readStarted;
    readFileGate.before = undefined;

    setConfigurationValue("files.exclude", { "**/vendor/**": true });
    await workspace.refreshExclusions();
    release();
    await scan;

    expect(toPaths(workspace, "vend")).toEqual([]);
    workspace.dispose();
  });
});

describe("an open document and files.exclude", () => {
  test("a document the setting hides leaves the index and stays out when edited", async () => {
    const workspace = await scanned();
    const open = createDocument("/w/gen/g.abnf", "one = %x41\n", "abnf");
    workspace.syncOpenDocument(asTextDocument(open));

    setConfigurationValue("files.exclude", { "**/gen/**": true });
    await workspace.refreshExclusions();
    const afterRefresh = toPaths(workspace, "one");
    const edited = createDocument("/w/gen/g.abnf", "two = %x41\n", "abnf");
    edited.version = 2;
    workspace.syncOpenDocument(asTextDocument(edited));

    expect(afterRefresh).toEqual([]);
    expect(toPaths(workspace, "two")).toEqual([]);
    workspace.dispose();
  });

  test("an edit after the setting hides the document drops its earlier text", async () => {
    const workspace = await scanned();
    const open = createDocument("/w/gen/g.abnf", "one = %x41\n", "abnf");
    workspace.syncOpenDocument(asTextDocument(open));
    setConfigurationValue("files.exclude", { "**/gen/**": true });
    fireConfigurationChange("files.exclude");
    const edited = createDocument("/w/gen/g.abnf", "two = %x41\n", "abnf");
    edited.version = 2;

    workspace.syncOpenDocument(asTextDocument(edited));

    expect(toPaths(workspace, "one")).toEqual([]);
    expect(toPaths(workspace, "two")).toEqual([]);
    workspace.dispose();
  });

  test("a document the setting stops hiding is indexed with its buffer text", async () => {
    setConfigurationValue("files.exclude", { "**/gen/**": true });
    diskFiles.set("/w/gen/g.abnf", "saved = %x41\n");
    const workspace = await scanned();
    const open = createDocument("/w/gen/g.abnf", "typed = %x41\n", "abnf");
    workspace.syncOpenDocument(asTextDocument(open));

    setConfigurationValue("files.exclude", {});
    await workspace.refreshExclusions();

    expect(toPaths(workspace, "typed")).toEqual(["/w/gen/g.abnf:typed"]);
    expect(toPaths(workspace, "saved")).toEqual([]);
    workspace.dispose();
  });

  test("a document hidden then unhidden returns with its buffer text", async () => {
    diskFiles.set("/w/gen/g.abnf", "saved = %x41\n");
    const workspace = await scanned();
    const open = createDocument("/w/gen/g.abnf", "typed = %x41\n", "abnf");
    workspace.syncOpenDocument(asTextDocument(open));
    setConfigurationValue("files.exclude", { "**/gen/**": true });
    await workspace.refreshExclusions();

    setConfigurationValue("files.exclude", {});
    await workspace.refreshExclusions();

    expect(toPaths(workspace, "typed")).toEqual(["/w/gen/g.abnf:typed"]);
    expect(toPaths(workspace, "saved")).toEqual([]);
    workspace.dispose();
  });
});

describe("a change to an excluded file", () => {
  test("does not notify index listeners", async () => {
    setConfigurationValue("files.exclude", { "**/vendor/**": true });
    diskFiles.set("/w/vendor/v.abnf", "vend = %x41\n");
    const workspace = await scanned();
    let changes = 0;
    workspace.onDidChangeIndex(() => changes++);

    fireFileEvent("change", "/w/vendor/v.abnf");
    fireFileEvent("delete", "/w/vendor/v.abnf");
    await indexedAfterEvents(workspace);

    expect(changes).toBe(1);
    workspace.dispose();
  });
});

describe("scanning many files", () => {
  test("reads the exclusion settings a bounded number of times", async () => {
    for (let i = 0; i < 40; i++) {
      diskFiles.set(`/w/g${i}.abnf`, `r${i} = %x41\n`);
    }
    const vscode = (await import("vscode")) as unknown as {
      workspace: { getConfiguration(...args: unknown[]): unknown };
    };
    const reads = spyOn(vscode.workspace, "getConfiguration");
    const workspace = new GrammarWorkspace();

    await workspace.initialize();

    expect(toPaths(workspace, "r")).toHaveLength(40);
    expect(reads.mock.calls.length).toBeLessThan(10);
    reads.mockRestore();
    workspace.dispose();
  });
});
