# Perf audit, task 4.1 (v0-3-0-bun-tooling-and-language-depth)

Benchmarks: `/tmp/perf41/bench.test.ts` (all stages, `SIZES=2000,8000`, `SEM8K=1` to include semantic tokens at 8k)
and `/tmp/perf41/auto.test.ts` (semantic tokens in the default `auto` mode). Run from the repo root with
`bun test /tmp/perf41/bench.test.ts --timeout 900000` (the bunfig preload supplies the vscode mock).
Raw table: `/tmp/perf41/results.md`. Times are best-of-3 in ms on Bun 1.4.3. The generated grammar has
about 4 refs per rule, a comment every 10 rules, and a typo ref every 25 rules. Code lens = provide + resolve
of every lens with 20 other same-size files indexed.

| dialect | rules | KB | parse | tokenize | diagnostics | diag (no did-you-mean) | semTokens (mode=on) | format | codeLens |
|---|---|---|---|---|---|---|---|---|---|
| abnf | 2000 | 131 | 9.2 | 4.6 | 26.6 | 12.2 | **4022** | 9.6 | 24.5 |
| abnf | 8000 | 540 | 29.5 | 21.6 | 67.0 | 45.3 | (not run) | 39.1 | 58.7 |
| bnf | 2000→8000 | 116→479 | 3.2→11.3 | | 20.7→44.5 | 6.5→26.9 | 1662 @2k | 10.8→38.8 | 12.1→53.6 |
| ebnf | 2000→8000 | 148→612 | 4.2→17.1 | | 23.2→50.3 | 6.4→34.5 | 4290 @2k | 16.2→59.2 | 14.5→60.8 |
| rbnf | 2000→8000 | 122→502 | 2.9→12.6 | | 25.0→51.6 | 5.3→28.2 | 1573 @2k | 12.1→47.0 | 17.6→62.3 |

Growth for 4x input: parse 3.2-4.3x, diagnostics 2.1-2.5x (fixed costs dominate), format 3.6-4.1x,
code lens 2.4-4.4x, so all of these are **linear**. Semantic tokens at 500→2000 rules grow **8.6-18.3x (quadratic)**.
In auto mode for ABNF: 250 rules take 58 ms, 500 take 192, and 1000 take **770 ms**. At 1500 rules or more, it emits 0 tokens because the
20k-candidate cap (semantic-tokens.ts:42,158-163) silently turns highlighting off.

## Status of the original findings
| id | status | evidence |
|---|---|---|
| AP1 / P1 sem-token selection O(n²) | **still present** | semantic-tokens.ts:285-299 (`overlapsAny(…, selected.map(…))` per candidate) |
| AP2 / P4 re-tokenize per request | **partly** | BNF/EBNF/RBNF share one memoized scan (scanner.ts:613,634-650). ABNF is tokenized again in parse (abnf/parser.ts:224), analysis (expression.ts:412), semantic tokens (tokenizer.ts:53), and case hints. abnf/format.ts:66 tokenizes once more |
| AP3 tokens.indexOf per rule | **fixed** | abnf/parser.ts:223-280 walks by index. ABNF parse grows 3.2x |
| AP4 / P7 linear word lookup | still present, harmless | word-at-position.ts:60-87. symbol-locations.ts:47,87,130 now do a map lookup per file, O(files) |
| AP5 per-token line re-render | structurally present, bounded | format-renderer.ts:530-540. The work is capped by maxLineLength. A 2000-token rule formats in 1.0 ms. No action |
| P2 rangeFromOffsets O(n·refs) | **fixed** | line-index.ts (binary search). ranges.ts:48 `rangeFromOffsets` is now unused but still O(end) per call: delete it |
| P3 symbol-table spread | **fixed** | symbol-table.ts `pushTo` |
| P5 activation/index | **still present** | extension.ts:31 awaits `initialize()`. workspace.ts:71 `findFiles(FILE_GLOB)` has no exclude (node_modules). Indexing reads disk only (workspace.ts:166), so unsaved edits are not indexed |
| P6 change/config handling | **partly** | Config refresh is fixed (extension.ts:68-75). The parse cache is version-keyed (workspace.ts:87-91). `scheduleReparse` still arms a timer for every document of any language and even for no-content changes (extension.ts:61-66; the filter applies only inside the callback) |

## Prioritized fixes
1. **semantic-tokens.ts:285-299, quadratic selection (P0).** 770 ms per request at 1k ABNF rules, 4.3 s at 2k EBNF rules
   in mode "on". Fix: sort candidates by priority, then keep a per-line sorted interval list (or one
   `Map<line, Array<[start,end]>>` with binary-search insert) and test overlap only against that line's
   neighbours. Expected cost is O(n log n), about 10 ms at 2k rules. Add a `growthForFourfoldInput` test in scaling.test.ts.
2. **semantic-tokens.ts:42,158-163, cap fallout.** Once (1) is fixed, raise or rethink `maxTokens=20000`. The default
   now blanks highlighting for grammars over about 1.3k rules. The cap was protecting against (1), not against the work itself.
3. **Cache tokens with the parse (AP2/P4).** Store the ABNF `AbnfToken[]` (or the production `ScanResult`) in
   `CachedParse` (workspace.ts:28-33,97-105). Have parseAbnf accept pre-tokenized input, and pass the tokens to
   `abnfBodyTokens` (expression.ts:405), the case hints, and the semantic tokens. This saves about 3 extra ABNF tokenizations per edit
   (about 20 ms each at 8k rules). It also replaces the module-global single-entry memos (scanner.ts:613 `lastScan`,
   rule-layout.ts:316 `lastLayout`), which any second document evicts: indexing, other open files, and
   formatting-provider.ts:95-96 (which lays out both `text` and `formatted`).
4. **Key the semantic memo by `doc.version`** (semantic-tokens.ts:132-141) instead of `getText()` plus a full
   string compare. That compare is O(n) per viewport request, and the one-entry memo per provider thrashes across editors.
5. **extension.ts:61-66.** Return early unless `isGrammarLanguage(event.document.languageId) &&
   event.contentChanges.length > 0` before `scheduleReparse`. As written, every keystroke in any file (and in output
   channels) allocates a timer.
6. **Workspace index (P5).** In workspace.ts:71, pass an exclude (`"**/{node_modules,.git,out,dist}/**"` or honour
   `search.exclude`). In extension.ts:31, stop awaiting `initialize()` before registering providers (index in the
   background and fire `onDidChangeIndex`). Overlay open dirty documents: on didChange of a grammar doc,
   update `#fileData`/`#index` from `get(doc)` (already cached), and restore the disk version on close.
   `symbol-locations.ts` and `completion.ts:150` then see unsaved edits. call-hierarchy.ts:175-205 already overlays open docs, so reuse that.
7. **Code lens resolve (code-lens.ts:130-139)** builds a full `Location[]` per lens just to count it. Use the existing
   `collectWorkspaceReferenceCount` (symbol-locations.ts:120), and build locations only when the lens is clicked.
   Measured cost is linear (about 60 ms for all 8k lenses × 21 files), so this is low priority.
8. **Did-you-mean** (diagnostics.ts:57-95, suggestions.ts:92-121) is memoized per unknown name and bucketed by
   length. It costs about 14-23 ms at 8k rules with 320 typos and grows sub-quadratically. No change needed. Keep the
   suggester built lazily.
9. **Low priority.** `searchSymbols` flattens the whole index per query (workspace.ts:150); keep a flat array that
   is rebuilt on index change. Call-hierarchy incoming calls rebuild `#sources` and scan every rule of every file
   (call-hierarchy.ts:120-160); use `symbolTable.references` per file. `diagnostics.push(...big)` spreads
   (diagnostics.ts:189-207) risk the engine's argument limit on huge outputs, so use a loop or concat.
10. Delete the dead `rangeFromOffsets` (ranges.ts:48-54).

## Caching summary
- Parse plus symbol table: cached per uri, version, and dialect (workspace.ts:84-106). Good.
- Tokens: not cached alongside the parse. Analysis and diagnostics are not cached; they are recomputed once per debounced
  change (200 ms, workspace.ts:110-125). That costs 45-67 ms at 8k rules, which is acceptable.
- Config changes: the diagnostics refresh runs (extension.ts:68), and code lenses refresh (code-lens.ts:54).
- The index ignores unsaved edits and node_modules is not excluded (see fix 6).
