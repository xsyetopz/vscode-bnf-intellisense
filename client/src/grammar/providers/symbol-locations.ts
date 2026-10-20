import { DocumentHighlight, DocumentHighlightKind, Location } from "vscode";
import type { Rule } from "../../types.ts";
import type { GrammarDialect } from "../dialects.ts";
import type { GrammarWorkspace } from "../workspace.ts";

type SymbolTable = ReturnType<GrammarWorkspace["get"]>["symbolTable"];

/**
 * Collects symbol locations from one symbol table.
 */
export function collectSymbolLocations(
  symbolTable: SymbolTable,
  word: string,
  uri: Location["uri"],
  includeDefinitions: boolean,
): Location[] {
  const locations: Location[] = [];
  if (includeDefinitions) {
    for (const rule of symbolTable.definitions.get(word) ?? []) {
      locations.push(new Location(uri, rule.nameRange));
    }
  }
  for (const ref of symbolTable.references.get(word) ?? []) {
    locations.push(new Location(uri, ref.range));
  }
  return locations;
}

/**
 * Collects symbol locations across the current workspace for one dialect.
 */
export function collectWorkspaceSymbolLocations(
  workspace: GrammarWorkspace,
  word: string,
  dialect: GrammarDialect,
  currentUri: string,
  currentSymbolTable: SymbolTable,
  currentDocumentUri: Location["uri"],
  includeDefinitions: boolean,
): Location[] {
  const locations = collectSymbolLocations(
    currentSymbolTable,
    word,
    currentDocumentUri,
    includeDefinitions,
  );
  for (const file of workspace.getAllFiles(dialect)) {
    if (file.uri.toString() === currentUri) {
      continue;
    }
    locations.push(
      ...collectSymbolLocations(
        file.symbolTable,
        word,
        file.uri,
        includeDefinitions,
      ),
    );
  }
  return locations;
}

/**
 * One rule definition together with the document that holds it.
 */
export interface WorkspaceDefinition {
  uri: Location["uri"];
  rule: Rule;
}

/**
 * Collects rule definitions across the current workspace for one dialect. The
 * current document comes first, then the other indexed files.
 */
export function collectWorkspaceDefinitions(
  workspace: GrammarWorkspace,
  word: string,
  dialect: GrammarDialect,
  currentUri: string,
  currentSymbolTable: SymbolTable,
  currentDocumentUri: Location["uri"],
): WorkspaceDefinition[] {
  const definitions: WorkspaceDefinition[] = [];
  for (const rule of currentSymbolTable.definitions.get(word) ?? []) {
    definitions.push({ uri: currentDocumentUri, rule });
  }
  for (const file of workspace.getAllFiles(dialect)) {
    if (file.uri.toString() === currentUri) {
      continue;
    }
    for (const rule of file.symbolTable.definitions.get(word) ?? []) {
      definitions.push({ uri: file.uri, rule });
    }
  }
  return definitions;
}

/**
 * Collects definition locations across the current workspace for one dialect.
 */
export function collectWorkspaceDefinitionLocations(
  workspace: GrammarWorkspace,
  word: string,
  dialect: GrammarDialect,
  currentUri: string,
  currentSymbolTable: SymbolTable,
  currentDocumentUri: Location["uri"],
): Location[] {
  return collectWorkspaceDefinitions(
    workspace,
    word,
    dialect,
    currentUri,
    currentSymbolTable,
    currentDocumentUri,
  ).map(({ uri, rule }) => new Location(uri, rule.nameRange));
}

/**
 * Counts references across the current workspace for one symbol.
 */
export function collectWorkspaceReferenceCount(
  workspace: GrammarWorkspace,
  word: string,
  dialect: GrammarDialect,
  currentUri: string,
  currentSymbolTable: SymbolTable,
): number {
  let count = currentSymbolTable.references.get(word)?.length ?? 0;
  for (const file of workspace.getAllFiles(dialect)) {
    if (file.uri.toString() === currentUri) {
      continue;
    }
    count += file.symbolTable.references.get(word)?.length ?? 0;
  }
  return count;
}

/**
 * Collects document-local highlights for one symbol.
 */
export function collectDocumentHighlights(
  symbolTable: SymbolTable,
  word: string,
): DocumentHighlight[] {
  const highlights: DocumentHighlight[] = [];
  for (const rule of symbolTable.definitions.get(word) ?? []) {
    highlights.push(
      new DocumentHighlight(rule.nameRange, DocumentHighlightKind.Write),
    );
  }
  for (const ref of symbolTable.references.get(word) ?? []) {
    highlights.push(
      new DocumentHighlight(ref.range, DocumentHighlightKind.Read),
    );
  }
  return highlights;
}
