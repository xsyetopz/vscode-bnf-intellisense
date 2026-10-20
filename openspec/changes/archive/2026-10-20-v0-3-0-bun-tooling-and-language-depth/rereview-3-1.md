# Re-review 3.1
Verdict: **not ready to tick**, but close. Almost every earlier finding is fixed.
Open: 1 HIGH (CI is blocked), 4 MED and 4 LOW.
Checks: biome:check, typecheck and build pass, and bun test passes 248/248. Every file is under 800 lines (analysis.ts is the largest at 699).
Repros are in /tmp/rv. h.ts now applies edits with VS Code's overlap rules and includes snippet edits. New repros: p11, p12, fuzz.ts and perf4-6.

## Earlier findings
| ID | Status | Evidence |
|---|---|---|
| H1 | Fixed | 8000 similar-length undefined refs: 20.8s -> 86ms. 1000/2000 refs: 18/24ms. |
| H2 | Fixed | `[..]` -> `(..)?`, `(* *)` -> `/* */`, `.`, `n*x` (1-16) and `! /` are converted. `?..?`, `(/ /)`, nested and `*/` comments are refused with a disabled action. 3000 fuzzed ISO files: no overlaps and no new errors (the only report is the empty production `a = (* n *) ;`, which is equivalent). |
| M1 | Fixed | `a = "x" , ;` -> `a ::= "x"` |
| M2 | Mostly | `a = "x" ; b = "y" ;` is split correctly. A new bug when a comment sits between the two: see N2. |
| M3 | Fixed | One diagnostic per rule with a real path. The path search has a budget, and an 8000-rule SCC takes 82ms. |
| M4 | Fixed | RFC 3986: 0 unreachable. Only orphan cycles are reported. |
| M5 | Fixed | `a = "x" / ; or /⏎ "x"` -> `a = "x" ; or /`. The fix works on tokens and keeps comments. |
| M6 | Fixed | New `bnf.duplicate-extension` diagnostic, whose fix removes the `=/` lines. Partial duplicates are removed per alternative (`a =/ "z"`). |
| M7 | Fixed | `DIGT` -> "DIGIT" |
| M8 | **Partial** | The refresh on config change and the scoped reads are done. But the `[abnf]` overrides do not work in real VS Code: see N3. |
| L1 | Fixed | `a = /` and `( | )` give one diagnostic and no fix. |
| L2 | Fixed (one risk) | Uses a SnippetTextEdit with `${1:definition}` and doc.eol. See N4. |
| L3 | Fixed | LWSP counts as nullable. |
| L4 | Fixed | `"abc" / %i"abc"` is reported. |
| L5 | Fixed | Fixes match on code only, and the name comes from `getText(range)`. |
| L6 | Fixed | The file-wide action needs 2 or more productions. |

The 3.1B fixes have not regressed. The end-to-end run (p6) and the `context.only` filtering still work.

## New findings
**HIGH**
- **N1. bun.lock is stale, so CI fails.**
  - package.json:426 asks for `@types/vscode ^1.91.0`, but bun.lock:13 records `^1.75.0` and resolves to 1.75.0. The previous lock had 1.110.
  - `bun install --frozen-lockfile`, which ci.yml:29 and release.yml:77 run, fails with "lockfile had changes, but lockfile is frozen" (reproduced in /tmp/rv/lock).
  - It also means the local typecheck ran against the 1.75 types, not those for the 1.91 engine.
  - Fix: run `bun install`, then commit bun.lock. @types/vscode will move to the latest version that matches ^1.91.0.

**MED**
- **N2. ISO: a comment between two productions on one line breaks the result.**
  - `a = "x" ; (* c *) b = "y" ;` becomes `a ::= "x" /* c */ b ::= "y"`, which gives a stray-assignment error.
  - Cause: `#terminatorEdit` (iso-conversion.ts:205-221) decides whether the next production is on the same line from the next token, and skips that check when the next token is a comment.
  - Fix: look past comments to the next non-comment token. If it is on the same line, insert the line break before that token, after the comment.
- **N3. Language overrides cannot work: no `scope` is declared.**
  - All 28 `bnf.*` settings in package.json have no `scope`, so they default to `window`.
  - The VS Code docs (contribution points) say a setting needs `"scope": "language-overridable"` to be set inside `"[abnf]"`. `getConfiguration("bnf", {languageId})` will not apply such a block, and the Settings editor flags it.
  - The mock (vscode-mock.ts:435-446) applies `[lang]` values whatever the scope, so the tests pass against an API VS Code does not offer.
  - Fix: add `"scope": "language-overridable"` to the `bnf.diagnostics.*`, `bnf.formatting.*`, `bnf.semanticHighlighting.*` and `bnf.inlayHints.*` settings. Make the mock honour a scope table built from package.json, and add a test that a `window`-scoped setting ignores `[lang]`.
- **N4. The create-rule snippet may get indented.**
  - When the file has no final newline and its last line is indented, for example a `    / "y"` continuation, the snippet is inserted on that line.
  - VS Code re-indents the lines of a snippet to match the line it is inserted on unless `keepWhitespace` is set. The new `b = ...` would then become an ABNF continuation.
  - `keepWhitespace` exists in @types 1.110 but not in 1.75. I could not verify which version first has it.
  - Fix: set `keepWhitespace = true` and bump the engine if needed. Otherwise, when the last line starts with whitespace, fall back to a plain insert. Verify in an extension host.
- **N5. The code-action provider is quadratic in the number of diagnostics in context** (code-actions.ts:62-64).
  - Each ISO diagnostic calls `collectIsoRuns(text)` (:288); each undefined reference re-parses the document and builds a new NameSuggester (:111-115); each removal re-parses (alternative-removal.ts:20/30).
  - Select all + Ctrl+. on 4000 ISO productions: 31s. With one diagnostic: 15ms.
  - Fix: compute the parse, symbol table, suggester, ISO runs and body tokens once per `provideCodeActions` call, lazily, and pass them in.

**LOW**
- **N6. Inserted line breaks are always `"\n"`.**
  - The ISO same-line split and the comment edits insert a hard-coded `"\n"`, even in CRLF files: `a = "x"; b = "y";\r\n` gives a `\n`.
  - Create-rule already uses doc.eol. Fix: pass the document's line break into convertIsoText.
- **N7. Messages and fixes can disagree on did-you-mean.**
  - The fix ignores `bnf.diagnostics.didYouMean`, and it uses a new 40k budget. So a rename can be offered when the message suggested nothing, or when the setting is off.
  - Fix: read the setting with the document's scope, and reuse the suggestion from the diagnostic run (for example a WeakMap keyed by Diagnostic).
- **N8. Some ISO cases convert awkwardly.**
  - A leading top-level `(* header *)` is outside every ISO run, so it is not converted and gives unexpected-text afterwards (p11). Fix: convert comment-only strays when the file has ISO runs.
  - Nested comments are refused with a misleading reason (`"*" has no W3C equivalent`), and the reason "a comment unterminated comment" is garbled.
  - `{ }` becomes `( )*`.
- **N9. The test helper can hide overlaps** (review-fixes.test.ts:46-72).
  - Its overlap check is skipped whenever the later edit is a zero-width insert, so an insert strictly inside a replaced range passes. VS Code rejects that.
  - It also ignores `inserts` and `snippetEdits`, and it assumes `\n` line breaks.
  - No actual overlap is hidden today: the strict applier and the fuzzer found none.
  - Fix: sort ascending by (start, end) and flag `b.start < a.end`. Include inserts and snippets, and handle CRLF.

## Mock vs the real API (@types/vscode 1.75 and 1.110)
These match the real API:
- `WorkspaceEdit.set(uri, ReadonlyArray<TextEdit|SnippetTextEdit>)`
- `SnippetTextEdit.insert(Position, SnippetString)`
- `CodeAction.disabled = { reason }`
- `onDidChangeInlayHints` and `onDidChangeSemanticTokens` as `Event<void>`. Both providers dispose their emitter and their config subscription, and they are in context.subscriptions through registerGrammarProviders.

These differ:
- The mock's `set` appends edits; the real `set` replaces the edits already recorded for that URI. Only one call is made today, so this is harmless.
- `getConfiguration` does not check the setting's scope (N3).
- DocumentMock `eol` is always LF, so the CRLF paths of create-rule are never exercised.

## To tick 3.1
Fix N1 to N5. N6 to N9 are small and can go in the same pass.
