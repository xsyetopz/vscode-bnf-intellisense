# Final review 3.1: NOT READY (one MED blocks the tick)
Checks I ran: `--frozen-lockfile` (in /tmp/rv/lock), biome:check, typecheck, bun test (261/261) and build all pass.
The 1.91 typecheck in /tmp/t91 also passes. A negative control (an altered 1.91 d.ts in /tmp/rv/vsbad) makes it fail, so that check really is enforced.

## N1–N9
| ID | Status | Evidence |
|---|---|---|
| N1 | Fixed | The lock matches `^1.91.0` and frozen install succeeds. |
| N2 | Fixed | `a = "x" ; (* c *) b = "y" ;` -> `a ::= "x" /* c */⏎b ::= "y"` |
| N3 | Fixed | All 28 settings are `language-overridable`. The mock reads scopes from package.json and applies `[lang]` values only to those settings. |
| N4 | Fixed | After an indented last line the fix falls back to a plain insert. Its prefix always holds an EOL, or two when the last line is non-empty, so the new rule starts at column 0 even when the file has no final newline. Checked for ABNF CRLF and for EBNF. |
| N5 | Fixed | 4000 diagnostics in one request: 31s -> 142ms. SharedState is built per `provideCodeActions` call, and RemovalIndex per SharedState, so nothing is reused across calls and nothing can go stale. |
| N6 | Fixed | A CRLF same-line split now inserts `\r\n`. |
| N7 | Fixed | With didYouMean off, a diagnostic that was not recorded gets no rename (p15). |
| N8 | Fixed | Header comments are converted, the nested-comment reason is now accurate, and the reasons are no longer garbled. |
| N9 | Fixed per the implementer | I did not re-read the helper. With my strict VS Code-rule applier, the fuzzer (3000 cases) found no overlaps. |

Re-runs: examples give 0 diagnostics, RFC 3986 gives 0 unreachable, and p1, p3, p9-p12 and the perf scripts are all OK.

## MED (blocks the tick)
**F1. suggestion-store gives the wrong rename after an edit shifts ranges** (suggestion-store.ts:9, 25-59, used at code-actions.ts:194).
- `byDocument` maps a range string to a suggestion, with nothing that ties it to the name or the document version.
- VS Code shifts markers as soon as the user edits. The reparse runs after a 200ms debounce (workspace.ts:105-120), and in that window a shifted diagnostic's range can hit a different reference's entry.
- Repro (/tmp/rv/p13.ts): with `fooo`→food and `barr`→bark, insert a line at the top. The fix on `fooo` becomes **`Change "fooo" to "bark"`**.
- The WeakMap path is fine, but VS Code hands copies to the provider, so in practice the range map is what gets used.
- Fix: store `{ name, suggestion }` per range. In `recalledSuggestion`, return the stored value only if `doc.getText(diagnostic.range) === name`; otherwise return undefined, so the code falls back to the shared suggester. Optionally also key by `doc.version`, or clear the map on change. Add p13 as a test.
- Memory is fine. The WeakMap is GC-safe, the Map holds one entry per open document and is rebuilt on every run, and `forgetDocumentSuggestions` runs on close (extension.ts:74).

## LOW
- L-a. The per-production ISO action also rewrites a top-of-file `(* h *)` even when a W3C production sits between it and the ISO production. This is harmless, but it does more than the title says.
- L-b. An ISO `(* *)` placed between W3C productions is not converted; it is still read as unexpected-continuation text plus a `mid` reference.
- L-c. The plain-insert fallback leaves `b = ` with an empty body, so an empty-rule error shows until the user types.
- L-d. `{ }` becomes `( )*`.

## Mock checks
- package.json scopes default to `window` when a setting has none, matching VS Code.
- DocumentMock: eol is detected from `\r\n`, lines split on CR/LF/CRLF, and line offsets use the real break length, so getText and offsetAt are correct for CRLF.

## @types/vscode
Recommendation: **pin to `~1.91.0`, or the exact `1.91.0`.**
- With 1.140, typecheck accepts APIs newer than the 1.91 floor (for example `SnippetTextEdit.keepWhitespace`). Those would throw or silently do nothing on VS Code 1.91–1.139.
- The code typechecks against 1.91 today. vsce's check that @types is not above the engine passes with a pin.
- Raise the pin only when the engine moves, and always together with it.

## Verdict
NOT READY. Fix F1 with the name check and a test, then 3.1 can be ticked. The LOW items are optional.
