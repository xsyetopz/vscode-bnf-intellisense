import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { GrammarDialect } from "../../grammar/dialects.ts";
import { openTextDocuments, PositionMock } from "../vscode-mock.ts";
import {
  asTextDocument,
  createDocument,
  createWorkspace,
  loadGrammarTestCore,
  textOfRange,
} from "./provider-test-utils.ts";

let GrammarCallHierarchyProvider: typeof import("../../grammar/providers/call-hierarchy.ts").GrammarCallHierarchyProvider;

beforeAll(async () => {
  await loadGrammarTestCore();
  ({ GrammarCallHierarchyProvider } = await import(
    "../../grammar/providers/call-hierarchy.ts"
  ));
});

afterEach(() => {
  openTextDocuments.length = 0;
});

type Item = import("vscode").CallHierarchyItem;
type Files = Array<{ path: string; text: string; dialect: GrammarDialect }>;

function setup(text: string, dialect: GrammarDialect, files: Files = []) {
  const path = `/workspace/main.${dialect}`;
  const provider = new GrammarCallHierarchyProvider(createWorkspace(files));
  const doc = createDocument(path, text, dialect);
  // The document the user works in is open in the editor.
  openTextDocuments.push(doc);
  return {
    provider,
    prepare: (line: number, character: number) =>
      provider.prepareCallHierarchy(
        asTextDocument(doc),
        new PositionMock(line, character) as never,
      ) as Item | undefined,
  };
}

function outgoing(
  provider: InstanceType<typeof GrammarCallHierarchyProvider>,
  item: Item,
  text: string,
) {
  return provider.provideCallHierarchyOutgoingCalls(item).map((call) => ({
    to: call.to.name,
    texts: call.fromRanges.map((range) => textOfRange(text, range)),
    ranges: call.fromRanges,
  }));
}

function incoming(
  provider: InstanceType<typeof GrammarCallHierarchyProvider>,
  item: Item,
) {
  return provider.provideCallHierarchyIncomingCalls(item).map((call) => ({
    from: call.from.name,
    uri: call.from.uri.path,
    count: call.fromRanges.length,
  }));
}

describe("call hierarchy provider", () => {
  test("prepares an item from a definition", () => {
    const { prepare } = setup('a = b\nb = "x"\n', "abnf");
    const item = prepare(1, 0);
    expect(item?.name).toBe("b");
    expect({ ...item?.selectionRange.start }).toEqual({
      line: 1,
      character: 0,
    });
  });

  test("prepares the same item from a reference as from the definition", () => {
    const { prepare } = setup('a = b\nb = "x"\n', "abnf");
    const fromDefinition = prepare(1, 0);
    const fromReference = prepare(0, 4);
    expect(fromReference?.name).toBe("b");
    expect(fromReference?.range).toEqual(fromDefinition?.range);
    expect(fromReference?.detail).toBe("main.abnf");
  });

  describe("prepares nothing", () => {
    const text = 'a = b ALPHA "s" ; c\n';

    test.each([
      ["a core rule without a body", 8],
      ["a name undefined in the workspace", 4],
      ["a position inside a string", 13],
      ["a position inside a comment", 18],
    ] as const)("for %s", (_label, character) => {
      expect(setup(text, "abnf").prepare(0, character)).toBeUndefined();
    });

    test("for an empty document", () => {
      expect(setup("", "abnf").prepare(0, 0)).toBeUndefined();
    });
  });

  test("outgoing calls group the reference ranges per callee", () => {
    const text = 'a = b c b\nb = "x" ALPHA\nc = a\n';
    const { provider, prepare } = setup(text, "abnf");
    const calls = outgoing(provider, prepare(0, 0) as Item, text);
    expect(calls.map((call) => call.to)).toEqual(["b", "c"]);
    expect(calls[0]?.texts).toEqual(["b", "b"]);
    expect(calls[0]?.ranges.map((range) => range.start.character)).toEqual([
      4, 8,
    ]);
  });

  test("outgoing calls omit core rules without a workspace definition", () => {
    const text = 'a = b c b\nb = "x" ALPHA\nc = a\n';
    const { provider, prepare } = setup(text, "abnf");
    expect(outgoing(provider, prepare(1, 0) as Item, text)).toEqual([]);
  });

  test("recursion appears in both directions", () => {
    const text = "a = a / b\nb = 'x'\n".replace(/'/g, '"');
    const { provider, prepare } = setup(text, "abnf");
    const item = prepare(0, 0) as Item;
    expect(outgoing(provider, item, text).map((c) => c.to)).toEqual(["a", "b"]);
    expect(incoming(provider, item)).toEqual([
      { from: "a", uri: "/workspace/main.abnf", count: 1 },
    ]);
  });

  test("incoming calls span workspace files and ignore other dialects", () => {
    const text = 'base = "x"\n';
    const { provider, prepare } = setup(text, "abnf", [
      { path: "/workspace/main.abnf", text, dialect: "abnf" },
      {
        path: "/workspace/user.abnf",
        text: "one = base base\ntwo = BASE\nthree = one\n",
        dialect: "abnf",
      },
      {
        path: "/workspace/user.ebnf",
        text: "base ::= 'x'\nuse ::= base\n",
        dialect: "ebnf",
      },
    ]);
    const item = prepare(0, 0) as Item;
    expect(incoming(provider, item)).toEqual([
      { from: "one", uri: "/workspace/user.abnf", count: 2 },
      { from: "two", uri: "/workspace/user.abnf", count: 1 },
    ]);
  });

  test("outgoing calls resolve callees defined in other files", () => {
    const text = "a = b\n";
    const { provider, prepare } = setup(text, "abnf", [
      { path: "/workspace/other.abnf", text: 'b = "x"\n', dialect: "abnf" },
    ]);
    const calls = provider.provideCallHierarchyOutgoingCalls(
      prepare(0, 0) as Item,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.to.uri.path).toBe("/workspace/other.abnf");
  });

  test("ABNF incremental alternatives belong to the same rule", () => {
    const text = 'a = b\nb = "x"\nc = "y"\na =/ c\nd = a\n';
    const { provider, prepare } = setup(text, "abnf");
    const item = prepare(3, 0) as Item;
    expect(item.selectionRange.start.line).toBe(0);
    expect(item.range.start.line).toBe(0);
    // The item range is the `=` rule only, not the rules up to the `=/`.
    expect(item.range.end.line).toBe(0);
    const calls = outgoing(provider, item, text);
    expect(calls.map((c) => c.to)).toEqual(["b", "c"]);
    expect(calls[1]?.ranges[0]?.start.line).toBe(3);
    // The caller of c is one merged rule "a", not two.
    const callers = incoming(provider, prepare(2, 0) as Item);
    expect(callers).toEqual([
      { from: "a", uri: "/workspace/main.abnf", count: 1 },
    ]);
  });

  test("an increment in another file is its own item with its own ranges", () => {
    const text = 'y = "q"\nx = "1"\n';
    const { provider, prepare } = setup(text, "abnf", [
      {
        path: "/workspace/other.abnf",
        text: "\n\n\ny =/ x\n",
        dialect: "abnf",
      },
    ]);
    // The `=` file's item has no calls: the call is written in other.abnf.
    const main = prepare(0, 0) as Item;
    expect(provider.provideCallHierarchyOutgoingCalls(main)).toEqual([]);
    // Incoming calls to x name the caller in the file that holds the call.
    const x = prepare(1, 0) as Item;
    const callers = provider.provideCallHierarchyIncomingCalls(x);
    expect(callers).toHaveLength(1);
    const caller = callers[0];
    expect(caller?.from.uri.path).toBe("/workspace/other.abnf");
    expect(caller?.fromRanges[0]?.start.line).toBe(3);
    // That caller item leads to the same call from its own file.
    const outgoingCalls = provider.provideCallHierarchyOutgoingCalls(
      caller?.from as Item,
    );
    expect(outgoingCalls.map((call) => call.to.name)).toEqual(["x"]);
    expect(outgoingCalls[0]?.fromRanges[0]?.start.line).toBe(3);
  });

  test("a reference on an increment line prepares that file's item", () => {
    const { prepare } = setup("y =/ a\n", "abnf", [
      { path: "/workspace/main.abnf", text: 'y = "q"\n', dialect: "abnf" },
    ]);
    expect((prepare(0, 0) as Item).uri.path).toBe("/workspace/main.abnf");
    expect((prepare(0, 0) as Item).selectionRange.start.line).toBe(0);
  });

  test("with two other files defining the name, neither item lists the caller", () => {
    const files: Files = [
      { path: "/workspace/a.abnf", text: 'x = "1"\n', dialect: "abnf" },
      { path: "/workspace/c.abnf", text: 'x = "2"\n', dialect: "abnf" },
      { path: "/workspace/b.abnf", text: "z = x\n", dialect: "abnf" },
    ];
    const { provider } = setup("q = r\n", "abnf", files);
    const resolved = provider.provideCallHierarchyOutgoingCalls({
      name: "z",
      uri: {
        path: "/workspace/b.abnf",
        toString: () => "file:///workspace/b.abnf",
      },
    } as never);
    expect(resolved).toHaveLength(1);
    const target = resolved[0]?.to as Item;
    const owners = ["a", "c"].map((name) => {
      const uri = {
        path: `/workspace/${name}.abnf`,
        toString: () => `file:///workspace/${name}.abnf`,
      };
      return provider
        .provideCallHierarchyIncomingCalls({ name: "x", uri } as never)
        .map((call) => call.from.name);
    });
    const winner = target.uri.path === "/workspace/a.abnf" ? 0 : 1;
    expect(owners[winner]).toEqual(["z"]);
    expect(owners[1 - winner]).toEqual([]);
  });

  test("a file that declares the name itself is not a caller of another copy", () => {
    const text = 'x = "2"\nz = x\n';
    const { provider, prepare } = setup(text, "abnf", [
      {
        path: "/workspace/other.abnf",
        text: 'x = "1"\ny = x\n',
        dialect: "abnf",
      },
    ]);
    expect(incoming(provider, prepare(0, 0) as Item)).toEqual([
      { from: "z", uri: "/workspace/main.abnf", count: 1 },
    ]);
  });

  test("an unsaved rename in another open file never throws", () => {
    const { provider, prepare } = setup("a = b\n", "abnf", [
      { path: "/workspace/other.abnf", text: 'b = "x"\n', dialect: "abnf" },
    ]);
    openTextDocuments.push(
      createDocument("/workspace/other.abnf", 'renamed = "x"\n', "abnf"),
    );
    expect(prepare(0, 4)).toBeUndefined();
    const calls = provider.provideCallHierarchyOutgoingCalls({
      name: "a",
      uri: {
        path: "/workspace/main.abnf",
        toString: () => "file:///workspace/main.abnf",
      },
    } as never);
    expect(calls).toEqual([]);
  });

  test("works for EBNF, BNF and RBNF with case-sensitive names", () => {
    const ebnf = "A ::= B a\nB ::= 'x'\na ::= 'y'\n";
    const e = setup(ebnf, "ebnf");
    expect(
      outgoing(e.provider, e.prepare(0, 0) as Item, ebnf).map((c) => c.to),
    ).toEqual(["B", "a"]);
    expect(incoming(e.provider, e.prepare(1, 0) as Item)).toEqual([
      { from: "A", uri: "/workspace/main.ebnf", count: 1 },
    ]);
    const bnf = "<a> ::= <b> | <b>\r\n<b> ::= 'x'\r\n";
    const b = setup(bnf, "bnf");
    const bnfCalls = outgoing(b.provider, b.prepare(0, 1) as Item, bnf);
    expect(bnfCalls).toHaveLength(1);
    expect(bnfCalls[0]?.texts).toEqual(["<b>", "<b>"]);
    const rbnf = "<a> ::= [ <b> ] ...\n<b> ::= 'x'\n";
    const r = setup(rbnf, "rbnf");
    expect(
      outgoing(r.provider, r.prepare(0, 1) as Item, rbnf).map((c) => c.to),
    ).toEqual(["<b>"]);
  });

  test("open documents are used instead of the indexed copy on disk", () => {
    const text = 'base = "x"\n';
    const stale = [
      {
        path: "/workspace/user.abnf",
        text: "old = base\n",
        dialect: "abnf" as const,
      },
    ];
    const { provider, prepare } = setup(text, "abnf", stale);
    const open = createDocument(
      "/workspace/user.abnf",
      "fresh = base\n",
      "abnf",
    );
    openTextDocuments.push(open);
    expect(incoming(provider, prepare(0, 0) as Item)).toEqual([
      { from: "fresh", uri: "/workspace/user.abnf", count: 1 },
    ]);
  });

  test("unknown items and cancelled requests give empty results", () => {
    const text = "a = b\nb = 'x'\n";
    const { provider, prepare } = setup(text, "abnf");
    const item = prepare(0, 0) as Item;
    const lost = {
      ...item,
      uri: { path: "/gone.abnf", toString: () => "file:///gone.abnf" },
    } as Item;
    expect(provider.provideCallHierarchyOutgoingCalls(lost)).toEqual([]);
    expect(provider.provideCallHierarchyIncomingCalls(lost)).toEqual([]);
    expect(
      provider.provideCallHierarchyOutgoingCalls(item, {
        isCancellationRequested: true,
      } as never),
    ).toEqual([]);
  });
});
