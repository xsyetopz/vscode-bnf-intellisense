# Verify 3.3 (round 4): NOT READY (0 HIGH, 0 MEDIUM, 3 LOW + 1 test gap). N1-N3 and the scaling note are FIXED.
Checks: biome clean, typecheck clean, bun test 2482/2482 pass. Probes: /tmp/v433/{a,b,c,d}.test.ts

## Earlier findings
- N1 FIXED. `(* top` and `a ::= x\n(* c` each give only iso-comment-unclosed. Pinned by AAA tests (empty-operands.test.ts:151-168).
- N2 FIXED (one gap, see L1). The checks are in parser.ts:257-385 and abnf/body-parser.ts:425-476, and parse-gate.ts:21-27 lists the codes.
  - No false positives on: examples/json.{abnf,bnf,ebnf,rbnf}; W3C XML productions (Char, CharData `[^<&]* - (...)`, Eq, S, Comment, AttValue); RFC 5234's ABNF-of-ABNF, including `(*c-wsp c-nl)`, `*(...)` and `[ 1*(...) ]`; the RFC 5511 Path Message sample with `[ [ A | B ] ... ]`; BNF `{ }`/`[ ]` that have content; empty alternatives (`x |`, `| x`, `( x | )`, `( | x )`); `"[]"`/`'()'` inside strings.
  - Correctly flagged: `()`, `( /* c */ )`, BNF/RBNF `[ ]` and `{ }`, EBNF `[^]`, `(*)`, `x - *`, a continuation line `  | *`, RBNF `...` at the start, after `|` and inside `( ... )`.
- N3 FIXED. isAdjacent (code-actions.ts:413-424) allows at most one line break. Tests are at code-actions-iso-conversion.test.ts:115-129.
- Scaling note FIXED. scanner.test.ts:447-464 now uses a growth-ratio assertion.

## New findings
- L1 LOW (N2 scope, false negative): in RBNF, a dangling prefix count with nothing after it is not flagged. Repro: `<a> ::= <b> | *3`, `<b> ::= *3`, `<a> ::= <b> ( 2* )`, `<a> ::= * 3` → no diagnostics. Cause: parser.ts:292-299 treats `*` as valid when `countFollows` is true, even if no operand follows the count. `2*` followed by `)` or the end of the rule is not checked either. Fix: after the count (and after the `*` in `m*`), require startsOperand(next). Add AAA tests.
- L2 LOW (pre-existing, misleading): a mismatched closer uses up the opener, so `a ::= x ( ]` only says `"]" has no matching opener` and the open `(` is never reported. The same happens in BNF. Cause: parser.ts:166-177 pops before it compares. Fix: when the closer does not match, leave the opener on the stack (or report "expected ')'").
- L3 LOW (test gap): the stacked postfix `x?+` is meant to be valid, but no test pins it. Add it to the valid list at empty-operands.test.ts:137.
- Info: the message for `( /* c */ )` says `"()"` while the range covers the comment. This is acceptable.

## `[]]` / `[^]]`
Not a bug. XML 1.0 §6 (Notation) defines only `[a-zA-Z]`, `[#xN-#xN]`, `[abc]`, `[#xN#xN#xN]` and their `[^…]` forms. It has no POSIX-style "literal `]` first" rule, and no production in the spec puts a literal `]` in a class. The spec writes it as `#x5D`. So `[]]` is an empty class followed by a stray `]`, which is what the scanner reports now. Optional improvement: add 'write "]" as #x5D' to the "Empty character class" message (parser.ts:335) when the next character is `]`.
