/**
 * Small most-recently-used cache for results derived from document text.
 * Several open documents alternate requests without evicting each other,
 * which a single remembered entry cannot do. Cached values must not be
 * mutated by callers. Entries are bounded by count and by total text length,
 * so a few huge documents cannot stay alive after they are closed.
 */
export class RecentCache<Value> {
  readonly #capacity: number;
  readonly #maxTextLength: number;
  readonly #entries: { scope: string; text: string; value: Value }[] = [];
  #textLength = 0;

  constructor(capacity: number, maxTextLength = RECENT_TEXT_BUDGET) {
    this.#capacity = capacity;
    this.#maxTextLength = maxTextLength;
  }

  /** Returns the cached value for `scope` and `text`, computing it on a miss. */
  get(scope: string, text: string, compute: () => Value): Value {
    const entries = this.#entries;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry && entry.text === text && entry.scope === scope) {
        if (i > 0) {
          entries.splice(i, 1);
          entries.unshift(entry);
        }
        return entry.value;
      }
    }
    const value = compute();
    entries.unshift({ scope, text, value });
    this.#textLength += text.length;
    // The newest entry always stays, even when it alone exceeds the budget.
    while (
      entries.length > 1 &&
      (entries.length > this.#capacity ||
        this.#textLength > this.#maxTextLength)
    ) {
      const evicted = entries.pop();
      this.#textLength -= evicted?.text.length ?? 0;
    }
    return value;
  }
}

/** Entries kept per derived-data cache; enough for a few open editors. */
export const RECENT_DOCUMENTS = 6;

/**
 * Total characters of text one cache keeps alive. Older entries are evicted
 * once the entries together exceed it; the newest entry always stays.
 */
export const RECENT_TEXT_BUDGET = 2_000_000;
