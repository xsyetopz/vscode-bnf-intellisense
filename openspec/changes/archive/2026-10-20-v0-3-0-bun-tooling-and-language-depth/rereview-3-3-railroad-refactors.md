# Re-review 3.3: refactors + railroad + suite. Verdict: NOT READY (1 MED, 9 LOW)

Checks: `bun test` passed twice (2298/2298, about 6 s each). Biome and typecheck are clean. `git stash list` is empty. The popped stash (dangling b279218) differs from the tree only by later intended edits (repoText, L8 test removed, syntaxes rewrite, a registerGrammarCommands signature change, formatting), so nothing was lost. Probes are in /tmp/rr33/.

## Round-1 status
**Refactors:** 1–6 are all fixed and reproduced.
- 1: the argument is now `[[uri, pos]]`. The position stays valid after the edit, and BNF gets +1 inside `<`.
- 2: a foreign file with its own definition gives no note. ABNF case differences are handled too.
- 3: an unresolved foreign `new-rule` now yields `new-rule-2` in ABNF, BNF and EBNF.
- 4: a selection ending at column 0 is fixed.
- 5: the header comment is kept.
- 6: annotated rules are refused.
- The tests for these now assert behaviour.

**Railroad:**
- Fixed: 1 (per-part spans, per-part errors), 2 (`B - C*`, `(B - C)*`, `B - C - D(+)`, `B - (C)*`, `B - C D*` are all correct), 3, 4, 5, 6 (with a test), 7, 8, 9, 10 (activation registers no command twice under the throwing mock), 11, 16 (`bnf.railroad` matches host.ts:98), 18.
- Partial: 12, 13, 14, 15 (see the LOW items below).
- Skipped: 17 (docs).

## MED
1. **Inline-all deletes comments inside the definition.** This contradicts design.md 3.3: "never deletes comments".
   - Repro: `a = b\nb = x ; why x\n`, inline on `b = x`. The result is `a = x\n`. EBNF `b ::= x /* why */` behaves the same.
   - The tests encode the deletion: refactor-inline-layout.test.ts:119-124 (drops `; two` and `; three`) and :159-163 ("comments before the first and after the last token are dropped").
   - Cause: inline-rule.ts:146-170 (whole-line removal) plus bodyText, which runs only from the first token to the last.
   - Fix: keep comment-only lines and leading/trailing comments, for example by leaving them where the definition was, or change the spec wording. The maintainer should decide which.

## LOW
2. **An orphaned doc comment attaches to the next rule.** `a = b\n\n; doc b\nb = x\n; doc c\nc = y\n` becomes `…; doc b\n; doc c\nc = y`, so it now reads as c's doc. The spec allows this; consider adding a test or keeping a blank separator.
3. **Orphan `=/` merge takes the wrong name and comment.** diagrams.ts:83-87 keeps the orphan's name and comment: `A =/ "z"\na = "x"` shows "A", and the base rule's comment is lost. The spans come out as `[[3,3],[1,1],[4,4]]`, but diagrams.ts:24 says "in source order".
4. **The timing floor can still hide growth.** At scaling.ts:41, `large/max(small, 2)` still uses the floor after `MAX_DOUBLINGS`. With small = 0.3 ms, a quadratic large time of 4.8 ms gives 2.4, which passes.
5. **repoText is not used everywhere.** railroad-diagrams.test.ts:3-4 and :496 still use fs/path, and extension-activation.test.ts:2 uses readFileSync. `repoFile` (repo-file.ts:10) is now unused.
6. **Prose that describes the implementation.**
   - Test titles: analysis.test.ts:616 and :629 ("merges the ABNF provider's…").
   - Source comments that mention tests: commands/index.ts:46, railroad/host.ts:32, railroad/panel.ts:37.
7. **Tests with several act/assert steps (not Arrange-Act-Assert).** provider-linked-editing.test.ts:95-101, abnf-code-actions.test.ts:560-565, and syntaxes.test.ts:91-94 and :104-107. Convert them to `test.each`.
8. **Weak assertions.**
   - extension-activation.test.ts:32 checks `subscriptions.length > 0`.
   - railroad-diagrams.test.ts:180, :189, :259 and :474 use `toBeDefined()` on error/warning; assert the message instead.
   - railroad-diagrams.test.ts:510 checks only `length > 0`.
9. **BNF/RBNF strings are only partly tested.** Only escapes are covered (string-escape-highlighting.test.ts). Nothing tests where the string begins and ends, or that `"a\"b"` does not end at `\"`. EBNF has such a test at syntaxes.test.ts:287.
10. **Selecting a whole alternative line (col 0 to col 0) offers nothing.** Repro: `r = a\n    / b c\n    / d\n`. The selection includes the leading `/`. This is debatable: either strip a leading or trailing separator, or document the limit.
