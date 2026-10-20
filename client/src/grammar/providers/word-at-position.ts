import type { Position, Range, TextDocument } from "vscode";
import type { SymbolTable } from "../../types.ts";
import { type GrammarDialect, normalizeSymbolName } from "../grammar.ts";
import type { GrammarWorkspace } from "../workspace.ts";

/**
 * Resolved grammar word and symbol context at a document position.
 */
export interface WordLookup {
  /** Normalized lookup key (lowercased only for case-insensitive dialects). */
  word: string;
  /** Name exactly as written in the document. */
  text: string;
  wordRange: Range;
  symbolTable: SymbolTable;
  dialect: GrammarDialect;
}

/**
 * Finds the grammar symbol under a VS Code document position.
 */
export function getWordLookup(
  doc: TextDocument,
  position: Position,
  grammarWorkspace: GrammarWorkspace,
): WordLookup | undefined {
  // Only parsed rule names and references count. Words inside comments and
  // strings are never symbols, and names may contain "_", ".", and ":".
  const found = findSymbolAtPosition(doc, position, grammarWorkspace);
  if (!found) {
    return undefined;
  }
  return { ...found, word: normalizeSymbolName(found.text, found.dialect) };
}

function positionInRange(pos: Position, range: Range): boolean {
  if (pos.line < range.start.line || pos.line > range.end.line) {
    return false;
  }
  if (pos.line === range.start.line && pos.character < range.start.character) {
    return false;
  }
  if (pos.line === range.end.line && pos.character > range.end.character) {
    return false;
  }
  return true;
}

function findSymbolAtPosition(
  doc: TextDocument,
  position: Position,
  grammarWorkspace: GrammarWorkspace,
):
  | {
      text: string;
      wordRange: Range;
      symbolTable: SymbolTable;
      dialect: GrammarDialect;
    }
  | undefined {
  const {
    dialect,
    document: grammarDoc,
    symbolTable,
  } = grammarWorkspace.get(doc);

  for (const rule of grammarDoc.rules) {
    if (positionInRange(position, rule.nameRange)) {
      return {
        text: rule.name,
        wordRange: rule.nameRange,
        symbolTable,
        dialect,
      };
    }
    for (const ref of rule.references) {
      if (positionInRange(position, ref.range)) {
        return {
          text: ref.name,
          wordRange: ref.range,
          symbolTable,
          dialect,
        };
      }
    }
  }

  return undefined;
}
