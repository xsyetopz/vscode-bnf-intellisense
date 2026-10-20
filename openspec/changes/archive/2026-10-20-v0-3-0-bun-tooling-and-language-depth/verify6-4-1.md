# Task 4.1 verification (round 7): READY (one LOW cleanup recommended)

Checks (all exit 0): biome:check, typecheck, bun test (2592 pass), build, md:check, /tmp/rereview41/keep/edge.test.ts (5 pass).

## verify5-4-1.md findings
1. MEDIUM, last folder removed during a scan: FIXED. workspace.ts:196 + 206-212 (scan filter), and 131-132, 158-162, 179-183 + 373, 395-396 (epoch into #indexFile). Tests workspace-indexing.test.ts:399, 414 and 428 cover P1, P2 and P4.
   Mutation check: with both mechanisms removed, all 3 tests fail. With only one removed (either one), all pass.
2. LOW, mock findFiles with no folders: FIXED. extension-host.ts:250-253. workspace-exclusions.test.ts:135 now expects an empty index. #scan with no folders makes no findFiles call (workspace.ts:192, 199).

## Scan filter vs epoch param
In tests the two mechanisms are fully redundant. Mutations A (drop the filter) and B (drop the epoch arguments) each pass 73/73 workspace tests.
Recommendation: keep the scan-level filter and drop the epoch plumbing (variant B):
- #scan returns Uri[] again. Drop `{ files, epoch }` and the `folderEpoch` param of #indexFile (373). It goes back to capturing the epoch itself at line 373 as the default.
- The filter avoids needless reads and generation bumps for files that are already out. With B, the 3 new tests pin the filter: removing it fails them.
- The gap between the filter and #indexFile's own capture is one microtask. VS Code delivers folder-change events as macrotasks, so nothing can slip in between.
- The vague doc sentence at 188-189 goes away with it.
If you prefer to keep both, note in the code that the epoch argument is defence in depth. No test can cover it.

## Other findings in workspace.ts (536 lines, < 800, no dead code or TODOs)
1. LOW workspace.ts:188-189: "files read from its results answer to it" is unclear prose. Removed by B; otherwise reword to "Callers pass the epoch to #indexFile so reads drop files whose folder was removed meanwhile."
2. LOW workspace.ts:197-198: the comment explains a branch that no longer exists. Drop it or shorten it to "No folders: nothing to scan."
3. LOW workspace.ts:206-212: a nested folder's files come back from both scans, so each is read twice. This is correct (the generation stamps drop the first read) but wastes I/O. Fix: dedupe by uri.toString() before returning.
4. INFO workspace.ts:140 + 194: refreshExclusions builds the exclusion matcher twice. Harmless (test :487 bounds the reads). Optional: build it only in #scan.
