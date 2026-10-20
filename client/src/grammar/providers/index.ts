import {
  type DiagnosticCollection,
  type DocumentSelector,
  languages,
} from "vscode";
import { GrammarCodeActionProvider } from "../code-actions.ts";
import {
  COMPLETION_TRIGGERS,
  GrammarCompletionProvider,
} from "../completion.ts";
import {
  GrammarFormattingProvider,
  GrammarRangeFormattingProvider,
} from "../formatting-provider.ts";
import { registerGrammarRefactorProviders } from "../refactors/index.ts";
import {
  GRAMMAR_SEMANTIC_TOKENS_LEGEND,
  GrammarSemanticTokensProvider,
} from "../semantic-tokens.ts";
import type { GrammarWorkspace } from "../workspace.ts";
import { GrammarCallHierarchyProvider } from "./call-hierarchy.ts";
import { GrammarCodeLensProvider } from "./code-lens.ts";
import { GrammarDeclarationProvider } from "./declaration.ts";
import { GrammarDefinitionProvider } from "./definition.ts";
import { GrammarDocumentLinkProvider } from "./document-links.ts";
import { GrammarFoldingRangeProvider } from "./folding.ts";
import { GrammarDocumentHighlightProvider } from "./highlighting.ts";
import { GrammarHoverProvider } from "./hover.ts";
import { GrammarInlayHintsProvider } from "./inlay-hints.ts";
import { GrammarLinkedEditingRangeProvider } from "./linked-editing.ts";
import {
  GrammarOnTypeFormattingProvider,
  ON_TYPE_FORMATTING_TRIGGERS,
} from "./on-type-formatting.ts";
import { GrammarReferenceProvider } from "./references.ts";
import { GrammarRenameProvider } from "./rename.ts";
import { GrammarSelectionRangeProvider } from "./selection-range.ts";
import { GrammarDocumentSymbolProvider } from "./symbols.ts";
import { GrammarWorkspaceSymbolProvider } from "./workspace-symbols.ts";

/**
 * Registers all grammar language providers for the extension.
 */
export function registerGrammarProviders(
  selector: DocumentSelector,
  workspace: GrammarWorkspace,
  diagnosticCollection: DiagnosticCollection,
) {
  const inlayHints = new GrammarInlayHintsProvider(workspace);
  const semanticTokens = new GrammarSemanticTokensProvider(workspace);
  const codeLens = new GrammarCodeLensProvider(workspace);
  return [
    inlayHints,
    semanticTokens,
    codeLens,
    languages.registerDocumentSymbolProvider(
      selector,
      new GrammarDocumentSymbolProvider(workspace),
    ),
    languages.registerDefinitionProvider(
      selector,
      new GrammarDefinitionProvider(workspace),
    ),
    languages.registerDeclarationProvider(
      selector,
      new GrammarDeclarationProvider(workspace),
    ),
    languages.registerReferenceProvider(
      selector,
      new GrammarReferenceProvider(workspace),
    ),
    languages.registerHoverProvider(
      selector,
      new GrammarHoverProvider(workspace),
    ),
    languages.registerRenameProvider(
      selector,
      new GrammarRenameProvider(workspace),
    ),
    languages.registerDocumentHighlightProvider(
      selector,
      new GrammarDocumentHighlightProvider(workspace),
    ),
    languages.registerFoldingRangeProvider(
      selector,
      new GrammarFoldingRangeProvider(workspace),
    ),
    languages.registerInlayHintsProvider(selector, inlayHints),
    languages.registerDocumentSemanticTokensProvider(
      selector,
      semanticTokens,
      GRAMMAR_SEMANTIC_TOKENS_LEGEND,
    ),
    languages.registerDocumentRangeSemanticTokensProvider(
      selector,
      semanticTokens,
      GRAMMAR_SEMANTIC_TOKENS_LEGEND,
    ),
    languages.registerSelectionRangeProvider(
      selector,
      new GrammarSelectionRangeProvider(),
    ),
    languages.registerCodeLensProvider(selector, codeLens),
    languages.registerCallHierarchyProvider(
      selector,
      new GrammarCallHierarchyProvider(workspace),
    ),
    languages.registerLinkedEditingRangeProvider(
      selector,
      new GrammarLinkedEditingRangeProvider(workspace),
    ),
    languages.registerDocumentLinkProvider(
      selector,
      new GrammarDocumentLinkProvider(),
    ),
    // Trigger characters are per dialect: "%" is ABNF-only, "#" is EBNF-only,
    // and "<" is BNF/RBNF-only.
    ...COMPLETION_TRIGGERS.map(({ language, triggers }) =>
      languages.registerCompletionItemProvider(
        { language },
        new GrammarCompletionProvider(workspace),
        ...triggers,
      ),
    ),
    languages.registerCodeActionsProvider(
      selector,
      new GrammarCodeActionProvider(),
      GrammarCodeActionProvider.metadata,
    ),
    languages.registerDocumentFormattingEditProvider(
      selector,
      new GrammarFormattingProvider(),
    ),
    languages.registerDocumentRangeFormattingEditProvider(
      selector,
      new GrammarRangeFormattingProvider(),
    ),
    languages.registerOnTypeFormattingEditProvider(
      selector,
      new GrammarOnTypeFormattingProvider(),
      ...ON_TYPE_FORMATTING_TRIGGERS,
    ),
    languages.registerWorkspaceSymbolProvider(
      new GrammarWorkspaceSymbolProvider(workspace),
    ),
    ...registerGrammarRefactorProviders(selector, workspace),
    diagnosticCollection,
  ];
}
