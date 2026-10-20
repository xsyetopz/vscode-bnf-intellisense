import type { PositionMock, RangeMock } from "./core.ts";

function rangeContains(outer: RangeMock, inner: RangeMock): boolean {
  const before = (a: PositionMock, b: PositionMock) =>
    a.line < b.line || (a.line === b.line && a.character <= b.character);
  return before(outer.start, inner.start) && before(inner.end, outer.end);
}

/**
 * Minimal VS Code SelectionRange test double.
 */
export class SelectionRangeMock {
  range: RangeMock;
  parent: SelectionRangeMock | undefined;

  constructor(range: RangeMock, parent?: SelectionRangeMock) {
    // Like VS Code: a parent must contain the child range.
    if (parent && !rangeContains(parent.range, range)) {
      throw new Error("Invalid argument: parent must contain range");
    }
    this.range = range;
    this.parent = parent;
  }
}

/**
 * Minimal VS Code CodeLens test double.
 */
export class CodeLensMock {
  range: RangeMock;
  command:
    | { title: string; command: string; arguments?: unknown[] }
    | undefined;

  constructor(
    range: RangeMock,
    command?: { title: string; command: string; arguments?: unknown[] },
  ) {
    this.range = range;
    this.command = command;
  }

  get isResolved(): boolean {
    return this.command !== undefined;
  }
}

/**
 * Minimal VS Code CallHierarchyItem test double.
 */
export class CallHierarchyItemMock {
  kind: number;
  name: string;
  detail: string | undefined;
  uri: unknown;
  range: RangeMock;
  selectionRange: RangeMock;

  constructor(
    kind: number,
    name: string,
    detail: string,
    uri: unknown,
    range: RangeMock,
    selectionRange: RangeMock,
  ) {
    this.kind = kind;
    this.name = name;
    this.detail = detail;
    this.uri = uri;
    this.range = range;
    this.selectionRange = selectionRange;
  }
}

/**
 * Minimal VS Code CallHierarchyIncomingCall test double.
 */
export class CallHierarchyIncomingCallMock {
  from: CallHierarchyItemMock;
  fromRanges: RangeMock[];

  constructor(from: CallHierarchyItemMock, fromRanges: RangeMock[]) {
    this.from = from;
    this.fromRanges = fromRanges;
  }
}

/**
 * Minimal VS Code CallHierarchyOutgoingCall test double.
 */
export class CallHierarchyOutgoingCallMock {
  to: CallHierarchyItemMock;
  fromRanges: RangeMock[];

  constructor(to: CallHierarchyItemMock, fromRanges: RangeMock[]) {
    this.to = to;
    this.fromRanges = fromRanges;
  }
}

/**
 * Minimal VS Code LinkedEditingRanges test double.
 */
export class LinkedEditingRangesMock {
  ranges: RangeMock[];
  wordPattern: RegExp | undefined;

  constructor(ranges: RangeMock[], wordPattern?: RegExp) {
    // Like VS Code: ranges must not overlap.
    const sorted = [...ranges].sort(
      (a, b) =>
        a.start.line - b.start.line || a.start.character - b.start.character,
    );
    for (let i = 1; i < sorted.length; i++) {
      const previous = sorted[i - 1] as RangeMock;
      const current = sorted[i] as RangeMock;
      if (
        previous.end.line > current.start.line ||
        (previous.end.line === current.start.line &&
          previous.end.character > current.start.character)
      ) {
        throw new Error("Invalid argument: ranges must not overlap");
      }
    }
    this.ranges = ranges;
    this.wordPattern = wordPattern;
  }
}

/**
 * Minimal VS Code DocumentLink test double.
 */
export class DocumentLinkMock {
  range: RangeMock;
  target: unknown;

  constructor(range: RangeMock, target?: unknown) {
    this.range = range;
    this.target = target;
  }
}

/**
 * Registrations made through the mocked `languages.register*` functions.
 */
export const providerRegistrations: Array<{
  kind: string;
  provider: unknown;
  args: unknown[];
}> = [];

export function registration(kind: string) {
  return (_selector: unknown, provider: unknown, ...args: unknown[]) => {
    providerRegistrations.push({ kind, provider, args });
    return { dispose: () => undefined };
  };
}

/**
 * Open text documents seen through the mocked `workspace.textDocuments`.
 */
export const openTextDocuments: unknown[] = [];

/**
 * Minimal VS Code DocumentSymbol test double.
 */
export class DocumentSymbolMock {
  name: string;
  detail: string;
  kind: number;
  range: unknown;
  selectionRange: unknown;

  constructor(
    name: string,
    detail: string,
    kind: number,
    range: unknown,
    selectionRange: unknown,
  ) {
    this.name = name;
    this.detail = detail;
    this.kind = kind;
    this.range = range;
    this.selectionRange = selectionRange;
  }
}

/**
 * Minimal VS Code FoldingRange test double.
 */
export class FoldingRangeMock {
  start: number;
  end: number;
  kind: unknown;

  constructor(start: number, end: number, kind?: unknown) {
    this.start = start;
    this.end = end;
    this.kind = kind;
  }
}

/**
 * Minimal VS Code SymbolInformation test double.
 */
export class SymbolInformationMock {
  name: string;
  kind: number;
  containerName: string;
  location: unknown;

  constructor(
    name: string,
    kind: number,
    containerName: string,
    location: unknown,
  ) {
    this.name = name;
    this.kind = kind;
    this.containerName = containerName;
    this.location = location;
  }
}
