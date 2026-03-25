# ABNF Syntax Highlighting and Intellisense

A VS Code extension for editing ABNF grammar files with full IDE support.

ABNF (Augmented Backus-Naur Form) is a notation for defining the syntax of protocols and data formats, widely used in IETF RFCs. This extension follows [RFC 5234](https://www.rfc-editor.org/rfc/rfc5234) and [RFC 7405](https://datatracker.ietf.org/doc/html/rfc7405).

## Features

### Core Editing

- **Syntax Highlighting** - Colors for rule names, strings, numeric values, comments, operators, and prose values
- **Semantic Highlighting** - Different colors for rule definitions, references, and core rules (ALPHA, DIGIT, etc.)
- **Formatting** - Align `=` signs, indent continuation lines, format alternatives
- **Snippets** - Quick templates for common ABNF patterns (type `rule`, `alt`, `hex`, `range`, etc.)
- **Auto-closing** - Automatically closes brackets, quotes, and prose value delimiters
- **Folding** - Collapse multi-line rules

### Navigation

- **Go to Definition** - Click a rule name to jump to where it's defined (F12)
- **Find References** - See everywhere a rule is used (Shift+F12)
- **Document Symbols** - View all rules in the outline panel (Ctrl+Shift+O)
- **Workspace Symbols** - Search for rules across all ABNF files in your project (Ctrl+T)
- **Hover** - See rule definitions on hover

### Validation

- **Undefined Rules** - Warns when you reference a rule that doesn't exist (core rules like ALPHA, DIGIT are recognized automatically)
- **Duplicate Rules** - Flags rules defined more than once (respects `=/` incremental alternatives)
- **Unused Rules** - Hints when a rule is defined but never referenced

### Refactoring

- **Rename** - Change a rule name everywhere it appears (F2)
- **Quick Fixes** - Click the lightbulb to create missing rules automatically
- **Inlay Hints** - Optional reference counts, recursion markers, and unused indicators

### Cross-file Support

- **Multi-file Navigation** - Jump to definitions in other ABNF files
- **Workspace References** - Find usages across your entire project

## Installation

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=xsyetopz.vscode-abnf-intellisense) or search for "ABNF" in VS Code extensions.

To build from source:

```bash
bun install
bun run package
code --install-extension vscode-abnf-intellisense-*.vsix
```

## Usage

Open any `.abnf` file. The extension activates automatically.

### Example ABNF file

```abnf
; A simple URI grammar (simplified)
URI       = scheme ":" hier-part
scheme    = ALPHA *(ALPHA / DIGIT / "+" / "-" / ".")
hier-part = "//" authority path-abempty
          / path-absolute

authority = [userinfo "@"] host [":" port]
userinfo  = *(unreserved / pct-encoded / ":")
host      = reg-name
port      = *DIGIT

path-abempty  = *("/" segment)
path-absolute = "/" [segment-nz *("/" segment)]
segment       = *pchar
segment-nz    = 1*pchar
pchar         = unreserved / pct-encoded / ":" / "@"

unreserved  = ALPHA / DIGIT / "-" / "." / "_" / "~"
pct-encoded = "%" HEXDIG HEXDIG
reg-name    = *(unreserved / pct-encoded)
```

### Core Rules

The 16 core rules from RFC 5234 Appendix B are built-in and always available:

`ALPHA`, `BIT`, `CHAR`, `CR`, `CRLF`, `CTL`, `DIGIT`, `DQUOTE`, `HEXDIG`, `HTAB`, `LF`, `LWSP`, `OCTET`, `SP`, `VCHAR`, `WSP`

### Markdown Support

Use `abnf` code blocks in Markdown files for syntax highlighting:

````markdown
```abnf
rule = element1 / element2
```
````

## Settings

### Diagnostics

| Setting | Default | Description |
|---------|---------|-------------|
| `abnf.diagnostics.enable` | `true` | Enable or disable all diagnostics |
| `abnf.diagnostics.unusedRules` | `true` | Show hints for unused rules |
| `abnf.diagnostics.undefinedReferences` | `true` | Show errors for undefined rule references |

### Formatting

| Setting | Default | Description |
|---------|---------|-------------|
| `abnf.formatting.alignEquals` | `true` | Align `=` signs across consecutive rules |
| `abnf.formatting.continuationIndent` | `4` | Spaces for continuation lines |
| `abnf.formatting.alternativeIndent` | `"align"` | `"align"` alternatives under `=`, or `"indent"` with fixed indent |
| `abnf.formatting.insertFinalNewline` | `true` | Insert final newline at end of file |

### Inlay Hints

| Setting | Default | Description |
|---------|---------|-------------|
| `abnf.inlayHints.referenceCount` | `false` | Show reference count after rule names |
| `abnf.inlayHints.recursion` | `false` | Mark directly recursive rules |
| `abnf.inlayHints.unusedMarker` | `false` | Mark unused rules inline |

## ABNF Quick Reference

| Syntax | Meaning |
|--------|---------|
| `=` | Rule definition |
| `=/` | Incremental alternative (extends existing rule) |
| `/` | Alternative (or) |
| `( ... )` | Grouping |
| `[ ... ]` | Optional (zero or one) |
| `*element` | Repetition (zero or more) |
| `1*element` | Repetition (one or more) |
| `3*5element` | Repetition (3 to 5 times) |
| `3element` | Repetition (exactly 3) |
| `"..."` | Case-insensitive string |
| `%s"..."` | Case-sensitive string (RFC 7405) |
| `%x41` | Hex value (character A) |
| `%x30-39` | Value range (digits 0-9) |
| `%x48.65.6C.6C.6F` | Value concatenation ("Hello") |
| `%d` / `%b` | Decimal / binary values |
| `<...>` | Prose value (natural language) |
| `;` | Comment (to end of line) |

## Development

```bash
bun run build    # Build the extension
bun run package  # Create .vsix package
```

## License

MIT

## Links

- [GitHub Repository](https://github.com/xsyetopz/vscode-abnf-intellisense)
- [Issue Tracker](https://github.com/xsyetopz/vscode-abnf-intellisense/issues)
- [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=xsyetopz.vscode-abnf-intellisense)
- [RFC 5234 - ABNF Specification](https://www.rfc-editor.org/rfc/rfc5234)
- [RFC 7405 - Case-Sensitive Strings](https://datatracker.ietf.org/doc/html/rfc7405)
