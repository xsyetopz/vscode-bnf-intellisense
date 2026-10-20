import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  closeListenerCount,
  diskFiles,
  fireCloseTextDocument,
  fireFileEvent,
  readFileGate,
  resetExtensionHost,
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
});

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const names = (workspace: InstanceType<typeof GrammarWorkspace>, q: string) =>
  workspace.searchSymbols(q).map((entry) => entry.rule.name);

async function scanned() {
  const workspace = new GrammarWorkspace();
  await workspace.initialize();
  return workspace;
}

describe("a changed file", () => {
  test("stays findable while its new text is read and notifies once", async () => {
    diskFiles.set("/w/a.abnf", "before = %x41\n");
    const workspace = await scanned();
    let changes = 0;
    workspace.onDidChangeIndex(() => changes++);
    const reading = deferred();
    const release = deferred();
    readFileGate.before = () => {
      reading.resolve();
      return release.promise;
    };
    diskFiles.set("/w/a.abnf", "after = %x41\n");

    fireFileEvent("change", "/w/a.abnf");
    await reading.promise;
    const duringRead = names(workspace, "before");
    release.resolve();
    await eventually(() => names(workspace, "after").length === 1);

    expect(duringRead).toEqual(["before"]);
    expect(names(workspace, "before")).toEqual([]);
    expect(changes).toBe(1);
    workspace.dispose();
  });

  test("leaves the index when it can no longer be read", async () => {
    diskFiles.set("/w/a.abnf", "doomed = %x41\n");
    const workspace = await scanned();
    diskFiles.delete("/w/a.abnf");

    fireFileEvent("change", "/w/a.abnf");

    await eventually(() => names(workspace, "doomed").length === 0);
    workspace.dispose();
  });
});

describe("a deleted file", () => {
  test("is not resurrected by a read that started before it was recreated", async () => {
    diskFiles.set("/w/a.abnf", "stale = %x41\n");
    const workspace = await scanned();
    const staleRead = deferred();
    const release = deferred();
    let reads = 0;
    const staleReadReturned = deferred();
    readFileGate.before = () => {
      reads++;
      if (reads > 1) {
        return undefined;
      }
      staleRead.resolve();
      return release.promise.then(() => staleReadReturned.resolve());
    };

    fireFileEvent("change", "/w/a.abnf");
    await staleRead.promise;
    fireFileEvent("delete", "/w/a.abnf");
    diskFiles.set("/w/a.abnf", "fresh = %x41\n");
    fireFileEvent("create", "/w/a.abnf");
    await eventually(() => names(workspace, "fresh").length === 1);
    diskFiles.set("/w/a.abnf", "latest = %x41\n");
    fireFileEvent("change", "/w/a.abnf");
    await eventually(() => names(workspace, "latest").length === 1);
    release.resolve();
    await staleReadReturned.promise;
    await new Promise((done) => setTimeout(done, 0));

    expect(names(workspace, "stale")).toEqual([]);
    expect(names(workspace, "latest")).toEqual(["latest"]);
    workspace.dispose();
  });
});

describe("a file deleted on disk while its document is open", () => {
  test("keeps the rules of the unsaved text", async () => {
    diskFiles.set("/w/d.abnf", "saved = %x41\n");
    const workspace = await scanned();
    const open = createDocument(
      "/w/d.abnf",
      "saved = %x41\nextra = %x42\n",
      "abnf",
    );
    workspace.syncOpenDocument(asTextDocument(open));

    diskFiles.delete("/w/d.abnf");
    fireFileEvent("delete", "/w/d.abnf");

    expect(names(workspace, "extra")).toEqual(["extra"]);
    workspace.dispose();
  });
});

describe("a file deleted on disk and then closed", () => {
  test("leaves no rules behind", async () => {
    diskFiles.set("/w/d.abnf", "saved = %x41\n");
    const workspace = await scanned();
    const open = createDocument("/w/d.abnf", "typed = %x41\n", "abnf");
    workspace.syncOpenDocument(asTextDocument(open));
    diskFiles.delete("/w/d.abnf");
    fireFileEvent("delete", "/w/d.abnf");

    fireCloseTextDocument(open);

    await eventually(() => names(workspace, "typed").length === 0);
    expect(names(workspace, "saved")).toEqual([]);
    workspace.dispose();
  });
});

describe("an open document that is not a grammar file on disk", () => {
  test("leaves the index when it is closed", async () => {
    const workspace = await scanned();
    const open = createDocument("/w/notes.txt", "leak = %x41\n", "abnf");
    workspace.syncOpenDocument(asTextDocument(open));
    const whileOpen = names(workspace, "leak");

    fireCloseTextDocument(open);

    expect(whileOpen).toEqual(["leak"]);
    await eventually(() => names(workspace, "leak").length === 0);
    workspace.dispose();
  });
});

describe("deleting a file that was never indexed", () => {
  test("does not notify index listeners", async () => {
    const workspace = await scanned();
    let changes = 0;
    workspace.onDidChangeIndex(() => changes++);

    fireFileEvent("delete", "/w/unknown.abnf");

    expect(changes).toBe(0);
    workspace.dispose();
  });
});

describe("a closed document", () => {
  test("gets fresh parse results when reopened with the same version", async () => {
    const workspace = await scanned();
    const first = createDocument("/w/e.abnf", "first = %x41\n", "abnf");
    workspace.get(asTextDocument(first));
    fireCloseTextDocument(first);
    const reopened = createDocument(
      "/w/e.abnf",
      "second = %x41\nthird = %x42\n",
      "abnf",
    );

    const parsed = workspace.get(asTextDocument(reopened));

    expect(parsed.document.rules).toHaveLength(2);
    workspace.dispose();
  });

  test("is no longer observed once the workspace is disposed", () => {
    const listenersBefore = closeListenerCount();
    const workspace = new GrammarWorkspace();
    const listening = closeListenerCount();

    workspace.dispose();

    expect(listening).toBe(listenersBefore + 1);
    expect(closeListenerCount()).toBe(listenersBefore);
  });
});
