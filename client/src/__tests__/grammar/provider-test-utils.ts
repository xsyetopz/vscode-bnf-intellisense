import { expect } from "bun:test";
import type { TextDocument } from "vscode";
import type { GrammarDialect } from "../../grammar/dialects.ts";
import { normalizeSymbolName } from "../../grammar/symbol-table.ts";
import { tokenizeGrammar } from "../../grammar/tokenizer.ts";
import type { GrammarWorkspace } from "../../grammar/workspace.ts";
import { PositionMock, RangeMock } from "../vscode-mock.ts";
import "../vscode-mock.ts";

let buildGrammarSymbolTable: typeof import("../../grammar/grammar.ts").buildGrammarSymbolTable;
let parseGrammar: typeof import("../../grammar/grammar.ts").parseGrammar;

type MockUri = {
  scheme: string;
  path: string;
  toString(): string;
};

export class DocumentMock {
  readonly uri: MockUri;
  version = 1;
  readonly languageId: GrammarDialect;
  readonly lineCount: number;
  readonly fileName: string;
  readonly isUntitled = false;
  readonly encoding = "utf-8";
  readonly isDirty = false;
  readonly isClosed = false;
  eol: 1 | 2 = 1;
  readonly save = async () => true;
  readonly validateRange = (range: RangeMock) => range;
  readonly validatePosition = (position: PositionMock) => position;
  readonly #text: string;
  readonly #lines: string[];
  readonly #lineOffsets: number[];

  constructor(
    path: string,
    text: string,
    languageId: GrammarDialect,
    eol?: 1 | 2,
  ) {
    this.uri = {
      scheme: "file",
      path,
      toString: () => `file://${path}`,
    };
    this.#text = text;
    this.languageId = languageId;
    this.fileName = path;
    this.eol = eol ?? (text.includes("\r\n") ? 2 : 1);
    this.#lines = text.split(/\r\n|\n|\r/);
    this.lineCount = this.#lines.length;
    this.#lineOffsets = [0];
    const breaks = /\r\n|\n|\r/g;
    for (let match = breaks.exec(text); match; match = breaks.exec(text)) {
      this.#lineOffsets.push(match.index + match[0].length);
    }
  }

  getText(range?: RangeMock): string {
    if (!range) {
      return this.#text;
    }
    return this.#text.slice(
      this.offsetAt(range.start.line, range.start.character),
      this.offsetAt(range.end.line, range.end.character),
    );
  }

  lineAt(line: number): { text: string } {
    return { text: this.#lines[line] ?? "" };
  }

  getWordRangeAtPosition(
    position: PositionMock,
    pattern: RegExp,
  ): RangeMock | undefined {
    const line = this.lineAt(position.line).text;
    for (const match of line.matchAll(new RegExp(pattern.source, "g"))) {
      const start = match.index ?? 0;
      const text = match[0] ?? "";
      const end = start + text.length;
      if (position.character >= start && position.character <= end) {
        return new RangeMock(position.line, start, position.line, end);
      }
    }
    return undefined;
  }

  positionAt(offset: number): PositionMock {
    let line = 0;
    while (
      line + 1 < this.#lineOffsets.length &&
      (this.#lineOffsets[line + 1] ?? Number.POSITIVE_INFINITY) <= offset
    ) {
      line++;
    }
    return new PositionMock(line, offset - (this.#lineOffsets[line] ?? 0));
  }

  offsetAt(line: number, character: number): number {
    return (this.#lineOffsets[line] ?? 0) + character;
  }
}

export async function loadGrammarTestCore(): Promise<void> {
  ({ buildGrammarSymbolTable, parseGrammar } = await import(
    "../../grammar/grammar.ts"
  ));
}

export function createDocument(
  path: string,
  text: string,
  languageId: GrammarDialect,
  eol?: 1 | 2,
): DocumentMock {
  return new DocumentMock(path, text, languageId, eol);
}

/**
 * Polls until the check holds, then asserts it, so tests wait for
 * background work without a fixed delay.
 */
export async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) {
    await Bun.sleep(5);
  }
  expect(check()).toBe(true);
}

export function asTextDocument(doc: DocumentMock): TextDocument {
  return doc as unknown as TextDocument;
}

export function createWorkspace(
  files: Array<{ path: string; text: string; dialect: GrammarDialect }> = [],
): GrammarWorkspace {
  const indexedFiles = files.map(({ path, text, dialect }) => {
    const document = parseGrammar(text, dialect);
    return {
      uri: {
        path,
        toString: () => `file://${path}`,
      },
      dialect,
      rules: document.rules,
      symbolTable: buildGrammarSymbolTable(document, dialect),
    };
  });

  return {
    findDefinitions(name: string, dialect: GrammarDialect) {
      return indexedFiles.flatMap((file) =>
        file.dialect === dialect
          ? file.rules
              .filter(
                (rule) =>
                  normalizeSymbolName(rule.name, dialect) ===
                  normalizeSymbolName(name, dialect),
              )
              .map((rule) => ({ uri: file.uri, dialect, rule }))
          : [],
      );
    },
    get(doc: DocumentMock) {
      const dialect = doc.languageId;
      const document = parseGrammar(doc.getText(), dialect);
      return {
        dialect,
        document,
        symbolTable: buildGrammarSymbolTable(document, dialect),
      };
    },
    getTokens(doc: DocumentMock) {
      return tokenizeGrammar(doc.getText(), doc.languageId);
    },
    getAllFiles(dialect?: GrammarDialect) {
      return dialect
        ? indexedFiles.filter((file) => file.dialect === dialect)
        : indexedFiles;
    },
  } as unknown as GrammarWorkspace;
}

interface AppliedEdit {
  start: number;
  end: number;
  text: string;
}

/**
 * Applies a WorkspaceEdit the way VS Code does: every edit refers to the
 * original text, edits are ordered by (start, end), and an edit that starts
 * before the previous one ends is rejected. Handles replacements, inserts,
 * deletes and snippet edits, and any mix of LF and CRLF line breaks.
 */
export function applyWorkspaceEdit(
  text: string,
  edit: {
    replacements: Array<{ range: unknown; text: string }>;
    inserts: Array<{ position: unknown; text: string }>;
    snippetEdits: Array<{ edits: unknown[] }>;
  },
): string {
  const starts = [0];
  const breaks = /\r\n|\n|\r/g;
  for (let m = breaks.exec(text); m; m = breaks.exec(text)) {
    starts.push(m.index + m[0].length);
  }
  const offset = (p: { line: number; character: number }): number =>
    (starts[p.line] ?? text.length) + p.character;
  const range = (r: unknown) => r as { start: PositionMock; end: PositionMock };
  const snippetText = (value: string): string =>
    value.replace(/\$\{\d+:([^}]*)\}/g, "$1").replace(/\\([\\$}])/g, "$1");
  const edits: AppliedEdit[] = [
    ...edit.replacements.map((r) => ({
      start: offset(range(r.range).start),
      end: offset(range(r.range).end),
      text: r.text,
    })),
    ...edit.inserts.map((i) => ({
      start: offset(i.position as PositionMock),
      end: offset(i.position as PositionMock),
      text: i.text,
    })),
    ...edit.snippetEdits.flatMap((entry) =>
      (
        entry.edits as Array<{ range: unknown; snippet: { value: string } }>
      ).map((e) => ({
        start: offset(range(e.range).start),
        end: offset(range(e.range).end),
        text: snippetText(e.snippet.value),
      })),
    ),
  ].sort((a, b) => a.start - b.start || a.end - b.end);
  let out = "";
  let cursor = 0;
  let previous: AppliedEdit | undefined;
  for (const e of edits) {
    if (previous && e.start < previous.end) {
      throw new Error(`overlapping edits: ${JSON.stringify([previous, e])}`);
    }
    out += text.slice(cursor, e.start) + e.text;
    cursor = e.end;
    previous = e;
  }
  return out + text.slice(cursor);
}

/**
 * Text of a range in a document, counting LF, CRLF, and lone CR as breaks.
 */
export function textOfRange(
  text: string,
  range: { start: PositionMock; end: PositionMock },
): string {
  const starts = [0];
  const breaks = /\r\n|\n|\r/g;
  for (let m = breaks.exec(text); m; m = breaks.exec(text)) {
    starts.push(m.index + m[0].length);
  }
  const offset = (p: PositionMock): number =>
    (starts[p.line] ?? text.length) + p.character;
  return text.slice(offset(range.start), offset(range.end));
}

/**
 * Applies text edits that all refer to the original text.
 */
export function applyTextEdits(
  text: string,
  edits: ReadonlyArray<{
    range: { start: PositionMock; end: PositionMock };
    newText: string;
  }>,
): string {
  const starts = [0];
  const breaks = /\r\n|\n|\r/g;
  for (let m = breaks.exec(text); m; m = breaks.exec(text)) {
    starts.push(m.index + m[0].length);
  }
  const offset = (p: PositionMock): number =>
    (starts[p.line] ?? text.length) + p.character;
  const sorted = [...edits].sort(
    (a, b) => offset(a.range.start) - offset(b.range.start),
  );
  let out = "";
  let cursor = 0;
  for (const edit of sorted) {
    const start = offset(edit.range.start);
    if (start < cursor) {
      throw new Error("overlapping edits");
    }
    out += text.slice(cursor, start) + edit.newText;
    cursor = offset(edit.range.end);
  }
  return out + text.slice(cursor);
}
