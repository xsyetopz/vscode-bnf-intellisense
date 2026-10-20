# Task 4.1 verification (round 3): NOT READY
Checks all pass: biome, typecheck, bun test (2574 pass), build, md:check, edge.test.ts (5/5). Probes A-E were run as a temporary repo test, which was then deleted.
Findings 1-7: all FIXED (A reverts, B [], C [] / [], D ["ee"], E test now waits on staleReadReturned + setTimeout 0; #removeIndexedFile returns early; matcher per scan).
Extra probes: G (disk delete of an open doc, then close) leaves nothing behind: OK. H (excluded open doc closed, then unhidden) indexes the disk text only: OK.

## Remaining / new
1. MEDIUM (new) workspace.ts:265-273 + 333-336: an open grammar doc whose path has no grammar extension (untitled:Untitled-1, notes.txt set to language mode abnf) keeps its rules in the index after close. removeDocument calls #reindexFile, then #indexFile returns at `!dialect` without removing anything. Probe F: ["leak"] stays after close. Fix: in #indexFile's `!dialect` branch, call `this.#forgetFile(uri)` when the generation still matches (or in removeDocument, call #forgetFile when grammarDialectFromPath(open.uri.path) is undefined). Add an AAA test: open a .txt doc with languageId abnf, close it, search returns [].
2. LOW workspace-exclude.ts:174-180: the `isExcluded` wrapper is dead code (no production or test use). Remove it.
3. LOW test gap: nothing covers "disk delete of an open doc, then close: rules gone" (probe G). Add it next to workspace-index-updates.test.ts:119.
4. LOW AAA: workspace-indexing.test.ts:230-238 runs act, assert, act, assert in one test. Split into "follows edits" and "reverts on close", each with one Act.
5. LOW test duplication: workspace-exclusions.test.ts:486-495 ("applies files.exclude changes made after a scan") repeats the test at :322 and sits under "scanning many files". Delete it, or make it cover a watcher change after the setting changes, with no refreshExclusions call. That would cover the constructor matcher reset at workspace.ts:100-104, which no test covers now.
6. LOW workspace.ts:340-347 and the catch at 356-361: when the read bails for exclusion, dialect or a failed read of an unindexed file, the #generations stamp stays. That is a small map leak. Fix: delete the stamp when it still equals `generation`.
7. INFO (existing, outside 4.1 unless in scope): nothing handles onDidChangeWorkspaceFolders. Added folders are not scanned and files of removed folders stay indexed. The matcher cache is keyed by folder URI, so it does not go stale.
