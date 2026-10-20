import {
  type CancellationToken,
  type DeclarationProvider,
  Location,
  type Position,
  type TextDocument,
} from "vscode";
import type { GrammarWorkspace } from "../workspace.ts";
import { GrammarDefinitionProvider } from "./definition.ts";
import { collectWorkspaceDefinitions } from "./symbol-locations.ts";
import { getWordLookup } from "./word-at-position.ts";

/**
 * VS Code declaration provider. ABNF splits a rule into one `=` declaration
 * and any number of `=/` increments, so declaration goes to the first `=`
 * only. The other dialects have no increments: declaration is definition.
 */
export class GrammarDeclarationProvider implements DeclarationProvider {
  readonly #grammarWorkspace: GrammarWorkspace;
  readonly #definitions: GrammarDefinitionProvider;

  constructor(grammarWorkspace: GrammarWorkspace) {
    this.#grammarWorkspace = grammarWorkspace;
    this.#definitions = new GrammarDefinitionProvider(grammarWorkspace);
  }

  provideDeclaration(
    doc: TextDocument,
    position: Position,
    token: CancellationToken,
  ): Location[] | undefined {
    const lookup = getWordLookup(doc, position, this.#grammarWorkspace);
    if (!lookup) {
      return undefined;
    }
    if (lookup.dialect !== "abnf") {
      return this.#definitions.provideDefinition(doc, position, token);
    }
    const definitions = collectWorkspaceDefinitions(
      this.#grammarWorkspace,
      lookup.word,
      lookup.dialect,
      doc.uri.toString(),
      lookup.symbolTable,
      doc.uri,
    );
    // Without any `=` (only `=/`), fall back to the first definition found.
    const declaration =
      definitions.find(({ rule }) => !rule.isIncremental) ?? definitions[0];
    if (declaration) {
      return [new Location(declaration.uri, declaration.rule.nameRange)];
    }
    // Core rules live in the virtual core-rules document.
    return this.#definitions.provideDefinition(doc, position, token);
  }
}
