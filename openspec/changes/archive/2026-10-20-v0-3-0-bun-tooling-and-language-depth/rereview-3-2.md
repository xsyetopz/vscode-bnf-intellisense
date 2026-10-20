# Re-review: task 3.2 fixes

Checks: biome, typecheck, `bun test` (431 pass, 0 fail) and build all pass. Repros are in /tmp/rr32/*.test.ts (run `bun test /tmp/rr32/<f>` from the repo root).

## New findings

1. MEDIUM: cross-file `=/` call sites are reported against the wrong file. Introduced by fix #5.
   - Code: call-hierarchy.ts:86-93 (outgoing) and 140-148 (incoming).
   - VS Code reads `fromRanges` relative to the caller item's file: the item passed in for outgoing calls, `from` for incoming calls. The ranges of an `=/` in another file are pushed under the `=` file's item.
   - Repro (/tmp/rr32/ch3.test.ts): main.abnf has `y = "q"` and `x = "1"` (2 lines); other.abnf has `\n\n\ny =/ x`. Outgoing for y gives x with fromRanges `3:5-3:6` inside main.abnf, which has only 2 lines. Incoming for x gives `y @ main.abnf 3:5`.
   - Fix: make a separate item for each file with an `=/` (uri = the increment's file, range = the increment). Otherwise, drop ranges from other files and list them as their own caller item.
2. LOW: incoming calls still disagree with outgoing calls when the name is ambiguous (fix #3 is PARTIAL).
   - Code: call-hierarchy.ts:131-134.
   - Repro (ch3.test.ts test 2): a.abnf and c.abnf both have `x`; b.abnf has `z = x`. Outgoing for z resolves to a.abnf, but incoming for both a.x and c.x lists z.
   - Fix: keep a source's references only when `#definingSource(sources, source, key) === own`, which replaces the `declares` check.
3. LOW: on-type `stringsClosed` gives false "open string" results, so no edit is made (fix #12 is PARTIAL).
   - Code: on-type-formatting.ts:52-70.
   - Repro (/tmp/rr32/ot2.test.ts), each giving `[]`:
     - ABNF `a = "\" /`: ABNF strings have no escapes, but line 58 treats `\` as one outside EBNF.
     - EBNF `a ::= ["'] |`: a quote inside a character class.
     - EBNF `a ::= b /* don't */ |`: a quote inside a block comment.
     - ABNF `a = <say "hi> /`: a quote inside prose.
   - Fix: drop the rescan. Use the layout instead: check that no string token ends unterminated on line-1 (the `multiline` and `incomplete` flags already exist).
4. LOW: the mid-body split (#14) also re-indents a comment split off the line below a rule. Enter before `; note` in `a = b ; note` indents it to column 4. Enter *inside* the comment does nothing (line 169-174). This is harmless but inconsistent; skip lines that start with a comment. Otherwise the heuristic had no false positives (heads `name =`, `<x> ::=`, `[1] x ::=` and same-line second rules were all tested).
5. LOW: the code-lens JSDoc is stale. code-lens.ts:39 says the event "Fires when a `bnf.*` setting changed", but it now also fires on edits and index changes. The edit listener (line 56) also fires when `contentChanges` is empty (dirty/save events), which causes needless lens refreshes; skip those events.
6. LOW: selection-range.ts:351 still does `layout.comments.includes(atom)` per position, an O(n) remainder of #16. Return the comment flag from chooseAtom instead.
7. LOW: vscode-mock.ts is now 764 lines, close to the 800-line limit. Split the mocks before 4.x adds more.

## Specific questions
- Empty command id: valid. VS Code's CodeLensWidget renders a lens whose `command.id` is falsy as a plain `<span>` (not clickable), and the converter accepts `command: ""`. Note: a resolve that returns a lens without `command` (code-lens.ts:115-117, cancel/miss) would show `!!MISSING: command!!` if VS Code used the result. In practice it is dropped when cancelled. This is OK.
- Debounce and disposables: OK. The provider is in the disposables array that the providers module returns (index.ts:54). dispose() clears the timer and both subscriptions. GrammarWorkspace disposes #indexChanged.
- Memos: OK.
  - The layout memo is pure (text+dialect), and no caller mutates it.
  - The semantic memo key is uri+languageId+mode+maxTokens+text. Tokens depend only on local parse data, so there are no stale results across files or config changes.
- Whitespace guard: it hides nothing. All examples plus 10 edge inputs, under default and aggressive configs, show the formatter changing only whitespace (/tmp/rr32/ws.test.ts).

## Original findings
| # | Verdict |
|---|---|
| 1 | FIXED (fuzz: 0 bad; RBNF garbage gives []) |
| 2 | FIXED |
| 3 | PARTIAL (see new #2) |
| 4 | FIXED |
| 5 | PARTIAL (see new #1) |
| 6 | FIXED |
| 7 | FIXED |
| 8 | FIXED |
| 9 | FIXED |
| 10 | ACCEPTED |
| 11 | FIXED |
| 12 | PARTIAL (see new #3) |
| 13 | FIXED |
| 14 | FIXED (see new #4) |
| 15 | FIXED |
| 16 | FIXED (see new #6) |
| 17 | FIXED |
| 18 | FIXED |
| 19 | FIXED |
| 20 | FIXED |
| 21 | DEFERRED (5.2) |
| RBNF `/* */` | ACCEPTED |
