import {
  type CancellationToken,
  type Position,
  type Range,
  type RenameProvider,
  type TextDocument,
  WorkspaceEdit,
} from "vscode";
import type { GrammarDialect } from "../dialects.ts";
import { normalizeSymbolName } from "../grammar.ts";
import type { GrammarWorkspace } from "../workspace.ts";
import {
  collectWorkspaceDefinitionLocations,
  collectWorkspaceSymbolLocations,
} from "./symbol-locations.ts";
import { getWordLookup } from "./word-at-position.ts";

/**
 * VS Code rename provider for grammar symbols.
 */
export class GrammarRenameProvider implements RenameProvider {
  readonly #grammarWorkspace: GrammarWorkspace;

  constructor(grammarWorkspace: GrammarWorkspace) {
    this.#grammarWorkspace = grammarWorkspace;
  }

  provideRenameEdits(
    doc: TextDocument,
    position: Position,
    newName: string,
    _token: CancellationToken,
  ): WorkspaceEdit | undefined {
    const lookup = getWordLookup(doc, position, this.#grammarWorkspace);
    if (!(lookup && isValidRuleName(newName, lookup.dialect))) {
      return undefined;
    }
    const newKey = normalizeSymbolName(newName, lookup.dialect);
    if (
      newKey !== lookup.word &&
      collectWorkspaceDefinitionLocations(
        this.#grammarWorkspace,
        newKey,
        lookup.dialect,
        doc.uri.toString(),
        lookup.symbolTable,
        doc.uri,
      ).length > 0
    ) {
      throw new Error(`A rule named "${newName}" is already defined`);
    }

    const edit = new WorkspaceEdit();
    for (const location of collectWorkspaceSymbolLocations(
      this.#grammarWorkspace,
      lookup.word,
      lookup.dialect,
      doc.uri.toString(),
      lookup.symbolTable,
      doc.uri,
      true,
    )) {
      edit.replace(location.uri, location.range, newName);
    }
    return edit;
  }

  prepareRename(
    doc: TextDocument,
    position: Position,
    _token: CancellationToken,
  ): { range: Range; placeholder: string } | undefined {
    const lookup = getWordLookup(doc, position, this.#grammarWorkspace);
    if (!lookup) {
      return undefined;
    }
    return { range: lookup.wordRange, placeholder: lookup.text };
  }
}

const ABNF_RULE_NAME_RE = /^[A-Za-z][A-Za-z0-9-]*$/;
const BNF_RULE_NAME_RE = /^<[^<>\r\n]+>$|^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const EBNF_RULE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const RBNF_RULE_NAME_RE = /^<[^<>\r\n]+>$/;

function isValidRuleName(name: string, dialect: GrammarDialect): boolean {
  switch (dialect) {
    case "abnf":
      return ABNF_RULE_NAME_RE.test(name);
    case "bnf":
      return BNF_RULE_NAME_RE.test(name);
    case "ebnf":
      return EBNF_RULE_NAME_RE.test(name);
    case "rbnf":
      return RBNF_RULE_NAME_RE.test(name);
    default:
      return false;
  }
}
