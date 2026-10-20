/**
 * Minimal VS Code EventEmitter test double.
 */
export class EventEmitterMock<T> {
  readonly #listeners = new Set<(value: T) => void>();
  readonly event = (listener: (value: T) => void) => {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of this.#listeners) {
      listener(value);
    }
  }

  dispose(): void {
    this.#listeners.clear();
  }
}

export const configurationListeners = new Set<
  (event: { affectsConfiguration: (section: string) => boolean }) => void
>();

export const textDocumentListeners = new Set<
  (event: {
    document: { languageId: string };
    contentChanges: unknown[];
  }) => void
>();

/**
 * Simulates an edit of a text document for every registered listener.
 */
export function fireTextDocumentChange(
  languageId: string,
  contentChanges: unknown[] = [{}],
): void {
  for (const listener of textDocumentListeners) {
    listener({ document: { languageId }, contentChanges });
  }
}

/**
 * Simulates an edit: VS Code reports the same document with its new text and a
 * bumped version, here given as the updated document.
 */
export function fireDocumentEdit(document: { languageId: string }): void {
  for (const listener of textDocumentListeners) {
    listener({ document, contentChanges: [{}] });
  }
}

/**
 * Simulates a settings change for every registered listener.
 */
export function fireConfigurationChange(section = "bnf"): void {
  for (const listener of configurationListeners) {
    listener({
      affectsConfiguration: (asked) =>
        section === asked || section.startsWith(`${asked}.`),
    });
  }
}
