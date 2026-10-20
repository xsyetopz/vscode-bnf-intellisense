import { buildAbnfSymbolTable } from "../abnf/parser.ts";
import type {
  GrammarDocument,
  IdentifierReference,
  Rule,
  SymbolTable,
} from "../types.ts";
import {
  type GrammarDialect,
  getGrammarDialectDescriptor,
} from "./dialects.ts";

/**
 * Normalizes rule names for dialect-specific lookup keys. ABNF names are
 * case-insensitive; W3C EBNF, BNF, and RBNF names are case-sensitive.
 */
export function normalizeSymbolName(
  name: string,
  dialect: GrammarDialect,
): string {
  return getGrammarDialectDescriptor(dialect).caseSensitiveNames
    ? name
    : name.toLowerCase();
}

/**
 * Collects the keys of rules that are referenced from a different rule.
 * A rule that only refers to itself is not counted as used.
 */
export function externallyReferencedKeys(
  doc: GrammarDocument,
  dialect: GrammarDialect,
): Set<string> {
  const keys = new Set<string>();
  for (const rule of doc.rules) {
    const own = normalizeSymbolName(rule.name, dialect);
    for (const ref of rule.references) {
      const key = normalizeSymbolName(ref.name, dialect);
      if (key !== own) {
        keys.add(key);
      }
    }
  }
  return keys;
}

function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) {
    list.push(value);
  } else {
    map.set(key, [value]);
  }
}

/**
 * Builds definition and reference indexes for any supported grammar dialect.
 */
export function buildGrammarSymbolTable(
  doc: GrammarDocument,
  dialect: GrammarDialect,
): SymbolTable {
  if (dialect === "abnf") {
    return buildAbnfSymbolTable(doc);
  }
  const definitions = new Map<string, Rule[]>();
  const references = new Map<string, IdentifierReference[]>();
  for (const rule of doc.rules) {
    const key = normalizeSymbolName(rule.name, dialect);
    pushTo(definitions, key, rule);
    for (const ref of rule.references) {
      pushTo(references, normalizeSymbolName(ref.name, dialect), ref);
    }
  }
  return { definitions, references };
}
