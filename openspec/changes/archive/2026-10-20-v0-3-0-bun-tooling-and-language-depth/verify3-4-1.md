# Task 4.1 verification (round 4): NOT READY

Checks: biome OK, typecheck OK, bun test 2580 pass / 0 fail, build OK, md:check 0 issues, /tmp/rereview41/keep/edge.test.ts 5/5.
I ran probes P1-P8 as a temporary repo test, then deleted it (git status is clean of it).
verify2 findings 1-6: FIXED. Finding 7 is partly fixed: the basic add and remove cases work, but the races below are still open.
Nested folders (P4): adding /w/sub to /w gives no duplicate entries, and removing /w keeps the /w/sub files. OK.

## Remaining / new
1. HIGH workspace.ts:165-171 + 369-374: a read in flight for a file of a removed folder still lands. Removal only goes through #fileData, so files that are not indexed yet keep their stamp. P1: ["/x/b.abnf:xb"] stays after /x is removed.
   Fix: in #indexFile's post-read guard, add `|| (workspace.workspaceFolders?.length && !workspace.getWorkspaceFolder(uri))`, which routes the read through #abandonRead. Do the same in the onDidCreate handler (:119).
2. HIGH workspace.ts:175-180: a findFiles of an added folder that resolves after the folder was removed indexes that folder anyway. P2: add /x, remove /x, release the scan, and xb is indexed.
   Fix: the guard from item 1 also covers this. Or filter `files` by `workspace.getWorkspaceFolder(uri)` after the await.
3. HIGH workspace.ts:126-127: the initial scan has the same race. P6: /x is removed during initialize(), and xb is still indexed. The fix for item 1 covers it.
4. MEDIUM workspace.ts:292-300 + 434-443: closing an open document of a removed folder re-reads the disk text into the index. P3: after close, "/w/a.abnf:wa" stays.
   Fix: in #reindexFile, when folders exist and getWorkspaceFolder(uri) is undefined, call #forgetFile(uri) and return.
5. MEDIUM (same root cause, existing before this change): a file outside every folder that is opened and then closed stays indexed with its disk text. P5: /y/o.abnf "outside" is still there after close. The fix for item 4 covers it.
6. LOW workspace.ts:107 and 126: `void this.#applyFolderChange(...)` and the initial findFiles can reject (findFiles or readFile failure in #scan) with no handler, so the rejection goes unhandled. Fix: add `.catch(() => {})`, or wrap #scan in try/catch and return [].
7. LOW workspace.ts:166: the matcher reset there repeats the one in #scan (:186). Remove one of them.
8. LOW tests: there are no AAA tests for items 1-5. Add them to workspace-indexing.test.ts in "workspace folder changes", using readFileGate and findFilesGate as the existing race tests do:
   - "a read in flight for a removed folder does not enter the index"
   - "a folder removed before its scan finishes is not indexed"
   - "an open document of a removed folder leaves the index when closed"
   - "a file outside the workspace leaves the index when closed"
9. LOW workspace-indexing.test.ts:285-296: "an open document of a removed folder keeps its text" asserts after a fixed Bun.sleep(20). Removal is synchronous, so assert straight after the Act, or use eventually() with a negative control.
10. LOW workspace-exclusions.test.ts:486: "a file change after files.exclude changed..." is still nested under describe("scanning many files"). Move it into describe("changing files.exclude") (:321).

Test style: the new tests follow Arrange-Act-Assert and test behaviour, with no implementation prose in their names.
