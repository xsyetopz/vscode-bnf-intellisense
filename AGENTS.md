# AGENTS.md

Use this file when an agent edits this repository. A nested `AGENTS.md` controls
files under its own directory. `CLAUDE.md` and `GEMINI.md` are symlinks to this
file. Edit this file only.

## Start Here

- [README.md](README.md): supported grammars, settings, commands, and usage.
- [CONTRIBUTING.md](CONTRIBUTING.md): contribution workflow and PR checklist.
- [CHANGELOG.md](CHANGELOG.md): user-facing release notes.
- `openspec/`: change specs and task lists.

## Commands

Bun 1.4.3 (`packageManager` in `package.json`). Scripts from `package.json`:

```bash
bun install           # runs `prepare`, which installs the lefthook hooks
bun test              # Bun tests; bunfig.toml preloads the VS Code mock
bun run typecheck     # runs `bun check`
bun run build         # bundles client/src/main.ts to dist/extension.cjs
bun run package       # build, then vsce package
bun run bench         # client/src/bench/bench.ts; BENCH_* env vars set the run
```

```bash
bun run biome:check   # Biome format and lint, no writes
bun run biome:format  # Biome format, writes files
bun run biome:lint    # Biome lint, writes files
bun run md:check      # markdownlint-cli2, no writes
bun run md:fix        # markdownlint-cli2 --fix, writes files
bun run verify        # biome:check, md:check, and typecheck in parallel
```

`bun run verify` runs no tests and no build. Before finishing code changes, run
`bun run biome:check`, `bun run typecheck`, `bun test`, and `bun run build`.

Do not run `md:fix` on openspec reports. It rewrote list numbers and code-span
contents in them. Audit and review reports are excluded from markdownlint in
`.markdownlint-cli2.jsonc`.

Hooks come from `lefthook.yml`. The old `.githooks` directory is gone.

- pre-commit: Biome on staged JS, TS, and JSON files; markdownlint on staged
  `.md` files.
- commit-msg: commitlint (conventional commits).
- pre-push: `bun check`, `bun test`, and `bun run build`.

CI (`.github/workflows/ci.yml`) runs commitlint on pull requests, then
`biome:check`, `md:check`, `typecheck`, `test`, and `build`.

Release (`.github/workflows/release.yml`) runs on `v*` tags and manual dispatch.
It checks the tag against the checked-out commit, runs lint, typecheck, and
tests, packages the VSIX, and creates the GitHub release.

## Module Map

`client/src/`:

- `main.ts` is the bundle entry. `extension.ts` activates the extension, starts
  the workspace index in the background, and registers providers, commands, and
  the railroad preview.
- `recent-cache.ts` is the most-recently-used cache for text-derived results.
  Each cache keeps 6 entries, keyed by dialect and text, and a 2,000,000-character
  budget.
- `append-all.ts` appends large arrays without `push(...items)` argument limits.
- `bench/bench.ts` is the benchmark behind `bun run bench`.

`client/src/abnf/` holds ABNF-only logic (RFC 5234 and RFC 7405):

- `tokenizer.ts`, `parser.ts`, `body-parser.ts`, and `regions.ts` scan and
  parse rules.
- `core-rules.ts` defines the RFC 5234 core rules.
- `case-hints.ts` holds the opt-in case-sensitivity hint.
- `format.ts` and `format-renderer.ts` format documents.
- `code-actions.ts` and `diagnostic-codes.ts` hold ABNF quick fixes and codes.
- `types.ts` defines the ABNF model types.

`client/src/grammar/` holds the shared BNF, EBNF, and RBNF logic, plus behaviour
common to all four families:

- `dialects.ts` and `standards.ts` define dialect metadata, including the name
  case rule.
- `scanner.ts` is the single-pass lexer for BNF, EBNF, and RBNF.
- `tokenizer.ts`, `parser.ts`, `expression.ts`, `grammar.ts`, and
  `rule-layout.ts` turn text into rules and a shared expression model.
- `symbol-table.ts`, `workspace.ts`, `workspace-exclude.ts`, and
  `suggestion-store.ts` index definitions and references across files.
  `suggestions.ts` matches names for did-you-mean.
- `analysis.ts` runs the graph checks (left recursion, reachability,
  productivity). `diagnostics.ts` reports them. `diagnostic-codes.ts` holds the
  stable codes that quick fixes match on.
- `code-actions.ts`, `alternative-removal.ts`, and `iso-conversion.ts` hold
  quick fixes and the ISO-to-W3C conversion.
- `format.ts`, `formatting-provider.ts`, `line-index.ts`, and `ranges.ts` hold
  the formatter and the offset-to-position mapping.
- `semantic-tokens.ts`, `syntax-details.ts`, and `completion.ts` serve
  highlighting, hover details, and completion.
- `config.ts` is the only reader of `bnf.*` settings (`readGrammarConfig`).
- `core-rules-document.ts` serves the synthetic ABNF core-rule document.
- `commands/` implements `bnf.sortRules`, `bnf.sortRulesByDependency`, and
  `bnf.convertDialect`.
- `refactors/` implements the extract rule and inline rule code actions.
- `railroad/` implements `bnf.showRailroadDiagram`. SVG is built in-house. The
  webview uses no external libraries, network, or CDN.
- `providers/` has one file per VS Code provider. `providers/index.ts` registers
  them all.

Other folders:

- `client/src/__tests__/` holds Bun tests. `vscode-mock.ts` is the VS Code mock
  that `bunfig.toml` preloads, and `vscode-mock/` holds its parts.
- `client/src/__tests__/grammar/` holds the grammar-family tests. Shared helpers
  there are `provider-test-utils.ts`, `code-action-test-utils.ts`,
  `refactor-test-utils.ts`, and `railroad-test-utils.ts`.
- `syntaxes/` holds TextMate grammars (JSON) and Markdown code-fence injections.
- `snippets/` holds snippets for each grammar.
- `examples/` holds equivalent JSON grammars in all four dialects.
- `assets/` holds the logo (`logo.svg`, `logo.png`).

## Invariants

- Use the `bnf.*` settings namespace for every grammar family. Read settings
  with `readGrammarConfig`. Do not add `abnf.*` aliases or deprecated
  compatibility layers.
- Name case: ABNF names are case-insensitive (RFC 5234). W3C EBNF, BNF, and RBNF
  names are case-sensitive. The rule lives in `dialects.ts`. The symbol table
  and rename use it.
- ABNF core rules resolve as built-ins, not workspace definitions. Keep ABNF
  core-rule behaviour in the ABNF core-rule modules.
- Preserve W3C XML EBNF semantics. ISO/IEC 14977 EBNF is not supported.
  `;` is not a comment in EBNF, and EBNF strings have no escapes.
- BNF and RBNF have only `;` comments. `/* */` is EBNF-only.
- BNF and RBNF strings accept `\\ \" \' \n \r \t \xHH`. Any other `\c` means `c`.
- RBNF angle-bracket names may contain spaces and still form one symbol.
- W3C character classes and exclusions are not rule references.
- The BNF-family parser, tokenizer, formatter, and completion read tokens from
  `scanner.ts`. Do not add a second lexer.
- The formatter must not change the token stream. It keeps empty alternatives,
  keeps the input's line endings (CRLF, LF, or CR), and emits a rule with
  parse errors verbatim. It returns no edits when the output equals the input.
- Parse once per document version. `CachedParse` in `workspace.ts` holds tokens
  per version.
- Workspace indexing runs in the background. Activation does not await the
  scan. The index skips `**/node_modules/**`, `**/.git/**`, root `out/**` and
  `dist/**`, and anything `files.exclude` hides. Open and untitled documents are
  indexed from their buffer text.
- TextMate grammar files stay JSON so VS Code can read them directly.
- Keep TypeScript ESM imports explicit, including `.ts` extensions.
- Keep files focused and below the 800-line limit.
- This is a local VS Code extension. Do not add telemetry, network calls,
  credential handling, or external services without maintainer agreement and
  user documentation. Never commit secrets or real user grammar files.

## Tests

- Tests check behaviour. Arrange the input, act, then assert the result
  (Arrange-Act-Assert).
- Parser and tokenizer changes need fixture-like examples in tests.
- Provider changes use the focused provider tests and the shared test utilities.
- Formatting changes cover output text and grammar-safe preservation.
- Settings changes update `package.json`, the README settings table, and tests.
- Do not write implementation prose in code comments. Put behaviour in tests and
  user-facing docs.

## Verification

- Code changes: run the four commands in Commands above.
- Markdown changes: run `bun run md:check`.
- TextMate grammar changes: open representative `.abnf`, `.bnf`, `.ebnf`, and
  `.rbnf` files in a VS Code extension host when practical.
