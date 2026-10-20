# Review: task 3.2 (new providers)

Checks: `bun run biome:check && typecheck && bun test && build` → all pass (410 pass, 0 fail, EXIT 0).
Scratch repros: /tmp/rev32/*.test.ts (run from the repo root: `bun test /tmp/rev32/<file>`).
All files are under 800 lines (vscode-mock.ts is at 719, close to the limit).

## HIGH
1. **Range formatting deletes comments (data loss).** client/src/grammar/formatting-provider.ts:113-141 with rule-layout.ts:243-250.
   Repro: ABNF `b=; c=` with range line 0 gives the edit `"b ="`, so the comment is gone. `b=  ; c\nd = e\n` also gives `"b ="`.
   Cause: when the body is empty, trimRegionEnd returns `from`. The rule's endLine then stops at the assign token, but the original line also holds the comment, and the formatter moves that comment to its own line, outside the rule's lines in the formatted text.
   RBNF garbage input `<a> ::= ||::=; c ::= ::= ]|((   | |[` also loses text: the formatted layout covers fewer lines than the original.
   Fix: before emitting each edit, compare the original slice and the replacement with all whitespace removed. If they differ, skip the edit, or return no edits at all. In abnfLayout, include the trailing comment for empty bodies too. Add fuzz/regression tests (see /tmp/rev32/fuzz.test.ts).

## MEDIUM
2. **prepareCallHierarchy throws on a stale index.** call-hierarchy.ts:69-83, 222-223.
   The definition comes from the on-disk index (collectWorkspaceDefinitions), but #item uses the open-document copy. If an unsaved edit renamed the rule there, you get `Error: No rule "x" in file:///workspace/other.abnf` (/tmp/rev32/ch2.test.ts).
   Fix: resolve the definition from `#sources(doc)`, and make #item return undefined instead of throwing.
3. **Incoming calls ignore cross-file shadowing.** call-hierarchy.ts:134-160.
   Setup: main.abnf has `x = "2"` and `z = x`; other.abnf has `x = "1"` and `y = x`. Incoming calls for main.x list `y` from other.abnf, but y calls its own local x (/tmp/rev32/ch.test.ts). This also disagrees with #definingSource (local definition first) in outgoing calls.
   Fix: skip sources that define `key` themselves, unless that source is `own`.

## LOW
4. The call hierarchy item range covers everything from the first `=` to the last `=/`, including the unrelated rules in between (`a = b\nb = "x"\nc = d\na =/ e` gives range 0:0-3:6). call-hierarchy.ts:225-240. Fix: use the `=` rule's definitionRange. fromRanges in `=/` increments still need a decision: either use separate items or accept them.
5. `=/` increments in other files are not merged into the item, so outgoing calls miss their references. call-hierarchy.ts:97, 220.
6. Code lens counts go stale when another file changes, because onDidChangeCodeLenses fires only on config changes. code-lens.ts:42-46. Fix: also fire on workspace index changes and on other documents' changes (debounced).
7. A code lens with "0 references" still runs showReferences, which opens an empty peek. code-lens.ts:98-102. Fix: use no command (or an empty command id) when the count is 0.
8. Selection range: a comment inside a rule gives the chain [comment → document] and skips the rule levels (`a = b ; note\n / c`). selection-range.ts:336-342. Fix: nest the comment's chain inside the rule's body/definition spans.
9. Linked editing refuses user-defined rules that have core-rule names (`ALPHA = "x"`). Hover, semantic tokens and call hierarchy let a user definition win. linked-editing.ts:80. Fix: check `!symbolTable.definitions.has(word)` before applying the core-rule exclusion.
10. Linked-editing word patterns are ASCII-only for EBNF/BNF (linked-editing.ts:16-21), while W3C Name allows Unicode. Unconfirmed impact: the parser also rejects `café`.
11. On-type formatting ignores `options.insertSpaces/tabSize` and always inserts spaces. Tabs count as 1 column (indentOf, bodyColumn). on-type-formatting.ts:43-45, 132.
12. On-type quotesBalanced counts `'` in ABNF (where it is not a delimiter) and quote characters inside other strings (EBNF `"'"`), so it gives false "unbalanced" results and skips the edit. on-type-formatting.ts:38-41.
13. On-type "mirror an existing alternative line" also matches `|`/`/` lines inside block comments. on-type-formatting.ts:163-172.
14. On-type in ABNF: Enter in the middle of a body (`a = b|c`) leaves `c` at column 0, which turns it into a new region. No edit is made and the document is now broken. Consider indenting when the previous line's rule was cut (compare with the pre-edit layout). on-type-formatting.ts:110-121. Design choice; flagging it.
15. Document links: `rfc 5234`, `RFC-5234` and `RFC\t5234` are not linked, but `RFC5234bis` is. document-links.ts:14. Fix: `/(?<![A-Za-z0-9])RFC[ \t-]?(\d{1,5})(?![\dA-Za-z])/gi`.
16. Performance: every call re-tokenizes the whole document, because layoutGrammar is not cached. This affects selection range, document links, on-type (every Enter), and range formatting (full format plus 2 layouts). Range semantic tokens compute the full-document set and then filter, so the range provider brings no speed gain. chooseAtom spreads all comments for each position (selection-range.ts:332-337, plus `includes`). Deferred to 4.1, but cache the layout per document version there.
17. Tests: in provider-sweep.test.ts the assertion `expect(at.line).toBeLessThan(lines.length)` does not check anything. Fix: assert that the first range contains the position, and check containment on ranges rather than with `toContain` on text. The range-formatting sweep filters out blank lines and never checks that comments are kept (that is how #1 got through). The linked-editing sweep only checks length > 0; it should also assert that all ranges have identical text.
18. Mock fidelity: SelectionRangeMock does not throw when the parent does not contain the range (real VS Code does). LinkedEditingRangesMock does not check that ranges have equal text or do not overlap. vscode-mock.ts SelectionRangeMock/LinkedEditingRangesMock.
19. Nit: a misplaced JSDoc in vscode-mock.ts (~line 32): "Clears test configuration overrides." now sits above setLanguageConfigurationValue.
20. Nit: the comment line in on-type-formatting.ts:70 is too long and wrapped badly.
21. Docs: the README settings table is missing `bnf.codeLens.references`, and the new providers are not in the README or CHANGELOG. This may be planned for 5.2.

## Out of scope but observed
- The RBNF formatter turns `/* x\n y */` into `/* x y */`, which changes a comment (test: `<a> ::=   <b> /* x\n y */ <c> ::=   <d>` with rbnf).

## Verified OK
- Selection ranges are strictly nested and the first range contains the position: fuzzed 16k random docs across 4 dialects with CRLF, zero failures (/tmp/rev32/sel.test.ts).
- Range-format edits never overlapped and never fell outside the range in the fuzz.
- ABNF tokens never span lines, so `endLine = line` is safe.
- Document links work with CRLF and multi-line block comments.
- Declaration falls back across files correctly.

## Not reviewed in depth
- Assertions in the range-semantic-tokens, declaration and code-lens tests.
- Real VS Code CodeLens resolve identity (WeakMap keyed by lens object; believed fine).
- A manual check in an extension host.
