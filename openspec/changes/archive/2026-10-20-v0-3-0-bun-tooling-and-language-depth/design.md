# Design: v0.3.0

## Inputs

- `audit-abnf.md`: ABNF bugs A1–A17, perf AP1–AP5, ABNF feature ideas.
- `audit-grammar.md`: BNF/EBNF/RBNF bugs, perf, missing providers.
- Repro scripts: `/tmp/abnfaudit/*.ts`, `/tmp/bnfaudit/*.ts` (`bun <file>`).
  These are temporary. Every fixed bug gets a regression test in
  `client/src/__tests__/`.

## Scope rule (user, verbatim)

> all these bugs will be fixed, even the smallest of!

Every audit item gets fixed: HIGH, MED and LOW, plus A16 (found by reading,
not run), G24 (INFO, add the hint) and every perf item. Grammar bugs are
G1–G24, as numbered in `audit-grammar.md`.

## Decisions

- **One scanner per dialect (BNF/EBNF/RBNF).** The parser, tokenizer and
  formatter each have their own regex lexer, and they disagree. Replace them
  with one single-pass scanner that every consumer uses. At each position it
  checks comment, then char class, then string, then the rest. Bugs G1–G6
  come from this split.
- **Name case.** ABNF names are case-insensitive (RFC 5234). W3C EBNF, BNF and
  RBNF names are case-sensitive. The rule lives in `dialects.ts`, and the
  symbol table and rename use it. Note this in CHANGELOG as a behaviour change.
- **W3C strings have no escapes.** `\` is a literal character. `;` is not a
  comment in EBNF; only `/* */` is.
- **The formatter must not change the token stream.** It never drops tokens,
  keeps empty alternatives, and keeps the input's EOL style (CRLF/LF/CR). A
  rule with parse errors is emitted verbatim. It returns no edits when the
  output equals the input. `continuationIndent` is clamped to at least 1
  (`"minimum": 1` in package.json).
- **Duplicate definitions are an Error.** `=/` without an earlier `=` is a
  Warning. The check uses `rule.isIncremental`, not a re-tokenize.
- **RBNF follows RFC 5511.** Optional is `[ ]` and repetition is `...`;
  snippets and TextMate grammars are updated to match.
- **ABNF uses `abnf-language-configuration.json`** (A17).

## File ownership for parallel work (2.2 and 2.3)

- **2.2 (ABNF):** `client/src/abnf/**`,
  `client/src/grammar/syntax-details.ts`, `abnf-language-configuration.json`,
  the abnf entries in `package.json` (language config, `continuationIndent`
  minimum), `syntaxes/abnf*`, `snippets/abnf*`, and tests named
  `abnf-*.test.ts`. Bugs A1–A5, A7–A14 and A17.
- **2.3 (BNF/EBNF/RBNF and shared):** the rest of `client/src/grammar/**`,
  including providers, `diagnostics.ts`, `semantic-tokens.ts`,
  `word-at-position.ts`, `symbol-table.ts` and `ranges.ts`. Also non-abnf
  `syntaxes/` and `snippets/`, and tests under `__tests__/grammar/`. All
  grammar-audit bugs, plus the shared-file ABNF bugs A6, A15 and A16.
- If one task needs a change in the other's files, it reports the change
  instead of making it.

## Deferred

- Perf items (AP1–AP5 and grammar perf) are done in 4.1, after the 2.x fixes
  land.
- New diagnostics and quick-fixes from the audits are done in 3.1:
  - recursion and cycles
  - unreachable from the start rule
  - rules that can never terminate
  - duplicate alternatives
  - "did you mean"
  - ISO→W3C conversion
  - ABNF `=`→`=/`, indent, missing closer, swap range bounds, char-val ↔
    num-val
- New providers are done in 3.2: selection range, code lens, call hierarchy,
  range and on-type formatting, linked editing, document links, declaration,
  and range semantic tokens.

## 3.3 Commands and refactors

No commands existed before 3.3. Command IDs use the `bnf.` prefix and are
shown in the command palette only for the four grammar languages
(`menus.commandPalette` `when: editorLangId =~ /^(abnf|bnf|ebnf|rbnf)$/`).

- **Extract rule** (`refactor.extract` code action). The selection must cover
  whole tokens and form a complete expression: one or more whole alternatives,
  or a contiguous run of sequence items, inside one rule's right-hand side.
  It adds a new rule right after the current rule (or after its last `=/`
  part), with a unique name in the dialect's style (`new-rule`,
  `<new-rule>`, `new-rule-2`, ...), and replaces the selection with a
  reference. Then it runs `editor.action.rename` on the new reference.
  Extracting from a rule with parse errors is not offered.
- **Inline rule** (`refactor.inline` code action). On a reference, it inlines
  that one reference. On a definition name, it inlines every reference in the
  document and removes the definition. It is not offered for recursive rules,
  rules with `=/` parts or several definitions, core rules, rules with
  W3C `[ wfc: ]` / `[ vc: ]` annotations, or rules with parse errors.
  Inlining every reference removes the definition but never deletes
  comments: comments above it stay where they are, and comments inside the
  definition stay as standalone comment lines where the definition was. A
  blank line keeps such leftover comments apart from the next rule.
  Inlined text never carries comments: they stay with the definition, or as
  those standalone lines when the definition is removed. The file's final
  newline is kept as it was. Add grouping where precedence needs it. BNF has no grouping, so
  a multi-alternative body is only inlined when the reference is a whole
  alternative. References in other files are left alone; the action title
  says so when they exist.
- **Sort rules** (`bnf.sortRules`, `bnf.sortRulesByDependency`). Alphabetical
  (by the dialect's name case rule), or dependency order (BFS from the start
  rule, then the rest in source order). Comments directly above a rule move
  with it. `=/` parts stay right after their base rule. Works on the whole
  document, or on the selected rules if a selection exists; several selections
  are each sorted on their own (selections that touch the same rule count as
  one). Alphabetical order ignores case first and breaks ties by case. Not run
  when the document has parse errors or a rule defined twice (show a message). One undoable edit.
- **Dialect conversion** (`bnf.convertDialect`, quick pick for the target).
  Converts through the shared expression AST. Output opens in a new untitled
  document of the target language; the source is never modified. Constructs
  the target cannot express are desugared where it is exact (BNF optional or
  repetition become helper rules; ABNF ranges become EBNF char classes and
  back; case-insensitive ABNF strings become alternations or `%i` as
  needed). Where no exact form exists, the output keeps the source text in a
  comment and the conversion reports a warning count. The rule body then
  refers to an undefined placeholder rule, never a string literal, so the
  converted grammar does not silently match different text. The placeholder
  is named `unsupported` (`<unsupported>` in BNF/RBNF), numbered when the
  name is taken. ABNF keeps `<prose>` for text it cannot express. Name style is adapted
  to the target (`<x>` for BNF/RBNF). Strings in BNF/RBNF accept the escapes
  `\\ \" \' \n \r \t \xHH` (any other `\c` means `c`); W3C EBNF strings have
  none. The converter writes `'"'` for a value with `"` and no `'`, and
  highlighting treats the same escapes as `constant.character.escape`. ABNF to a case-sensitive dialect keeps
  names as written; name clashes that only differ by case are reported.
- **Railroad preview** (`bnf.showRailroadDiagram`). A webview beside the
  editor. SVG is built by our own code, with no external libraries, network,
  or CDN, and a strict CSP (nonce scripts, `default-src 'none'`). It shows every
  rule, scrolls to the rule at the cursor, updates on edits (debounced) and
  follows the active grammar editor. Clicking a nonterminal reveals its
  definition. Colours come from VS Code theme CSS variables.

## 4.1 Performance

Reports: perf-audit-4-1.md, perf-baseline-4-1.md, review-4-1.md,
rereview-4-1.md, verify-4-1.md, verify2-4-1.md through verify6-4-1.md.

- **Semantic tokens.** Overlap selection uses per-line sorted intervals
  (O(n log n)). Past `bnf.semanticHighlighting.maxTokens` in `auto` mode
  only rule-name and reference tokens are kept, never zero. TextMate
  colours the rest. The per-uri memo is keyed by version, language, mode
  and `maxTokens`, and is dropped on close.
- **Caches.** `CachedParse` holds tokens per document version.
  `recent-cache.ts` replaces single-entry module caches: 6 entries per
  dialect and a 2,000,000-char budget. Cached arrays are `readonly`. ABNF
  is tokenized once per text.
- **Workspace index.** Activation does not await the scan. It excludes
  `**/node_modules/**`, `**/.git/**`, root `out/**` and `dist/**`, plus
  `files.exclude` (braces expanded per pattern, read per folder). Open
  documents are indexed with their buffer text. On close, the index goes
  back to the disk text if a folder holds the file, and drops it
  otherwise. Untitled documents are indexed while open. Excluded open
  documents get diagnostics but are not indexed. Every read carries a
  global generation stamp and a folder epoch, so stale reads are dropped.
  Folder add/remove and `files.exclude` changes rescan.
- **Events.** A re-parse is queued only for grammar languages with content
  changes.
- **Benchmarks.** `bun run bench` (`client/src/bench/bench.ts`).
  Env: `BENCH_SIZES`, `BENCH_DIALECTS`, `BENCH_RUNS`, `BENCH_LENS_FILES`.
  Every stage grows about 4x for 4x rules.
- Review reports are excluded from markdownlint
  (`.markdownlint-cli2.jsonc`). `md:fix` rewrote list numbers and
  code-span contents in them.
