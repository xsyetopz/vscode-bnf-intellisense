# AGENTS.md

Instructions for AI coding assistants working on this project.

## What This Project Is

A Visual Studio Code extension that provides IDE features for EBNF grammar files. EBNF (Extended Backus-Naur Form) is a notation for defining programming language syntax, following ISO/IEC 14977.

## Quick Start

```bash
bun install        # Install dependencies
bun run build      # Build the extension
bun run package    # Create installable .vsix file
```

## Directory Layout

```
client/src/           # TypeScript source code
  main.ts             # Entry point -- registers all providers
  tokenizer.ts        # Converts text to tokens (lexer)
  parser.ts           # Converts tokens to AST (parser)
  document-manager.ts # Caches parse results
  workspace-index.ts  # Indexes files across workspace
  types.ts            # Type definitions
  providers/          # VS Code language feature implementations
    definition.ts     # "Go to definition"
    references.ts     # "Find all references"
    hover.ts          # Hover tooltips
    completion.ts     # Autocomplete suggestions
    rename.ts         # Rename refactoring
    diagnostics.ts    # Errors and warnings
    symbols.ts        # Outline view
    semantic-tokens.ts # Syntax highlighting
    code-actions.ts   # Quick fixes
    folding.ts        # Code folding
    highlighting.ts   # Highlight occurrences
    word-at-position.ts # Helper for word detection
    workspace-symbols.ts # Cross-file symbol search
syntaxes/             # TextMate grammar files (JSON)
snippets/             # Code snippet definitions
dist/                 # Build output (do not edit)
```

## How It Works

1. User opens a `.ebnf` or `.bnf` file
2. `main.ts` activates the extension
3. `tokenizer.ts` breaks text into tokens (identifiers, strings, operators)
4. `parser.ts` builds a document model with rules and references
5. Providers use the parsed model to implement IDE features

## Key Types

```typescript
interface Rule {
  name: string;           // Rule identifier
  nameRange: Range;       // Location of the name
  definitionRange: Range; // Full rule span
  references: IdentifierReference[]; // Rules referenced in body
}

interface EbnfDocument {
  rules: Rule[];
  diagnostics: Diagnostic[];
}

interface SymbolTable {
  definitions: Map<string, Rule[]>;    // name -> rules
  references: Map<string, IdentifierReference[]>; // name -> usages
}
```

## Adding Features

### New Provider

1. Create file in `client/src/providers/`
2. Implement VS Code's provider interface
3. Register in `main.ts`:
   ```typescript
   languages.registerXxxProvider(SELECTOR, new YourProvider(manager))
   ```

### New Diagnostic

Add to `client/src/providers/diagnostics.ts`:
```typescript
diagnostics.push({
  message: "Your message",
  range: someRange,
  severity: DiagnosticSeverity.Warning,
  source: DIAGNOSTIC_SOURCE,
});
```

### New Setting

1. Add to `package.json` under `contributes.configuration.properties`
2. Read in code:
   ```typescript
   workspace.getConfiguration("ebnf").get<boolean>("yourSetting", defaultValue)
   ```

## Code Conventions

- TypeScript with strict mode
- Use `type` keyword for type-only imports
- Prefer `const`, use `let` only when reassignment needed
- No `any` without good reason
- camelCase for variables/functions
- PascalCase for types/classes/interfaces

## Commit Messages

Use conventional commits:
```
feat(scope): add feature
fix(scope): fix bug
docs(scope): update docs
refactor(scope): restructure code
```

## Common Tasks

### Parse a document

```typescript
import { parse, buildSymbolTable } from "./parser";

const doc = parse(text);
const symbols = buildSymbolTable(doc);
```

### Get cached parse result

```typescript
const { document, symbolTable } = manager.get(textDocument);
```

### Find definition of a rule

```typescript
const rules = symbolTable.definitions.get(ruleName);
```

### Search across workspace

```typescript
const results = workspaceIndex.findDefinitions(ruleName);
const matches = workspaceIndex.searchSymbols(query);
```

## Testing

No automated tests exist yet. Test manually:
1. Run `bun run build`
2. Press F5 in VS Code to launch Extension Development Host
3. Open a `.ebnf` file and verify features work
