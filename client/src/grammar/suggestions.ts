const ANGLE_WRAP_RE = /^<(.*)>$/s;

/**
 * Removes one pair of enclosing angle brackets so `<name>` and `name` compare
 * equal.
 */
export function bareName(name: string): string {
  const match = ANGLE_WRAP_RE.exec(name);
  return match ? (match[1] ?? name) : name;
}

/**
 * Optimal-string-alignment edit distance (insert, delete, substitute,
 * adjacent swap) with an early exit once every cell exceeds `limit`.
 * Returns `limit + 1` when the distance is larger than `limit`.
 */
export function boundedEditDistance(
  a: string,
  b: string,
  limit: number,
): number {
  if (Math.abs(a.length - b.length) > limit) {
    return limit + 1;
  }
  let twoAgo: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row: number[] = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        (previous[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, (twoAgo[j - 2] ?? 0) + 1);
      }
      row[j] = value;
      best = Math.min(best, value);
    }
    if (best > limit) {
      return limit + 1;
    }
    twoAgo = previous;
    previous = row;
  }
  return Math.min(previous[b.length] ?? limit + 1, limit + 1);
}

function allowedDistance(length: number): number {
  if (length < 3) {
    return 0;
  }
  return length < 6 ? 1 : 2;
}

/**
 * Suggestion for an undefined rule name.
 */
export interface NameSuggestion {
  /** Candidate spelled exactly as defined. */
  name: string;
  /** True when the candidate differs only by letter case or `<>` wrapping. */
  caseOrShapeOnly: boolean;
}

interface Candidate {
  name: string;
  lower: string;
  order: number;
}

/** Edit-distance comparisons one suggester may spend before it gives up. */
const DEFAULT_BUDGET = 40_000;

/**
 * Finds the defined name closest to an undefined one. Case and bracket
 * mismatches are found through a hash lookup; typos are searched only among
 * candidates whose length is within the edit budget, and the total number of
 * comparisons is capped so many undefined names stay cheap.
 */
export class NameSuggester {
  readonly #exact = new Map<string, Candidate>();
  readonly #byLength = new Map<number, Candidate[]>();
  #budget: number;

  constructor(candidates: Iterable<string>, budget = DEFAULT_BUDGET) {
    this.#budget = budget;
    let order = 0;
    for (const name of candidates) {
      const lower = bareName(name).toLowerCase();
      const candidate = { name, lower, order: order++ };
      if (!this.#exact.has(lower)) {
        this.#exact.set(lower, candidate);
      }
      const bucket = this.#byLength.get(lower.length);
      if (bucket) {
        bucket.push(candidate);
      } else {
        this.#byLength.set(lower.length, [candidate]);
      }
    }
  }

  suggest(target: string): NameSuggestion | undefined {
    const lower = bareName(target).toLowerCase();
    const exact = this.#exact.get(lower);
    if (exact && exact.name !== target) {
      return { name: exact.name, caseOrShapeOnly: true };
    }
    const limit = allowedDistance(lower.length);
    let best: Candidate | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (
      let length = lower.length - limit;
      limit > 0 && length <= lower.length + limit;
      length++
    ) {
      for (const candidate of this.#byLength.get(length) ?? []) {
        if (this.#budget-- <= 0) {
          return best ? { name: best.name, caseOrShapeOnly: false } : undefined;
        }
        if (candidate.name === target || candidate.lower === lower) {
          continue;
        }
        const distance = boundedEditDistance(lower, candidate.lower, limit);
        if (
          distance <= limit &&
          (distance < bestDistance ||
            (distance === bestDistance &&
              best !== undefined &&
              candidate.order < best.order))
        ) {
          best = candidate;
          bestDistance = distance;
        }
      }
    }
    return best ? { name: best.name, caseOrShapeOnly: false } : undefined;
  }
}

/**
 * One-shot convenience wrapper around {@link NameSuggester}.
 */
export function suggestName(
  target: string,
  candidates: Iterable<string>,
): NameSuggestion | undefined {
  return new NameSuggester(candidates).suggest(target);
}
