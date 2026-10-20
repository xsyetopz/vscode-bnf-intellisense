# Review: 3.3 railroad preview, wiring, test suite

**Verdict: NOT READY.** There are 2 MEDIUM correctness bugs in the railroad preview and 2 MEDIUM test-quality items in scope C. Everything else is LOW.

Checks: `bun test` ran 2071/2071 three times and again from client/ and client/src. The near-linear timing tests ran 6× in parallel under load with 0 failures. Typecheck and biome are clean.

**Security holds up.** Every grammar string goes through `escapeXml`, including control characters and lone surrogates. The CSP is `default-src 'none'` with nonces, and the nonce has 24 random bytes. `localResourceRoots` is `[]`. Message validation uses own properties only and checks against a Map, so prototype tricks don't get through. Disposing the panel clears both timers. I found no XSS. Probe: /tmp/rrscratch/probe.test.ts.

## MEDIUM
1. **Interleaved `=/` steals focus and error badges.** Location: diagrams.ts:79-80, :116 (`diagramAtLine`), :35-44 (`errorIn`).
   - Repro: `a = "x"\nb = "y"\na =/ "z"`.
   - Actual: `a` covers lines 0–2, so the cursor on line 1 focuses `a`. Errors in `b` would also show on `a`'s badge.
   - Expected: line 1 focuses `b`.
   - Fix: keep one line span per part and match the cursor and diagnostics against each part.
2. **W3C EBNF: a postfix after `-` repeats the whole exclusion.** Location: build.ts:220-232 together with `add` at :186-198.
   - Repro: `A ::= B - C*` builds `loop(except(B,C))`. `B - C+` and `B - 'x'?` have the same problem.
   - Expected: `except(B, C*)`. Postfix operators bind tighter than `-`.
   - Fix: when the last item is an except created by the previous operand, apply the suffix to its `excluded`.
3. **Tests assert internals or keep bug IDs.**
   - provider-actions-rename.test.ts:111 is titled `"L8: …keeps the document scan memoized"` and checks object identity of the scanner cache.
   - syntaxes.test.ts:21-60 only check that `repository[...]` keys exist with `toBeDefined`.
   - Fix: test what tokenizing produces, and drop the bug ID.
4. **Weak assertions behind implementation-prose titles.** analysis.test.ts:616 and :624 ("merges the ABNF provider's…") only assert `length > 0`. They should assert the specific fix or refactor titles.

## LOW
5. **`=/` before its base rule.** diagrams.ts:70,97: `a =/ "z"\na = "x"\na =/ "w"` draws two sections named `a`, and the first one is never merged or flagged.
6. **Re-activating the same document skips the cursor.** panel.ts:215-217 returns early without updating `#line`. With split editors on one file, switching editors doesn't refocus.
7. **Uncaught exception in the message handler.** panel.ts:343: `#lookup` calls `workspace.get` without a guard, so a parse failure throws inside `onDidReceiveMessage`. `#render` catches the same failure.
8. **CSP could be tighter.** page.ts:155: add `base-uri 'none'; form-action 'none'` as defence in depth.
9. **Real host is untested.** Nothing tests `createNonce` (host.ts:56) or the `createWebviewPanel` options. The mock at vscode-mock/extension-host.ts:97 ignores the options.
10. **Duplicate command IDs go unnoticed.** The mock `registerCommand` (extension-host.ts:84) silently overwrites a duplicate ID, which real VS Code would throw on.
11. **Layout tests.** railroad-layout.test.ts:324 "layout is deterministic" just renders a pure function twice and compares, which proves little. No test covers items 1, 2 or 5. The rest of the rebuilt coverage looks complete and makes sense.
12. **Timing helper can pass falsely.** scaling.ts:7-31 has no warm-up, and the 0.5 ms floor (`MIN_BASELINE_MS`) hides growth. Neither makes the tests flaky. Fix: add a warm-up call and require a minimum baseline time.
13. **Inconsistent file reading in tests.** Several tests use `readFileSync(repoFile(...).name ?? "")` (convert-dialect.test.ts:68, sort-rules.test.ts:507-570, convert-dialect-command.test.ts:68). The activation test uses a `URL` and railroad-diagrams uses `fs/path`. Fix: add a `repoPath`/`repoText` helper.
14. **Multi-behaviour tests.** provider-document-links.test.ts:104, provider-selection-range.test.ts:158 and provider-linked-editing.test.ts:106 each test several things. Split them to follow Arrange-Act-Assert.
15. **Source comments mention tests.** grammar/diagnostic-codes.ts:4 and abnf/diagnostic-codes.ts:3.
16. **Command hidden from the webview.** The `editorLangId` condition on the command-palette entry hides the railroad command while the preview has focus.
17. **Docs.**
    - README and CHANGELOG don't mention `bnf.showRailroadDiagram`.
    - AGENTS.md:9 links to the deleted ARCHITECTURE.md. HANDOVER says the deletion is intentional and planned for 5.2.
18. **Text width estimate.** layout.ts:24,58 uses a fixed character width, so wide or CJK labels overflow their boxes.

No `activationEvents` are needed: with engine ^1.91, VS Code generates them from contributed commands and languages.
