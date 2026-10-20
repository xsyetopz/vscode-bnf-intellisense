# Task 4.1 verification (round 6): NOT READY

Checks: biome OK, typecheck OK, bun test OK, build OK, md:check OK, edge.test.ts OK (all exit 0).
Findings 1-5 of verify4-4-1.md: FIXED.
- #1 workspace.ts:109, 368, 385-386 (epoch); test workspace-indexing.test.ts:354.
- #2 workspace.ts:302-308; test :378.
- #3 extension-host.ts:262-265; test workspace-exclusions.test.ts:204.
- #4 tests workspace-indexing.test.ts:561, 578.
- #5 workspace.ts:518.
Epoch regression probe P3: a folder is added while a read for a file in a folder that stays is in flight. The read still lands (OK).

## Folderless-close test race
This is not a production race. With no folders, `#scan` (workspace.ts:200) calls `findFiles(FILE_GLOB)`. VS Code builds that query from the workspace folders, so it returns nothing. In a window with folders, a scan that reads a file after its document closed indexes the disk text, which is correct. Waiting for the scan in the test is fine.

## Remaining / new
1. MEDIUM workspace.ts:131-132, 179-183, 158-163 + 368: the last folder can be removed while a scan's findFiles is in flight. The scan results still get indexed.
   The epoch is captured in #indexFile, which runs only after the scan returns, so it misses the change. #outsideWorkspace is false with no folders.
   Probes (temporary file, deleted):
   - P1: initial scan, then changeWorkspaceFolders([]) -> "wa" indexed.
   - P2: add /x, then remove all folders during the scan -> "xb" indexed.
   - P4: refreshExclusions, then remove the last folder -> "wa" indexed.
   Fix: in #scan, capture `const epoch = this.#folderEpoch` before the await. After it, filter
   `uri => this.#folderEpoch === epoch || workspace.getWorkspaceFolder(uri)`.
   Tests: "a scan in flight when the last folder is removed indexes nothing", for the initial scan, the added-folder scan and the refreshExclusions scan.
2. LOW vscode-mock/extension-host.ts:245-266: with a string glob and no folders, the mock findFiles returns every disk file. VS Code returns none.
   workspace-exclusions.test.ts:135 ("a window without folders still scans...") and the folderless test (workspace-indexing.test.ts:378, "outside") assert behavior that cannot happen in production.
   Fix: return [] when the include is a string and workspaceFolders is empty/undefined. Change test :135 to expect an empty index, and drop the "outside" scan step from :378.
   Optionally simplify #scan's folderless branch (workspace.ts:200) to return [].
