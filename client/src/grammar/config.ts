import { type ConfigurationScope, workspace } from "vscode";

/**
 * Reads one `bnf.*` setting. Pass the document's `{ uri, languageId }` as
 * `scope` so folder and `"[language]"` overrides apply.
 */
export function readGrammarConfig<T>(
  key: string,
  fallback: T,
  scope?: ConfigurationScope,
): T {
  return workspace.getConfiguration("bnf", scope).get<T>(key, fallback);
}
