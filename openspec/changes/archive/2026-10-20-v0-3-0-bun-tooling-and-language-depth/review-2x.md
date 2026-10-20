# Review: v0.3.0 tasks 2.2 / 2.3 (uncommitted)

Verdict: mostly solid. ABNF A1–A13/A17 and grammar G1–G24 behave as described, and regression tests exist for each.
- RFC 3986, RFC 5234 App. B and examples/*.abnf give zero non-hint diagnostics (also with CRLF).
- ABNF formatter fuzz (old fz3 plus a new 4.8k-case fuzz with CRLF/CR/comment fragments): idempotent, no token loss.
- I found 1 HIGH, 4 MED and several LOW issues.

## HIGH
H1. The production formatter drops a comment that comes before a rule on the same line (token loss).
- Where: client/src/grammar/format.ts formatSimple (~l.205) and formatWithComments (~l.228). The comment lands in Production.precedingComment (scanner.ts Grouper #precedingComment l.449). The formatter rewrites the whole start line from `head` and never emits that comment.
- Repro (ebnf): `/* c */ a ::= b | c\nb ::= 'x'\n` -> `a ::= b\n      | c\n...`. The comment is gone. Same with `/* c */ a ::= b /* d\n e */`.
- Fix: if precedingComment.line === productionStartLine, emit the source from line start up to the name before `head`, or treat the production as verbatim. Add a regression test.

## MED
M1. The ABNF formatter pulls indented continuation comments out of the rule (a regression from HEAD, on RFC 5234's own Appendix B).
- Where: client/src/abnf/format.ts:104-106. trimRegionEnd cuts the body after the last token plus its same-line comment. Following lines like `    ; excluding NUL` become standalone column-0 "comment" items. Each one splits the alignment group (groupConsecutiveRules) and drops the blank lines between rules.
- They also become the *next* rule's doc comment (parser.ts collectPrecedingComment), so after formatting, the hover for CRLF says "carriage return".
- Repro: format RFC 5234 core rules (`CHAR = %x01-7F\n    ; any 7-bit...\nCR = %x0D\n    ; carriage return\nCRLF = CR LF`). HEAD kept them inline or indented, aligned, with blank lines.
- Fix: keep trailing comment-only continuation lines in the rule (render them at the continuation indent). At minimum, don't let them break groups or blank-line spacing.

M2. The formatter can change the token stream when `<`…`>` (BNF/RBNF) or `[`…`]`/annotations (EBNF) are split across lines.
- Where: format.ts joinTokens/normalizeBreaks (~l.125) joins the lines and the result re-lexes as an angleName/charClass. productionHasErrors (scanner.ts:536) treats a balanced EBNF `[ ]` group as fine, and ignores a stray BNF `<` punct.
- Repro (fuzz): bnf `<o\n  ect> ::= ...`, ebnf `a ::= [#x\n 7F-#x1FFF]`, and `[WFC: PEs in Inter\nnal Subset]` all change tokens.
- Fix: count EBNF `group:[` and BNF/RBNF `punct:<`/`>` as errors (emit verbatim). Or, more robust: rescan each formatted production and fall back to verbatim if the kind+text sequence differs.

M3. Garbage before the first production gets no diagnostic (G7/G8 only partly fixed).
- Where: scanner.ts Grouper.addToken l.429-443. With no current production or stray, the token is silently discarded.
- Repro: ebnf `hello world\na ::= 'x'` -> []; bnf `garbage\n<a> ::= 'x'` -> []; bnf `<a> = 'x'` -> [] (no rule, no diagnostic).
- Fix: collect these tokens into a stray and emit "Unexpected ... expected a rule definition". Add tests.

M4. EBNF still declares `;` as its line comment.
- Where: bnf-language-configuration.json:3 (shared by bnf, ebnf and rbnf; package.json:93). The design says `;` is not a comment in EBNF. Toggle-comment in .ebnf inserts `;`, which now lexes as punct and turns the commented words into undefined refs. BNF/RBNF also get a `/* */` blockComment they don't support.
- Fix: add an ebnf-language-configuration.json with blockComment only (and drop blockComment for bnf/rbnf).

## LOW
- L1 (A11 partial): `1*1` gives no hint (the audit asked for 0*0 / 1*1). `3* "x"` and `3 *"x"` (whitespace inside a repetition) are accepted silently. Where: body-parser.ts:275-358, where #peek skips trivia.
- L2: Cascading or misleading messages for `%x41..42` and `%x41-42.43` ("Unexpected "."" plus "Repetition has no element to repeat"). Mixing a range with concatenation is not reported as such. Where: body-parser.ts:77-95.
- L3 (A7/A8): references on skipped non-rule lines are dropped, giving a false "unused" hint. Repro: `a = b\nc\nb = "x"\nc = "y"` hints c. Where: abnf/parser.ts:205-212.
- L4: The production formatter merges column-0 garbage (an "unindented" warning) into the rule line, silently hiding the warning. Design says rules with errors are emitted verbatim. Fix: productionHasErrors returns true when unindentedTokens.length > 0.
- L5: RBNF `<a> ::= b`: bare `b` is neither a reference nor a diagnostic. Where: parser.ts:74-77.
- L6: syntaxes/abnf-markdown.tmLanguage.json was not given the info-string fence fix that G23 applied to bnf/ebnf/rbnf.
- L7: The EBNF TextMate exclusion `(?<=\s)-(?=\s)` misses `A -B`. The scanner calls every `-` an exclusion.
- L8 (perf): CLASS_RE/NUMBER_RE retry to end of line for each `[`. 20k `[` takes 121 ms, so it is quadratic but harmless. code-actions.ts isoConversionEdits rescans a sub-text, which evicts the single-entry scan memo (scanner.ts:504).
- Other perf is fine: 8k EBNF rules parse in 73 ms and format in 52 ms; 8k ABNF rules format in 40 ms. Semantic tokens O(n²) is deferred to 4.1 as designed.

## Rules / design
- `.ts` imports OK. All files under 800 lines (max: scanner.ts at 554). Only `bnf.*` settings. The core-rule lookup is still centralized.
- Case sensitivity is consistent: normalizeSymbolName is used in symbol-table, rename (with a conflict check), hover, completion, diagnostics and workspace index. Workspace symbol search is intentionally case-insensitive on the name.

## Not reviewed
- syntax-details.ts beyond the sx.ts repro and the A14 tests.
- format-renderer.ts internals.
- semantic-tokens/tokenizer.ts diff in depth.
- symbol-locations.ts cross-file rename.
- Extension-host TextMate check.
- The CHANGELOG note on the case change.
