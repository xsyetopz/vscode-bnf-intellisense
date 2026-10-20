import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Disposable, TextDocument } from "vscode";
import "../vscode-mock.ts";
import type {
  ActiveGrammarEditor,
  PanelLike,
  RailroadHost,
} from "../../grammar/railroad/host.ts";
import type { Scheduler } from "../../grammar/railroad/panel.ts";

let RailroadPreview: typeof import("../../grammar/railroad/panel.ts").RailroadPreview;
let registerRailroadPreview: typeof import("../../grammar/railroad/index.ts").registerRailroadPreview;
let GrammarWorkspace: typeof import("../../grammar/workspace.ts").GrammarWorkspace;
let SHOW: string;

beforeAll(async () => {
  ({ RailroadPreview } = await import("../../grammar/railroad/panel.ts"));
  ({ registerRailroadPreview } = await import(
    "../../grammar/railroad/index.ts"
  ));
  ({ GrammarWorkspace } = await import("../../grammar/workspace.ts"));
  SHOW = (await import("../../grammar/railroad/panel.ts"))
    .SHOW_RAILROAD_COMMAND;
});

class FakeDoc {
  version = 1;
  readonly uri: { path: string; toString(): string };
  text: string;
  readonly languageId: string;
  constructor(path: string, text: string, languageId: string) {
    this.text = text;
    this.languageId = languageId;
    this.uri = { path, toString: () => `file://${path}` };
  }
  getText(): string {
    return this.text;
  }
  edit(text: string): void {
    this.text = text;
    this.version++;
  }
  asDoc(): TextDocument {
    return this as unknown as TextDocument;
  }
}

class FakeScheduler implements Scheduler {
  #next = 1;
  readonly pending = new Map<number, { cb: () => void; ms: number }>();
  set(cb: () => void, ms: number): unknown {
    const id = this.#next++;
    this.pending.set(id, { cb, ms });
    return id;
  }
  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  flush(): void {
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [, { cb }] of entries) {
      cb();
    }
  }
}

class FakePanel implements PanelLike {
  title: string;
  disposed = false;
  revealed = 0;
  readonly posted: Array<Record<string, unknown>> = [];
  html = "";
  #onMessage: Array<(m: unknown) => void> = [];
  #onDispose: Array<() => void> = [];
  readonly webview: PanelLike["webview"];

  constructor(title: string) {
    this.title = title;
    const self = this;
    this.webview = {
      get html() {
        return self.html;
      },
      set html(value: string) {
        self.html = value;
      },
      postMessage: (message) => {
        if (self.disposed) {
          throw new Error("Webview is disposed");
        }
        self.posted.push(message as Record<string, unknown>);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (listener) => {
        self.#onMessage.push(listener);
        return { dispose: () => {} } as Disposable;
      },
    };
  }
  reveal(): void {
    this.revealed++;
  }
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const l of this.#onDispose) {
      l();
    }
  }
  onDidDispose(listener: () => void): Disposable {
    this.#onDispose.push(listener);
    return { dispose: () => {} } as Disposable;
  }
  receive(message: unknown): void {
    for (const l of this.#onMessage) {
      l(message);
    }
  }
}

class FakeHost implements RailroadHost {
  editor: ActiveGrammarEditor | undefined;
  readonly panels: FakePanel[] = [];
  readonly messages: string[] = [];
  readonly revealed: Array<{ uri: unknown; range: unknown; column: unknown }> =
    [];
  readonly commands = new Map<string, () => void>();
  readonly listeners = {
    editor: new Set<() => void>(),
    selection: new Set<(d: TextDocument, line: number) => void>(),
    change: new Set<(d: TextDocument) => void>(),
    close: new Set<(d: TextDocument) => void>(),
  };
  nonceCount = 0;

  #sub<T>(set: Set<T>, listener: T): Disposable {
    set.add(listener);
    return { dispose: () => set.delete(listener) } as Disposable;
  }
  activeGrammarEditor() {
    return this.editor;
  }
  onDidChangeActiveEditor(l: () => void) {
    return this.#sub(this.listeners.editor, l);
  }
  onDidChangeSelection(l: (d: TextDocument, line: number) => void) {
    return this.#sub(this.listeners.selection, l);
  }
  onDidChangeDocument(l: (d: TextDocument) => void) {
    return this.#sub(this.listeners.change, l);
  }
  onDidCloseDocument(l: (d: TextDocument) => void) {
    return this.#sub(this.listeners.close, l);
  }
  registerCommand(id: string, cb: () => void) {
    this.commands.set(id, cb);
    return { dispose: () => this.commands.delete(id) } as Disposable;
  }
  createPanel(title: string) {
    const panel = new FakePanel(title);
    this.panels.push(panel);
    return panel;
  }
  revealRange(uri: never, range: never, column: never) {
    this.revealed.push({ uri, range, column });
    return Promise.resolve();
  }
  showMessage(m: string) {
    this.messages.push(m);
  }
  createNonce() {
    this.nonceCount++;
    return `nonce${String(this.nonceCount).padStart(20, "0")}`;
  }
  edit(doc: FakeDoc, text: string) {
    doc.edit(text);
    for (const l of this.listeners.change) {
      l(doc.asDoc());
    }
  }
  activate(doc: FakeDoc, line = 0) {
    this.editor = { document: doc.asDoc(), line, viewColumn: 1 as never };
    for (const l of this.listeners.editor) {
      l();
    }
  }
  select(doc: FakeDoc, line: number) {
    for (const l of this.listeners.selection) {
      l(doc.asDoc(), line);
    }
  }
}

const GRAMMAR = 'first = second\nsecond = "x"\n    / third\nthird = %x41\n';

let host: FakeHost;
let scheduler: FakeScheduler;
let workspace: InstanceType<typeof GrammarWorkspace>;
let preview: InstanceType<typeof RailroadPreview>;
let doc: FakeDoc;

function openPanel(): FakePanel {
  preview.show();
  return host.panels[0] as FakePanel;
}

function pendingDelays(): number[] {
  return [...scheduler.pending.values()].map((entry) => entry.ms);
}

function otherDoc(): FakeDoc {
  return new FakeDoc("/proj/o.abnf", "x = y\n", "abnf");
}

function stubWorkspace(overrides: {
  findDefinitions: (name: string) => unknown[];
  onDidChangeIndex?: (listener: () => void) => Disposable;
}) {
  const real = new GrammarWorkspace();
  return {
    get: (d: TextDocument) => real.get(d),
    onDidChangeIndex: () => ({ dispose() {} }) as Disposable,
    ...overrides,
  } as never;
}

beforeEach(() => {
  host = new FakeHost();
  scheduler = new FakeScheduler();
  workspace = new GrammarWorkspace();
  preview = new RailroadPreview(workspace, host, { scheduler });
  doc = new FakeDoc("/proj/g.abnf", GRAMMAR, "abnf");
  host.editor = { document: doc.asDoc(), line: 1, viewColumn: 1 as never };
});

describe("railroad preview panel: opening", () => {
  test("opens one panel titled after the file", () => {
    const panel = openPanel();

    expect(host.panels).toHaveLength(1);
    expect(panel.title).toBe("Railroad: g.abnf");
    expect(preview.isOpen).toBe(true);
  });

  test("serves a page with a content security policy and the rules", () => {
    const panel = openPanel();

    expect(panel.html).toContain("Content-Security-Policy");
    expect(panel.html).toContain('data-rule-name="second"');
  });

  test("focuses the rule under the cursor", () => {
    const panel = openPanel();

    expect(panel.html).toContain('data-focus="rule-1"');
  });

  test("focuses a multi-line rule from its continuation line", () => {
    host.editor = { document: doc.asDoc(), line: 2, viewColumn: 1 as never };

    const panel = openPanel();

    expect(panel.html).toContain('data-focus="rule-1"');
  });

  test("reveals the existing panel on a second show", () => {
    preview.show();

    preview.show();

    expect(host.panels).toHaveLength(1);
    expect((host.panels[0] as FakePanel).revealed).toBe(1);
  });

  test("tells the user when there is no grammar editor", () => {
    host.editor = undefined;

    preview.show();

    expect(host.panels).toHaveLength(0);
    expect(host.messages).toHaveLength(1);
  });

  test("shows a message instead of throwing when parsing fails", () => {
    const broken = {
      get: () => {
        throw new Error("boom");
      },
      findDefinitions: () => [],
      onDidChangeIndex: () => ({ dispose() {} }) as Disposable,
    };
    const failing = new RailroadPreview(broken, host, { scheduler });

    failing.show();

    expect((host.panels[0] as FakePanel).html).toContain("could not be drawn");
  });

  test("gives a reopened panel a new nonce", () => {
    openPanel().dispose();

    preview.show();

    expect(host.panels).toHaveLength(2);
    expect((host.panels[1] as FakePanel).html).toContain(
      "nonce00000000000000000002",
    );
  });
});

describe("railroad preview panel: edits", () => {
  test("debounces edits by 250 ms into one pending update", () => {
    const panel = openPanel();

    host.edit(doc, 'first = "a"\n');
    host.edit(doc, 'first = "ab"\n');
    host.edit(doc, 'first = "abc"\n');

    expect(panel.posted).toHaveLength(0);
    expect(pendingDelays()).toEqual([250]);
  });

  test("posts one render with the latest text after the debounce", () => {
    const panel = openPanel();
    host.edit(doc, 'first = "a"\n');
    host.edit(doc, 'first = "ab"\n');
    host.edit(doc, 'first = "abc"\n');

    scheduler.flush();

    expect(panel.posted).toHaveLength(1);
    const message = panel.posted[0] as { type: string; html: string };
    expect(message.type).toBe("render");
    expect(message.html).toContain("abc");
  });

  test("posts nothing when the diagram is unchanged", () => {
    const panel = openPanel();
    host.edit(doc, `${GRAMMAR}\n\n`);

    scheduler.flush();

    expect(panel.posted).toHaveLength(0);
  });

  test("ignores edits of other documents", () => {
    openPanel();

    host.edit(otherDoc(), "x = z\n");

    expect(scheduler.pending.size).toBe(0);
  });

  test("does not throw when posting to a disposed webview", () => {
    const panel = openPanel();
    panel.disposed = true;
    host.edit(doc, 'first = "changed"\n');

    expect(() => scheduler.flush()).not.toThrow();
  });
});

describe("railroad preview panel: workspace index changes", () => {
  function previewWithExternalRule() {
    const listeners = new Set<() => void>();
    const external = new Set<string>();
    const fake = stubWorkspace({
      findDefinitions: (name) =>
        external.has(name)
          ? [{ uri: doc.uri, rule: { nameRange: { start: { line: 0 } } } }]
          : [],
      onDidChangeIndex: (l) => {
        listeners.add(l);
        return { dispose: () => listeners.delete(l) } as Disposable;
      },
    });
    doc.edit("r = elsewhere\n");
    new RailroadPreview(fake, host, { scheduler }).show();
    return { listeners, external, panel: host.panels[0] as FakePanel };
  }

  test("draws an undefined reference before it is indexed", () => {
    const { panel } = previewWithExternalRule();

    expect(panel.html).toContain("rr-nt-undefined");
  });

  test("debounces repeated index changes into one pending refresh", () => {
    const { listeners, external } = previewWithExternalRule();
    external.add("elsewhere");

    for (const l of listeners) {
      l();
      l();
    }

    expect(scheduler.pending.size).toBe(1);
  });

  test("redraws the reference as external once it is indexed", () => {
    const { listeners, external, panel } = previewWithExternalRule();
    external.add("elsewhere");
    for (const l of listeners) {
      l();
    }

    scheduler.flush();

    expect(panel.posted).toHaveLength(1);
    expect((panel.posted[0] as { html: string }).html).toContain(
      "rr-nt-external",
    );
  });

  test("stops listening to index changes when the panel is disposed", () => {
    const { listeners, panel } = previewWithExternalRule();

    panel.dispose();

    expect(listeners.size).toBe(0);
  });
});

describe("railroad preview panel: cursor movement", () => {
  test("debounces selection changes by 100 ms into one pending update", () => {
    openPanel();

    host.select(doc, 3);
    host.select(doc, 3);

    expect(pendingDelays()).toEqual([100]);
  });

  test("focuses the rule at the new cursor line", () => {
    const panel = openPanel();
    host.select(doc, 3);

    scheduler.flush();

    expect(panel.posted).toEqual([{ type: "focus", id: "rule-2" }]);
  });

  test("does not refocus a rule that is already focused", () => {
    const panel = openPanel();
    host.select(doc, 3);
    scheduler.flush();

    host.select(doc, 3);
    scheduler.flush();

    expect(panel.posted).toHaveLength(1);
  });

  test("keeps the focus when the cursor is outside any rule", () => {
    const panel = openPanel();
    host.select(doc, 99);

    scheduler.flush();

    expect(panel.posted).toHaveLength(0);
  });

  test("ignores selections in other documents", () => {
    openPanel();

    host.select(otherDoc(), 0);

    expect(scheduler.pending.size).toBe(0);
  });

  test("lets the refresh after an edit win over a stale selection", () => {
    const panel = openPanel();
    host.select(doc, 3);
    doc.edit('first = "a"\n');

    scheduler.flush();

    expect(panel.posted.some((m) => m["type"] === "focus")).toBe(false);
  });
});

describe("railroad preview panel: active editor", () => {
  test("retitles the panel after the newly active grammar file", () => {
    const panel = openPanel();

    host.activate(new FakeDoc("/proj/other.ebnf", "Name ::= Letter\n", "ebnf"));

    expect(panel.title).toBe("Railroad: other.ebnf");
  });

  test("renders the newly active grammar file", () => {
    const panel = openPanel();

    host.activate(new FakeDoc("/proj/other.ebnf", "Name ::= Letter\n", "ebnf"));

    expect(panel.posted).toHaveLength(1);
    expect((panel.posted[0] as { html: string }).html).toContain("Name");
  });

  test("changes nothing when the same document is activated again", () => {
    const panel = openPanel();

    host.activate(doc, 1);

    expect(panel.posted).toHaveLength(0);
    expect(panel.title).toBe("Railroad: g.abnf");
  });

  test("follows the cursor when the same document is activated in another editor", () => {
    const panel = openPanel();

    host.activate(doc, 3);
    scheduler.flush();

    expect(panel.posted).toEqual([{ type: "focus", id: "rule-2" }]);
  });

  test("changes nothing when a non-grammar editor becomes active", () => {
    const panel = openPanel();
    host.editor = undefined;

    for (const l of host.listeners.editor) {
      l();
    }

    expect(panel.posted).toHaveLength(0);
    expect(panel.title).toBe("Railroad: g.abnf");
  });

  test("shows the empty state when the shown document is closed", () => {
    const panel = openPanel();

    for (const l of host.listeners.close) {
      l(doc.asDoc());
    }

    expect((panel.posted[0] as { html: string }).html).toContain(
      "Open an ABNF",
    );
  });
});

describe("railroad preview panel: disposal", () => {
  test("disposing the panel cancels pending timers", () => {
    const panel = openPanel();
    host.edit(doc, 'first = "x"\n');
    host.select(doc, 0);

    panel.dispose();

    expect(scheduler.pending.size).toBe(0);
  });

  test("disposing the panel removes every host listener", () => {
    const panel = openPanel();

    panel.dispose();

    for (const set of Object.values(host.listeners)) {
      expect(set.size).toBe(0);
    }
  });

  test("disposing the panel marks the preview as closed", () => {
    const panel = openPanel();

    panel.dispose();

    expect(preview.isOpen).toBe(false);
  });

  test("ignores events that arrive after disposal", () => {
    const panel = openPanel();
    panel.dispose();

    host.edit(doc, 'first = "y"\n');
    host.select(doc, 0);
    scheduler.flush();

    expect(panel.posted).toHaveLength(0);
  });

  test("disposing the preview disposes the panel and cancels timers", () => {
    const panel = openPanel();
    host.edit(doc, 'first = "x"\n');

    preview.dispose();

    expect(panel.disposed).toBe(true);
    expect(scheduler.pending.size).toBe(0);
  });

  test("disposing the preview twice is harmless", () => {
    openPanel();
    preview.dispose();

    expect(() => preview.dispose()).not.toThrow();
  });
});

describe("railroad webview messages", () => {
  test("reveal jumps to the definition of a known rule", () => {
    const panel = openPanel();

    panel.receive({ type: "reveal", rule: "third" });

    expect(host.revealed).toHaveLength(1);
    const { uri, range, column } = host.revealed[0] as {
      uri: { path: string };
      range: { start: { line: number } };
      column: unknown;
    };
    expect(uri.path).toBe("/proj/g.abnf");
    expect(range.start.line).toBe(3);
    expect(column).toBe(1 as never);
  });

  test("reveal ignores case in ABNF", () => {
    const panel = openPanel();

    panel.receive({ type: "reveal", rule: "THIRD" });

    expect(host.revealed).toHaveLength(1);
  });

  test("reveal does not match a different case in EBNF", () => {
    const panel = openPanel();
    host.activate(new FakeDoc("/p/x.ebnf", "A ::= B\nB ::= 'x'\n", "ebnf"));

    panel.receive({ type: "reveal", rule: "b" });

    expect(host.revealed).toHaveLength(0);
  });

  test("reveal matches the exact case in EBNF", () => {
    const panel = openPanel();
    host.activate(new FakeDoc("/p/x.ebnf", "A ::= B\nB ::= 'x'\n", "ebnf"));

    panel.receive({ type: "reveal", rule: "B" });

    expect(host.revealed).toHaveLength(1);
  });

  test("reveal falls back to the workspace index", () => {
    const uri = { path: "/proj/other.abnf", toString: () => "file:///o" };
    const nameRange = { start: { line: 7 } };
    const fake = stubWorkspace({
      findDefinitions: (name) =>
        name === "outside" ? [{ uri, rule: { nameRange } }] : [],
    });
    doc.edit("r = outside\n");
    new RailroadPreview(fake, host, { scheduler }).show();

    (host.panels[0] as FakePanel).receive({ type: "reveal", rule: "outside" });

    expect(host.revealed).toEqual([
      { uri, range: nameRange, column: 1 as never },
    ]);
  });

  test("ignores a reveal when the document can no longer be parsed", () => {
    let failing = false;
    const real = new GrammarWorkspace();
    const flaky = {
      get: (d: TextDocument) => {
        if (failing) {
          throw new Error("boom");
        }
        return real.get(d);
      },
      findDefinitions: () => [],
      onDidChangeIndex: () => ({ dispose() {} }) as Disposable,
    } as never;
    new RailroadPreview(flaky, host, { scheduler }).show();
    failing = true;

    const receive = () =>
      (host.panels[0] as FakePanel).receive({ type: "reveal", rule: "third" });

    expect(receive).not.toThrow();
    expect(host.revealed).toHaveLength(0);
  });

  test.each([
    ["undefined", undefined],
    ["null", null],
    ["a bare string", "reveal"],
    ["an unknown rule", { type: "reveal", rule: "missing" }],
    ["a core rule", { type: "reveal", rule: "ALPHA" }],
    ["a non-string rule", { type: "reveal", rule: 1 }],
    ["the rule __proto__", { type: "reveal", rule: "__proto__" }],
    ["the rule constructor", { type: "reveal", rule: "constructor" }],
    [
      "an openExternal request",
      { type: "openExternal", url: "https://example.com" },
    ],
    [
      "a command request",
      { type: "command", command: "workbench.action.reloadWindow" },
    ],
    ["a message without a type", { rule: "first" }],
  ])("ignores %s", (_name, message) => {
    const panel = openPanel();

    panel.receive(message);

    expect(host.revealed).toHaveLength(0);
  });

  test("ignores messages after disposal", () => {
    const panel = openPanel();
    panel.dispose();

    panel.receive({ type: "reveal", rule: "first" });

    expect(host.revealed).toHaveLength(0);
  });
});

describe("railroad command from the preview panel", () => {
  test("reveals the open panel when no grammar editor is active", () => {
    const panel = openPanel();
    host.editor = undefined;

    preview.show();

    expect(panel.revealed).toBe(1);
    expect(host.panels).toHaveLength(1);
    expect(host.messages).toHaveLength(0);
  });

  test("refreshes the panel for the shown document", () => {
    const panel = openPanel();
    host.editor = undefined;
    doc.edit('first = "changed"\n');

    preview.show();

    expect((panel.posted[0] as { html: string }).html).toContain("changed");
  });
});

describe("registerRailroadPreview", () => {
  test("registers the show command under its public id", () => {
    registerRailroadPreview(workspace, host, { scheduler });

    expect(SHOW).toBe("bnf.showRailroadDiagram");
    expect(host.commands.has(SHOW)).toBe(true);
  });

  test("the registered command opens the preview", () => {
    registerRailroadPreview(workspace, host, { scheduler });

    host.commands.get(SHOW)?.();

    expect(host.panels).toHaveLength(1);
  });

  test("disposing the registration removes the command and closes the panel", () => {
    const disposables = registerRailroadPreview(workspace, host, { scheduler });
    host.commands.get(SHOW)?.();

    for (const d of disposables) {
      d.dispose();
    }

    expect(host.commands.has(SHOW)).toBe(false);
    expect((host.panels[0] as FakePanel).disposed).toBe(true);
  });
});
