import type { GrammarDialect } from "../../grammar/dialects.ts";
import type { GrammarWorkspace } from "../../grammar/workspace.ts";
import { type CodeActionKindMock, RangeMock } from "../vscode-mock.ts";
import {
  applyWorkspaceEdit,
  asTextDocument,
  createDocument,
  createWorkspace,
} from "./provider-test-utils.ts";

type Applicable = Parameters<typeof applyWorkspaceEdit>[1];

export interface RefactorAction {
  title: string;
  kind: { value: string };
  edit: Applicable;
  command?: { command: string; arguments: unknown[] };
}

export interface RefactorSetup {
  text: string;
  dialect: GrammarDialect;
  workspace: GrammarWorkspace;
  provide(
    from: number,
    to: number,
    only?: CodeActionKindMock,
  ): RefactorAction[];
  at(needle: string, nth?: number): number;
  select(
    needle: string,
    nth?: number,
    only?: CodeActionKindMock,
  ): RefactorAction[];
  apply(action: RefactorAction): string;
}

export function setupRefactor(
  provider: new (
    workspace: GrammarWorkspace,
  ) => {
    provideCodeActions(...args: never[]): unknown;
  },
  text: string,
  dialect: GrammarDialect,
  extraFiles: Array<{
    path: string;
    text: string;
    dialect: GrammarDialect;
  }> = [],
): RefactorSetup {
  const workspace = createWorkspace([
    { path: `/workspace/test.${dialect}`, text, dialect },
    ...extraFiles,
  ]);
  const instance = new provider(workspace) as unknown as {
    provideCodeActions(
      doc: unknown,
      range: unknown,
      context: unknown,
      token: unknown,
    ): RefactorAction[] | undefined;
  };
  const doc = createDocument(`/workspace/test.${dialect}`, text, dialect);
  const starts = [0];
  for (const m of text.matchAll(/\r\n|\n|\r/g)) {
    starts.push((m.index ?? 0) + m[0].length);
  }
  const position = (offset: number): [number, number] => {
    let line = 0;
    while (line + 1 < starts.length && (starts[line + 1] as number) <= offset) {
      line++;
    }
    return [line, offset - (starts[line] as number)];
  };
  const at = (needle: string, nth = 0): number => {
    let from = -1;
    for (let k = 0; k <= nth; k++) {
      from = text.indexOf(needle, from + 1);
    }
    if (from < 0) {
      throw new Error(`"${needle}" #${nth} not found`);
    }
    return from;
  };
  const provide = (from: number, to: number, only?: CodeActionKindMock) => {
    const [l1, c1] = position(from);
    const [l2, c2] = position(to);
    return (
      instance.provideCodeActions(
        asTextDocument(doc),
        new RangeMock(l1, c1, l2, c2),
        { diagnostics: [], only },
        {},
      ) ?? []
    );
  };
  return {
    text,
    dialect,
    workspace,
    provide,
    at,
    select: (needle, nth = 0, only) =>
      provide(at(needle, nth), at(needle, nth) + needle.length, only),
    apply: (action) => applyWorkspaceEdit(text, action.edit),
  };
}

export function inlineResult(
  s: RefactorSetup,
  cursorAt: string,
  nth = 0,
  offset = 0,
): string | undefined {
  const from = s.at(cursorAt, nth) + offset;
  const action = s
    .provide(from, from)
    .find((entry) => entry.kind.value === "refactor.inline");
  return action ? s.apply(action) : undefined;
}
