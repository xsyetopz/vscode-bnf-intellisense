# Task 2.1 audit: BNF / EBNF / RBNF (client/src/grammar, syntaxes, snippets)
Repro scripts: /tmp/bnfaudit/{p1,p2,p3,f1,fuzz}.ts, XML 1.0 excerpt /tmp/bnfaudit/xml.ebnf (run with `bun <file>`).
Root cause shared by bugs 1-6: three separate regex lexers (parser.ts, tokenizer.ts, format.ts) that disagree, and run strings before classes/comments.
Fix for all of them: one single-pass scanner per dialect, used by the parser, semantic tokens and formatter, in this order: comment > char class > string.

## Bugs
1. HIGH parser.ts:98-100, tokenizer.ts:201. Strings are masked before EBNF char classes. `AttValue ::= '"' ([^<&"] | Reference)* '"'` drops the `Reference` ref and reports a false "Opening ( / [ has no matching closer". Same for SystemLiteral and EntityValue (XML [9], [10], [11]).
2. HIGH parser.ts:98-100. Strings are masked before comments, and STRING_RE crosses newlines. `a ::= b /* don't */ c` yields a bogus ref `don`. BNF `; don't` followed by `| <c> 'x'` loses the `<c>` ref.
3. HIGH parser.ts:211 `.filter(ref => ref.name !== ownName)`, also tokenizer.ts:369,386. Self-references are dropped. With `list ::= item | list "," item`, rename leaves the inner `list` unchanged (breaks the grammar). Also: no semantic token or highlight for it, and the "recursive" inlay hint (inlay-hints.ts:112) can never show. Fix: keep self refs and exclude them only when counting "unused".
4. HIGH format.ts:284. `;` and `/*` inside an EBNF char class are treated as a comment: `a ::= [^;] | b` becomes `a ::= [^  ;] | b`, which changes the semantics. Same for `[/*]`. `;` is not a comment in W3C EBNF at all.
5. MED parser.ts:42 INVALID_EBNF_CHAR_CODE_RE runs on the raw body. False warnings on `'&#x' [0-9a-fA-F]+` (XML [66] CharRef) and on `"#xZZ"`.
6. MED parser.ts:102 (stripLineComment for every dialect). EBNF `a ::= b ; c` silently drops `c`, while tokenizer.ts:178 does not treat `;` as a comment in EBNF.
7. MED parser.ts:185-201. A production runs until the next line that looks like a production start, even inside comments. `/*\n foo ::= bar\n*/` defines `foo` and reports `bar` undefined. Garbage lines after a rule are absorbed as references with no syntax error.
8. MED parser.ts:170-173. The ISO `=` check only runs on lines outside any production, so before the first rule only: `a ::= b\nb = 'x' ;` gives no ISO warning. It also fires on lines inside a multi-line `/* */`. Any unrecognised line (e.g. `<a> ::= 'x'` in EBNF) gets no diagnostic.
9. MED parser.ts:39, tokenizer.ts:172. An unterminated `/*` gives no diagnostic, and its words become undefined references.
10. MED parser.ts:45,131 XML_HEX_MARKER_RE. A rule named `x` or `X` is never counted as referenced (false "unused"). It also applies to BNF.
11. MED parser.ts:38 / tokenizer.ts:37. `\` is treated as an escape, but W3C XML EBNF has no string escapes, so `"\"` is mis-lexed (formatter: format.ts:129).
12. MED symbol-table.ts:13-18. Names are case-insensitive for every dialect. In EBNF, `Name ::=` plus `name ::=` gives a false duplicate warning, and the wrong case resolves silently. W3C names are case-sensitive; RBNF is unverified.
13. MED ranges.ts:28-55. rangeFromOffsets counts only `\n`. With CR-only line endings, ranges are wrong (`a ::= 'x'\rb ::= a` puts the ref at 0:16).
14. MED workspace.ts:131-139. searchSymbols matches against the key `dialect:name`, so a query of `bnf` or `:` matches every symbol (verified by reading the code).
15. MED rename.ts:59 and word-at-position.ts:38. The prepareRename placeholder is lowercased: RBNF `<Common Header>` shows as `<common header>`. The IDENTIFIER_PATTERN fallback (word-at-position.ts:49) lets you rename or go to definition from words inside comments and strings, and it breaks on `_`, `.` and `:` names. No conflict check is done against existing names.
16. MED format.ts:93-98. blankLinesBetweenRules=2 yields 1. Lines inside `/* */` that look like rules get reformatted. Existing continuation lines are not re-indented after realignment. No blank line is added after a multi-line rule (format.ts:341-344).
17. LOW format.ts:151-175. `<` and `(` inside char classes are counted as depth: `[^<] | b` never breaks, and `( [)] | b ) | c` breaks inside the group. alternativeIndent "indent" (format.ts:231) indents from the end of the name, so it looks the same as "align". alignProductionNumbers does not pad `[1]` against `[10]`.
18. LOW formatting-provider.ts:47. It always replaces the whole document, even when nothing changed. Return [] in that case, or a minimal diff.
19. LOW parser.ts:377-380. definitionRange includes trailing blank or comment lines, so folds and symbols swallow the next rule's comment. collectPrecedingComment (parser.ts:140) handles only single-line comments.
20. LOW code-actions.ts:46. The ISO quick-fix regex `(^|\s)=` does not match `a=b` and returns an empty edit. It also leaves the ISO `;` and `,` in place.
21. LOW completion.ts:24-35. Completion ignores context: it fires inside strings and comments and on `"`, `'`, `#` and `%` in every dialect. BNF items have no range after the `<` trigger, so `<<a>` is possible (unverified in a real VS Code host).
22. LOW completion.ts:174-183, snippets/rbnf.json:12-20, rbnf.tmLanguage `\d*\*\d*`. RBNF uses ABNF-style `*(x)` and `1*(x)`. RFC 5511 uses `[ ]` and `...`, and `...` has no token or scope.
23. LOW ebnf.tmLanguage. The `A - B` exclusion has no operator scope. `[ wfc: ... ]` and `[VC: ...]` are scoped as a character class (in semantic tokens too). Markdown fences with extra info text (```` ```ebnf title ````) are not matched.
24. INFO. `b-c` lexes as one name. This matches XML NameChar, but a hint for `-` exclusion without spaces would help.
Fuzz result: 3000 random config × mutated examples and XML excerpt runs: idempotent, and non-whitespace text was preserved in every run. Bug 4 changes only whitespace, so the fuzz check misses it.

## Performance
P1 semantic-tokens.ts:183-190. selectSemanticTokens is O(n²) and rebuilds `selected.map` for every candidate. Use a per-line sorted interval sweep.
P2 ranges.ts:28. rangeFromOffsets scans from offset 0 on every reference and rule, so the parse is O(n·refs). Precompute line starts and binary-search.
P3 symbol-table.ts:34,37. Array spread on every insert is O(n²). Use push.
P4 semantic tokens re-tokenize the whole text on every request (semantic-tokens.ts:74) with a second lexer. The tokenizer runs ~13 regex passes per line, and commentTokens and maskCommentRanges loop over all comments per line (tokenizer.ts:239,261), O(lines·comments). Cache tokens per version.
P5 extension.ts:26. Activation awaits a full findFiles plus read and parse of `**/*.{abnf,…}` with no exclude (node_modules). The index ignores unsaved edits (workspace.ts:57 handles disk changes only), so workspace symbols, completion and rename go stale.
P6 extension.ts:52. scheduleReparse runs for every document change in any language, and nothing listens for config changes to refresh diagnostics. The parse cache is version-keyed (good). Diagnostics are recomputed in full each time.
P7 word-at-position.ts:90 does a linear scan of all refs per hover, definition or highlight call. symbol-locations.ts walks every indexed file for each lookup.

## Missing features
Diagnostics: left recursion (direct and indirect), unreachable from the start rule, unproductive or non-terminating rules, duplicate alternatives, empty or epsilon alternatives, unterminated comment or string, rule cycles, an unused hint that ignores self-use, ISO detection anywhere. Quick fixes: create the rule with the correct name shape, ISO→W3C conversion of the whole file, remove the duplicate, rename the case mismatch, a "did you mean" fix for typos.
Providers not registered in providers/index.ts: SelectionRange, CodeLens (ref counts), CallHierarchy, DocumentRangeFormatting, OnTypeFormatting, LinkedEditingRange, DocumentLink (standard URLs), Declaration, TypeHierarchy (n/a), Range semantic tokens / delta edits, SignatureHelp (n/a).
