import { type Diagnostic, DiagnosticSeverity } from "vscode";
import { CORE_RULE_NAMES } from "../../abnf/core-rules.ts";
import { ruleExpressions } from "../../abnf/parser.ts";
import type { GrammarDocument, Rule } from "../../types.ts";
import type { GrammarDialect } from "../dialects.ts";
import { normalizeSymbolName } from "../symbol-table.ts";
import { buildAbnfBody, buildProductionBody } from "./build.ts";
import type { RefKind } from "./layout.ts";
import { choiceOf, EMPTY_NODE, type RailNode } from "./model.ts";

/**
 * One rule (all its `=/` parts merged) ready for layout.
 */
export interface RuleDiagram {
  /** Stable index within the document; used for the DOM id. */
  id: number;
  name: string;
  key: string;
  node: RailNode;
  /** Number of definitions merged (1 plus `=/` parts). */
  parts: number;
  /** Zero-based first and last source lines over all parts. */
  startLine: number;
  endLine: number;
  /** Zero-based first and last source line of each part, in source order. */
  spans: Array<readonly [number, number]>;
  comment?: string | undefined;
  /** Message when a part failed to parse completely. */
  error?: string | undefined;
  /** Message when a `=/` part has no earlier `=` definition. */
  warning?: string | undefined;
}

function lineSpan(rule: Rule): [number, number] {
  return [rule.definitionRange.start.line, rule.definitionRange.end.line];
}

function orphanWarning(name: string): string {
  return `Rule "${name}" is extended with "=/" before any base definition`;
}

function errorIn(
  diagnostics: readonly Diagnostic[],
  start: number,
  end: number,
): string | undefined {
  return diagnostics.find(
    (d) =>
      d.severity === DiagnosticSeverity.Error &&
      d.range.start.line >= start &&
      d.range.start.line <= end,
  )?.message;
}

function bodyOf(
  rule: Rule,
  dialect: GrammarDialect,
): { node: RailNode; broken: boolean } {
  return dialect === "abnf"
    ? buildAbnfBody(ruleExpressions.get(rule))
    : buildProductionBody(rule.definitionText, dialect);
}

/**
 * Builds one diagram per rule name. Incremental ABNF parts (`=/`) merge into
 * their base rule as one choice; production dialects keep each definition
 * separate. A part that failed to parse keeps what parsed and sets `error`.
 */
export function buildRuleDiagrams(
  document: GrammarDocument,
  dialect: GrammarDialect,
): RuleDiagram[] {
  const diagrams: RuleDiagram[] = [];
  const byKey = new Map<string, RuleDiagram>();
  const bodies = new Map<RuleDiagram, RailNode[]>();
  const unbased = new Set<RuleDiagram>();
  for (const rule of document.rules) {
    const key = normalizeSymbolName(rule.name, dialect);
    const found = byKey.get(key);
    const adoptsBase = !rule.isIncremental && found && unbased.has(found);
    const existing = rule.isIncremental || adoptsBase ? found : undefined;
    const body = bodyOf(rule, dialect);
    const [start, end] = lineSpan(rule);
    const error =
      errorIn(document.diagnostics, start, end) ??
      (body.broken ? "The rule body is incomplete or malformed" : undefined);
    if (existing) {
      const parts = bodies.get(existing);
      if (adoptsBase) {
        // The base definition names the rule and lists first, whereas the
        // spans stay in source order.
        parts?.unshift(body.node);
        existing.name = rule.name;
        existing.warning = orphanWarning(rule.name);
        existing.comment = rule.precedingComment ?? existing.comment;
        unbased.delete(existing);
      } else {
        parts?.push(body.node);
      }
      existing.spans.push([start, end]);
      existing.parts++;
      existing.startLine = Math.min(existing.startLine, start);
      existing.endLine = Math.max(existing.endLine, end);
      existing.error ??= error;
      continue;
    }
    const diagram: RuleDiagram = {
      id: diagrams.length,
      name: rule.name,
      key,
      node: EMPTY_NODE,
      parts: 1,
      startLine: start,
      endLine: end,
      spans: [[start, end]],
      comment: rule.precedingComment,
      error,
    };
    if (rule.isIncremental) {
      diagram.warning = orphanWarning(rule.name);
      unbased.add(diagram);
    }
    diagrams.push(diagram);
    bodies.set(diagram, [body.node]);
    if (dialect === "abnf" || !byKey.has(key)) {
      byKey.set(key, diagram);
    }
  }
  for (const diagram of diagrams) {
    const parts = bodies.get(diagram) ?? [];
    diagram.node =
      parts.length === 1 ? (parts[0] as RailNode) : choiceOf(parts);
  }
  return diagrams;
}

/**
 * Finds the diagram with a part whose source lines contain `line`.
 */
export function diagramAtLine(
  diagrams: readonly RuleDiagram[],
  line: number,
): RuleDiagram | undefined {
  return diagrams.find((d) =>
    d.spans.some(([start, end]) => line >= start && line <= end),
  );
}

/**
 * Builds the nonterminal classifier for one document.
 */
export function createRefResolver(
  diagrams: readonly RuleDiagram[],
  dialect: GrammarDialect,
  hasExternalDefinition: (name: string) => boolean,
): (name: string) => RefKind {
  const local = new Set(diagrams.map((d) => d.key));
  return (name) => {
    const key = normalizeSymbolName(name, dialect);
    if (local.has(key)) {
      return "local";
    }
    if (dialect === "abnf" && CORE_RULE_NAMES.has(key)) {
      return "core";
    }
    return hasExternalDefinition(name) ? "external" : "undefined";
  };
}
