const RUNS = 3;
const MIN_BASELINE_MS = 2;
const MAX_DOUBLINGS = 6;

/**
 * Best-of-N wall time of one call, in milliseconds.
 */
function bestTime(action: () => void): number {
  action(); // warm-up: JIT, caches, and lazy initialisation stay out of the timing
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < RUNS; run++) {
    const started = performance.now();
    action();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

/**
 * How much slower the action gets when the input grows fourfold. Linear work
 * gives about 4 and quadratic work about 16, independent of machine speed, so
 * tests compare it with a generous bound such as `MAX_LINEAR_GROWTH`.
 * `prepare(size)` builds the input outside the timed region and returns the
 * action to time.
 *
 * The cost of the action on empty input (`prepare(0)`) is subtracted from
 * every timing, so a fixed cost per call cannot hide growth. The starting
 * `size` doubles until the small run takes at least `MIN_BASELINE_MS` beyond
 * that fixed cost, so timer noise cannot hide growth either. When even
 * `MAX_DOUBLINGS` doublings leave the baseline under that floor, the ratio
 * would be dominated by timer noise, so this throws instead of guessing:
 * start the test with a larger `size`.
 */
export function growthForFourfoldInput(
  prepare: (size: number) => () => void,
  size: number,
): number {
  const fixed = bestTime(prepare(0));
  let baseSize = size;
  let small = bestTime(prepare(baseSize)) - fixed;
  for (
    let doubling = 0;
    doubling < MAX_DOUBLINGS && small < MIN_BASELINE_MS;
    doubling++
  ) {
    baseSize *= 2;
    small = bestTime(prepare(baseSize)) - fixed;
  }
  const large = bestTime(prepare(baseSize * 4)) - fixed;
  if (small < MIN_BASELINE_MS) {
    throw new Error(
      `Baseline of ${small.toFixed(3)} ms at size ${baseSize} (after subtracting ${fixed.toFixed(3)} ms for empty input) is under the ${MIN_BASELINE_MS} ms floor after ${MAX_DOUBLINGS} doublings; start with a larger size`,
    );
  }
  return large / small;
}

/**
 * Upper bound for linear-ish growth: between linear (4) and quadratic (16).
 */
export const MAX_LINEAR_GROWTH = 10;
