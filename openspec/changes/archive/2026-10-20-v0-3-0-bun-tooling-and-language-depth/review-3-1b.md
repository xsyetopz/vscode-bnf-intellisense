# Review 3.1B: ABNF quick fixes/refactors
Verdict: logic mostly sound; 17/17 tests pass. Not shippable yet: unwired, plus a few incorrect edits.

HIGH
1. provideAbnfCodeActions is never called (only definition: client/src/abnf/code-actions.ts:486). GrammarCodeActionProvider (client/src/grammar/code-actions.ts:22-23) advertises only QuickFix. Fix: delegate for languageId "abnf" and add CodeActionKind.RefactorRewrite to providedCodeActionKinds.

MED
2. Two `=/` lines with no base: both get "Change to =" (code-actions.ts:174-197). Fix-all then creates a duplicate `=`. Offer it only on the first `=/` (no earlier head with the same key).
3. Wrong-kind closer: `a = ( b ]` -> `( b) ]`, which still has an error (closerPosition :225-258). Replace the mismatched closer with the right one, or offer that as a second action.
4. A case hint on an unterminated string `"GET` gives `%s"GET`, still unterminated (case-hints.ts:18, code-actions.ts:316-320). Skip tokens that do not end with `"` (or that are just `"`).
5. Duplicate actions: with the hint on, "Make case-sensitive" shows twice (QuickFix + refactor). Leave out the refactor variant when a fix covers the same token.
6. The `context.only` path is untested. The mock CodeActionKind is plain strings with no `.contains` (vscode-mock.ts:285), so code-actions.ts:494-496 never runs. Also quick fixes are returned even when only=refactor; VS Code filters these out, so it is wasted work, not a bug.

LOW
7. Message fallback code-actions.ts:27-28,76-83 is dead now that grammar/diagnostics.ts:130,147 attach abnf.* codes. It also matches any diagnostic source. Remove it.
8. `a = (` -> `()`, an empty group, which is invalid ABNF. Skip when nothing follows the opener.
9. After a blank line, the indent fix produces a continuation that strict RFC 5234 rejects (c-nl must be followed by WSP). The parser accepts it, so this is minor.
10. A large selection gets 2-3 refactors per literal (touches(), :448-480). Limit refactors to an empty or single-token range.
11. makeAction has an unused `_document` parameter (:105).

Verified correct: CRLF/tab columns, comments after the body (closer goes before `;`), multi-line bodies, nested groups, %x/%d/%b decoding, %x22 and non-printables refused, ranges never decoded, `""` skipped. Letter strings convert to `%s"..."` and keep exact case. A meaning change ("makes it case-sensitive") is flagged in the title. Removing %I keeps the meaning. Range swap keeps the base letter.

Test gaps: CRLF, only-filtering, wrong-kind closer, multiple =/ with no base, unterminated string hint.
