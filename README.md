# vscode-bnf-intellisense

[![Stars](https://img.shields.io/github/stars/xsyetopz/vscode-bnf-intellisense?style=social)](https://github.com/xsyetopz/vscode-bnf-intellisense/stargazers)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Edit ABNF, BNF, W3C XML EBNF, and RBNF files in VS Code with highlighting,
navigation, diagnostics, refactors, formatting, snippets, and rule-aware
completions.

## Fast Path

Use the extension:

1. Install the extension.
2. Open an `.abnf`, `.bnf`, `.ebnf`, or `.rbnf` file.
3. Check the VS Code language mode if highlighting or diagnostics do not appear.

Work on the extension:

```bash
bun install
bun run build
```

Check changes before a PR:

```bash
bun run biome:check
bun run typecheck
bun test
bun run build
```

Build a local VSIX:

```bash
bun run package
```

Time the pipeline stages on generated grammars:

```bash
bun run bench
```

`bun run bench` reads `BENCH_SIZES`, `BENCH_DIALECTS`, `BENCH_RUNS`, and
`BENCH_LENS_FILES`.

## Supported Grammars

| File | Language | Standard | Supported syntax |
| -------- | -------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `.abnf` | ABNF | [RFC 5234](https://www.rfc-editor.org/rfc/rfc5234) + [RFC 7405](https://datatracker.ietf.org/doc/html/rfc7405) | Rule names, `=`, `=/`, `/`, repetitions, numeric values, prose values, and `%s`/`%i` strings. |
| `.bnf` | BNF | [W3C BNF notation](https://www.w3.org/Notation.html) | `::=` productions, alternatives, grouping, optional parts, repetitions, and literals. |
| `.ebnf` | EBNF | [W3C XML 1.0 EBNF notation](https://www.w3.org/TR/xml/#sec-notation) | Production numbers, `::=`, `?`, `+`, `*`, character classes, character exclusions, and `/* */` comments. |
| `.rbnf` | RBNF | [RFC 5511](https://datatracker.ietf.org/doc/html/rfc5511) | `::=` productions and angle-bracket rule names, including names with spaces. |

ISO/IEC 14977 EBNF is not supported. `.ebnf` files use W3C XML EBNF. ISO-style
`=` productions are reported as diagnostics.

### Comments and strings

| Language | Comments | Strings |
| -------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| ABNF | `;` to end of line. | Quoted strings and `%s`/`%i` strings, as RFC 5234 and RFC 7405 define them. |
| BNF | `;` to end of line only. | Backslash escapes: `\\`, `\"`, `\'`, `\n`, `\r`, `\t`, and `\xHH`. Any other `\c` means `c`. |
| EBNF | `/* ... */` only. `;` is not a comment. | No escapes. `\` is a literal character. |
| RBNF | `;` to end of line only. | Backslash escapes, as in BNF. |

`(* ... *)` in EBNF is ISO/IEC 14977 syntax. It is reported, and a quick fix
rewrites it as `/* ... */` unless the comment is nested or contains `*/`.
Those comments get a disabled quick fix that gives the reason.

## Editor Features

Navigation and highlighting:

- TextMate highlighting for grammar files and Markdown code fences.
- Semantic highlighting for rule names and references. Large files are capped
  (see [Large files](#large-files)).
- Go to Definition, Go to Declaration, Find References, Rename, Linked Editing,
  Hover, Document Highlights, Document Symbols, Workspace Symbols, and Call
  Hierarchy.
- Hover and Go to Definition for ABNF core rules such as `ALPHA`. The
  definition opens a document of the RFC 5234 Appendix B rules.
- Folding ranges and selection ranges. Expand Selection follows tokens,
  elements, alternatives, groups, rule bodies, and whole rules.
- Document links. `RFC 1234` in a comment links to the rfc-editor.org page. The
  extension never fetches anything; VS Code opens the link when you follow it.
- A code lens with the reference count above each rule, unless
  `bnf.codeLens.references` is off.
- Inlay hints for reference counts, direct recursion, unused rules, repetitions,
  terminals, and character classes. All are off by default.
- Completion for rule names and each dialect's syntax.
- Snippets for common grammar constructs.

Call Hierarchy follows references from the body of one rule to another. ABNF
`=/` increments in one file share the item of that file's rule. A file that only
extends a rule with `=/` gets its own item, and its calls are not merged into the
item in the file with `=`. Core rules and undefined names are not items.

Diagnostics and quick fixes:

- Undefined references, duplicate definitions, unused rules, unreachable rules,
  left recursion, unproductive rules, duplicate and empty alternatives, empty
  groups, repetitions with no operand, unbalanced brackets, stray punctuation,
  unclosed ISO comments, and W3C exclusions written without spaces (`A-B`).
- RBNF: a bare word where a `<name>` is needed.
- ABNF: malformed numeric values, reversed or incomplete ranges, invalid
  repetition bounds, redundant repetitions such as `1*1`, whitespace after a
  repetition prefix, missing separators between elements, unterminated strings
  and prose values, non-ASCII strings and prose values, `=/` without a base
  rule, and duplicate `=/` extensions.
- Did-you-mean suggestions for undefined references.

Quick fixes:

- Create a missing rule for an undefined reference.
- Rename or change a reference to its did-you-mean suggestion.
- Remove a duplicate or empty alternative.
- ABNF: change `=` to `=/` for an extra alternative, or `=/` to `=` for a rule
  with no base. Indent a continuation line that starts in column 0. Insert a
  missing closer, or replace a mismatched one. Swap range bounds. Convert a
  quoted string to `%x` form, or a numeric value to a quoted string. Make a
  string case-sensitive with `%s`. Remove a redundant `%i`.
- EBNF ISO/IEC 14977 syntax: use `::=` for an ISO production, or `/* ... */`
  for an ISO comment. Convert every ISO production in the file at once when the
  file has at least two. An ISO production or comment that W3C has no form for
  gets a disabled fix that gives the reason.

Formatting:

- Formatting and range formatting: aligned assignments, wrapped alternatives,
  final newlines, and comment spacing.
- On-type formatting runs when you press Enter. VS Code only calls it when
  `editor.formatOnType` is enabled.

RBNF names such as `<WF flow descriptor>` stay one symbol. Rename, references,
and highlighting keep the full angle-bracket name together.

Rule names are case-sensitive in EBNF, BNF, and RBNF. ABNF names are
case-insensitive, as RFC 5234 defines them.

## Commands And Refactors

These commands appear in the command palette for ABNF, BNF, EBNF, and RBNF files.

- **BNF: Sort Rules Alphabetically** (`bnf.sortRules`). Sorts by the dialect's
  name rule. Sorting does nothing when the file has parse errors or a rule
  defined twice, and a message says so.
- **BNF: Sort Rules by Dependency** (`bnf.sortRulesByDependency`). Lists rules
  breadth first from the start rule (the first rule), then the rest in source
  order. Comments above a rule move with it. ABNF `=/` parts stay after their
  base rule. A selection sorts only the selected rules.
- **BNF: Convert to Another Dialect...** (`bnf.convertDialect`). Opens the
  converted grammar in a new untitled document. The source file is not changed.
  Constructs the target cannot express keep the source text in a comment, and
  the command reports how many there were.
- **BNF: Show Railroad Diagram** (`bnf.showRailroadDiagram`). Also in the editor
  title bar. It opens a webview beside the editor with a diagram of every rule.
  It scrolls to the rule at the cursor, updates after edits, and follows the
  active grammar editor. Clicking a nonterminal opens its definition.

Refactors appear as code actions:

- **Extract rule** (`refactor.extract`). Select whole alternatives, or a run of
  sequence items, inside one rule. The selection becomes a reference to a new
  rule, placed after the current rule, and the new name is renamed right away.
  Not offered in a rule with parse errors.
- **Inline rule** (`refactor.inline`). On a reference, inlines that one
  reference. On a definition name, inlines every reference in the file and
  removes the definition. Not offered for recursive rules, empty rules, rules
  with `=/` parts or more than one definition, core rules, rules with W3C
  `[ wfc: ]` or `[ vc: ]` annotations, or rules with parse errors. In a dialect
  with no grouping syntax, a reference that would need grouping is skipped.
  References in other files are left alone, and the action title says so when
  they exist.

## Large Files

In `auto` mode, a file with more semantic tokens than
`bnf.semanticHighlighting.maxTokens` gets semantic tokens only for rule names and
references. TextMate highlighting colours the rest.

Workspace indexing runs in the background, so features answer from the files
indexed so far. The index skips `node_modules` and `.git` folders, and `out` and
`dist` folders at the workspace root. It honours `files.exclude` and rescans when
that setting changes. Open documents are indexed from their unsaved buffer
text, and so are untitled documents. An open document that `files.exclude`
hides is not indexed, though it still gets diagnostics.

## Examples

Equivalent JSON grammars:

- [`examples/json.abnf`](examples/json.abnf)
- [`examples/json.bnf`](examples/json.bnf)
- [`examples/json.ebnf`](examples/json.ebnf)
- [`examples/json.rbnf`](examples/json.rbnf)

ABNF:

```abnf
json-text = ws value ws
value = object / array / string / number / true / false / null
object = begin-object ws [member *(ws value-separator ws member)] ws end-object
```

W3C BNF:

```bnf
<json-text> ::= <ws> <value> <ws>
<value> ::= <object> | <array> | <string> | <number> | "true" | "false" | "null"
<object> ::= "{" <ws> [<member> {<ws> "," <ws> <member>}] <ws> "}"
```

W3C XML EBNF:

```ebnf
[1] json-text ::= ws value ws
[2] value ::= object | array | string | number | "true" | "false" | "null"
[3] object ::= "{" ws (member (ws "," ws member)*)? ws "}"
```

RBNF:

```rbnf
<JSON text> ::= <WS> <value> <WS>
<value> ::= <object> | <array> | <string> | <number> | "true" | "false" | "null"
<object> ::= "{" <WS> [<member> *(<WS> "," <WS> <member>)] <WS> "}"
```

## Settings

All settings use the `bnf.*` prefix.

| Setting | Default | Effect |
| ----------------------------------------------- | -------- | ----------------------------------------------------------------------- |
| `bnf.diagnostics.enable` | `true` | Shows parser and rule diagnostics. |
| `bnf.diagnostics.unusedRules` | `true` | Shows hints for rules with no references. |
| `bnf.diagnostics.undefinedReferences` | `true` | Shows errors for references with no rule definition. |
| `bnf.diagnostics.didYouMean` | `true` | Suggests the closest defined rule for undefined references. |
| `bnf.diagnostics.leftRecursion` | `hint` | Severity for directly or indirectly left-recursive rules. Use `off` to disable. |
| `bnf.diagnostics.unproductiveRules` | `warning` | Severity for rules that can never derive a terminal string. |
| `bnf.diagnostics.unreachableRules` | `information` | Severity for referenced rules the start rule cannot reach. |
| `bnf.diagnostics.duplicateAlternatives` | `warning` | Severity for identical alternatives inside one choice. |
| `bnf.diagnostics.emptyAlternatives` | `hint` | Severity for alternatives that match only the empty string. |
| `bnf.diagnostics.caseSensitiveStrings` | `false` | ABNF only. Hints on quoted strings with uppercase letters. |
| `bnf.codeLens.references` | `true` | Shows a reference count above each rule definition. |
| `bnf.formatting.alignEquals` | `true` | Aligns assignment operators across consecutive rules. |
| `bnf.formatting.continuationIndent` | `4` | Sets spaces for wrapped rule-body lines. |
| `bnf.formatting.alternativeIndent` | `align` | Uses `align` or `indent` for alternatives on continuation lines. |
| `bnf.formatting.blankLinesBetweenRules` | `1` | Keeps this many blank lines between rule definitions. |
| `bnf.formatting.breakAlternatives` | `always` | Uses `always`, `auto`, or `never` for top-level alternatives. |
| `bnf.formatting.maxLineLength` | `80` | Wraps rule bodies after this column. Use `0` to disable wrapping. |
| `bnf.formatting.alignProductionNumbers` | `true` | Aligns EBNF production numbers such as `[1]`. |
| `bnf.formatting.preserveCommentSpacing` | `true` | Keeps blank-line spacing around standalone comments. |
| `bnf.formatting.trimTrailingBlankLines` | `true` | Removes extra blank lines at the end of the file. |
| `bnf.formatting.preserveContinuationLineBreaks` | `false` | Keeps existing indented continuation line breaks. |
| `bnf.formatting.spaceBeforeInlineComment` | `2` | Sets spaces before inline semicolon comments in rule bodies. |
| `bnf.formatting.insertFinalNewline` | `true` | Ends formatted files with one final newline. |
| `bnf.inlayHints.referenceCount` | `false` | Shows reference counts after rule names. |
| `bnf.inlayHints.recursion` | `false` | Marks rules that reference themselves directly. |
| `bnf.inlayHints.unusedMarker` | `false` | Marks rules with no references. |
| `bnf.inlayHints.syntaxDetails` | `false` | Shows syntax hints for repetitions, terminals, and character classes. |
| `bnf.semanticHighlighting.mode` | `auto` | Uses `auto`, `on`, or `off` for semantic tokens. |
| `bnf.semanticHighlighting.maxTokens` | `20000` | Sets the semantic-token limit in `auto` mode. Use `0` for no limit. |

## If Something Looks Wrong

- No highlighting: set the VS Code language mode to `ABNF`, `BNF`, `EBNF`, or
  `RBNF`.
- No diagnostics: check `bnf.diagnostics.enable`.
- Missing-rule errors feel noisy: set `bnf.diagnostics.undefinedReferences` to
  `false`.
- Large files feel slow: set `bnf.semanticHighlighting.mode` to `off`, or lower
  `bnf.semanticHighlighting.maxTokens`.
- Formatter changes too much: adjust `bnf.formatting.*` settings, then format a
  small selection before formatting the full file.
- Enter does not format continuation lines: turn on `editor.formatOnType`.

## Maintainers And Agents

- [AGENTS.md](AGENTS.md): commands, module map, invariants, and verification
  rules.
- [CONTRIBUTING.md](CONTRIBUTING.md): contribution workflow.
- [`client/src/__tests__`](client/src/__tests__): parser, formatter, provider,
  and TextMate grammar expectations.

## Star History

<a href="https://www.star-history.com/?type=date&repos=xsyetopz%2Fvscode-bnf-intellisense">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=xsyetopz/vscode-bnf-intellisense&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=xsyetopz/vscode-bnf-intellisense&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=xsyetopz/vscode-bnf-intellisense&type=date&legend=top-left" />
 </picture>
</a>

## License

[MIT](LICENSE)
