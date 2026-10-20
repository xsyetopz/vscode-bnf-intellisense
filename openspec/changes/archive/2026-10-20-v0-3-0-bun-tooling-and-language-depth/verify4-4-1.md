# Task 4.1 verification (round 5): NOT READY

Checks: biome OK, typecheck OK, bun test 2584 pass / 0 fail, build OK, md:check 0 issues, edge.test.ts 5/5.
Verify3 findings 1-10: FIXED (#6 accepted deviation). P1-P6 now behave; P4 nested OK (PE re-run).
New probes (temp file, deleted): PC untitled with folders -> indexed while open, dropped on close (OK).
Outside file open -> indexed with buffer text, forgotten on close (OK, matches "open docs synced").
Probe file removed; git status clean of it.

## Remaining / new
1. MEDIUM workspace.ts:451-456 + 370-376: removing the LAST folder while a read is in flight lets it land.
   #outsideWorkspace is false when there are no folders. PA: /w/b.abnf "wb" stays after changeWorkspaceFolders([]).
   Fix: keep a #folderEpoch counter bumped in the onDidChangeWorkspaceFolders handler (:106). Capture it in #indexFile before the await.
   Abandon the read when the epoch changed and !workspace.getWorkspaceFolder(uri). The folderless scan is unaffected.
   Test: "a read in flight when the last folder is removed does not enter the index".
2. LOW workspace.ts:440 + 298-300: in a folderless window, a closed document is re-read from disk and stays indexed.
   No watcher covers it there, so its rules go stale for the session (PB: "outside" stays).
   Fix: removeDocument should forget the file when !getWorkspaceFolder(uri), even with no folders. Use a separate check from the scan guard.
   Test: "a file closed in a window without folders leaves the index".
3. LOW vscode-mock/extension-host.ts:262: findFiles returns `mockUri(path)` (scheme "file") even for a RelativePattern of a vscode-vfs folder.
   With #outsideWorkspace, virtual-folder scans now index nothing in tests (PD: scan []). Production is fine, but nothing covers it.
   Fix: `mockUri(path, typeof include === "string" ? "file" : include.baseUri.scheme)`.
   Add test "files of a virtual workspace folder are indexed" (workspace-exclusions.test.ts, "open documents by scheme").
4. LOW tests: no test covers the new logging. Add:
   - "a failed folder scan is logged": findFilesGate rejects and changeWorkspaceFolders runs; console.error gets "BNF workspace indexing failed:".
   - the refreshExclusions catch at extension.ts:86 (a rejecting scan after a files.exclude change).
5. LOW workspace.ts:509: the `!scheme` branch in isWorkspaceScheme only served the old schemeless DocumentMock; real Uris always have a scheme. Remove it.
   DocumentMock scheme "file" otherwise masks nothing: the tests that need other schemes override it (exclusions :208, git :219).
