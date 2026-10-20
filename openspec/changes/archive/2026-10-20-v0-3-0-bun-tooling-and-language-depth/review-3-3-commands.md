# Review: task 3.3 sort rules + dialect conversion

Verdict: NOT READY. Lint, types and 869 tests pass, and all 12 json.* conversions parse with 0 diagnostics. But some conversions silently change the language, and some tests lock in wrong behaviour.

## HIGH
1. When there is no exact form, the converter writes a string literal into the rule body (write-grammar.ts:155-176, `#placeholder` → `this.#string(src, true)`). The spec says to keep the source text *in a comment*. A literal changes what the rule matches.
   - Example: EBNF `a ::= [^a-z]` → BNF gives `<a> ::= "[^a-z]"`, which matches the 6 characters `[^a-z]`.
   - Same for `b - c` → `"b - c"` and ABNF `<prose here>` → `"<prose here>"`.
   - Tests lock this in: convert-dialect-details.test.ts:255, 274-278, 289-295.
   - Fix: keep only the note comment, and put a placeholder in the body that can't be read as a literal. For example, a reference to an undefined `<…>` rule; that also shows up as a diagnostic.
2. BNF `x{1}` → ABNF gives `a = x *<1>` (convert-dialect.test.ts:353-360).
   - In this extension's BNF, `{…}` means zero or more (README:90). The bare `1` scans as `punct` (scanner.ts:288-291), not a reference, and parseGrammar reports **no** diagnostic (`<a> ::= <x> 1 @ ~` gives `[]`). So the gate lets it through, read-production.ts:363 reads it as raw, and the output is "zero or more of prose `1`".
   - The EBNF output `a ::= x "1"*` silently means something else.
   - The test comment "repeats the reference 1" is false, and the test name contradicts the actual behaviour.
   - Fix: the BNF/RBNF parser should report stray punct tokens as UnexpectedText, so the gate refuses. Then rewrite the test.

## MEDIUM
3. Strings with escapes are read differently by different parts of the extension.
   - scanner.ts:118-124 treats `\` as an escape in BNF/RBNF.
   - read-production.ts:43-75 makes up `\n \r \t \xHH`. Nothing else in the extension decodes these, and no doc defines them.
   - syntaxes/bnf.tmLanguage.json:43-55 and rbnf.tmLanguage.json:35-45 have no escape rule. So the writer's `"\""` (write-grammar.ts:509-528) is highlighted as `"\"` followed by an open string that runs to end of line.
   - Repro: ABNF `a = %x22` → BNF `<a> ::= "\""`.
   - Fix: write `'"'` when the value contains `"`. Add an `constant.character.escape` rule to both TextMate grammars, and document the escape set (README/design).
4. EBNF `a ::= b - c` with `b ::= [a-z]` and `c ::= [q]` is exactly expressible as a character set, but the output is `"b - c"`. charSetOf doesn't follow references (write-grammar.ts:333-350). The test at details.test.ts:259-264 only checks `warnings.length === 1`, which hides this. Fix: resolve references to single-character rules, and assert on the output text.

## LOW
5. Negated EBNF class → ABNF gives `%x00-60 / %x7B-10FFFF`. That includes control characters and surrogates that W3C `Char` excludes. Intersect with Char.
6. Alphabetical sort compares code units (sort-rules.ts:37-42). EBNF `z, B, a` sorts to `B, a, z`. Compare case-insensitively, then break ties by case.
7. Sort is not refused when a rule is defined twice (`b="x"\nb="y"\na=b` gets sorted), although the design calls duplicates an Error. parse-gate.ts only sees parse diagnostics.
8. Multiple selections are merged into one min..max span (index.ts:~95). Rules between the selections get sorted too.
9. `host.replace` returns false on failure, and that is ignored (index.ts runSort). No message is shown.
10. index.ts `registerGrammarCommands(_grammarWorkspace)` has an unused parameter.
11. client/src/grammar/commands/rite-grammar.ts is an empty stray file with 0 lines.
12. Test quality against the user's rule:
    - convert-dialect-semantics.test.ts:30-60 uses readAbnf/readProduction, the code under test, as its own oracle. That is circular.
    - Comments describe the implementation, not behaviour: "Weak: only the count is checked…" (details:259) and the false `{1}` comment (convert-dialect.test.ts:353).

## Checked OK
- `%i`/`%s`, `%x41.42`, ranges, `n*m`, `0b`, RBNF `...`/`0*2`.
- Helper rules in BNF; core rules appended; `=/` merged, with comments.
- Renaming and case-clash warnings; dropped body comments are counted.
- Sort: comment attachment, `=/` grouping, CRLF, idempotence, no edit when already sorted, dependency BFS, refusal on errors, file without a final newline.
