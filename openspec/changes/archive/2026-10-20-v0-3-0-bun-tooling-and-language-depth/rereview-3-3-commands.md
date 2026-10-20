# Re-review: task 3.3 sort rules + dialect conversion

Verdict: NOT READY. One MEDIUM and four LOW. biome, typecheck and 2298 tests pass.

## Round-1 findings
1 FIXED: `[^a-z]`, `b - c` and `<prose>` now become `<unsupported>` / `<unsupported-N>`, not literals. Names are unique even when `unsupported` or `unsupported-2` already exist. ABNF output keeps `<b - c>` as prose.
2 PARTLY FIXED: `<x>{1}` and `<x> 1 @ ~` are now refused. The `,` case still gets through (see N1).
3 FIXED in code: `"\""` becomes `'"'`, `%x5C.22` becomes `'\\"'`, and the TM `string-escape` rule is in both grammars. The scanner and TM agree on `"\\"`, `"a\"b"`, `'\''`, `"\x4"` and a trailing `\` before EOL. The README still does not document the escape set (N4).
4 FIXED: `b - c` over single-character rules is exact (ABNF `%x61-70 / %x72-7A`).
5 FIXED: the negated class is now limited to W3C Char.
6 FIXED: `z,B,a,b,A` sorts to `A,a,B,b,z`.
7 FIXED: duplicates are refused for ABNF (`b`/`B` too), EBNF and RBNF.
8 FIXED: each selection is sorted on its own, and overlapping selections are merged.
9, 10, 11 FIXED.
12 FIXED: the oracle shares no code with the converter (it uses only the scanner and parseAbnf). The misleading comments are gone. The oracle bug is N3.

## New findings
N1 MEDIUM: commas are never reported (parser.ts:236-237).
- Repro: BNF `<a> ::= <b>, <c>`, RBNF `<a> ::= <x>, "b"`, EBNF `a ::= x , "b"`. parseGrammar gives `[]`, so the gate lets them through.
- Expected: UnexpectedText, and the conversion is refused. W3C EBNF and RFC 5511 have no `,`.
- Actual: the conversion succeeds with `a = b <,> c` or `a ::= x unsupported "b"`, plus 2 warnings for one token (`unsupported ","` and `no exact form for ,`).
- In EBNF, `;` is also exempt (line 237), so `a ::= x ; "b"` gives no diagnostic either.
- stray-punctuation.test.ts:47 locks this in as "valid ebnf text".
- Fix: remove both exemptions (`;` is already a comment token in BNF/RBNF) and change that test case to expect a diagnostic.

N2 LOW: string-escape-highlighting.test.ts:19-50 checks the shape of the JSON (`patterns` equals include, the regex alone, the rule is absent), not how text gets highlighted. Nothing tests that `"a\"b" <x>` stays one string followed by a reference. Fix: tokenize sample lines with vscode-textmate if it is available; otherwise test with begin/escape/end applied to sample strings.

N3 LOW: the oracle class parser (reference-language.ts:104-135) adds the string `"-"` to a `Set<number>` when `-` comes first or last. `[-a]` and `[a-]` match only `a`. Fix: push 45 when the dash is not between two items.

N4 LOW: README has no escape-set documentation, although round 1 #3 asked for it. Add a line to the BNF/RBNF rows or the notes.

N5 LOW: one unsupported construct gives two warnings when the reader also warns (`a: unsupported ","` and the placeholder warning). This goes away with N1, unless other raw tokens can reach the reader.

## Checked OK
- No false UnexpectedText for: all 4 examples; BNF `[ ] { } ( )`, `| + * ?`, escapes, `;` comments with punctuation, CRLF; RBNF names with spaces, `...`, `0*2`, `3<x>`, `2*`, `*3`, `2 * 3 <b>`, `2*3( )`, `2"x"`.
- A trailing `<b> 2` in RBNF is correctly flagged.
- Dependency sort keeps `=/` with its base.
