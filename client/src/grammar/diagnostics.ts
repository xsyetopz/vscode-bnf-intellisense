import {
  type ConfigurationScope,
  type Diagnostic,
  type DiagnosticCollection,
  DiagnosticSeverity,
  type TextDocument,
} from "vscode";
import { collectAbnfCaseHints } from "../abnf/case-hints.ts";
import { CORE_RULE_DEFINITIONS, CORE_RULE_NAMES } from "../abnf/core-rules.ts";
import { AbnfDiagnosticCode } from "../abnf/diagnostic-codes.ts";
import { appendAll } from "../append-all.ts";
import {
  type AnalysisSettings,
  analyzeGrammar,
  DEFAULT_ANALYSIS_SETTINGS,
  type SeverityName,
} from "./analysis.ts";
import { readGrammarConfig } from "./config.ts";
import { GrammarDiagnosticCode } from "./diagnostic-codes.ts";
import {
  type GrammarDialect,
  getGrammarDialectDescriptor,
  isGrammarLanguage,
  normalizeSymbolName,
} from "./grammar.ts";
import {
  recordSuggestion,
  rememberDocumentSuggestions,
} from "./suggestion-store.ts";
import { NameSuggester } from "./suggestions.ts";
import { externallyReferencedKeys } from "./symbol-table.ts";
import type { GrammarWorkspace } from "./workspace.ts";

const DEFAULT_DIAGNOSTIC_SOURCE = "bnf";

type ManagerResult = ReturnType<GrammarWorkspace["get"]>;

function isBuiltinReference(name: string, dialect: GrammarDialect): boolean {
  return dialect === "abnf" && CORE_RULE_NAMES.has(name.toLowerCase());
}

/**
 * Names a reference to an undefined rule may be corrected to: every rule of
 * the file, plus the canonical ABNF core rules.
 */
export function suggestionCandidates(
  symbolTable: ManagerResult["symbolTable"],
  dialect: GrammarDialect,
): string[] {
  const names = [...symbolTable.definitions.values()].flatMap(
    (rules) => rules[0]?.name ?? [],
  );
  return dialect === "abnf"
    ? names.concat(CORE_RULE_DEFINITIONS.map((rule) => rule.name))
    : names;
}

function checkUndefinedReferences(
  result: ManagerResult,
  didYouMean: boolean,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const suggestions = new Map<string, string>();
  let suggester: NameSuggester | undefined;
  for (const rule of result.document.rules) {
    for (const ref of rule.references) {
      const key = normalizeSymbolName(ref.name, result.dialect);
      if (
        result.symbolTable.definitions.has(key) ||
        isBuiltinReference(ref.name, result.dialect)
      ) {
        continue;
      }
      let message = `Rule reference "${ref.name}" has no definition in this file`;
      if (didYouMean) {
        let suggestion = suggestions.get(ref.name);
        if (suggestion === undefined) {
          suggester ??= new NameSuggester(
            suggestionCandidates(result.symbolTable, result.dialect),
          );
          suggestion = suggester.suggest(ref.name)?.name ?? "";
          suggestions.set(ref.name, suggestion);
        }
        if (suggestion) {
          message += `. Did you mean "${suggestion}"?`;
        }
      }
      const diagnostic: Diagnostic = {
        message,
        range: ref.range,
        severity: DiagnosticSeverity.Error,
        source: result.dialect,
        code: GrammarDiagnosticCode.UndefinedReference,
      };
      recordSuggestion(diagnostic, ref.name, suggestions.get(ref.name) ?? "");
      diagnostics.push(diagnostic);
    }
  }
  return diagnostics;
}

function checkUnusedRules(result: ManagerResult): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const firstRuleKey = result.document.rules[0]
    ? normalizeSymbolName(result.document.rules[0].name, result.dialect)
    : undefined;
  // A rule that only refers to itself, or to a core name it redefines, is
  // still unused.
  const used = externallyReferencedKeys(result.document, result.dialect);

  for (const [name, rules] of result.symbolTable.definitions) {
    if (name === firstRuleKey || used.has(name)) {
      continue;
    }
    for (const rule of rules) {
      diagnostics.push({
        message: `Rule "${rule.name}" is not referenced by another rule`,
        range: rule.nameRange,
        severity: DiagnosticSeverity.Hint,
        source: result.dialect,
        code: GrammarDiagnosticCode.UnusedRule,
      });
    }
  }
  return diagnostics;
}

function checkDuplicateDefinitions(result: ManagerResult): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const isAbnf = result.dialect === "abnf";
  const operator = getGrammarDialectDescriptor(
    result.dialect,
  ).assignmentOperator;
  for (const rules of result.symbolTable.definitions.values()) {
    const base = rules.filter((rule) => !rule.isIncremental);
    if (base.length > 1) {
      for (const rule of base) {
        diagnostics.push({
          message: `Rule "${rule.name}" has more than one definition`,
          range: rule.nameRange,
          severity: DiagnosticSeverity.Error,
          source: result.dialect,
          code: isAbnf
            ? AbnfDiagnosticCode.DuplicateDefinition
            : GrammarDiagnosticCode.DuplicateDefinition,
        });
      }
    }
    // Incremental alternatives ("=/") need an earlier "=" definition.
    let seenBase = false;
    for (const rule of rules) {
      if (!rule.isIncremental) {
        seenBase = true;
      } else if (!seenBase) {
        diagnostics.push({
          message: `Rule "${rule.name}" is extended with "=/" before any "${operator}" definition`,
          range: rule.nameRange,
          severity: DiagnosticSeverity.Warning,
          source: result.dialect,
          code: isAbnf
            ? AbnfDiagnosticCode.IncrementalWithoutBase
            : GrammarDiagnosticCode.IncrementalWithoutBase,
        });
      }
    }
  }
  return diagnostics;
}

/**
 * Options for one diagnostics run. Omitted values fall back to the defaults
 * of the matching `bnf.diagnostics.*` setting.
 */
export interface GrammarDiagnosticOptions extends Partial<AnalysisSettings> {
  undefinedReferences?: boolean;
  unusedRules?: boolean;
  didYouMean?: boolean;
  caseSensitiveStrings?: boolean;
}

/**
 * Collects syntax, symbol, and structural diagnostics for one grammar
 * document.
 */
export function collectGrammarDiagnostics(
  result: ManagerResult,
  text: string,
  options: GrammarDiagnosticOptions = {},
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [...result.document.diagnostics];
  if (options.undefinedReferences ?? true) {
    appendAll(
      diagnostics,
      checkUndefinedReferences(result, options.didYouMean ?? true),
    );
  }
  const unusedRules = options.unusedRules ?? true;
  if (unusedRules) {
    appendAll(diagnostics, checkUnusedRules(result));
  }
  appendAll(diagnostics, checkDuplicateDefinitions(result));
  appendAll(
    diagnostics,
    analyzeGrammar(result, text, {
      ...DEFAULT_ANALYSIS_SETTINGS,
      ...definedOnly(options),
      unusedRules,
    }),
  );
  if (result.dialect === "abnf" && options.caseSensitiveStrings) {
    appendAll(diagnostics, collectAbnfCaseHints(text));
  }
  for (const diagnostic of diagnostics) {
    diagnostic.source ??= DEFAULT_DIAGNOSTIC_SOURCE;
  }
  return diagnostics;
}

function definedOnly(
  options: GrammarDiagnosticOptions,
): Partial<AnalysisSettings> {
  const out: Partial<AnalysisSettings> = {};
  for (const key of [
    "leftRecursion",
    "unproductiveRules",
    "unreachableRules",
    "duplicateAlternatives",
    "emptyAlternatives",
  ] as const) {
    const value = options[key];
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

const SEVERITY_KEYS = [
  "leftRecursion",
  "unproductiveRules",
  "unreachableRules",
  "duplicateAlternatives",
  "emptyAlternatives",
] as const;

/**
 * Reads the `bnf.diagnostics.*` settings that apply to one document, so
 * language-specific overrides such as `"[abnf]"` take effect.
 */
export function readDiagnosticOptions(
  scope: ConfigurationScope,
): GrammarDiagnosticOptions & { enable: boolean } {
  const read = <T>(key: string, fallback: T): T =>
    readGrammarConfig<T>(`diagnostics.${key}`, fallback, scope);
  const options: GrammarDiagnosticOptions & { enable: boolean } = {
    enable: read("enable", true),
    undefinedReferences: read("undefinedReferences", true),
    unusedRules: read("unusedRules", true),
    didYouMean: read("didYouMean", true),
    caseSensitiveStrings: read("caseSensitiveStrings", false),
  };
  for (const key of SEVERITY_KEYS) {
    options[key] = read<SeverityName>(key, DEFAULT_ANALYSIS_SETTINGS[key]);
  }
  return options;
}

/**
 * Refreshes the VS Code diagnostics collection for a document.
 */
export function updateGrammarDiagnostics(
  doc: TextDocument,
  workspace: GrammarWorkspace,
  collection: DiagnosticCollection,
): void {
  const result = workspace.get(doc);
  const { enable, ...options } = readDiagnosticOptions({
    uri: doc.uri,
    languageId: doc.languageId,
  });
  if (!enable) {
    collection.set(doc.uri, []);
    return;
  }
  const found = collectGrammarDiagnostics(result, doc.getText(), options);
  rememberDocumentSuggestions(doc.uri.toString(), found);
  collection.set(doc.uri, found);
}

/**
 * Re-runs diagnostics for every given grammar document, for example after a
 * `bnf.*` setting changed.
 */
export function refreshGrammarDiagnostics(
  documents: readonly TextDocument[],
  workspace: GrammarWorkspace,
  collection: DiagnosticCollection,
): void {
  for (const doc of documents) {
    if (isGrammarLanguage(doc.languageId)) {
      updateGrammarDiagnostics(doc, workspace, collection);
    }
  }
}
