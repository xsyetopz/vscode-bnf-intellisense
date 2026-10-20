import { beforeAll, describe, expect, test } from "bun:test";
import "../vscode-mock.ts";
import type { GrammarDialect } from "../../grammar/dialects.ts";

let commands: typeof import("../../grammar/commands/index.ts");

let DocumentMock: typeof import("./provider-test-utils.ts").DocumentMock;

beforeAll(async () => {
  ({ DocumentMock } = await import("./provider-test-utils.ts"));
  commands = await import("../../grammar/commands/index.ts");
});

interface Harness {
  host: import("../../grammar/commands/index.ts").CommandHost;
  handlers: Map<string, (...args: unknown[]) => unknown>;
  messages: Array<{ kind: "info" | "warning"; text: string }>;
  replaced: Array<{ start: number; end: number; text: string }>;
  opened: Array<{ language: GrammarDialect; content: string }>;
  picks: Array<import("../../grammar/commands/index.ts").DialectPick[]>;
  setEditor(
    text: string,
    language: GrammarDialect | "plaintext",
    selections?: Array<[number, number]>,
  ): void;
  pick: GrammarDialect | undefined;
}

function harness(): Harness {
  let editor:
    | import("../../grammar/commands/index.ts").CommandEditor
    | undefined;
  const state: Harness = {
    handlers: new Map(),
    messages: [],
    replaced: [],
    opened: [],
    picks: [],
    pick: undefined,
    setEditor(text, language, selections = []) {
      const doc = new DocumentMock("/tmp/x", text, language as GrammarDialect);
      editor = {
        document: {
          languageId: language,
          uri: doc.uri,
          getText: () => doc.getText(),
          offsetAt: (p) => doc.offsetAt(p.line, p.character),
        },
        selections: selections.map(([start, end]) => ({
          start: doc.positionAt(start) as unknown as never,
          end: doc.positionAt(end) as unknown as never,
        })),
      };
    },
    host: undefined as never,
  };
  state.host = {
    registerCommand: (id, handler) => {
      state.handlers.set(id, handler);
      return { dispose: () => state.handlers.delete(id) };
    },
    activeEditor: () => editor,
    replace: async (_editor, start, end, text) => {
      state.replaced.push({ start, end, text });
      return true;
    },
    showInformation: (text) => state.messages.push({ kind: "info", text }),
    showWarning: (text) => state.messages.push({ kind: "warning", text }),
    pickDialect: async (picks) => {
      state.picks.push(picks);
      return state.pick;
    },
    openUntitled: async (language, content) => {
      state.opened.push({ language, content });
    },
    format: () => (text) => text,
  };
  return state;
}

function apply(
  text: string,
  edit: { start: number; end: number; text: string },
) {
  return text.slice(0, edit.start) + edit.text + text.slice(edit.end);
}

async function run(
  h: Harness,
  command: string,
  text: string,
  language: GrammarDialect | "plaintext",
  selections?: Array<[number, number]>,
): Promise<string | undefined> {
  commands.registerGrammarCommands(h.host);
  h.setEditor(text, language, selections);
  await h.handlers.get(command)?.();
  const edit = h.replaced[0];
  return edit ? apply(text, edit) : undefined;
}

describe("sort commands", () => {
  test("registers the three commands", () => {
    const h = harness();

    commands.registerGrammarCommands(h.host);

    expect([...h.handlers.keys()].sort()).toEqual([
      "bnf.convertDialect",
      "bnf.sortRules",
      "bnf.sortRulesByDependency",
    ]);
  });

  test("disposing the registrations removes the commands", () => {
    const h = harness();
    const disposables = commands.registerGrammarCommands(h.host);

    for (const disposable of disposables) {
      disposable.dispose();
    }

    expect(h.handlers.size).toBe(0);
  });

  test("bnf.sortRules sorts the whole document", async () => {
    const h = harness();
    const text = "c = %x41\nb = %x42\na = %x43\n";

    const out = await run(h, "bnf.sortRules", text, "abnf");

    expect(out).toBe("a = %x43\nb = %x42\nc = %x41\n");
  });

  test("bnf.sortRules applies the sort as one edit without messages", async () => {
    const h = harness();

    await run(h, "bnf.sortRules", "c = %x41\nb = %x42\na = %x43\n", "abnf");

    expect(h.replaced.length).toBe(1);
    expect(h.messages).toEqual([]);
  });

  test("an empty selection (the cursor) sorts the whole document", async () => {
    const h = harness();
    const text = "c = %x41\nb = %x42\na = %x43\n";

    const out = await run(h, "bnf.sortRules", text, "abnf", [[10, 10]]);

    expect(out).toBe("a = %x43\nb = %x42\nc = %x41\n");
  });

  test("a selection limits the sort to the selected rules", async () => {
    const h = harness();
    const text = "z = %x41\nc = %x42\nb = %x43\na = %x44\n";

    const out = await run(h, "bnf.sortRules", text, "abnf", [
      [text.indexOf("c ="), text.length],
    ]);

    expect(out).toBe("z = %x41\na = %x44\nb = %x43\nc = %x42\n");
  });

  test("several selections are each sorted on their own", async () => {
    const h = harness();
    const text = "z = %x41\nc = %x42\nm = %x43\ny = %x44\nb = %x45\n";

    const out = await run(h, "bnf.sortRules", text, "abnf", [
      [text.indexOf("z ="), text.indexOf("m =")],
      [text.indexOf("y ="), text.length],
    ]);

    expect(out).toBe("c = %x42\nz = %x41\nm = %x43\nb = %x45\ny = %x44\n");
  });

  test("several selections on separate single rules change nothing", async () => {
    const h = harness();
    const text = "z = %x41\nc = %x42\nb = %x43\na = %x44\n";

    const out = await run(h, "bnf.sortRules", text, "abnf", [
      [text.indexOf("z ="), text.indexOf("z =") + 2],
      [text.indexOf("a ="), text.indexOf("a =") + 2],
    ]);

    expect(out).toBeUndefined();
  });

  test("selections that touch the same rule are sorted together", async () => {
    const h = harness();
    const text = "c = %x41\nb = %x42\na = %x43\n";

    const out = await run(h, "bnf.sortRules", text, "abnf", [
      [text.indexOf("c ="), text.indexOf("b =") + 2],
      [text.indexOf("b =") + 3, text.indexOf("a =") + 2],
    ]);

    expect(out).toBe("a = %x43\nb = %x42\nc = %x41\n");
  });

  test("a rejected edit shows a warning", async () => {
    const h = harness();
    h.host.replace = async () => false;

    await run(h, "bnf.sortRules", "b = %x41\na = %x42\n", "abnf");

    expect(h.messages).toEqual([
      {
        kind: "warning",
        text: "Rules were not sorted: the editor rejected the edit.",
      },
    ]);
  });

  test("bnf.sortRulesByDependency uses dependency order", async () => {
    const h = harness();
    const text = "top = b\nz = %x41\nb = %x42\n";

    const out = await run(h, "bnf.sortRulesByDependency", text, "abnf");

    expect(out).toBe("top = b\nb = %x42\nz = %x41\n");
  });

  test("an already sorted document makes no edit", async () => {
    const h = harness();

    await run(h, "bnf.sortRules", "a = %x41\nb = %x42\n", "abnf");

    expect(h.replaced).toEqual([]);
  });

  test("an already sorted document says so", async () => {
    const h = harness();

    await run(h, "bnf.sortRules", "a = %x41\nb = %x42\n", "abnf");

    expect(h.messages).toEqual([
      { kind: "info", text: "The rules are already in that order." },
    ]);
  });

  test("parse errors make no edit", async () => {
    const h = harness();

    await run(h, "bnf.sortRules", 'b ::= ("x"\na ::= "y"\n', "bnf");

    expect(h.replaced).toEqual([]);
  });

  test("parse errors show a warning that names the cause", async () => {
    const h = harness();

    await run(h, "bnf.sortRules", 'b ::= ("x"\na ::= "y"\n', "bnf");

    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]?.kind).toBe("warning");
    expect(h.messages[0]?.text).toContain("Rules were not sorted");
    expect(h.messages[0]?.text).toContain("parse errors");
  });

  test("other languages get an info message and no edit", async () => {
    const h = harness();

    await run(h, "bnf.sortRules", "c = 1\nb = 2\n", "plaintext");

    expect(h.replaced).toEqual([]);
    expect(h.messages[0]?.kind).toBe("info");
  });

  test("a missing editor shows a message", async () => {
    const h = harness();
    commands.registerGrammarCommands(h.host);
    h.host.activeEditor = () => undefined;

    await h.handlers.get("bnf.sortRules")?.();

    expect(h.messages).toHaveLength(1);
  });

  test("a selection without a rule is reported and makes no edit", async () => {
    const h = harness();

    await run(h, "bnf.sortRules", "; note\n\nb = %x41\na = %x42\n", "abnf", [
      [0, 3],
    ]);

    expect(h.replaced).toEqual([]);
    expect(h.messages[0]?.text).toContain("The selection contains no rule");
  });

  test("CRLF documents keep their line breaks", async () => {
    const h = harness();
    const text = 'b ::= "x"\r\na ::= "y"\r\n';

    const out = await run(h, "bnf.sortRules", text, "bnf");

    expect(out).toBe('a ::= "y"\r\nb ::= "x"\r\n');
  });
});
