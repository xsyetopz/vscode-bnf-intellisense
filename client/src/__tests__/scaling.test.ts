import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { GrammarDialect } from "../grammar/dialects.ts";
import {
  asTextDocument,
  createDocument,
  loadGrammarTestCore,
} from "./grammar/provider-test-utils.ts";
import { growthForFourfoldInput, MAX_LINEAR_GROWTH } from "./scaling.ts";
import {
  resetConfigurationValues,
  setConfigurationValue,
} from "./vscode-mock.ts";

const FIXED_COST_MS = 10;

function spin(milliseconds: number): void {
  const until = performance.now() + milliseconds;
  while (performance.now() < until) {
    // busy wait: the cost must be CPU time, not a timer sleep
  }
}

describe("growthForFourfoldInput", () => {
  test("linear work next to a large fixed cost stays under the bound", () => {
    const growth = growthForFourfoldInput(
      (size) => () => spin(FIXED_COST_MS + size * 0.005),
      1000,
    );

    expect(growth).toBeLessThan(MAX_LINEAR_GROWTH);
  });

  test("quadratic work is caught even beside a large fixed cost", () => {
    const growth = growthForFourfoldInput(
      (size) => () => spin(FIXED_COST_MS + size * size * 0.000_005),
      1000,
    );

    expect(growth).toBeGreaterThan(MAX_LINEAR_GROWTH);
  });

  test("a baseline that never rises above the floor is an error", () => {
    const run = () => growthForFourfoldInput(() => () => undefined, 10);

    expect(run).toThrow("floor");
  });
});

describe("semantic tokens growth", () => {
  let GrammarWorkspace: typeof import("../grammar/workspace.ts").GrammarWorkspace;
  let GrammarSemanticTokensProvider: typeof import("../grammar/semantic-tokens.ts").GrammarSemanticTokensProvider;

  beforeAll(async () => {
    await loadGrammarTestCore();
    ({ GrammarWorkspace } = await import("../grammar/workspace.ts"));
    ({ GrammarSemanticTokensProvider } = await import(
      "../grammar/semantic-tokens.ts"
    ));
  });

  afterEach(() => {
    resetConfigurationValues();
  });

  const GRAMMARS: Record<GrammarDialect, (index: number) => string> = {
    abnf: (i) =>
      `rule${i} = "x" rule${i + 1} / "y" *( "a" / rule${i + 2} ) ; c`,
    ebnf: (i) => `rule${i} ::= "x" rule${i + 1} | "y" ( "a" | rule${i + 2} )*`,
    bnf: (i) => `<rule${i}> ::= "x" <rule${i + 1}> | "y" <rule${i + 2}>`,
    rbnf: (i) => `<rule${i}> ::= "x" <rule${i + 1}> [ <rule${i + 2}> ] ...`,
  };

  for (const dialect of ["abnf", "ebnf", "bnf", "rbnf"] as const) {
    for (const mode of ["on", "auto"] as const) {
      test(`${dialect} tokens in ${mode} mode take near-linear time as rules grow`, () => {
        setConfigurationValue("bnf.semanticHighlighting.mode", mode);

        const growth = growthForFourfoldInput((count) => {
          const text = Array.from({ length: count }, (_, i) =>
            GRAMMARS[dialect](i),
          ).join("\n");
          let version = 0;
          return () => {
            // A distinct text per run, so no cache can answer for the run.
            const run = ++version;
            const mock = createDocument(
              `/w/g.${dialect}`,
              `${text}\n${GRAMMARS[dialect](count + run)}`,
              dialect,
            );
            mock.version = run;
            const doc = asTextDocument(mock);
            new GrammarSemanticTokensProvider(
              new GrammarWorkspace(),
            ).provideDocumentSemanticTokens(doc, {} as never);
          };
        }, 250);

        expect(growth).toBeLessThan(MAX_LINEAR_GROWTH);
      });
    }
  }
});
