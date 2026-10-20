import { Range } from "vscode";
import type { LineIndex } from "./line-index.ts";

/**
 * Single source line with its document offset.
 */
export interface LineInfo {
  text: string;
  line: number;
  offset: number;
}

const LINE_SPLIT_RE = /\r\n|\n|\r/;

/**
 * Creates a VS Code range from one line and two columns.
 */
export function makeSingleLineRange(
  line: number,
  start: number,
  end: number,
): Range {
  return new Range(line, start, line, end);
}

/**
 * Converts offsets into a VS Code range using a prebuilt line index.
 */
export function rangeFromLineIndex(
  lines: LineIndex,
  start: number,
  end: number,
): Range {
  const startLine = lines.lineAt(start);
  const endLine = lines.lineAt(end);
  return new Range(
    startLine,
    start - (lines.starts[startLine] ?? 0),
    endLine,
    end - (lines.starts[endLine] ?? 0),
  );
}

/**
 * Splits text into lines while preserving starting offsets.
 */
export function splitLinesWithOffsets(text: string): LineInfo[] {
  const lines: LineInfo[] = [];
  let offset = 0;
  const parts = text.split(LINE_SPLIT_RE);
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i] ?? "";
    lines.push({ text: line, line: i, offset });
    offset += line.length;
    const next = text.charAt(offset);
    switch (next) {
      case "\r":
        offset += text.charAt(offset + 1) === "\n" ? 2 : 1;
        break;
      case "\n":
        offset += 1;
        break;
      default:
        break;
    }
  }
  return lines;
}
