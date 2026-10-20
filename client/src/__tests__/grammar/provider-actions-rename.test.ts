import { beforeAll, describe, expect, test } from "bun:test";
import {
  PositionMock,
  RangeMock,
  type WorkspaceEditMock,
} from "../vscode-mock.ts";
import {
  asTextDocument,
  createDocument,
  createWorkspace,
  loadGrammarTestCore,
} from "./provider-test-utils.ts";

let GrammarCodeActionProvider: typeof import("../../grammar/code-actions.ts").GrammarCodeActionProvider;
let GrammarRenameProvider: typeof import("../../grammar/providers/rename.ts").GrammarRenameProvider;

beforeAll(async () => {
  await loadGrammarTestCore();
  ({ GrammarCodeActionProvider } = await import(
    "../../grammar/code-actions.ts"
  ));
  ({ GrammarRenameProvider } = await import(
    "../../grammar/providers/rename.ts"
  ));
});

describe("grammar code action and rename providers", () => {
  test("offers ISO assignment replacement quick fix", () => {
    const provider = new GrammarCodeActionProvider();
    const doc = createDocument(
      "/workspace/root.ebnf",
      "root = value\n",
      "ebnf",
    );
    const diagnostic = {
      code: "bnf.iso-ebnf",
      message: 'Use "::=" for W3C XML EBNF productions.',
      range: new RangeMock(0, 0, 0, 12),
    };
    const actions =
      provider.provideCodeActions(
        asTextDocument(doc),
        new RangeMock(0, 0, 0, 0) as never,
        { diagnostics: [diagnostic] } as never,
        {} as never,
      ) ?? [];
    const edit = actions[0]?.edit as unknown as WorkspaceEditMock;

    expect(actions[0]?.title).toBe('Use "::=" for this EBNF production');
    expect(edit.replacements[0]?.text).toBe("::=");
  });

  test("renames one symbol across same-dialect workspace files", () => {
    const workspace = createWorkspace([
      {
        path: "/workspace/shared.ebnf",
        text: "shared ::= item\n",
        dialect: "ebnf",
      },
      {
        path: "/workspace/other.ebnf",
        text: "entry ::= shared\n",
        dialect: "ebnf",
      },
    ]);
    const provider = new GrammarRenameProvider(workspace);
    const doc = createDocument(
      "/workspace/main.ebnf",
      "root ::= shared\nshared ::= item\n",
      "ebnf",
    );
    const edit = provider.provideRenameEdits(
      asTextDocument(doc),
      new PositionMock(0, 10) as never,
      "renamed",
      {} as never,
    ) as unknown as WorkspaceEditMock;

    expect(edit.replacements).toHaveLength(4);
    expect(
      edit.replacements.every((replacement) => replacement.text === "renamed"),
    ).toBe(true);
  });

  test("rejects invalid rename targets and syntax-only positions", () => {
    const workspace = createWorkspace();
    const provider = new GrammarRenameProvider(workspace);
    const doc = createDocument(
      "/workspace/main.ebnf",
      "root ::= #x20 shared\nshared ::= item\n",
      "ebnf",
    );

    expect(
      provider.prepareRename(
        asTextDocument(doc),
        new PositionMock(0, 10) as never,
        {} as never,
      ),
    ).toBeUndefined();
    expect(
      provider.provideRenameEdits(
        asTextDocument(doc),
        new PositionMock(0, 18) as never,
        "bad name",
        {} as never,
      ),
    ).toBeUndefined();
  });
});
