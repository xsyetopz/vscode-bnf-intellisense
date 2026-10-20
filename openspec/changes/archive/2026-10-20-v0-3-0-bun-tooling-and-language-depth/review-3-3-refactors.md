# Review 3.3 extract/inline rule — NOT READY (1 MED, 5 LOW)

Exercised ~70 cases (/tmp/rv33/*.test.ts). Correct: grouping for alt/seq/op into seq, `*x`, `x?`, `-` both sides, RBNF `...`, `[ ]`; BNF refusal; `=/` (offer refusal + extract anchor, case-insensitive `Y =/`); ABNF case-insensitive refs; CR/CRLF/no-EOL; multi-line bodies with `;`/`/* */`; recursion; core rules; name clashes (case, refs).

## MED
1. Rename command args wrong shape — client/src/grammar/refactors/extract-rule.ts:178-185.
   VS Code RenameAction.runCommand(accessor, args) reads `const [uri, pos] = Array.isArray(args) && args` from the FIRST argument only (TS extension calls `executeCommand('editor.action.rename', [uri, pos])`). Here `arguments: [uri, pos]` → runCommand gets `uri`, ignores the position, renames at current cursor (after the replace the cursor sits at the end of `<new-rule>` → outside the name for BNF/RBNF).
   Fix: `arguments: [[ctx.doc.uri, new Position(...)]]`; update refactor-extract.test.ts:624-635. (From VS Code source; confirm in an extension host.)

## LOW
2. Cross-file title false positive — inline-rule.ts:194-206. Other file `q = x\nx = z\n` (own `x`), inline def `x` in `y = x\nx = a\n` → title "...; references in other files are left alone". Expected: no note; count only files whose refs resolve to this definition (no local definition of the key).
3. Name generation ignores unresolved refs in other files — extract-rule.ts:38-55. Other file `q = new-rule` (undefined) → picks `new-rule`, which then resolves that foreign ref and the follow-up rename edits it. Also add workspace reference keys to `used`.
4. Full-line selection not offered — extract-rule.ts:103-106. `r = a\n    / b c\n\nz = d\n`, select `b c\n` (end at col 0 of next line) → nothing. Clamp an end at column 0 to the previous line's content end before rule lookup.
5. Header comment deleted — inline-rule.ts:150-165. `; head\nx = a b\n\ny = x\n` inline def x → `y = a b\n`: the file header comment goes. Only take comments with no blank line between them and the rule when the rule is first? (At least don't take comments at line 0 when followed by... decide; add a test.)
6. Undocumented refusal — inline-rule.ts:77: rules with `[ wfc: ]`/`[ vc: ]` annotations are not inlined (reasonable) but design.md 3.3 "not offered" list omits it. Add it to design.md.

## Tests
AAA and behaviour-focused overall (table-driven input → resulting text). Issues:
- refactor-extract.test.ts:620-637 assert argument layout (`arguments[0]`, `[1]`), so they encode bug 1; the name "renames the new reference in the edited document" over-claims. Assert the command shape VS Code expects instead.
- refactor-registration.test.ts:22-26 asserts disposable/registration counts (implementation detail); the kinds test is fine.
- Missing: cross-file own-definition (2), foreign unresolved `new-rule` (3), full-line selection (4), header comment (5).
Source comments: no implementation-narration problems found.
