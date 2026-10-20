/**
 * Scaling benchmark for the grammar pipeline. Run with `bun run bench`.
 *
 * Environment:
 * - `BENCH_SIZES`: comma separated rule counts (default `500,2000`)
 * - `BENCH_DIALECTS`: comma separated dialects (default all four)
 * - `BENCH_RUNS`: timed runs per stage, the best is reported (default 3)
 * - `BENCH_LENS_FILES`: other indexed files while resolving lenses (default 20)
 */
import {
  asTextDocument,
  createDocument,
} from "../__tests__/grammar/provider-test-utils.ts";
import { setConfigurationValue } from "../__tests__/vscode-mock/config.ts";
import { collectGrammarDiagnostics } from "../grammar/diagnostics.ts";
import type { GrammarDialect } from "../grammar/dialects.ts";
import { GrammarFormattingProvider } from "../grammar/formatting-provider.ts";
import { buildGrammarSymbolTable, parseGrammar } from "../grammar/grammar.ts";
import { GrammarCodeLensProvider } from "../grammar/providers/code-lens.ts";
import { GrammarSemanticTokensProvider } from "../grammar/semantic-tokens.ts";
import { GrammarWorkspace } from "../grammar/workspace.ts";

const DIALECTS: readonly GrammarDialect[] = ["abnf", "bnf", "ebnf", "rbnf"];
const STAGES = [
  "parse",
  "diagnostics",
  "semanticTokens",
  "format",
  "codeLens",
] as const;
type Stage = (typeof STAGES)[number];

const CANCELLATION = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
} as never;

function numbers(name: string, fallback: string): number[] {
  return (process.env[name] ?? fallback)
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function ruleName(dialect: GrammarDialect, index: number): string {
  switch (dialect) {
    case "rbnf":
      return `<rule ${index}>`;
    case "bnf":
      return `<rule${index}>`;
    default:
      return `rule${index}`;
  }
}

/**
 * Generates a grammar with about four references per rule, a comment every
 * tenth rule, and a misspelled reference every 25th rule.
 */
function generate(dialect: GrammarDialect, rules: number, salt = ""): string {
  const operator = dialect === "abnf" ? "=" : "::=";
  const bar = dialect === "abnf" ? "/" : "|";
  const comment = dialect === "ebnf" ? "/* c */" : "; c";
  const lines: string[] = [];
  const ref = (index: number) =>
    index < rules ? ruleName(dialect, index) : `"t${index}"`;
  for (let i = 0; i < rules; i++) {
    const typo =
      i % 25 === 0
        ? ` ${ruleName(dialect, i + 2).replace("rule", "rulx")}${salt}`
        : "";
    let repeat = '"a"';
    if (dialect === "abnf") {
      repeat = `*( "a" ${bar} ${ref(i + 3)} )`;
    } else if (dialect === "ebnf") {
      repeat = `( "a" ${bar} ${ref(i + 3)} )*`;
    }
    const id = dialect === "ebnf" ? `[${i + 1}] ` : "";
    lines.push(
      `${id}${ruleName(dialect, i)} ${operator} "x${i}" ${ref(i + 1)} ${bar} "y" ${ref(i + 2)} ${repeat}${typo} ${bar} "z"`,
    );
    if (i % 10 === 0) {
      lines.push(comment);
    }
  }
  return `${lines.join("\n")}\n`;
}

function best(run: () => void, runs: number): number {
  run();
  let fastest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    run();
    fastest = Math.min(fastest, performance.now() - start);
  }
  return fastest;
}

function measure(
  dialect: GrammarDialect,
  rules: number,
  runs: number,
  lensFiles: number,
): Record<Stage, number> {
  const text = generate(dialect, rules);
  const doc = asTextDocument(
    createDocument(`/bench/main.${dialect}`, text, dialect),
  );
  const workspace = new GrammarWorkspace();
  const parsed = workspace.get(doc);
  const others = Array.from({ length: lensFiles }, (_, index) => {
    const grammar = parseGrammar(
      generate(dialect, rules, `o${index}`),
      dialect,
    );
    return {
      uri: {
        path: `/bench/o${index}.${dialect}`,
        toString: () => `file:///bench/o${index}.${dialect}`,
      },
      dialect,
      rules: grammar.rules,
      symbolTable: buildGrammarSymbolTable(grammar, dialect),
    };
  });
  const formatter = new GrammarFormattingProvider();
  let tokenRun = 0;
  const result: Record<Stage, number> = {
    parse: best(() => {
      buildGrammarSymbolTable(parseGrammar(text, dialect), dialect);
    }, runs),
    diagnostics: best(() => {
      collectGrammarDiagnostics(parsed, text, {});
    }, runs),
    semanticTokens: best(() => {
      // Each run sees a distinct text in a fresh workspace and provider, so
      // parsing and tokenizing are measured too, not answered from caches.
      tokenRun++;
      const fresh = asTextDocument(
        createDocument(
          `/bench/main.${dialect}`,
          `${text}\n${generate(dialect, 1, `run${tokenRun}`)}`,
          dialect,
        ),
      );
      new GrammarSemanticTokensProvider(
        new GrammarWorkspace(),
      ).provideDocumentSemanticTokens(fresh, CANCELLATION);
    }, runs),
    format: best(() => {
      formatter.provideDocumentFormattingEdits(
        doc,
        { tabSize: 2, insertSpaces: true } as never,
        CANCELLATION,
      );
    }, runs),
    codeLens: 0,
  };
  // Lenses count references across the other indexed files.
  Object.assign(workspace, { getAllFiles: () => others });
  const lenses = new GrammarCodeLensProvider(workspace, 1e9);
  result.codeLens = best(() => {
    for (const lens of lenses.provideCodeLenses(doc)) {
      lenses.resolveCodeLens(lens);
    }
  }, 1);
  lenses.dispose();
  workspace.dispose();
  return result;
}

function cell(value: string, width: number): string {
  return value.padStart(width);
}

function main(): void {
  setConfigurationValue("bnf.semanticHighlighting.mode", "on");
  const sizes = numbers("BENCH_SIZES", "500,2000");
  const runs = numbers("BENCH_RUNS", "3")[0] ?? 3;
  const lensFiles = numbers("BENCH_LENS_FILES", "20")[0] ?? 20;
  const requested = (process.env["BENCH_DIALECTS"] ?? DIALECTS.join(","))
    .split(",")
    .map((value) => value.trim());
  const dialects = DIALECTS.filter((dialect) => requested.includes(dialect));

  const header = ["dialect", "rules", ...STAGES];
  const lines = [header.map((name, i) => cell(name, i < 2 ? 8 : 15)).join(" ")];
  for (const dialect of dialects) {
    let previous: { rules: number; times: Record<Stage, number> } | undefined;
    for (const rules of sizes) {
      const times = measure(dialect, rules, runs, lensFiles);
      lines.push(
        [
          cell(dialect, 8),
          cell(String(rules), 8),
          ...STAGES.map((stage) => cell(`${times[stage].toFixed(1)} ms`, 15)),
        ].join(" "),
      );
      if (previous) {
        const base = previous.times;
        const size = (rules / previous.rules).toFixed(1);
        lines.push(
          [
            cell("", 8),
            cell(`x${size}`, 8),
            ...STAGES.map((stage) =>
              cell(`${(times[stage] / base[stage]).toFixed(1)}x`, 15),
            ),
          ].join(" "),
        );
      }
      previous = { rules, times };
    }
  }
  console.log(lines.join("\n"));
}

main();
