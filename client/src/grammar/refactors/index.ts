import {
  type CancellationToken,
  type CodeAction,
  type CodeActionContext,
  type CodeActionKind,
  type CodeActionProvider,
  type Disposable,
  type DocumentSelector,
  languages,
  type Range,
  type TextDocument,
} from "vscode";
import type { GrammarWorkspace } from "../workspace.ts";
import { RefactorContext } from "./context.ts";
import { EXTRACT_KIND, extractRuleAction } from "./extract-rule.ts";
import { INLINE_KIND, inlineRuleAction } from "./inline-rule.ts";

function wanted(context: CodeActionContext, kind: CodeActionKind): boolean {
  return !context.only || context.only.contains(kind);
}

/**
 * Refactor code actions: extract rule and inline rule.
 */
export class GrammarRefactorProvider implements CodeActionProvider {
  static readonly metadata = {
    providedCodeActionKinds: [EXTRACT_KIND, INLINE_KIND],
  };

  readonly #workspace: GrammarWorkspace;

  constructor(workspace: GrammarWorkspace) {
    this.#workspace = workspace;
  }

  provideCodeActions(
    doc: TextDocument,
    range: Range,
    context: CodeActionContext,
    token?: CancellationToken,
  ): CodeAction[] | undefined {
    const extract = wanted(context, EXTRACT_KIND);
    const inline = wanted(context, INLINE_KIND);
    if (!(extract || inline) || token?.isCancellationRequested) {
      return undefined;
    }
    const ctx = RefactorContext.create(doc, this.#workspace);
    if (!ctx) {
      return undefined;
    }
    const actions: CodeAction[] = [];
    const push = (action: CodeAction | undefined): void => {
      if (action) {
        actions.push(action);
      }
    };
    if (extract) {
      push(extractRuleAction(ctx, this.#workspace, range));
    }
    if (inline) {
      push(inlineRuleAction(ctx, this.#workspace, range));
    }
    return actions.length > 0 ? actions : undefined;
  }
}

/**
 * Registers the refactor provider for the given document selector.
 */
export function registerGrammarRefactorProviders(
  selector: DocumentSelector,
  grammarWorkspace: GrammarWorkspace,
): Disposable[] {
  return [
    languages.registerCodeActionsProvider(
      selector,
      new GrammarRefactorProvider(grammarWorkspace),
      GrammarRefactorProvider.metadata,
    ),
  ];
}
