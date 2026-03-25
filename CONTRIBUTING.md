# Contributing to ABNF Syntax Highlighting and Intellisense

Thank you for your interest in contributing! This document provides guidelines and instructions for contributing to the project.

## Code of Conduct

This project adheres to a [Contributor Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:

   ```bash
   git clone https://github.com/YOUR_USERNAME/vscode-abnf-intellisense.git
   cd vscode-abnf-intellisense
   ```

3. **Install dependencies**:

   ```bash
   bun install
   ```

## Development Workflow

### Building

```bash
bun run build
```

Generates the extension bundle in `dist/extension.js`.

### Testing Your Changes

1. Open the project in VS Code
2. Press `F5` to launch the extension in a new VS Code window
3. Create or open `.abnf` files to test functionality

### Code Style

This project uses [Biome](https://biomejs.dev) for code quality:

```bash
bun run lint      # Check code style
bun run format    # Auto-fix formatting
```

All contributions must pass Biome checks before merging.

## Making Changes

### Grammar Changes

TextMate grammar improvements are in `syntaxes/abnf.tmLanguage.json`:

- Maintain proper scope naming (e.g., `keyword.operator.repetition.abnf`)
- Test changes by opening `.abnf` files in a debug VS Code instance
- Include delimiter scoping (`punctuation.definition.*`) for theme compatibility
- Prevent unintended multiline matching with lookahead assertions

### Language Server Changes

TypeScript code in `client/src/`:

- Follow TypeScript strict mode (no `any` without justification, no non-null assertions without docs)
- Use discriminated unions over type assertions
- Avoid `unwrap()`/`expect()` equivalents; use explicit error handling
- Export public APIs from provider modules

### Commit Messages

Use the conventional commit format:

```text
type(scope): subject

body...

Co-Authored-By: Your Name <your.email@example.com>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`

Examples:

- `feat(grammar): fix repetition-count scoping`
- `fix(completion): handle rule names with hyphens`
- `docs(readme): clarify markdown support`

## Reporting Issues

Before opening an issue:

1. Check existing [issues](https://github.com/xsyetopz/vscode-abnf-intellisense/issues)
2. Provide a minimal reproducible example
3. Include VS Code version and extension version
4. Attach screenshots or test files

## Submitting Pull Requests

1. Create a feature branch from `main`:

   ```bash
   git checkout -b feat/your-feature
   ```

2. Make your changes and commit with clear messages
3. Push to your fork and open a pull request on GitHub
4. Describe what your PR addresses
5. Ensure all checks pass

### PR Checklist

- [ ] Commits follow conventional format
- [ ] Grammar changes tested in VS Code debug window
- [ ] Code passes Biome lint/format
- [ ] Changes documented (README, CHANGELOG, comments)
- [ ] No breaking changes without discussion

## Licensing

By contributing, you agree that your contributions will be licensed under the project's [MIT License](LICENSE).

## Questions?

Open an [issue](https://github.com/xsyetopz/vscode-abnf-intellisense/issues) or start a discussion on GitHub.
