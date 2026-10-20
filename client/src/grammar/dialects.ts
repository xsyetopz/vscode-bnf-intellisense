/**
 * Grammar dialect identifiers supported by the extension.
 */
export type GrammarDialect = "abnf" | "bnf" | "ebnf" | "rbnf";

/**
 * Registration and syntax metadata for one grammar dialect.
 */
export interface GrammarDialectDescriptor {
  id: GrammarDialect;
  displayName: string;
  standardName: string;
  standardUrl: string;
  extensions: readonly string[];
  scopeName: string;
  markdownScopeName: string;
  markdownFence: string;
  assignmentOperator: "=" | "::=";
  /**
   * Whether `Name` and `name` are different rule names. ABNF names are
   * case-insensitive (RFC 5234); W3C EBNF, BNF, and RBNF names are not.
   */
  caseSensitiveNames: boolean;
}

/**
 * Ordered dialect list used for registration and package metadata.
 */
export const GRAMMAR_DIALECTS = [
  {
    id: "abnf",
    displayName: "ABNF",
    standardName: "RFC 5234 ABNF + RFC 7405 strings",
    standardUrl: "https://www.rfc-editor.org/rfc/rfc5234",
    extensions: [".abnf"],
    scopeName: "source.abnf",
    markdownScopeName: "text.html.markdown.abnf.codeblock",
    markdownFence: "abnf",
    assignmentOperator: "=",
    caseSensitiveNames: false,
  },
  {
    id: "bnf",
    displayName: "BNF",
    standardName: "W3C BNF notation",
    standardUrl: "https://www.w3.org/Notation.html",
    extensions: [".bnf"],
    scopeName: "source.bnf",
    markdownScopeName: "text.html.markdown.bnf.codeblock",
    markdownFence: "bnf",
    assignmentOperator: "::=",
    caseSensitiveNames: true,
  },
  {
    id: "ebnf",
    displayName: "EBNF",
    standardName: "W3C XML 1.0 EBNF notation",
    standardUrl: "https://www.w3.org/TR/xml/#sec-notation",
    extensions: [".ebnf"],
    scopeName: "source.ebnf",
    markdownScopeName: "text.html.markdown.ebnf.codeblock",
    markdownFence: "ebnf",
    assignmentOperator: "::=",
    caseSensitiveNames: true,
  },
  {
    id: "rbnf",
    displayName: "RBNF",
    standardName: "RFC 5511 Routing BNF",
    standardUrl: "https://datatracker.ietf.org/doc/html/rfc5511",
    extensions: [".rbnf"],
    scopeName: "source.rbnf",
    markdownScopeName: "text.html.markdown.rbnf.codeblock",
    markdownFence: "rbnf",
    assignmentOperator: "::=",
    caseSensitiveNames: true,
  },
] as const satisfies readonly GrammarDialectDescriptor[];

/**
 * Language IDs registered by the extension.
 */
export const GRAMMAR_LANGUAGE_IDS = GRAMMAR_DIALECTS.map(
  (dialect) => dialect.id,
) as readonly GrammarDialect[];

/**
 * Returns descriptor metadata for a grammar dialect.
 */
export function getGrammarDialectDescriptor(
  dialect: GrammarDialect,
): GrammarDialectDescriptor {
  return (
    GRAMMAR_DIALECTS.find((entry) => entry.id === dialect) ??
    GRAMMAR_DIALECTS[0]
  );
}

/**
 * Resolves a VS Code language ID to a grammar dialect.
 */
export function grammarDialectFromLanguageId(
  languageId: string,
): GrammarDialect {
  return GRAMMAR_LANGUAGE_IDS.includes(languageId as GrammarDialect)
    ? (languageId as GrammarDialect)
    : "abnf";
}

/**
 * Infers a grammar dialect from a file path.
 */
export function grammarDialectFromPath(
  path: string,
): GrammarDialect | undefined {
  const lower = path.toLowerCase();
  return GRAMMAR_DIALECTS.find((dialect) =>
    dialect.extensions.some((extension) => lower.endsWith(extension)),
  )?.id;
}

/**
 * Checks whether a language ID belongs to a supported grammar dialect.
 */
export function isGrammarLanguage(languageId: string): boolean {
  return GRAMMAR_LANGUAGE_IDS.includes(languageId as GrammarDialect);
}

/**
 * Builds the VS Code document selector for all grammar dialects.
 */
export function languageIdsSelector(): Array<{ language: GrammarDialect }> {
  return GRAMMAR_DIALECTS.map(({ id }) => ({ language: id }));
}
