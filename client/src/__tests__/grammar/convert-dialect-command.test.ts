import { beforeAll, describe, expect, test } from "bun:test";
import "../vscode-mock.ts";
import type { GrammarDialect } from "../../grammar/dialects.ts";
import { repoText } from "../repo-file.ts";

type Commands = typeof import("../../grammar/commands/index.ts");
let commands: Commands;
let formatting: typeof import("../../grammar/commands/format-converted.ts");

let DocumentMock: typeof import("./provider-test-utils.ts").DocumentMock;

beforeAll(async () => {
  ({ DocumentMock } = await import("./provider-test-utils.ts"));
  commands = await import("../../grammar/commands/index.ts");
  formatting = await import("../../grammar/commands/format-converted.ts");
});

function setup(text: string, language: GrammarDialect | "plaintext") {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const messages: Array<{ kind: "info" | "warning"; text: string }> = [];
  const opened: Array<{ language: GrammarDialect; content: string }> = [];
  const picks: Array<import("../../grammar/commands/index.ts").DialectPick[]> =
    [];
  const state = { pick: undefined as GrammarDialect | undefined, edits: 0 };
  const doc = new DocumentMock("/tmp/source", text, language as GrammarDialect);
  const editor = {
    document: {
      languageId: language,
      uri: doc.uri,
      getText: () => doc.getText(),
      offsetAt: (p: { line: number; character: number }) =>
        doc.offsetAt(p.line, p.character),
    },
    selections: [],
  };
  const host: import("../../grammar/commands/index.ts").CommandHost = {
    registerCommand: (id, handler) => {
      handlers.set(id, handler);
      return { dispose: () => handlers.delete(id) };
    },
    activeEditor: () => editor,
    replace: async () => {
      state.edits++;
      return true;
    },
    showInformation: (message) =>
      messages.push({ kind: "info", text: message }),
    showWarning: (message) => messages.push({ kind: "warning", text: message }),
    pickDialect: async (items) => {
      picks.push(items);
      return state.pick;
    },
    openUntitled: async (target, content) => {
      opened.push({ language: target, content });
    },
    format: (_editor, target) => (value) =>
      formatting.formatConverted(value, target),
  };
  commands.registerGrammarCommands(host);
  const run = async (...args: unknown[]) => {
    await handlers.get("bnf.convertDialect")?.(...args);
  };
  return { run, messages, opened, picks, state };
}

describe("bnf.convertDialect", () => {
  const json = repoText("examples/json.abnf");

  async function convertJson() {
    const t = setup(json, "abnf");
    t.state.pick = "ebnf";
    await t.run();
    return t;
  }

  test("offers the other three dialects", async () => {
    const t = await convertJson();

    expect(t.picks).toHaveLength(1);
    expect(t.picks[0]?.map((pick) => pick.dialect)).toEqual([
      "bnf",
      "ebnf",
      "rbnf",
    ]);
    expect(t.picks[0]?.map((pick) => pick.label)).toEqual([
      "BNF",
      "EBNF",
      "RBNF",
    ]);
  });

  test("opens the converted text in a new document of the chosen dialect", async () => {
    const t = await convertJson();

    expect(t.opened).toHaveLength(1);
    expect(t.opened[0]?.language).toBe("ebnf");
    expect(t.opened[0]?.content).toContain("json-text");
  });

  test("formats the converted text with the host formatter", async () => {
    const t = await convertJson();

    expect(t.opened[0]?.content).toContain("value           ::= object\n");
  });

  test("leaves the source document unedited", async () => {
    const t = await convertJson();

    expect(t.state.edits).toBe(0);
  });

  test("confirms an exact conversion", async () => {
    const t = await convertJson();

    expect(t.messages).toEqual([{ kind: "info", text: "Converted to EBNF." }]);
  });

  test("a cancelled pick does nothing", async () => {
    const t = setup("a = %x41\n", "abnf");

    await t.run();

    expect(t.opened).toEqual([]);
    expect(t.messages).toEqual([]);
  });

  test("a target argument skips the pick", async () => {
    const t = setup("a = %x41\n", "abnf");

    await t.run("rbnf");

    expect(t.picks).toEqual([]);
    expect(t.opened[0]?.language).toBe("rbnf");
  });

  test("the source dialect as target argument falls back to the pick", async () => {
    const t = setup("a = %x41\n", "abnf");

    await t.run("abnf");

    expect(t.picks).toHaveLength(1);
    expect(t.opened).toEqual([]);
  });

  test("warnings are counted and the first ones listed", async () => {
    const t = setup(
      `${json}\nextra = <prose one> <prose two> %x110000-110001 %x5D-10FFFF\n`,
      "abnf",
    );

    await t.run("bnf");

    expect(t.opened).toHaveLength(1);
    expect(t.messages).toHaveLength(1);
    expect(t.messages[0]?.kind).toBe("warning");
    expect(t.messages[0]?.text).toContain("with 5 warnings:");
    expect(t.messages[0]?.text).toContain("and 2 more");
  });

  test("a single warning is not plural", async () => {
    const t = setup("a = <prose>\n", "abnf");

    await t.run("bnf");

    expect(t.messages[0]?.text).toContain("with 1 warning:");
  });

  test("parse errors open nothing", async () => {
    const t = setup('a ::= ("x"\n', "bnf");

    await t.run("abnf");

    expect(t.opened).toEqual([]);
  });

  test("parse errors show a warning", async () => {
    const t = setup('a ::= ("x"\n', "bnf");

    await t.run("abnf");

    expect(t.messages[0]?.kind).toBe("warning");
    expect(t.messages[0]?.text).toContain("Not converted");
  });

  test("other languages get an info message and open nothing", async () => {
    const t = setup("a b\n", "plaintext");

    await t.run("abnf");

    expect(t.opened).toEqual([]);
    expect(t.messages[0]?.kind).toBe("info");
  });
});
