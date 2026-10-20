import { beforeAll, describe, expect, test } from "bun:test";
import type { GrammarDialect } from "../../grammar/dialects.ts";
import { repoText } from "../repo-file.ts";
import { PositionMock, RangeMock } from "../vscode-mock.ts";
import {
  applyTextEdits,
  asTextDocument,
  createDocument,
  createWorkspace,
  loadGrammarTestCore,
  textOfRange,
} from "./provider-test-utils.ts";

let GrammarSelectionRangeProvider: typeof import("../../grammar/providers/selection-range.ts").GrammarSelectionRangeProvider;
let GrammarFormattingProvider: typeof import("../../grammar/formatting-provider.ts").GrammarFormattingProvider;
let GrammarRangeFormattingProvider: typeof import("../../grammar/formatting-provider.ts").GrammarRangeFormattingProvider;
let GrammarOnTypeFormattingProvider: typeof import("../../grammar/providers/on-type-formatting.ts").GrammarOnTypeFormattingProvider;
let GrammarLinkedEditingRangeProvider: typeof import("../../grammar/providers/linked-editing.ts").GrammarLinkedEditingRangeProvider;

beforeAll(async () => {
  await loadGrammarTestCore();
  ({ GrammarSelectionRangeProvider } = await import(
    "../../grammar/providers/selection-range.ts"
  ));
  ({ GrammarFormattingProvider, GrammarRangeFormattingProvider } = await import(
    "../../grammar/formatting-provider.ts"
  ));
  ({ GrammarOnTypeFormattingProvider } = await import(
    "../../grammar/providers/on-type-formatting.ts"
  ));
  ({ GrammarLinkedEditingRangeProvider } = await import(
    "../../grammar/providers/linked-editing.ts"
  ));
});

const DIALECTS: GrammarDialect[] = ["abnf", "bnf", "ebnf", "rbnf"];

function load(dialect: GrammarDialect, eol: "\n" | "\r\n"): string {
  const text = repoText(`examples/json.${dialect}`);
  return text.replace(/\r\n/g, "\n").replace(/\n/g, eol);
}

function containsPosition(
  range: { start: PositionMock; end: PositionMock },
  at: PositionMock,
): boolean {
  const afterStart =
    at.line > range.start.line ||
    (at.line === range.start.line && at.character >= range.start.character);
  const beforeEnd =
    at.line < range.end.line ||
    (at.line === range.end.line && at.character <= range.end.character);
  return afterStart && beforeEnd;
}

type Chained = {
  range: { start: PositionMock; end: PositionMock };
  parent?: Chained;
};

describe("providers on the example grammars", () => {
  for (const dialect of DIALECTS) {
    for (const eol of ["\n", "\r\n"] as const) {
      const label = `${dialect} (${eol === "\n" ? "LF" : "CRLF"})`;

      test(`${label}: selection ranges strictly nest outward from every position`, () => {
        const text = load(dialect, eol);
        const doc = createDocument(`/w/j.${dialect}`, text, dialect);
        const lines = text.split(eol);
        const positions: PositionMock[] = [];
        for (let line = 0; line < lines.length; line++) {
          for (let ch = 0; ch <= (lines[line]?.length ?? 0); ch++) {
            positions.push(new PositionMock(line, ch));
          }
        }
        const results =
          new GrammarSelectionRangeProvider().provideSelectionRanges(
            asTextDocument(doc),
            positions as never,
          );
        expect(results).toHaveLength(positions.length);
        results.forEach((result, index) => {
          const at = positions[index] as PositionMock;
          let previous: string | undefined;
          let last: Chained | undefined;
          const first = result as unknown as Chained;
          expect(containsPosition(first.range, at)).toBe(true);
          for (
            let r = result as unknown as Chained | undefined;
            r;
            r = r.parent
          ) {
            const piece = textOfRange(text, r.range);
            expect(piece.length).toBeGreaterThan(0);
            if (previous !== undefined) {
              expect(piece.length).toBeGreaterThan(previous.length);
              expect(piece).toContain(previous);
            }
            previous = piece;
            last = r;
          }
          expect(textOfRange(text, (last as Chained).range)).toBe(text);
        });
      });

      test(`${label}: range formatting the whole document matches full formatting`, () => {
        const text = load(dialect, eol)
          .replace(/ ::= /g, "   ::=    ")
          .replace(/ = /g, "   =   ");
        const doc = createDocument(`/w/j.${dialect}`, text, dialect);
        const full = applyTextEdits(
          text,
          new GrammarFormattingProvider().provideDocumentFormattingEdits(
            asTextDocument(doc),
            {} as never,
            {} as never,
          ) as never,
        );
        const lineCount = text.split(eol).length;
        const all =
          new GrammarRangeFormattingProvider().provideDocumentRangeFormattingEdits(
            asTextDocument(doc),
            new RangeMock(0, 0, lineCount, 0) as never,
            {} as never,
          ) as unknown as Array<{ range: RangeMock; newText: string }>;
        const fullLines = full.split(eol);
        const applied = applyTextEdits(text, all as never);
        const appliedLines = applied.split(eol);
        const originalLines = text.split(eol);
        expect(appliedLines.filter((line) => line.trim() !== "")).toEqual(
          fullLines.filter((line) => line.trim() !== ""),
        );
        expect(appliedLines.filter((line) => line.trim() === "").length).toBe(
          originalLines.filter((line) => line.trim() === "").length,
        );
        const commentsOf = (value: string) =>
          value.match(/;[^\r\n]*|\/\*[\s\S]*?\*\//g)?.map((c) => c.trim()) ??
          [];
        expect(commentsOf(applied)).toEqual(commentsOf(text));
        for (const edit of all) {
          const touched = originalLines.slice(
            edit.range.start.line,
            edit.range.end.line + 1,
          );
          expect(touched.join(eol)).not.toBe(edit.newText);
        }
        let stepwise = text;
        for (const edit of [...all].reverse()) {
          stepwise = applyTextEdits(stepwise, [edit as never]);
        }
        expect(stepwise).toBe(applied);
      });

      test(`${label}: Enter leaves complete rules alone and linked ranges hold one name`, () => {
        const text = load(dialect, eol);
        const doc = createDocument(`/w/j.${dialect}`, text, dialect);
        const lines = text.split(eol);
        const onType = new GrammarOnTypeFormattingProvider();
        const linked = new GrammarLinkedEditingRangeProvider(createWorkspace());
        for (let line = 0; line < lines.length; line++) {
          const edits = onType.provideOnTypeFormattingEdits(
            asTextDocument(doc),
            new PositionMock(line, 0) as never,
            "\n",
            {} as never,
          );
          expect(edits).toEqual([]);
          for (let ch = 0; ch <= (lines[line]?.length ?? 0); ch++) {
            const result = linked.provideLinkedEditingRanges(
              asTextDocument(doc),
              new PositionMock(line, ch) as never,
            );
            const texts = (result?.ranges ?? []).map((range) =>
              textOfRange(text, range),
            );
            for (const piece of texts) {
              expect(piece.length).toBeGreaterThan(0);
            }
            expect(new Set(texts).size).toBeLessThanOrEqual(1);
            if (result) {
              expect(
                result.ranges.some((range) =>
                  containsPosition(range, new PositionMock(line, ch)),
                ),
              ).toBe(true);
            }
          }
        }
      });
    }
  }
});
