# CLAUDE.md

Project-specific instructions for Claude Code.

## Project Overview

VS Code extension for EBNF (Extended Backus-Naur Form) grammar files. Provides syntax highlighting, intellisense, diagnostics, and refactoring support following ISO/IEC 14977.

## Build & Test

```bash
bun run build      # Build extension (outputs to dist/extension.js)
bun run package    # Create .vsix for installation
```

No test suite exists yet. Verify changes by building and testing manually in VS Code.

## Project Structure

```
client/src/
  main.ts              # Extension entry point, provider registration
  tokenizer.ts         # Lexer -- converts text to tokens
  parser.ts            # Parser -- converts tokens to EbnfDocument + diagnostics
  document-manager.ts  # Caches parsed documents per URI
  workspace-index.ts   # Indexes all EBNF files in workspace
  types.ts             # Core types: Rule, EbnfDocument, SymbolTable
  providers/
    definition.ts      # Go to definition (F12)
    references.ts      # Find references (Shift+F12)
    hover.ts           # Hover information
    completion.ts      # Autocompletion
    rename.ts          # Rename symbol (F2)
    diagnostics.ts     # Error/warning reporting
    symbols.ts         # Document symbols (Ctrl+Shift+O)
    workspace-symbols.ts  # Workspace symbols (Ctrl+T)
    semantic-tokens.ts # Semantic highlighting
    code-actions.ts    # Quick fixes
    highlighting.ts    # Document highlights
    folding.ts         # Folding ranges
    word-at-position.ts  # Word detection helper
syntaxes/
  ebnf.tmLanguage.json        # TextMate grammar
  ebnf-markdown.tmLanguage.json  # Markdown injection
snippets/
  ebnf.json            # Code snippets
```

## Key Patterns

### Adding a New Provider

1. Create `client/src/providers/your-provider.ts`
2. Implement the VS Code provider interface
3. Import and register in `main.ts` using `languages.register*Provider()`
4. Add to `context.subscriptions.push()`

### Parser Flow

```
Text -> tokenize() -> Token[] -> parse() -> EbnfDocument
                                         -> buildSymbolTable() -> SymbolTable
```

### DocumentManager

All providers use `DocumentManager.get(doc)` to get cached parse results:

```typescript
const { document, symbolTable } = manager.get(doc);
```

### Cross-file Features

Use `WorkspaceIndex` for workspace-wide operations:
- `findDefinitions(name)` -- find rule in any file
- `searchSymbols(query)` -- fuzzy search all rules
- `getAllFiles()` -- iterate all indexed files

## Code Style

- TypeScript strict mode
- No `any` without justification
- Prefer `const` over `let`
- Use `type` imports: `import type { X } from "y"`
- camelCase for functions/variables, PascalCase for types/classes

## Commit Style

Conventional commits with scope:

```
feat(providers): add semantic tokens
fix(parser): handle empty rules
docs(readme): update feature list
refactor(parser): extract parseRuleBody helper
```

## Configuration

Settings defined in `package.json` under `contributes.configuration`:
- `ebnf.diagnostics.enable` -- toggle all diagnostics
- `ebnf.diagnostics.unusedRules` -- toggle unused rule hints
- `ebnf.parser.spacedIdentifiers` -- ISO 14977 spaced identifiers

Read settings via:
```typescript
const config = workspace.getConfiguration("ebnf");
const value = config.get<boolean>("diagnostics.enable", true);
```
