# Contributing to BNF-family Syntax Highlighting and Intellisense

Use this guide when you change code, grammar files, examples, or documentation.

## Code of Conduct

Follow the [Contributor Code of Conduct](CODE_OF_CONDUCT.md).

## Getting Started

1. Fork the repository on GitHub.
2. Clone your fork:

   ```bash
   git clone https://github.com/YOUR_USERNAME/vscode-bnf-intellisense.git
   cd vscode-bnf-intellisense
   ```

3. Install dependencies:

   ```bash
   bun install
   ```

## Development Workflow

### Building

```bash
bun run build
```

The build writes the extension bundle to `dist/extension.cjs`.

### Testing Your Changes

1. Run `bun run build`. The extension loads `dist/extension.cjs`. The repo
   does not commit a `.vscode/launch.json`.
2. Start an Extension Development Host from the repo root, for example
   `code --extensionDevelopmentPath="$PWD"`.
3. Open `.abnf`, `.bnf`, `.ebnf`, and `.rbnf` files that match your change.

### Code Style

This project uses [Biome](https://biomejs.dev) for code quality:

```bash
bun run verify      # Biome, markdownlint, and typecheck in parallel
bun run biome:check   # Check code style without modifying files
bun run md:check      # Lint Markdown (md:fix auto-fixes)
bun run biome:format  # Auto-fix formatting only
bun run biome:lint    # Auto-fix lint findings only
```

Run `bun run verify`, tests, and build before opening a PR.

### Git Hooks

Hooks are managed by [Lefthook](https://lefthook.dev) and install
automatically with `bun install` (the `prepare` script). To reinstall:

```bash
bunx lefthook install
```

The pre-commit hook runs Biome and markdownlint on staged files. The
commit-msg hook runs commitlint (conventional commits). The pre-push hook
runs `bun check`, tests, and build.

## Making Changes

### Grammar Changes

TextMate grammar improvements are in `syntaxes/*.tmLanguage.json`:

- Maintain proper scope naming for each dialect (for example,
  `keyword.operator.repetition.abnf`)
- Test changes by opening representative `.abnf`, `.bnf`, `.ebnf`, and `.rbnf`
  files in a debug VS Code instance
- Include delimiter scopes such as `punctuation.definition.*` for theme support
- Prevent unintended multiline matching with lookahead assertions

### TypeScript Changes

TypeScript code in `client/src/`:

- Follow TypeScript strict mode. Avoid `any` and non-null assertions unless the
  nearby code explains why they are safe.
- Use discriminated unions over type assertions
- Keep settings under the `bnf.*` namespace for all supported grammar families

### Provider Changes

Providers live in `client/src/grammar/providers/`, one file per VS Code provider:

- Register a new provider in `providers/index.ts`.
- Export public APIs from the provider module.
- Add focused tests in `client/src/__tests__/grammar/provider-*.test.ts`, and
  use the shared helpers in `provider-test-utils.ts`.
- Write each test in Arrange-Act-Assert order.

### Commit Messages

Use the conventional commit format:

```text
type(scope): subject

body...

Co-Authored-By: Your Name <your.email@example.com>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`,
`chore`, `revert`

Examples:

- `feat(grammar): fix repetition-count scoping`
- `fix(completion): handle rule names with hyphens`
- `docs(readme): clarify markdown support`

## Reporting Issues

Before opening an issue:

1. Check existing [issues](https://github.com/xsyetopz/vscode-bnf-intellisense/issues)
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
- [ ] User-facing changes documented in README, CHANGELOG, or comments
- [ ] No breaking changes without discussion

## Licensing

Contributions are licensed under the [MIT License](LICENSE).

## Questions?

Open an [issue](https://github.com/xsyetopz/vscode-bnf-intellisense/issues).
