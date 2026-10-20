# Changelog

User-facing changes go in this file.

## [0.3.0] - 2026-10-20

### Added

- Expand Selection follows tokens, elements, alternatives, groups, rule
  bodies, and whole rules.
- Code lens with the reference count above each rule.
- Go to Declaration, Call Hierarchy, Linked Editing, and document links for
  `RFC 1234` references in comments.
- Range formatting, and on-type formatting when you press Enter. VS Code calls
  on-type formatting only when `editor.formatOnType` is on.
- Commands: Sort Rules Alphabetically, Sort Rules by Dependency, Convert to
  Another Dialect, and Show Railroad Diagram. The diagram opens beside the
  editor, follows the cursor, and updates after edits.
- Refactors: Extract Rule from whole alternatives or sequence items, and
  Inline Rule for one reference or for every reference plus the definition.
- Diagnostics for left recursion, unproductive rules, unreachable rules,
  duplicate alternatives, empty alternatives, empty groups, repetitions with no
  operand, stray punctuation, unclosed ISO `(*` comments, unbalanced `(`, `[`,
  and `{`, W3C exclusions written without spaces, and RBNF bare words where a
  `<name>` is needed.
- ABNF diagnostics for malformed numeric values and ranges, invalid repetition
  bounds, redundant repetitions, whitespace after a repetition prefix, missing
  separators between elements, unterminated strings and prose values, non-ASCII
  strings and prose values, `=/` without a base rule, and duplicate `=/`
  extensions.
- Did-you-mean suggestions for undefined references, including case and
  angle-bracket mismatches.
- Opt-in ABNF hint for quoted strings with uppercase letters, with a quick fix
  to case-sensitive `%s"..."`.
- EBNF `(* ... *)` comments get a quick fix that rewrites each one as
  `/* ... */`, unless the comment is nested or contains `*/`.
- Backslash escapes in BNF and RBNF strings.
- New settings for the new diagnostics and the code lens, such as
  `bnf.diagnostics.leftRecursion` and `bnf.codeLens.references`.
- All `bnf.*` settings can be set per language.

### Changed

- Rule names are case-sensitive in W3C XML EBNF, BNF, and RBNF. ABNF names stay
  case-insensitive, as RFC 5234 defines them.
- Requires VS Code 1.91 or later.
- ABNF and EBNF files use their own language configuration instead of the BNF
  one.
- Large files past `bnf.semanticHighlighting.maxTokens` keep semantic
  highlighting for rule names and references. Before, they fell back entirely
  to TextMate highlighting.
- Workspace indexing runs in the background. It skips `node_modules`, `.git`,
  and the root `out` and `dist` folders, and it honours `files.exclude`.
- Open and untitled documents are indexed from their unsaved text, unless
  `files.exclude` hides them.
- Parse results are cached per document version.
- Development tooling moved to Bun: `bun test`, Biome, lefthook git hooks in
  place of `.githooks`, and `bun run bench`.
- New logo.

### Fixed

- W3C XML EBNF: `;` is no longer treated as a comment, and `\` is no longer an
  escape character in strings.
- Many parser, formatter, diagnostic, and highlighting bugs fixed across ABNF,
  BNF, W3C XML EBNF, and RBNF.

## [0.2.1] - 2026-08-27

### Fixed

- Comment text no longer receives grammar operator or delimiter highlighting.

## [0.1.0] - 2026-04-23

BNF-family reset release.

### Added

- Four grammar families:
  - ABNF (`.abnf`) via RFC 5234 and RFC 7405
  - BNF (`.bnf`) via W3C BNF notation
  - EBNF (`.ebnf`) via strict W3C XML EBNF
  - RBNF (`.rbnf`) via RFC 5511
- Syntax highlighting, semantic highlighting, hover, definition, references,
  rename, symbols, inlay hints, diagnostics, formatting, and snippets.
- Workspace-aware rule navigation and completion.
- Hover and navigation for built-in ABNF core rules.
- JSON example grammars for all four supported notations.

### Changed

- Extension renamed as a BNF-family grammar extension.
- EBNF support now targets W3C XML EBNF only.
- Settings use one `bnf.*` namespace for all grammar families.

### Fixed

- W3C EBNF character syntax such as `#x20` and `[#x20-#x21]` no longer reports
  false missing-rule diagnostics.
- Spaced rule names and mixed grammar constructs tokenize consistently across
  dialects.
- Formatter layout settings work across grammar families.
