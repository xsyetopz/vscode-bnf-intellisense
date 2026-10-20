# Final review 3.3. Verdict: NOT READY (1 MEDIUM, 5 LOW)

Checks: biome clean, typecheck clean, bun test 2327/2327 passed twice (~5.3 s). Probes are in /tmp/fr33/p1-p3.test.ts.

## Earlier findings
- Commands N1 and N5: FIXED. `,` and `;` are flagged, with one warning each. No false positives in: examples/, `;` comments in BNF/RBNF, `,` inside strings, `[,;]`, `/* , ; */`, `[ wfc: a, b; c ]`, RBNF names with spaces, `#x2C`. ISO documents (all-ISO and mixed) give only iso-ebnf diagnostics, with no extra UnexpectedText.
- N2: PARTLY FIXED (see L3). N3: FIXED (45 for an edge dash). N4: deferred.
- Railroad/refactors:
  - Fixed: 1 (comments kept), 2, 3 (name "a", base comment, source-order spans, startLine 0), 4 (now throws), 6, 7, 8 (toBeDefined gone), 10 (whole-line extract: `/`, trailing `/`, `/` in strings and prose, partial selections all correct).
  - 5: PARTLY FIXED (L4). 9: deferred.

## New findings
M1 MEDIUM: comments inside the body are moved into every reference instead of staying where the definition was. inline-rule.ts:92 (bodyText goes from the first to the last token) and :161-170 (inner comments are left out of `kept`). This contradicts design.md:94-96.
- Repro (ABNF): `a = b c b\nb = x ; why\n    / y\nc = z\n`, inline-all on `b`. The result is `a = (x ; why\n    / y) c (x ; why\n    / y)`, so the comment appears twice.
- Fix: strip comments from bodyText (rejoin the lines) and keep all of the definition's comments as standalone lines. Or change the spec. Add a test.

L1: Inline-all of the last rule adds a newline the file did not have. `a = b\nb = x ; why` (no trailing EOL) gives `a = x\n; why\n`. The cause is inline-rule.ts:179. Fix: omit the final eol when the file did not end with one.

L2: `a ::= x (* iso, comment; *)` (EBNF) gives two UnexpectedText for the `,` and `;` inside the ISO comment. `(* plain *)` gives nothing, and the user gets no IsoEbnf diagnostic or fix. The new warnings point at the wrong thing (parser.ts:227-252). Fix: give IsoEbnf for `(*...*)` inside W3C bodies, or skip the punctuation inside it.

L3: string-escape-highlighting.test.ts:
- The simulator (:36-77) picks the opener only among the string rules. It ignores the top-level `#comment` and `#rule-definition` precedence and never checks that strings can be reached from `#expression`. It is faithful for the current cases: `end` wins a tie, as in vscode-textmate. But a quote after `;` or inside `<..>` would be modelled wrongly.
- :109-114 still checks the shape of the JSON (`string-escape` absent). Instead, assert on behaviour, e.g. that `scanString("ebnf", 'a ::= "a\\" b')` ends at `\"`.

L4: railroad-diagrams.test.ts:3 and :520-528 still read files with `fs.readFileSync` instead of `repoText`. `existsSync ? … : []` makes the test vacuous when examples/ is missing. Fix: use repoText and fail when the list is empty.

L5: diagnostics-rules.test.ts:38-41 measured a growth of 1.88 (24 ms → 46 ms). A large fixed cost hides growth, so a quadratic part of up to ~4 ms would still pass. Fix: subtract a size-0 baseline, or raise the size.

Scaling flakiness: none. Baselines reached the 2 ms floor after ≤3 of 6 doublings, so a machine would need to be about 8x faster to hit the throw. The scanner bnf/ebnf alternation is honest: each call misses the cache.
