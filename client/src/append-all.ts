/**
 * Appends every item to `target`. Unlike `push(...items)`, the number of items
 * is not limited by the engine's argument count, which large documents exceed.
 */
export function appendAll<T>(target: T[], items: readonly T[]): void {
  for (const item of items) {
    target.push(item);
  }
}
