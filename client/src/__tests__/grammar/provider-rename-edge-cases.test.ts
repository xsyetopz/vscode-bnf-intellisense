import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  PositionMock,
  type RangeMock,
  resetConfigurationValues,
  type WorkspaceEditMock,
} from "../vscode-mock.ts";
import {
  asTextDocument,
  createDocument,
  createWorkspace,
  loadGrammarTestCore,
} from "./provider-test-utils.ts";

let GrammarRenameProvider: typeof import("../../grammar/providers/rename.ts").GrammarRenameProvider;
const token = {} as never;

beforeAll(async () => {
  await loadGrammarTestCore();
  ({ GrammarRenameProvider } = await import(
    "../../grammar/providers/rename.ts"
  ));
});

afterEach(() => {
  resetConfigurationValues();
});

describe("rename", () => {
  test("updates the self reference inside a recursive rule", () => {
    const doc = createDocument(
      "/w/a.ebnf",
      'list ::= item | list "," item\nitem ::= "x"\n',
      "ebnf",
    );

    const edit = new GrammarRenameProvider(
      createWorkspace(),
    ).provideRenameEdits(
      asTextDocument(doc),
      new PositionMock(0, 1) as never,
      "seq",
      token,
    ) as unknown as WorkspaceEditMock;

    expect(edit.replacements).toHaveLength(2);
    expect(
      edit.replacements.map((r) => (r.range as RangeMock).start.character),
    ).toEqual([0, 16]);
  });

  test("refuses a name that is already defined", () => {
    const doc = createDocument(
      "/w/a.ebnf",
      "a ::= b\nb ::= 'x'\nc ::= 'y'\n",
      "ebnf",
    );
    const provider = new GrammarRenameProvider(createWorkspace());

    const rename = () =>
      provider.provideRenameEdits(
        asTextDocument(doc),
        new PositionMock(1, 0) as never,
        "c",
        token,
      );

    expect(rename).toThrow("already defined");
  });

  test("accepts a name that differs only in case in a case-sensitive dialect", () => {
    const doc = createDocument(
      "/w/a.ebnf",
      "a ::= b\nb ::= 'x'\nc ::= 'y'\n",
      "ebnf",
    );
    const provider = new GrammarRenameProvider(createWorkspace());

    const edit = provider.provideRenameEdits(
      asTextDocument(doc),
      new PositionMock(1, 0) as never,
      "C",
      token,
    ) as unknown as WorkspaceEditMock;

    expect(edit.replacements).toHaveLength(2);
  });
});

describe("prepare rename", () => {
  test("keeps the original case of RBNF names", () => {
    const doc = createDocument(
      "/w/a.rbnf",
      '<Common Header> ::= <x>\n<msg> ::= <Common Header>\n<x> ::= "a"\n',
      "rbnf",
    );

    const prepared = new GrammarRenameProvider(createWorkspace()).prepareRename(
      asTextDocument(doc),
      new PositionMock(1, 12) as never,
      token,
    );

    expect(prepared?.placeholder).toBe("<Common Header>");
  });
});
