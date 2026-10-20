import { beforeAll, describe, expect, test } from "bun:test";
import { PositionMock, type RangeMock } from "../vscode-mock.ts";
import {
  asTextDocument,
  createDocument,
  loadGrammarTestCore,
  textOfRange,
} from "./provider-test-utils.ts";

let GrammarSelectionRangeProvider: typeof import("../../grammar/providers/selection-range.ts").GrammarSelectionRangeProvider;

beforeAll(async () => {
  await loadGrammarTestCore();
  ({ GrammarSelectionRangeProvider } = await import(
    "../../grammar/providers/selection-range.ts"
  ));
});

describe("selection range inside rule comments", () => {
  test("a comment between alternatives still reaches the rule levels", () => {
    const text = "a = b ; note\n  / c\n";
    const doc = createDocument("/w/g.abnf", text, "abnf");

    const [result] = new GrammarSelectionRangeProvider().provideSelectionRanges(
      asTextDocument(doc),
      [new PositionMock(0, 8) as never],
    );

    const texts: string[] = [];
    for (
      let r = result as unknown as
        | { range: RangeMock; parent?: unknown }
        | undefined;
      r;
      r = r.parent as typeof r
    ) {
      texts.push(textOfRange(text, r.range));
    }
    expect(texts).toEqual([
      "; note",
      "b ; note\n  / c",
      "a = b ; note\n  / c",
      text,
    ]);
  });
});
