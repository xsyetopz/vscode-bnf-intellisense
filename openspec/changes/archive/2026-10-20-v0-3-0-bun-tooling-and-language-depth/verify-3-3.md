# Verify 3.3: NOT READY (0 HIGH, 0 MEDIUM, 4 new LOW)

Checks: biome clean, typecheck clean, bun test 2360/2360 passed. Probes are in /tmp/v33/{a,b,c}.test.ts.

## Earlier findings
- M1 FIXED: `a = b c b\nb = x ; why\n    / y\nc = z\n` with inline-all gives `a = (x / y) c (x / y)\n; why\n\nc = z\n`. CRLF and `"a" ; c1\n "b" ; c2` both work.
- L1 FIXED: `a = b\nb = x ; why` (no EOL) gives `a = x\n; why`, and with an EOL the output also ends in one.
- L2 FIXED: `(* iso, comment; *)` gives one bnf.iso-ebnf and offers the "/* ... */" fix.
- L3 FIXED: the tests now check behaviour (quote after `;`, in block comments, in char classes).
- L4 FIXED: tests use repoText and require ruleCount > 0.
- L5 FIXED: scaling.ts:40 subtracts a size-0 baseline.
- Inline body building is correct. `x/* c */y` gives `x y`. `"x  y" 'p q'` stays intact. ABNF continuation `x\n    / y` stays valid. No token merging.

## Formatter and scanner consumers
- The formatter keeps the token stream identical and is idempotent on 19 `(*` cases: in strings, in `[(*]`, in `/* (* */`, `( *x )`, `(x)*`, `(*)`, multi-line, CRLF, ISO+comment, and `x(*c*)y`.
- Layout, selection range, document links (RFC inside multi-line `(* *)`), symbols, railroad nodes and the mixed-file "Convert every" (leaves `"(*"` strings alone) all behave sensibly.
- Not a regression: sort, convert, and inline refuse a document or rule with `(* *)` because IsoEbnf blocks them. Before this change it was already an error.

## New findings (all LOW)
N1 parser.ts:43-54 `commentText` treats `(* … *)` as a line comment (`raw.slice(1)`).
- Repro: `(* head\n   more *)\nb ::= y` gives b a precedingComment of `"* head\n   more *)"`. That text then appears in hover (hover.ts:85), completion (completion.ts:176) and railroad.
- Fix: when `token.iso`, strip `(*`/`*)` the same way as `/* */`.

N2 scanner.ts:220 `indexOf("*)")` has no limit, so a stray `(*` swallows later productions up to any postfix `x*)`.
- Repro: `a ::= (*) b\nc ::= (d*)\n` scans one comment `(*) b\nc ::= (d*)`. Rule c disappears, and the diagnostics are empty-rule plus iso-ebnf 0:6-1:10. This happens while typing too.
- Fix: refuse a close that comes after a later production head (`name ::=` at the start of a line), or after a `*` that follows an operand.

N3 scanner.ts:218-224 ignores nesting. ISO 14977 comments nest, and iso-conversion.ts:66-80 counts depth.
- Repro: `a ::= x (* (* n *) *) y` gives the comment `(* (* n *)`, then a stray `*` `)` and bnf.unbalanced-delimiter at 0:20. The iso-ebnf range covers only the inner part, and there is no explanation.
- Fix: count depth in the scanner, the same way lexIso does.

N4 code-actions.ts:466 / iso-conversion.ts:604: `a ::= x (* has */ inside *)` gives an IsoEbnf warning with no fix and no disabled "cannot convert" reason. Skipping the conversion is correct, but the user is left without an explanation.
- Fix: add a disabled action whose reason is `comment contains "*/"` (the same for nested comments).

Tests for N1-N4 should be AAA behaviour tests (input text → diagnostics, hover text, or edit result).
