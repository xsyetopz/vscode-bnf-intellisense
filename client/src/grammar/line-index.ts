/**
 * Maps document offsets to line and column positions. Handles LF, CRLF, and
 * lone CR line endings, and uses binary search for lookups.
 */
export class LineIndex {
  readonly starts: number[] = [0];

  constructor(text: string) {
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      if (ch === 13 && text.charCodeAt(i + 1) === 10) {
        i++;
        this.starts.push(i + 1);
      } else if (ch === 10 || ch === 13) {
        this.starts.push(i + 1);
      }
    }
  }

  lineAt(offset: number): number {
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((this.starts[mid] ?? 0) <= offset) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return low;
  }
}
