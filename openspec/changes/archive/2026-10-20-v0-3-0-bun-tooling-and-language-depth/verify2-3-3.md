# Verify 3.3 (round 2): NOT READY (0 HIGH, 1 MEDIUM, 3 LOW)
Checks: biome clean, typecheck clean, bun test 2368/2368 pass. Probes: /tmp/v332/{b,c}.test.ts.

## N1-N4
- N1 FIXED: parser.ts:43-53. Hover on `(* head\n   more *)\nb ::= y` gives "head\nmore".
- N2 FIXED: `a ::= (*) b\nc ::= (d*)` gives rules a and c, no diagnostics. `a ::= x (* open\nb ::= y` keeps b.
- N3 FIXED: `(* (* n *) *)` and `(*(*(* *) *) *)` each scan as one comment with one iso-ebnf warning and no unbalanced-delimiter.
- N4 FIXED: code-actions.ts:480-487. `*/` and nested comments get a disabled action with the right reason. Inside an ISO production the reason appears on the "Cannot convert expr" action.

## Regressions
The formatter is token-identical and idempotent on 31 cases. The cases cover strings, `[(*]`, `/* (* */`, `( *x )`, `(x)*`, `(*)`, nested, unclosed, multi-line, CRLF, `x(*c*)y`, `(*) y *)`, back-to-back comments, and head-like lines inside a comment. ISO documents still get their diagnostics, "Convert every" works, and the result has no diagnostics. examples/ is clean.

## New findings
M1 MEDIUM: scanner.ts:257-276 `#isoCommentEnd` is O(n²) when there are many unclosed `(*` and no later head. Only `#headAfter` is cached. Each opener scans to the limit again.
Repro (lex+parse): `a ::= y\n` + `"  x (* c\n".repeat(n)` takes 16 / 227 / 3257 ms for n = 1k/4k/16k. `"(* (* (*\n".repeat(n)` takes 42 / 647 / 10334 ms. An ISO document (no `::=` heads) with many unclosed `(*` is affected the same way. This is the same class of bug the `[` cache at scanner.ts:280 fixes.
Fix: run one stack pass per head segment, pushing on `(*` and popping on `*)`, and record match[open]=close. That gives the same result as depth counting. Add a scaling test like scanner.test.ts:401.

L1 LOW: no formatter or scanner tests cover `(*`. No format*.test.ts or scanner.test.ts mentions it. Add AAA tests that format each of the 31 inputs above and assert (a) the token texts before and after are equal and (b) format(format(x)) === format(x). Also add scanner tests: `(*)` → group,repeat,group; `x(*c*)y` → name,comment,name; `[(*]` → charClass; `"(*"` → string; CRLF multi-line → one comment.

L2 LOW: a head-like line inside a comment splits the comment. That is intended, but the diagnostics give no hint. `a ::= x (* eg:\nfoo ::= bar *)` gives unexpected-text plus two unbalanced-delimiter and no iso-ebnf. Fix: when `(*` fails because a head comes first, add a message such as "ISO comment ends at the next production". At minimum, add a test that pins this behaviour.

L3 LOW (may predate this change): the "Use ::=" fix for one production also rewrites a comment owned by another. For `a ::= x (* has */ *) (* ok *)\nb = 'y';`, the fix for b also changes a's trailing `(* ok *)` to `/* ok */`. For `(* header *)\nexpr = ...;`, the fix for expr also converts the header. Fix: start the ISO run at the first non-comment stray token.
