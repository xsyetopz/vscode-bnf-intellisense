import { type Diagnostic, DiagnosticSeverity } from "vscode";
import { CORE_RULE_DEFINITIONS } from "../abnf/core-rules.ts";
import { parseAbnf } from "../abnf/parser.ts";
import type { GrammarDocument, Rule, SymbolTable } from "../types.ts";
import { GrammarDiagnosticCode } from "./diagnostic-codes.ts";
import type { GrammarDialect } from "./dialects.ts";
import {
  type AltBranch,
  abnfBodyTokens,
  abnfRuleBody,
  type BodyToken,
  type Expr,
  findAltGroups,
  parseProductionBody,
  productionBodyTokens,
  type RuleBody,
} from "./expression.ts";
import { scanProductionGrammar } from "./scanner.ts";
import {
  externallyReferencedKeys,
  normalizeSymbolName,
} from "./symbol-table.ts";

/**
 * Severity choice for an analysis diagnostic; "off" disables it.
 */
export type SeverityName = "off" | "hint" | "information" | "warning" | "error";

/**
 * Settings that control the analysis diagnostics.
 */
export interface AnalysisSettings {
  leftRecursion: SeverityName;
  unproductiveRules: SeverityName;
  unreachableRules: SeverityName;
  duplicateAlternatives: SeverityName;
  emptyAlternatives: SeverityName;
  /**
   * Whether the unused-rule hint is on. Unreachable-rule findings skip rules
   * that the hint already covers.
   */
  unusedRules: boolean;
}

export const DEFAULT_ANALYSIS_SETTINGS: AnalysisSettings = {
  leftRecursion: "hint",
  unproductiveRules: "warning",
  unreachableRules: "information",
  duplicateAlternatives: "warning",
  emptyAlternatives: "hint",
  unusedRules: true,
};

const SEVERITIES: Record<Exclude<SeverityName, "off">, DiagnosticSeverity> = {
  hint: DiagnosticSeverity.Hint,
  information: DiagnosticSeverity.Information,
  warning: DiagnosticSeverity.Warning,
  error: DiagnosticSeverity.Error,
};

/**
 * Parsed grammar plus its symbol table, as produced by the workspace.
 */
export interface AnalysisInput {
  dialect: GrammarDialect;
  document: GrammarDocument;
  symbolTable: SymbolTable;
}

interface RuleInfo {
  rule: Rule;
  key: string;
  body: RuleBody;
  tokens: BodyToken[] | undefined;
}

function buildInfos(
  input: AnalysisInput,
  text: string,
): RuleInfo[] | undefined {
  const { dialect, document } = input;
  const rules = document.rules;
  if (dialect === "abnf") {
    const bodies = abnfBodyTokens(
      text,
      rules.map((rule) => rule.nameRange.start.line),
    );
    return rules.map((rule, index) => ({
      rule,
      key: normalizeSymbolName(rule.name, dialect),
      body: abnfRuleBody(rule),
      tokens: bodies[index],
    }));
  }
  const scan = scanProductionGrammar(text, dialect);
  if (scan.productions.length !== rules.length) {
    return undefined;
  }
  return rules.map((rule, index) => {
    const bodyTokens = scan.productions[index]?.bodyTokens ?? [];
    return {
      rule,
      key: normalizeSymbolName(rule.name, dialect),
      body: parseProductionBody(bodyTokens, dialect),
      tokens: productionBodyTokens(bodyTokens),
    };
  });
}

function collectRefs(expr: Expr, out: Set<string>): void {
  switch (expr.kind) {
    case "ref":
      out.add(expr.key);
      break;
    case "seq":
      for (const item of expr.items) {
        collectRefs(item, out);
      }
      break;
    case "alt":
      for (const branch of expr.branches) {
        collectRefs(branch, out);
      }
      break;
    case "repeat":
      collectRefs(expr.item, out);
      break;
    default:
  }
}

type Truth = (key: string) => boolean;

/**
 * Least fixpoint of monotone boolean rule equations, using a worklist so a
 * rule is only re-evaluated when something it references became true.
 */
function solve(
  defs: ReadonlyMap<string, Expr[]>,
  evaluate: (expr: Expr, truth: Truth) => boolean,
  unknown: boolean,
): Set<string> {
  const dependents = new Map<string, string[]>();
  for (const [key, exprs] of defs) {
    const refs = new Set<string>();
    for (const expr of exprs) {
      collectRefs(expr, refs);
    }
    for (const ref of refs) {
      const list = dependents.get(ref);
      if (list) {
        list.push(key);
      } else {
        dependents.set(ref, [key]);
      }
    }
  }
  const truth = new Set<string>();
  const truthOf: Truth = (key) => (defs.has(key) ? truth.has(key) : unknown);
  const queue = [...defs.keys()];
  const queued = new Set(queue);
  while (queue.length > 0) {
    const key = queue.pop() as string;
    queued.delete(key);
    if (truth.has(key)) {
      continue;
    }
    if ((defs.get(key) ?? []).some((expr) => evaluate(expr, truthOf))) {
      truth.add(key);
      for (const dependent of dependents.get(key) ?? []) {
        if (!(truth.has(dependent) || queued.has(dependent))) {
          queued.add(dependent);
          queue.push(dependent);
        }
      }
    }
  }
  return truth;
}

function isNullable(expr: Expr, truth: Truth): boolean {
  switch (expr.kind) {
    case "empty":
      return true;
    case "term":
      return false;
    case "ref":
      return truth(expr.key);
    case "seq":
      return expr.items.every((item) => isNullable(item, truth));
    case "alt":
      return expr.branches.some((branch) => isNullable(branch, truth));
    case "repeat":
      return expr.min === 0 || isNullable(expr.item, truth);
    default:
      return false;
  }
}

function isProductive(expr: Expr, truth: Truth): boolean {
  switch (expr.kind) {
    case "ref":
      return truth(expr.key);
    case "seq":
      return expr.items.every((item) => isProductive(item, truth));
    case "alt":
      return expr.branches.some((branch) => isProductive(branch, truth));
    case "repeat":
      return expr.min === 0 || isProductive(expr.item, truth);
    default:
      return true;
  }
}

/**
 * Collects rules that can be reached without consuming input and returns
 * whether `expr` can match the empty string.
 */
function leftRefs(expr: Expr, nullable: Truth, out: Set<string>): boolean {
  switch (expr.kind) {
    case "empty":
      return true;
    case "term":
      return false;
    case "ref":
      out.add(expr.key);
      return nullable(expr.key);
    case "seq":
      for (const item of expr.items) {
        if (!leftRefs(item, nullable, out)) {
          return false;
        }
      }
      return true;
    case "alt": {
      let any = false;
      for (const branch of expr.branches) {
        any = leftRefs(branch, nullable, out) || any;
      }
      return any;
    }
    case "repeat": {
      const inner = leftRefs(expr.item, nullable, out);
      return expr.min === 0 || inner;
    }
    default:
      return false;
  }
}

/**
 * Strongly connected components (Tarjan, iterative). Components come out in
 * reverse topological order.
 */
function stronglyConnected(edges: readonly number[][]): number[][] {
  const n = edges.length;
  const index = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const onStack = new Array<boolean>(n).fill(false);
  const stack: number[] = [];
  const components: number[][] = [];
  let counter = 0;
  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) {
      continue;
    }
    const work: Array<[number, number]> = [[root, 0]];
    index[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = true;
    while (work.length > 0) {
      const frame = work[work.length - 1] as [number, number];
      const node = frame[0];
      const next = edges[node]?.[frame[1]++];
      if (next !== undefined) {
        if (index[next] === -1) {
          index[next] = low[next] = counter++;
          stack.push(next);
          onStack[next] = true;
          work.push([next, 0]);
        } else if (onStack[next]) {
          low[node] = Math.min(low[node] as number, index[next] as number);
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        low[parent[0]] = Math.min(
          low[parent[0]] as number,
          low[node] as number,
        );
      }
      if (low[node] === index[node]) {
        const component: number[] = [];
        let member: number;
        do {
          member = stack.pop() as number;
          onStack[member] = false;
          component.push(member);
        } while (member !== node);
        components.push(component);
      }
    }
  }
  return components;
}

/** Edge visits all cycle-path searches of one run may spend together. */
const PATH_BUDGET = 200_000;

/**
 * Shortest edge path from `start` back to itself inside `members`, ignoring
 * self-loops. Undefined when the shared visit budget runs out.
 */
function cyclePath(
  start: number,
  members: ReadonlySet<number>,
  edges: readonly number[][],
  budget: { left: number },
): number[] | undefined {
  const parent = new Map<number, number>();
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head] as number;
    for (const next of edges[node] ?? []) {
      if (next === node || !members.has(next)) {
        continue;
      }
      if (budget.left-- <= 0) {
        return undefined;
      }
      if (next === start) {
        const chain = [node];
        for (let at = node; at !== start; ) {
          at = parent.get(at) as number;
          chain.push(at);
        }
        return [...chain.reverse(), start];
      }
      if (!parent.has(next)) {
        parent.set(next, node);
        queue.push(next);
      }
    }
  }
  return undefined;
}

let coreCache: Map<string, Expr> | undefined;

/**
 * Expressions of the RFC 5234 core rules, so `LWSP` and friends take part in
 * nullability when the file does not redefine them.
 */
function coreExpressions(): Map<string, Expr> {
  if (!coreCache) {
    const source = CORE_RULE_DEFINITIONS.map(
      (rule) => `${rule.name} = ${rule.definitionText}`,
    ).join("\n");
    coreCache = new Map(
      parseAbnf(source).rules.map((rule) => [
        rule.name.toLowerCase(),
        abnfRuleBody(rule).expr,
      ]),
    );
  }
  return coreCache;
}

class Reporter {
  readonly diagnostics: Diagnostic[] = [];
  readonly #dialect: GrammarDialect;

  constructor(dialect: GrammarDialect) {
    this.#dialect = dialect;
  }

  add(
    severity: SeverityName,
    code: string,
    message: string,
    range: Diagnostic["range"],
  ): void {
    if (severity === "off") {
      return;
    }
    this.diagnostics.push({
      message,
      range,
      severity: SEVERITIES[severity],
      source: this.#dialect,
      code,
    });
  }
}

interface KeyGroup {
  key: string;
  infos: RuleInfo[];
  first: RuleInfo;
}

function groupByKey(infos: readonly RuleInfo[]): Map<string, KeyGroup> {
  const groups = new Map<string, KeyGroup>();
  for (const info of infos) {
    const group = groups.get(info.key);
    if (group) {
      group.infos.push(info);
    } else {
      groups.set(info.key, { key: info.key, infos: [info], first: info });
    }
  }
  return groups;
}

function checkLeftRecursion(
  groups: ReadonlyMap<string, KeyGroup>,
  nullable: Truth,
  settings: AnalysisSettings,
  reporter: Reporter,
): void {
  const keys = [...groups.keys()];
  const indexOf = new Map(keys.map((key, i) => [key, i]));
  const edges = keys.map((key) => {
    const refs = new Set<string>();
    for (const info of groups.get(key)?.infos ?? []) {
      if (!info.body.broken) {
        leftRefs(info.body.expr, nullable, refs);
      }
    }
    return [...refs]
      .map((ref) => indexOf.get(ref))
      .filter((i): i is number => i !== undefined);
  });
  const nameOf = (i: number): string =>
    groups.get(keys[i] as string)?.first.rule.name ?? "";
  const budget = { left: PATH_BUDGET };
  for (const raw of stronglyConnected(edges)) {
    const component = raw.sort((a, b) => a - b);
    const members = new Set(component);
    for (const member of component) {
      const range = groups.get(keys[member] as string)?.first.rule.nameRange;
      if (!range) {
        continue;
      }
      const name = nameOf(member);
      if (edges[member]?.includes(member)) {
        reporter.add(
          settings.leftRecursion,
          GrammarDiagnosticCode.LeftRecursion,
          `Rule "${name}" is directly left-recursive: ${name} -> ${name}`,
          range,
        );
      } else if (component.length > 1) {
        const path = cyclePath(member, members, edges, budget);
        reporter.add(
          settings.leftRecursion,
          GrammarDiagnosticCode.LeftRecursion,
          path
            ? `Rule "${name}" is indirectly left-recursive: ${path.map(nameOf).join(" -> ")}`
            : `Rule "${name}" is indirectly left-recursive (part of a cycle of ${component.length} rules)`,
          range,
        );
      }
    }
  }
}

function checkUnproductive(
  groups: ReadonlyMap<string, KeyGroup>,
  settings: AnalysisSettings,
  reporter: Reporter,
): void {
  const defs = new Map<string, Expr[]>();
  for (const [key, group] of groups) {
    defs.set(
      key,
      group.infos.map((info) =>
        info.body.broken ? { kind: "term" as const } : info.body.expr,
      ),
    );
  }
  const productive = solve(defs, isProductive, true);
  for (const [key, group] of groups) {
    if (!productive.has(key)) {
      reporter.add(
        settings.unproductiveRules,
        GrammarDiagnosticCode.UnproductiveRule,
        `Rule "${group.first.rule.name}" can never derive a terminal string: every alternative depends on rules that never terminate`,
        group.first.rule.nameRange,
      );
    }
  }
}

function checkUnreachable(
  input: AnalysisInput,
  groups: ReadonlyMap<string, KeyGroup>,
  settings: AnalysisSettings,
  reporter: Reporter,
): void {
  const { document, dialect } = input;
  const startRule = document.rules[0];
  if (!startRule || groups.size < 2) {
    return;
  }
  // Rules nothing else references are entry points of their own (the unused
  // hint covers them). Only rules caught in reference cycles that no entry
  // point reaches are reported here, so the two diagnostics never overlap.
  const used = externallyReferencedKeys(document, dialect);
  const startKey = normalizeSymbolName(startRule.name, dialect);
  const visited = new Set<string>();
  const queue: string[] = [];
  for (const key of groups.keys()) {
    if (key === startKey || !used.has(key)) {
      visited.add(key);
      queue.push(key);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    for (const info of groups.get(queue[head] as string)?.infos ?? []) {
      for (const ref of info.rule.references) {
        const key = normalizeSymbolName(ref.name, dialect);
        if (groups.has(key) && !visited.has(key)) {
          visited.add(key);
          queue.push(key);
        }
      }
    }
  }
  for (const [key, group] of groups) {
    if (visited.has(key)) {
      continue;
    }
    for (const info of group.infos) {
      reporter.add(
        settings.unreachableRules,
        GrammarDiagnosticCode.UnreachableRule,
        `Rule "${info.rule.name}" is only referenced by rules that the start rule "${startRule.name}" and the other entry points cannot reach`,
        info.rule.nameRange,
      );
    }
  }
}

function isEmptyBranch(
  dialect: GrammarDialect,
  branch: { empty: boolean; key: string },
): boolean {
  return (
    branch.empty ||
    (dialect === "abnf" && (branch.key === '""' || branch.key === '%s""'))
  );
}

function optionalHint(dialect: GrammarDialect): string {
  return dialect === "ebnf" ? 'use "?" or "( ... )?"' : 'use "[ ... ]"';
}

function rangeKey(range: Diagnostic["range"]): string {
  return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}

function checkAlternatives(
  dialect: GrammarDialect,
  groups: ReadonlyMap<string, KeyGroup>,
  settings: AnalysisSettings,
  reporter: Reporter,
): void {
  for (const group of groups.values()) {
    // One set per rule name, so `=/` extensions are checked against the
    // alternatives of the base definition and of earlier extensions.
    const seenTop = new Set<string>();
    for (const info of group.infos) {
      if (!info.tokens || info.body.broken) {
        continue;
      }
      const { top, groups: nested } = findAltGroups(info.tokens);
      const reported = new Set<string>();
      const name = info.rule.name;
      const reportEmpty = (range: Diagnostic["range"]): void => {
        const key = rangeKey(range);
        if (!reported.has(key)) {
          reported.add(key);
          reporter.add(
            settings.emptyAlternatives,
            GrammarDiagnosticCode.EmptyAlternative,
            `Rule "${name}" has an empty alternative that matches nothing; ${optionalHint(dialect)} to make a part optional`,
            range,
          );
        }
      };
      const shared = info.rule.isIncremental || info === group.first;
      const seen = shared ? seenTop : new Set<string>();
      const duplicates: AltBranch[] = [];
      for (const branch of top) {
        if (isEmptyBranch(dialect, branch)) {
          if (top.length > 1) {
            reportEmpty(branch.range);
          }
        } else if (seen.has(branch.key)) {
          duplicates.push(branch);
        } else {
          seen.add(branch.key);
        }
      }
      if (
        info.rule.isIncremental &&
        duplicates.length > 0 &&
        duplicates.length === top.length
      ) {
        reporter.add(
          settings.duplicateAlternatives,
          GrammarDiagnosticCode.DuplicateExtension,
          `Rule "${name}" extends an earlier definition with alternatives it already has`,
          info.rule.definitionRange,
        );
      } else {
        for (const branch of duplicates) {
          reporter.add(
            settings.duplicateAlternatives,
            GrammarDiagnosticCode.DuplicateAlternative,
            `Rule "${name}" repeats an alternative`,
            branch.range,
          );
        }
      }
      for (const choice of nested) {
        const local = new Set<string>();
        for (const branch of choice) {
          if (isEmptyBranch(dialect, branch)) {
            reportEmpty(branch.range);
          } else if (local.has(branch.key)) {
            reporter.add(
              settings.duplicateAlternatives,
              GrammarDiagnosticCode.DuplicateAlternative,
              `Rule "${name}" repeats an alternative`,
              branch.range,
            );
          } else {
            local.add(branch.key);
          }
        }
      }
    }
  }
}

/**
 * Runs the structural analyses: left recursion, non-terminating rules,
 * rules unreachable from the start rule, duplicate alternatives, and empty
 * alternatives. All graph passes are linear in grammar size.
 */
export function analyzeGrammar(
  input: AnalysisInput,
  text: string,
  settings: AnalysisSettings = DEFAULT_ANALYSIS_SETTINGS,
): Diagnostic[] {
  const reporter = new Reporter(input.dialect);
  const infos = buildInfos(input, text);
  if (!infos) {
    return reporter.diagnostics;
  }
  const groups = groupByKey(infos);
  if (settings.leftRecursion !== "off") {
    const defs = new Map<string, Expr[]>();
    for (const [key, group] of groups) {
      defs.set(
        key,
        group.infos.map((info) =>
          info.body.broken ? { kind: "term" as const } : info.body.expr,
        ),
      );
    }
    if (input.dialect === "abnf") {
      for (const [key, expr] of coreExpressions()) {
        if (!defs.has(key)) {
          defs.set(key, [expr]);
        }
      }
    }
    const nullable = solve(defs, isNullable, false);
    checkLeftRecursion(groups, (key) => nullable.has(key), settings, reporter);
  }
  if (settings.unproductiveRules !== "off") {
    checkUnproductive(groups, settings, reporter);
  }
  if (settings.unreachableRules !== "off") {
    checkUnreachable(input, groups, settings, reporter);
  }
  if (
    settings.duplicateAlternatives !== "off" ||
    settings.emptyAlternatives !== "off"
  ) {
    checkAlternatives(input.dialect, groups, settings, reporter);
  }
  return reporter.diagnostics;
}
