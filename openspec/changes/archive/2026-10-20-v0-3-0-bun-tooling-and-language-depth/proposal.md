## Why

Release 0.3.0 (minor). The toolchain still leans on Node-era pieces (`tsc`,
hand-rolled `.githooks` via `core.hooksPath`), `bun check` fails on
`commitlint.config.mjs` (TS6059, outside `rootDir`), and the four grammar
families (ABNF, BNF, W3C XML EBNF, RBNF) have unaudited linter/formatter bugs
and missing language features.

## What Changes

- Tooling: Bun 1.4.3 native commands (`bun check` replaces `tsc`), latest
  Biome, lefthook replaces `.githooks`, commitlint + markdownlint-cli2 wired
  into hooks, scripts and CI. Fix tsconfig `rootDir`/include error.
- Correctness: audit and fix tokenizer/parser/diagnostics/formatter/TextMate
  bugs for all four families against their standards.
- Features: add every useful VS Code language feature still missing
  (see design.md inventory).
- Performance: cache parses per document version, cut redundant work in
  diagnostics, semantic tokens and workspace indexing.
- Docs: rewrite AGENTS.md, refresh README parts, CHANGELOG 0.3.0.
- Logo: restrained redesign with meaningful colours.

## Impact

package.json, tsconfig.json, CI workflows, hooks config, `client/src/**`,
`syntaxes/**`, `snippets/**`, docs, `assets/logo.*`.
