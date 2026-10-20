import { beforeAll, describe, expect, test } from "bun:test";
import {
  asTextDocument,
  createDocument,
  createWorkspace,
  loadGrammarTestCore,
} from "./grammar/provider-test-utils.ts";
import "./vscode-mock.ts";

let provideAbnfCodeActions: typeof import("../abnf/code-actions.ts").provideAbnfCodeActions;
let collectAbnfCaseHints: typeof import("../abnf/case-hints.ts").collectAbnfCaseHints;
let AbnfDiagnosticCode: typeof import("../abnf/diagnostic-codes.ts").AbnfDiagnosticCode;
let parseAbnf: typeof import("../abnf/parser.ts").parseAbnf;
let collectGrammarDiagnostics: typeof import("../grammar/diagnostics.ts").collectGrammarDiagnostics;

type Pos = { line: number; character: number };
type Edit = { range: { start: Pos; end: Pos }; text: string };

beforeAll(async () => {
  await loadGrammarTestCore();
  ({ provideAbnfCodeActions } = await import("../abnf/code-actions.ts"));
  ({ collectAbnfCaseHints } = await import("../abnf/case-hints.ts"));
  ({ AbnfDiagnosticCode } = await import("../abnf/diagnostic-codes.ts"));
  ({ parseAbnf } = await import("../abnf/parser.ts"));
  ({ collectGrammarDiagnostics } = await import("../grammar/diagnostics.ts"));
});

const ERROR = 0;
const WARNING = 1;

function diagnosticsOf(text: string) {
  const doc = createDocument("/w/a.abnf", text, "abnf");
  return collectGrammarDiagnostics(
    createWorkspace().get(asTextDocument(doc)),
    text,
  );
}

function kindValue(kind: unknown): string {
  return typeof kind === "string" ? kind : (kind as { value: string }).value;
}

/** Local stand-in for a CodeActionKind used as `context.only`. */
function onlyKind(value: string) {
  return {
    value,
    contains: (kind: unknown) => {
      const v = kindValue(kind);
      return v === value || v.startsWith(`${value}.`);
    },
  };
}

function actionsFor(
  text: string,
  options: {
    code?: string;
    line?: number;
    col?: number;
    end?: number;
    endLine?: number;
    only?: string;
    extra?: unknown[];
  } = {},
) {
  const doc = createDocument("/w/a.abnf", text, "abnf");
  const diagnostics = [
    ...diagnosticsOf(text),
    ...((options.extra ?? []) as ReturnType<typeof diagnosticsOf>),
  ].filter(
    (d) =>
      (options.code === undefined || d.code === options.code) &&
      (options.line === undefined || d.range.start.line === options.line),
  );
  const line = options.line ?? 0;
  const col = options.col ?? 0;
  const range = {
    start: { line, character: col },
    end: { line: options.endLine ?? line, character: options.end ?? col },
  };
  return provideAbnfCodeActions(
    asTextDocument(doc),
    range as never,
    {
      diagnostics,
      triggerKind: 1,
      only: options.only ? onlyKind(options.only) : undefined,
    } as never,
  );
}

function applyEdit(text: string, action: { edit?: unknown }): string {
  const edit = action.edit as {
    inserts: { position: Pos; text: string }[];
    replacements: Edit[];
  };
  const lines = text.split("\n");
  const offset = (p: Pos) =>
    lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
  const changes = [
    ...edit.inserts.map((i) => ({
      from: offset(i.position),
      to: offset(i.position),
      text: i.text,
    })),
    ...edit.replacements.map((r) => ({
      from: offset(r.range.start),
      to: offset(r.range.end),
      text: r.text,
    })),
  ].sort((a, b) => b.from - a.from);
  let out = text;
  for (const c of changes) {
    out = out.slice(0, c.from) + c.text + out.slice(c.to);
  }
  return out;
}

function errorCount(text: string): number {
  return parseAbnf(text).diagnostics.filter((d) => d.severity === ERROR).length;
}

function titles(text: string, options?: Parameters<typeof actionsFor>[1]) {
  return actionsFor(text, options).map((a) => a.title);
}

describe("ABNF diagnostic codes", () => {
  const codes = (text: string) =>
    parseAbnf(text).diagnostics.map((d) => d.code);

  test.each([
    ['a = ( "x"\n', "UnclosedGroup"],
    ['a = [ "x"\n', "UnclosedOption"],
    ["a = %x5A-41\n", "RangeOrder"],
    ["a = b\nc\n", "ContinuationIndent"],
    ["a = 5*3b\n", "RepetitionBounds"],
    ['a = "x\n', "UnterminatedString"],
    ["a =\n", "EmptyRule"],
  ] as const)(
    "attaches a stable code to the diagnostic for %p",
    (text, name) => {
      const result = codes(text);

      expect(result).toContain(AbnfDiagnosticCode[name]);
    },
  );
});

describe("ABNF quick fixes", () => {
  test("offers =/ for a duplicate definition on the later rule", () => {
    const text = 'a = "x"\na = "y"\n';

    const fixes = actionsFor(text, { line: 1 }).filter((a) =>
      a.title.includes('"=/"'),
    );

    expect(fixes).toHaveLength(1);
    const fixed = applyEdit(text, fixes[0] as never);
    expect(fixed).toBe('a = "x"\na =/ "y"\n');
    expect(errorCount(fixed)).toBe(0);
    expect(
      diagnosticsOf(fixed).filter((d) => d.severity === ERROR),
    ).toHaveLength(0);
  });

  test("does not offer =/ on the first definition", () => {
    const text = 'a = "x"\na = "y"\n';

    const first = titles(text, { line: 0 });

    expect(first.some((t) => t.includes('"=/"'))).toBe(false);
  });

  test("offers = for =/ without a base definition", () => {
    const text = 'a =/ "x"\nb = a\n';

    const fixes = actionsFor(text).filter((a) => a.title.includes('"="'));

    expect(fixes).toHaveLength(1);
    const fixed = applyEdit(text, fixes[0] as never);
    expect(fixed).toBe('a = "x"\nb = a\n');
    expect(
      diagnosticsOf(fixed).filter((d) => d.severity <= WARNING),
    ).toHaveLength(0);
  });

  test("does not offer = for =/ that precedes a later =", () => {
    const text = 'a =/ "x"\na = "y"\n';

    const result = titles(text);

    expect(result.some((t) => t.includes('Change to "="'))).toBe(false);
  });

  test("indents a column-0 continuation line", () => {
    const text = 'a = b\n/ c\nb = "x"\nc = "y"\n';

    const fixes = actionsFor(text, {
      code: AbnfDiagnosticCode.ContinuationIndent,
    });

    expect(fixes[0]?.title).toBe("Indent continuation line");
    const fixed = applyEdit(text, fixes[0] as never);
    expect(fixed).toBe('a = b\n    / c\nb = "x"\nc = "y"\n');
    expect(errorCount(fixed)).toBe(0);
    expect(parseAbnf(fixed).rules).toHaveLength(3);
  });

  test("indenting a plain continuation word removes the error", () => {
    const plain = "a = b\nb\n";

    const fixed = applyEdit(
      plain,
      actionsFor(plain, {
        code: AbnfDiagnosticCode.ContinuationIndent,
      })[0] as never,
    );

    expect(errorCount(fixed)).toBe(0);
  });

  test("inserts a missing ) at the end of the body", () => {
    const text = 'a = ( "x" / "y"\nb = a ; note\n';

    const fixes = actionsFor(text, { code: AbnfDiagnosticCode.UnclosedGroup });

    expect(fixes[0]?.title).toBe('Insert missing ")"');
    const fixed = applyEdit(text, fixes[0] as never);
    expect(fixed).toBe('a = ( "x" / "y")\nb = a ; note\n');
    expect(errorCount(fixed)).toBe(0);
  });

  test("inserts a missing ] before a mismatched closer", () => {
    const text = 'a = ( b [ c ) d\nb = "x"\nc = "y"\nd = "z"\n';

    const fixes = actionsFor(text, { code: AbnfDiagnosticCode.UnclosedOption });

    const fixed = applyEdit(text, fixes[0] as never);
    expect(fixed).toBe('a = ( b [ c] ) d\nb = "x"\nc = "y"\nd = "z"\n');
    expect(errorCount(fixed)).toBe(0);
  });

  test("inserts the closer of a multi-line body after the last token", () => {
    const text = 'a = [ b\n    / c ; tail\nb = "x"\nc = "y"\n';

    const fixes = actionsFor(text, { code: AbnfDiagnosticCode.UnclosedOption });

    const fixed = applyEdit(text, fixes[0] as never);
    expect(fixed).toBe('a = [ b\n    / c] ; tail\nb = "x"\nc = "y"\n');
    expect(errorCount(fixed)).toBe(0);
  });

  test.each([
    ["%x5A-41", "%x41-5A"],
    ["%d90-65", "%d65-90"],
    ["%b11-01", "%b01-11"],
  ] as const)("swaps reversed range bounds in %p", (bad, good) => {
    const text = `a = ${bad}\n`;

    const fixes = actionsFor(text, { code: AbnfDiagnosticCode.RangeOrder });

    expect(fixes).toHaveLength(1);
    const fixed = applyEdit(text, fixes[0] as never);
    expect(fixed).toBe(`a = ${good}\n`);
    expect(errorCount(fixed)).toBe(0);
  });
});

describe("ABNF char-val and num-val refactors", () => {
  const find = (text: string, col: number, titlePart: string) =>
    actionsFor(text, { col, end: col }).find((a) =>
      a.title.includes(titlePart),
    );

  test('rewrites "x" as %s"x" when it contains letters', () => {
    const text = 'a = "Ab"\n';

    const action = find(text, 6, "case-sensitive");

    expect(kindValue(action?.kind)).toBe("refactor.rewrite");
    const fixed = applyEdit(text, action as never);
    expect(fixed).toBe('a = %s"Ab"\n');
    expect(errorCount(fixed)).toBe(0);
  });

  test("does not offer case-sensitive for a string without letters", () => {
    const action = find('a = "12"\n', 6, "case-sensitive");

    expect(action).toBeUndefined();
  });

  test('rewrites "ab" as %x61.62', () => {
    const action = find('a = "ab"\n', 6, "%x");

    const fixed = applyEdit('a = "ab"\n', action as never);

    expect(fixed).toBe("a = %x61.62\n");
    expect(errorCount(fixed)).toBe(0);
  });

  test('rewrites %s"ab" as %x61.62 without the case-sensitive note', () => {
    const sensitive = 'a = %s"ab"\n';

    const action = find(sensitive, 8, "%x61.62");

    expect(action?.title).not.toContain("makes it case-sensitive");
    expect(applyEdit(sensitive, action as never)).toBe("a = %x61.62\n");
  });

  test("notes that %x for a string with letters makes it case-sensitive", () => {
    const action = find('a = "ab"\n', 6, "%x");

    expect(action?.title).toContain("case-sensitive");
  });

  test("omits the case-sensitive note for a string without letters", () => {
    const action = find('a = "1-"\n', 6, "%x");

    expect(action?.title).not.toContain("case-sensitive");
  });

  test('rewrites %x61.62 as %s"ab"', () => {
    const letters = "a = %x61.62\n";

    const fixed = applyEdit(letters, find(letters, 8, '%s"ab"') as never);

    expect(fixed).toBe('a = %s"ab"\n');
    expect(errorCount(fixed)).toBe(0);
  });

  test("rewrites decimal digit values as a plain string", () => {
    const digits = "a = %d49.50\n";

    const fixed = applyEdit(digits, find(digits, 8, '"12"') as never);

    expect(fixed).toBe('a = "12"\n');
  });

  test("rewrites a binary digit value as a plain string", () => {
    const binary = "a = %b110001\n";

    const fixed = applyEdit(binary, find(binary, 8, '"1"') as never);

    expect(fixed).toBe('a = "1"\n');
  });

  test.each([
    "a = %x41-5A\n",
    "a = %x22\n",
    "a = %x0D.0A\n",
    "a = %x7F\n",
    "a = %x\n",
  ])("does not convert the unsafe or non-literal num-val in %p", (text) => {
    const actions = actionsFor(text, { col: 6 });

    expect(actions).toHaveLength(0);
  });

  test("removes a redundant %i prefix", () => {
    const text = 'a = %i"ab"\n';

    const action = find(text, 8, "Remove redundant");

    expect(applyEdit(text, action as never)).toBe('a = "ab"\n');
  });

  test("offers nothing for an empty string", () => {
    const actions = actionsFor('a = ""\n', { col: 5 });

    expect(actions).toHaveLength(0);
  });

  test("offers nothing away from a literal", () => {
    const actions = actionsFor('a = b "x"\nb = "y"\n', { col: 0 });

    expect(actions).toHaveLength(0);
  });
});

describe("ABNF case-sensitivity hint", () => {
  test("reports only strings with uppercase letters", () => {
    const hints = collectAbnfCaseHints(
      'a = "GET" / "get" / %s"POST" / "1" / "Ab"\n',
    );

    expect(hints).toHaveLength(2);
    expect(
      hints.every((h) => h.code === AbnfDiagnosticCode.CaseInsensitiveString),
    ).toBe(true);
    expect(hints.every((h) => h.severity === 3)).toBe(true);
  });

  test("offers a quick fix that makes the string case-sensitive", () => {
    const text = 'a = "GET"\n';
    const doc = createDocument("/w/a.abnf", text, "abnf");

    const actions = provideAbnfCodeActions(
      asTextDocument(doc),
      {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      } as never,
      {
        diagnostics: collectAbnfCaseHints(text),
        triggerKind: 1,
        only: undefined,
      } as never,
    );

    expect(kindValue(actions[0]?.kind)).toBe("quickfix");
    expect(applyEdit(text, actions[0] as never)).toBe('a = %s"GET"\n');
  });

  test("skips unterminated strings", () => {
    expect(collectAbnfCaseHints('a = "GET\n')).toHaveLength(0);
    expect(collectAbnfCaseHints('a = "\n')).toHaveLength(0);
    expect(collectAbnfCaseHints('a = "GET"\n')).toHaveLength(1);
  });
});

describe("ABNF code action edge cases", () => {
  test("offers = only for the first =/ without a base", () => {
    const text = 'a =/ "x"\na =/ "y"\n';

    expect(actionsFor(text, { line: 0 }).map((a) => a.title)).toEqual([
      'Change to "=" (define "a")',
    ]);
    expect(
      actionsFor(text, { line: 1 }).filter((a) => a.title.includes("Change")),
    ).toHaveLength(0);
  });

  test("changing the first =/ to = leaves no warnings or errors", () => {
    const text = 'a =/ "x"\na =/ "y"\n';

    const fixed = applyEdit(text, actionsFor(text, { line: 0 })[0] as never);

    expect(fixed).toBe('a = "x"\na =/ "y"\n');
    expect(
      diagnosticsOf(fixed).filter((d) => d.severity <= WARNING),
    ).toHaveLength(0);
  });

  test("replaces a wrong-kind closer so the group parses cleanly", () => {
    const text = 'a = ( b ]\nb = "x"\n';

    const fix = actionsFor(text, {
      code: AbnfDiagnosticCode.UnclosedGroup,
    })[0];

    expect(fix?.title).toBe('Replace "]" with ")"');
    const fixed = applyEdit(text, fix as never);
    expect(fixed).toBe('a = ( b )\nb = "x"\n');
    expect(errorCount(fixed)).toBe(0);
  });

  test("replaces a wrong-kind closer so the option parses cleanly", () => {
    const opt = 'a = [ b )\nb = "x"\n';

    const fixed = applyEdit(
      opt,
      actionsFor(opt, { code: AbnfDiagnosticCode.UnclosedOption })[0] as never,
    );

    expect(errorCount(fixed)).toBe(0);
  });

  test("offers no closer fix when nothing follows the opener", () => {
    const actions = actionsFor("a = (\n", {
      code: AbnfDiagnosticCode.UnclosedGroup,
    });

    expect(actions).toHaveLength(0);
  });

  test("offers no indent fix right after a blank line", () => {
    const text = "a = b\n\nfoo\nb = c\n";

    const actions = actionsFor(text, {
      code: AbnfDiagnosticCode.ContinuationIndent,
    });

    expect(actions).toHaveLength(0);
  });

  test("indents continuation lines at the right column in CRLF documents", () => {
    const text = 'a = b\r\nfoo\r\nb = "x"\r\n';

    const fix = actionsFor(text, {
      code: AbnfDiagnosticCode.ContinuationIndent,
    })[0];

    expect(applyEdit(text.replace(/\r/g, ""), fix as never)).toBe(
      'a = b\n    foo\nb = "x"\n',
    );
  });

  test("inserts closers at the right column in CRLF documents", () => {
    const open = 'a = ( b\r\nb = "x"\r\n';

    const closer = actionsFor(open, { code: AbnfDiagnosticCode.UnclosedGroup });

    expect(applyEdit(open.replace(/\r/g, ""), closer[0] as never)).toBe(
      'a = ( b)\nb = "x"\n',
    );
  });

  test("offers refactors on literals in CRLF documents", () => {
    const lit = 'a = "Ab"\r\n';

    const actions = actionsFor(lit, { col: 6 });

    expect(actions.some((a) => a.title.includes("case-sensitive"))).toBe(true);
  });

  describe("context.only filtering", () => {
    const text = 'a = ( "Ab"\n';

    test("offers both quick fixes and refactors without a filter", () => {
      const all = actionsFor(text, { col: 7 });

      expect(all.length).toBeGreaterThan(1);
    });

    test("quickfix keeps only quick fixes", () => {
      const quick = actionsFor(text, { col: 7, only: "quickfix" });

      expect(quick.map((a) => a.title)).toEqual(['Insert missing ")"']);
    });

    test("refactor keeps only rewrite refactors", () => {
      const refactor = actionsFor(text, { col: 7, only: "refactor" });

      expect(refactor.length).toBeGreaterThan(0);
      expect(
        refactor.every((a) => kindValue(a.kind) === "refactor.rewrite"),
      ).toBe(true);
    });

    test("source yields nothing", () => {
      const source = actionsFor(text, { col: 7, only: "source" });

      expect(source).toHaveLength(0);
    });
  });

  test("does not repeat a hint's quick fix as a refactor", () => {
    const text = 'a = "GET"\n';

    const acts = actionsFor(text, {
      col: 6,
      extra: collectAbnfCaseHints(text),
    });

    expect(
      acts.filter((a) => a.title.startsWith("Make case-sensitive")),
    ).toHaveLength(1);
  });

  test("offers no refactors for a large selection", () => {
    const text = 'a = "Ab" "Cd"\n';

    const acts = actionsFor(text, { col: 4, end: 13 });

    expect(acts).toHaveLength(0);
  });

  test("offers refactors for a small selection inside a string", () => {
    const text = 'a = "Ab" "Cd"\n';

    const acts = actionsFor(text, { col: 6, end: 7 });

    expect(acts.map((a) => a.title)).toEqual([
      'Make case-sensitive: %s"Ab" (RFC 7405)',
      'Convert "Ab" to %x41.62 (makes it case-sensitive)',
    ]);
  });
});
