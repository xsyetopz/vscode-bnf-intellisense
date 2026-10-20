## 1. Tooling

- [x] 1.1 Bun-native scripts (`bun check`), fix TS6059 tsconfig error, latest Biome, lefthook replaces `.githooks`, commitlint + markdownlint-cli2 in hooks/scripts/CI, markdown lint clean

## 2. Correctness audit

- [x] 2.1 Audit ABNF (RFC 5234/7405) and BNF/EBNF/RBNF tokenizer, parser, diagnostics, formatter, TextMate grammars; produce bug list
- [x] 2.2 Fix ABNF bugs with regression tests
- [x] 2.3 Fix BNF/EBNF/RBNF bugs with regression tests

## 3. Feature expansion

- [x] 3.1 New diagnostics and quick fixes
- [x] 3.2 New providers (selection range, code lens, call hierarchy, range/on-type formatting, linked editing, document links, declaration)
- [x] 3.3 Commands/refactors (extract/inline rule, sort rules, dialect conversion, railroad preview)

## 4. Performance

- [x] 4.1 Per-version parse cache, cheaper diagnostics/semantic tokens/workspace index, benchmarks

## 5. Docs, logo, release

- [x] 5.1 Logo redesign (SVG + PNG)
- [x] 5.2 Rewrite AGENTS.md, refresh README, CHANGELOG 0.3.0, version bump
- [x] 5.3 Final review and full verification
