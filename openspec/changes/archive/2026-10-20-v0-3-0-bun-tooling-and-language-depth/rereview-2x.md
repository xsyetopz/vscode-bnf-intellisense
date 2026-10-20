# Re-review: review-2x fixes

Verdict: CLEAN, apart from two LOW items. Every original finding is fixed and passes its original repro.

## Re-run results
- H1 fixed: `/* c */ a ::= b | c` stays verbatim and is idempotent.
- M1 fixed: the RFC 5234 App. B core rules keep their indented comments inside the rule, stay aligned, and keep their blank lines.
- M2 fixed: `<o\n ect>` and `[#x\n 7F-#x1FFF]` are kept verbatim.
- M3 fixed: text before the first rule now gets "Unexpected ..." (ebnf `hello world`, bnf `garbage`, bnf `<a> = 'x'`).
- M4 fixed: ebnf now uses ebnf-language-configuration.json (blockComment only); bnf and rbnf have `;` only.
- L1 fixed: the `1*1` hint is added, and `3* "x"` and `3 *"x"` are now errors.
- L2 fixed: `%x41.`, `%x41..42` and `%x41-42.43` each give one clear error.
- L3 fixed: `c` on a skipped line is credited to rule `a`, so there is no false unused hint.
- L4 fixed: a production with column-0 garbage is kept verbatim.
- L5 fixed: the bare-word warning fires on `<a> ::= b`. It flags nothing in examples/json.rbnf (LF or CRLF).
- L7 fixed. In TextMate, strings and character classes are tried before `#exclusion`, so a `-` inside `'-'` or `[a-z-]` never reaches it. Matches in json.ebnf and xml.ebnf are all real exclusions (`Char - '-'`, `Name - (...)`, `[^<&]* - (...)`). `b-c` and `#x20-#x7F` do not match. `A- B` is still unscoped (acceptable).

## Regressions
- RFC 3986 (LF and CRLF), RFC 5234 core rules, rfc.abnf and examples/*: no errors or warnings, idempotent, line endings kept.
- Fuzz (4 seeds × 800 cases, plus the old fz3): no token loss. The two remaining differences are acceptable:
  - (1) a lone CR inside a block comment in an LF file is normalized to LF, which is the "keep the first EOL" design;
  - (2) trailing spaces are trimmed after a `;` comment.

## Findings
- LOW: client/src/abnf/body-parser.ts:510. `%x41-42-43` says "a range cannot be combined with '.' concatenation", but there is no dot in the input. Fix: when the tail has a second "-", say "a range has only one '-'".
- LOW (open item b): `a = b\n\n    ; c\nb = "x"` formats to `a = b\n; c\nb = "x"`. The indented comment moves to column 0 and becomes b's doc comment, and the blank line is dropped. Fix: keep the standalone comment's indentation, or keep one blank line before it. Not blocking.

## Open items from the implementers
- (a) Acceptable. Reference ranges point at the token itself; only the owning rule is "a". That matches RFC intent, since the line really is part of a's region.
- (b) Acceptable. Per RFC 5234, a blank line ends the rule. Only the cosmetic issue above remains.
- (c) Acceptable / not reproduced. `veryverylongname ::= ( a` (verbatim) did not widen `b ::=`. The output is idempotent.

## Not reviewed
- Extension-host TextMate check.
- New test bodies (only the behaviour was verified).
