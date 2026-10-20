# Task 4.1 round-2 verification: NOT READY
Checks: biome, typecheck, bun test (2563 pass), build, md:check all green. Edge repro: all 5 pass; rereview #1-#11 and close-subscription hardening verified fixed.
Probe (/tmp/verify41/probe.test.ts, run temporarily, removed): A close via activation reverts to disk OK; B/C/D/E reproduce bugs below.

1. MEDIUM workspace.ts:303-311 - refreshExclusions during in-flight scan: read lands after exclusion change, excluded file indexed (B: ["vend"]). Fix: after the read, also bail if isExcluded(uri).
2. MEDIUM workspace.ts:116-124 + 163-166 - open doc that becomes excluded: refreshExclusions keeps it, then syncOpenDocument returns early, so old text stays indexed and #openDocuments keeps it (C: "one" stays, "two" never). Fix: in the excluded branch, if #openDocuments has it, delete and #removeIndexedFile; drop the open-doc skip in refreshExclusions.
3. LOW workspace.ts:371-375 - disk delete of an open document drops its buffer's rules until next edit (D: []). Fix: if #openDocuments has uri, only bump generation.
4. MEDIUM (test gap) workspace-indexing.test.ts:125-135 calls removeDocument directly; no test reverts via fireOpenTextDocument/fireCloseTextDocument through activateGrammarExtension now that extension.ts close handler no longer calls it. Add one (probe A shape).
5. LOW (vacuous test) workspace-index-updates.test.ts:108-109 - one `await Promise.resolve()` doesn't let the stale read finish (E: not landed after one tick), so the test passes even without the generation guard. Fix: wait on a deferred resolved after the gated read returns, then flush with setTimeout 0.
6. LOW workspace.ts:377-399 - #removeIndexedFile fires onDidChangeIndex and stamps #generations even when not indexed (excluded change, unknown delete). Fix: early-return if !#fileData.has; forget stamp in excluded paths.
7. LOW perf workspace-exclude.ts:143-149 - isExcluded rereads config and recompiles every regex per call; #scan calls it per file. Fix: build matchers once per folder per scan.
