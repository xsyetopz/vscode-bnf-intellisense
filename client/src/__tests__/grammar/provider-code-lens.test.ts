import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { GrammarDialect } from "../../grammar/dialects.ts";
import {
  EventEmitterMock,
  fireConfigurationChange,
  fireTextDocumentChange,
  resetConfigurationValues,
  setConfigurationValue,
  setLanguageConfigurationValue,
} from "../vscode-mock.ts";
import {
  asTextDocument,
  createDocument,
  createWorkspace,
  loadGrammarTestCore,
} from "./provider-test-utils.ts";

const createEmitter = () => new EventEmitterMock<void>();

let GrammarCodeLensProvider: typeof import("../../grammar/providers/code-lens.ts").GrammarCodeLensProvider;
let referenceLensTitle: typeof import("../../grammar/providers/code-lens.ts").referenceLensTitle;

beforeAll(async () => {
  await loadGrammarTestCore();
  ({ GrammarCodeLensProvider, referenceLensTitle } = await import(
    "../../grammar/providers/code-lens.ts"
  ));
});

afterEach(() => {
  resetConfigurationValues();
});

interface Lens {
  range: { start: { line: number; character: number } };
  command?: { title: string; command: string; arguments?: unknown[] };
}

function lenses(
  text: string,
  dialect: GrammarDialect,
  files: Array<{ path: string; text: string; dialect: GrammarDialect }> = [],
  path = `/workspace/main.${dialect}`,
): Array<{ line: number; title: string; lens: Lens }> {
  const provider = new GrammarCodeLensProvider(createWorkspace(files));
  const doc = asTextDocument(createDocument(path, text, dialect));
  return (provider.provideCodeLenses(doc) as Lens[]).map((lens) => {
    expect(lens.command).toBeUndefined();
    const resolved = provider.resolveCodeLens(lens as never) as Lens;
    return {
      line: lens.range.start.line,
      title: resolved.command?.title ?? "",
      lens: resolved,
    };
  });
}

describe("code lens provider", () => {
  test("titles use singular and plural", () => {
    expect(referenceLensTitle(0)).toBe("0 references");
    expect(referenceLensTitle(1)).toBe("1 reference");
    expect(referenceLensTitle(2)).toBe("2 references");
  });

  test("one lens per rule with the reference count, all dialects", () => {
    expect(
      lenses('a = b b\nb = "x"\nc = a\n', "abnf").map((l) => l.title),
    ).toEqual(["1 reference", "2 references", "0 references"]);
    expect(
      lenses("A ::= B B\nB ::= 'x'\nC ::= A\n", "ebnf").map((l) => l.title),
    ).toEqual(["1 reference", "2 references", "0 references"]);
    expect(
      lenses("<a> ::= <b> <b>\n<b> ::= 'x'\n", "bnf").map((l) => l.title),
    ).toEqual(["0 references", "2 references"]);
    expect(
      lenses("<a> ::= <b>\n<b> ::= 'x'\n", "rbnf").map((l) => l.title),
    ).toEqual(["0 references", "1 reference"]);
  });

  test("lens sits on the rule name and runs showReferences", () => {
    const [entry] = lenses('\n\nb = a\na = "x"\nc = b\n', "abnf");
    expect(entry?.line).toBe(2);
    expect(entry?.lens.command?.command).toBe("editor.action.showReferences");
    const [uri, position, locations] = (entry?.lens.command?.arguments ??
      []) as [{ path: string }, { line: number; character: number }, unknown[]];
    expect(uri.path).toBe("/workspace/main.abnf");
    expect(position).toEqual({ line: 2, character: 0 });
    expect(locations).toHaveLength(1);
  });

  test("a lens with no references is plain text, not an empty peek", () => {
    const [entry] = lenses('a = "x"\n', "abnf");
    expect(entry?.title).toBe("0 references");
    expect(entry?.lens.command?.command).toBe("");
    expect(entry?.lens.command?.arguments).toBeUndefined();
  });

  test("refreshes after edits and index changes, debounced", async () => {
    const workspace = createWorkspace() as unknown as {
      onDidChangeIndex: ReturnType<typeof createEmitter>["event"];
    };
    const index = createEmitter();
    workspace.onDidChangeIndex = index.event;
    const provider = new GrammarCodeLensProvider(workspace as never, 5);
    let fired = 0;
    provider.onDidChangeCodeLenses(() => {
      fired++;
    });
    fireTextDocumentChange("markdown");
    // Dirty-state and save events carry no content change.
    fireTextDocumentChange("ebnf", []);
    expect(fired).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fired).toBe(0);
    fireTextDocumentChange("abnf");
    fireTextDocumentChange("abnf");
    index.fire();
    expect(fired).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fired).toBe(1);
    fireTextDocumentChange("markdown");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fired).toBe(1);
    fireTextDocumentChange("ebnf");
    provider.dispose();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fired).toBe(1);
  });

  test("counts cross-file references and passes their locations", () => {
    const result = lenses('a = "x"\n', "abnf", [
      { path: "/workspace/other.abnf", text: "b = a / A\n", dialect: "abnf" },
    ]);
    expect(result[0]?.title).toBe("2 references");
    const locations = result[0]?.lens.command?.arguments?.[2] as unknown[];
    expect(locations).toHaveLength(2);
    // ABNF names are case-insensitive, other dialects are not.
    const ebnf = lenses("a ::= 'x'\n", "ebnf", [
      { path: "/workspace/other.ebnf", text: "b ::= a A\n", dialect: "ebnf" },
    ]);
    expect(ebnf[0]?.title).toBe("1 reference");
  });

  test("ABNF incremental alternatives get no lens of their own", () => {
    const result = lenses('a = b\na =/ c\nb = "x"\nc = a\n', "abnf");
    expect(result.map((l) => l.line)).toEqual([0, 2, 3]);
    expect(result[0]?.title).toBe("1 reference");
  });

  test("duplicate definitions each get a lens; empty and CRLF documents work", () => {
    expect(lenses("a = x\na = y\n", "abnf")).toHaveLength(2);
    expect(lenses("", "abnf")).toEqual([]);
    expect(
      lenses("a ::= b\r\nb ::= 'x'\r\n", "bnf").map((l) => l.title),
    ).toEqual(["0 references", "1 reference"]);
    expect(
      lenses("a ::= b\r\nb ::= 'x'\r\n", "ebnf").map((l) => l.title),
    ).toEqual(["0 references", "1 reference"]);
  });

  test("bnf.codeLens.references turns lenses off, per language too", () => {
    const text = 'a = b\nb = "x"\n';
    setConfigurationValue("bnf.codeLens.references", false);
    expect(lenses(text, "abnf")).toEqual([]);
    resetConfigurationValues();
    setLanguageConfigurationValue("abnf", "bnf.codeLens.references", false);
    expect(lenses(text, "abnf")).toEqual([]);
    expect(lenses("a ::= b\nb ::= 'x'\n", "ebnf")).toHaveLength(2);
  });

  test("refreshes when a bnf setting changes and stops after dispose", () => {
    const provider = new GrammarCodeLensProvider(createWorkspace());
    let fired = 0;
    provider.onDidChangeCodeLenses(() => {
      fired++;
    });
    fireConfigurationChange("bnf.codeLens.references");
    expect(fired).toBe(1);
    fireConfigurationChange("editor");
    expect(fired).toBe(1);
    provider.dispose();
    fireConfigurationChange("bnf");
    expect(fired).toBe(1);
  });

  test("honours cancellation and ignores foreign lenses", () => {
    const provider = new GrammarCodeLensProvider(createWorkspace());
    const doc = asTextDocument(createDocument("/w/a.abnf", "a = b\n", "abnf"));
    expect(
      provider.provideCodeLenses(doc, {
        isCancellationRequested: true,
      } as never),
    ).toEqual([]);
    const [lens] = provider.provideCodeLenses(doc);
    const cancelled = provider.resolveCodeLens(
      lens as never,
      {
        isCancellationRequested: true,
      } as never,
    ) as Lens;
    expect(cancelled.command).toBeUndefined();
    const foreign = { range: lens?.range } as never;
    expect((provider.resolveCodeLens(foreign) as Lens).command).toBeUndefined();
  });
});
