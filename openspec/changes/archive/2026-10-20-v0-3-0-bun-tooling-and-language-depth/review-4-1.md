# Review of task 4.1 (performance)
Checks: bun test passes 2519/0, typecheck is clean, biome is clean, bench (500/2000) shows roughly linear growth (3–5x for 4x input).
Verdict: NOT DONE. Two HIGH bugs were reproduced (scripts: /tmp/review41/t/repro*.test.ts).

## HIGH
1. semantic-tokens.ts:124-134: the memo survives close and reopen. VS Code restarts version at 1 when a document reopens, so a file changed on disk while closed (or a reused Untitled-1) is served stale tokens. Repro: 3 vs 10 from a fresh provider. Fix: in the constructor, subscribe to `workspace.onDidCloseTextDocument` and delete the uri from the memo (dispose that subscription too). Add a reopen test.
2. workspace.ts:222-236 / 270-276: two `#indexFile` reads of one uri at the same time both add entries, so you get duplicate definitions and symbols. Triggers: background scan plus close re-read, a double watcher onDidChange, scan plus onDidCreate. Repro: findDefinitions gives 2. The older read can also land last and win with stale text. Fix: keep a generation counter per uri, bump it on every reindex/remove/sync, and drop the result if the generation changed after the await. Then call `#removeIndexedFile(uri,false)` before `#addIndexedFile`.

## MEDIUM
3. workspace.ts:314-325: files.exclude patterns that contain braces (`**/*.{js,map}`) get nested inside `{…}`. VS Code glob and ripgrep globset do not support nested alternates, so the scan can reject. extension.ts:34 then swallows the error and leaves an empty index. The mock (vscode-mock/extension-host.ts:63) does accept nesting, which hides this. Fix: expand braces in each configured pattern before joining, and add a test for it.
4. workspace.ts:84-85: watcher create/change events ignore the exclusions, so files in out/dist/node_modules get indexed after a build. removeDocument (180) does the same for an excluded file the user opened. Fix: share an `isExcluded(uri)` check (path segments plus the expanded patterns) and run it in the watcher handlers and the close re-read.
5. scaling.test.ts:78-90: every run uses the same text, so tokenize and scan come from RecentCache and the test never measures their growth. bench.ts:110-140 reuses the workspace, so semanticTokens leaves out parse and tokenize, and its comment says "memoizes the last document" (it keeps 8). Fix: add a per-run `; run N` line so each text differs, use a fresh workspace, and fix the comment.
6. parser.ts:666-671: whole-document diagnostic arrays (`...lexicalDiagnostics(scan)` and others) are spread into push. This was not on your list and is the biggest argument-limit risk. Fix: use appendAll.

## LOW
7. workspace.ts:320: `if (enabled)` also accepts `{when: …}` objects, which turns a conditional exclude into an unconditional one. Fix: `enabled === true`.
8. workspace.ts:315: `getConfiguration("files")` has no scope, so per-folder files.exclude is ignored in multi-root workspaces. Fix: read it per workspace folder and pass a RelativePattern.
9. workspace.ts:307: `**/out/**` and `**/dist/**` also drop user grammar folders named out or dist anywhere in the tree. Fix: anchor them to the folder root, or document it in the README.
10. extension.ts:34: `.catch(() => undefined)` hides scan failures. Fix: log with console.error or an output channel.
11. workspace.ts:207: indexing keeps writing into the maps after dispose. Fix: add a `#disposed` guard in `#indexFile` and `#addIndexedFile`.
12. workspace.ts:97-100: virtual workspaces (vscode-vfs) are scanned but their open documents are never synced. Fix: accept any scheme for which `workspace.getWorkspaceFolder(doc.uri)` is defined, plus untitled.
13. recent-cache.ts / workspace.ts:146 / tokenizer.ts:449 / scanner ScanResult: no caller mutates the shared arrays today (checked sort/splice/push/reverse/field writes), but nothing enforces it. Fix: return `readonly` arrays from these functions.
14. Memory: 3 RecentCaches × 6 entries plus 8 memos keep old versions and closed big texts alive. Fix: lower to about 3, or clear the memo on close (item 1).
15. provider-semantic-tokens-large.test.ts:35-59: `tokenCount` returns ints, not tokens, and `>= 9000` means only 1800 tokens. Fix: rename it to `dataLength`, assert exactly 3000*3*5, and assert that no operator, string or comment tokens are present.
16. workspace-indexing.test.ts:71-88 and 92-108 each have two act/assert phases; split them. Line 110 opens the document before the scan starts, so the in-flight race is never tested; add a readFile gate. Lines 155-190: call mockRestore in afterEach.
17. provider-semantic-tokens-large.test.ts:63: the describe name "semantic token caching" is implementation prose. Fix: rename it to something like "tokens stay correct across requests".
18. railroad-layout.test.ts is 835 lines, over the 800-line limit. Fix: split it.

## push(...spread): convert to loops/appendAll
Convert, since these grow with document size: parser.ts:658 (and 666), code-actions.ts:80, convert-ast.ts:64/76/212, convert-dialect.ts:140 (also 98), convert-comments.ts:57, railroad/model.ts:41/61, scanner.ts:544.
Safe, small and bounded per token: iso-conversion.ts:196/388/426, code-actions.ts:454, write-grammar.ts:505/514, abnf/code-actions.ts:544/547/572.
