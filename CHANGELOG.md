# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-03-10

### Fixed

- `..` range operator (e.g., `"0".."9"`) no longer tokenized as two semicolons, preventing false "Unclosed" diagnostics

## [0.1.0] - 2026-03-09

### Added

- Initial release
- Syntax highlighting via TextMate grammar for ISO/IEC 14977 EBNF
- EBNF syntax highlighting in markdown code blocks
- Go to definition for rule references
- Hover information for rule definitions
- Autocompletion for rule names and operators
- Real-time diagnostics for syntax errors
- Find references for rule names
- Rename refactoring for rule names
- Document symbols (outline view)
- Snippets for common EBNF patterns
- Language configuration (bracket matching, comment toggling, auto-closing pairs)

### Grammar

- Fixed `repetition-count` to scope numeric count and `*` operator separately
- Added standalone `repetition-star` pattern for `*` operator
- Added `punctuation.definition.*` delimiter scoping for comments, strings, and special sequences
- Prevented strings from spanning lines with lookahead end patterns
- Added `#comment` include in expression patterns for defensive robustness

[Unreleased]: https://github.com/xsyetopz/vscode-ebnf-intellisense/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/xsyetopz/vscode-ebnf-intellisense/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/xsyetopz/vscode-ebnf-intellisense/releases/tag/v0.1.0
