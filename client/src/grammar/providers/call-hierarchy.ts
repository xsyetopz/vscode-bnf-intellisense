import {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  type CallHierarchyProvider,
  type CancellationToken,
  type Position,
  type Range,
  SymbolKind,
  type TextDocument,
  type Uri,
  workspace,
} from "vscode";
import type { Rule, SymbolTable } from "../../types.ts";
import type { GrammarDialect } from "../dialects.ts";
import { isGrammarLanguage, normalizeSymbolName } from "../grammar.ts";
import type { GrammarWorkspace } from "../workspace.ts";
import { getWordLookup } from "./word-at-position.ts";

/**
 * One parsed grammar file. Open documents win over the indexed copy on disk,
 * so unsaved edits show up in the hierarchy.
 */
interface Source {
  uri: Uri;
  dialect: GrammarDialect;
  rules: Rule[];
  symbolTable: SymbolTable;
}

const FILE_NAME_RE = /[^/\\]*$/;

function compareStart(a: Range, b: Range): number {
  return a.start.line - b.start.line || a.start.character - b.start.character;
}

/**
 * VS Code call hierarchy provider. A "call" is a reference from the body of
 * one rule to another rule.
 *
 * Items are rules defined in the workspace. ABNF core rules (`ALPHA`,
 * `DIGIT`, ...) and any other name without a definition are not items: they
 * are left out of outgoing calls and cannot be prepared, because there is no
 * body to descend into. A rule that the user defines with a core-rule name is
 * a normal rule. ABNF `=/` increments of one file share the item of that
 * file's rule. Call sites are always reported against the file they are
 * written in (VS Code reads `fromRanges` relative to that item's document),
 * so a file that only extends a rule with `=/` has its own item, and its
 * calls are not folded into the item in the file with the `=`.
 */
export class GrammarCallHierarchyProvider implements CallHierarchyProvider {
  readonly #grammarWorkspace: GrammarWorkspace;

  constructor(grammarWorkspace: GrammarWorkspace) {
    this.#grammarWorkspace = grammarWorkspace;
  }

  prepareCallHierarchy(
    doc: TextDocument,
    position: Position,
    _token?: CancellationToken,
  ): CallHierarchyItem | undefined {
    const lookup = getWordLookup(doc, position, this.#grammarWorkspace);
    if (!lookup) {
      return undefined;
    }
    // Resolve through the same sources as the later calls, so unsaved edits
    // in other open files cannot disagree with the on-disk index.
    const sources = this.#sources(doc);
    const own = sourceOf(sources, doc.uri);
    if (!own) {
      return undefined;
    }
    // A file that holds `=/` increments of the name has an item of its own.
    const owner = rulesNamed(own, lookup.word).length
      ? own
      : this.#definingSource(sources, own, lookup.word);
    return owner ? this.#item(owner, lookup.word) : undefined;
  }

  provideCallHierarchyOutgoingCalls(
    item: CallHierarchyItem,
    token?: CancellationToken,
  ): CallHierarchyOutgoingCall[] {
    const sources = this.#sources();
    const source = sourceOf(sources, item.uri);
    if (!source) {
      return [];
    }
    const key = normalizeSymbolName(item.name, source.dialect);
    const grouped = new Map<string, Range[]>();
    for (const rule of rulesNamed(source, key)) {
      for (const ref of rule.references) {
        const target = normalizeSymbolName(ref.name, source.dialect);
        const ranges = grouped.get(target) ?? [];
        ranges.push(ref.range);
        grouped.set(target, ranges);
      }
    }
    const calls: CallHierarchyOutgoingCall[] = [];
    for (const [target, ranges] of grouped) {
      if (token?.isCancellationRequested) {
        break;
      }
      const owner = this.#definingSource(sources, source, target);
      const callee = owner ? this.#item(owner, target) : undefined;
      if (callee) {
        calls.push(
          new CallHierarchyOutgoingCall(callee, ranges.sort(compareStart)),
        );
      }
    }
    return calls;
  }

  provideCallHierarchyIncomingCalls(
    item: CallHierarchyItem,
    token?: CancellationToken,
  ): CallHierarchyIncomingCall[] {
    const sources = this.#sources();
    const own = sourceOf(sources, item.uri);
    if (!own) {
      return [];
    }
    const key = normalizeSymbolName(item.name, own.dialect);
    const callers = new Map<
      string,
      { owner: Source; key: string; ranges: Range[] }
    >();
    for (const source of sources) {
      if (source.dialect !== own.dialect) {
        continue;
      }
      if (token?.isCancellationRequested) {
        break;
      }
      const callsIn = callSitesOf(source).get(key);
      if (!callsIn) {
        continue;
      }
      // References in a file count only when they resolve to `item`'s file,
      // the same way outgoing calls resolve them.
      if (this.#definingSource(sources, source, key) !== own) {
        continue;
      }
      for (const [rule, ranges] of callsIn) {
        const callerKey = normalizeSymbolName(rule.name, source.dialect);
        // Call sites are reported against the file they are written in, so
        // a file with only `=/` increments is a caller item of its own.
        const id = `${source.uri.toString()}|${callerKey}`;
        const entry = callers.get(id) ?? {
          owner: source,
          key: callerKey,
          ranges: [],
        };
        for (const range of ranges) {
          entry.ranges.push(range);
        }
        callers.set(id, entry);
      }
    }
    const calls: CallHierarchyIncomingCall[] = [];
    for (const { owner, key: callerKey, ranges } of callers.values()) {
      const from = this.#item(owner, callerKey);
      if (from) {
        calls.push(
          new CallHierarchyIncomingCall(from, ranges.sort(compareStart)),
        );
      }
    }
    return calls;
  }

  /**
   * Open grammar documents, then indexed files that are not open.
   */
  #sources(extra?: TextDocument): Source[] {
    const sources = new Map<string, Source>();
    const open = [...(workspace.textDocuments ?? [])];
    if (extra) {
      open.unshift(extra);
    }
    for (const doc of open) {
      const key = doc.uri.toString();
      if (!isGrammarLanguage(doc.languageId) || sources.has(key)) {
        continue;
      }
      const { dialect, document, symbolTable } =
        this.#grammarWorkspace.get(doc);
      sources.set(key, {
        uri: doc.uri,
        dialect,
        rules: document.rules,
        symbolTable,
      });
    }
    for (const file of this.#grammarWorkspace.getAllFiles()) {
      const key = file.uri.toString();
      if (!sources.has(key)) {
        sources.set(key, {
          uri: file.uri,
          dialect: file.dialect,
          rules: file.rules,
          symbolTable: file.symbolTable,
        });
      }
    }
    return [...sources.values()];
  }

  /**
   * The file that declares `key` as seen from `from`: its own file first.
   * A name that only has `=/` increments falls back to the first file that
   * has any definition.
   */
  #definingSource(
    sources: readonly Source[],
    from: Source,
    key: string,
  ): Source | undefined {
    if (declares(from, key)) {
      return from;
    }
    const same = sources.filter((source) => source.dialect === from.dialect);
    return (
      same.find((source) => declares(source, key)) ??
      same.find((source) => source.symbolTable.definitions.has(key))
    );
  }

  /**
   * The item of the rule declared with `=` (or the first definition when only
   * increments exist). Its range is that one definition; reference ranges in
   * later `=/` increments of the same file may lie outside it.
   */
  #item(source: Source, key: string): CallHierarchyItem | undefined {
    const rules = rulesNamed(source, key);
    const primary = rules.find((rule) => !rule.isIncremental) ?? rules[0];
    if (!primary) {
      return undefined;
    }
    return new CallHierarchyItem(
      SymbolKind.Function,
      primary.name,
      FILE_NAME_RE.exec(source.uri.path)?.[0] ?? source.uri.path,
      source.uri,
      primary.definitionRange,
      primary.nameRange,
    );
  }
}

/** True when the file has a definition of `key` that is not an `=/`. */
function declares(source: Source, key: string): boolean {
  return rulesNamed(source, key).some((rule) => !rule.isIncremental);
}

function sourceOf(sources: readonly Source[], uri: Uri): Source | undefined {
  const key = uri.toString();
  return sources.find((source) => source.uri.toString() === key);
}

function rulesNamed(source: Source, key: string): Rule[] {
  return source.symbolTable.definitions.get(key) ?? [];
}

const callSiteCache = new WeakMap<
  readonly Rule[],
  Map<string, Map<Rule, Range[]>>
>();

/**
 * Call sites of one file grouped by referenced name, then by the rule that
 * contains them. Built once per parse of the file.
 */
function callSitesOf(source: Source): Map<string, Map<Rule, Range[]>> {
  const cached = callSiteCache.get(source.rules);
  if (cached) {
    return cached;
  }
  const byName = new Map<string, Map<Rule, Range[]>>();
  for (const rule of source.rules) {
    for (const ref of rule.references) {
      const name = normalizeSymbolName(ref.name, source.dialect);
      let byRule = byName.get(name);
      if (!byRule) {
        byRule = new Map();
        byName.set(name, byRule);
      }
      const ranges = byRule.get(rule);
      if (ranges) {
        ranges.push(ref.range);
      } else {
        byRule.set(rule, [ref.range]);
      }
    }
  }
  callSiteCache.set(source.rules, byName);
  return byName;
}
