import type { Diagnostic } from "vscode";

/**
 * Did-you-mean suggestions computed together with the diagnostics, so a
 * quick fix offers exactly what the message said. VS Code hands back copies
 * of diagnostics, so the suggestions are also kept per document and range.
 */
interface Recorded {
  /** Reference text the suggestion was computed for. */
  name: string;
  suggestion: string;
}

const byDiagnostic = new WeakMap<object, Recorded>();
const byDocument = new Map<string, Map<string, Recorded>>();

function rangeKey(range: Diagnostic["range"]): string {
  return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}

/**
 * Records the suggestion of one diagnostic; "" means there was none.
 */
export function recordSuggestion(
  diagnostic: object,
  name: string,
  suggestion: string,
): void {
  byDiagnostic.set(diagnostic, { name, suggestion });
}

/**
 * Keeps the suggestions of a document's current diagnostics by range.
 */
export function rememberDocumentSuggestions(
  uri: string,
  diagnostics: readonly Diagnostic[],
): void {
  const map = new Map<string, Recorded>();
  for (const diagnostic of diagnostics) {
    const suggestion = byDiagnostic.get(diagnostic);
    if (suggestion !== undefined) {
      map.set(rangeKey(diagnostic.range), suggestion);
    }
  }
  byDocument.set(uri, map);
}

/**
 * Drops the stored suggestions of a closed document.
 */
export function forgetDocumentSuggestions(uri: string): void {
  byDocument.delete(uri);
}

/**
 * Suggestion computed for this diagnostic, "" when there was none, or
 * undefined when nothing was recorded for it. A stored entry is used only if
 * the text now under the diagnostic's range is still the reference it was
 * computed for: after an edit VS Code moves ranges before the next reparse,
 * and a moved range must not pick up another reference's suggestion.
 */
export function recalledSuggestion(
  uri: string,
  diagnostic: Diagnostic,
  currentName: string,
): string | undefined {
  const entry =
    byDiagnostic.get(diagnostic) ??
    byDocument.get(uri)?.get(rangeKey(diagnostic.range));
  return entry && entry.name === currentName ? entry.suggestion : undefined;
}
