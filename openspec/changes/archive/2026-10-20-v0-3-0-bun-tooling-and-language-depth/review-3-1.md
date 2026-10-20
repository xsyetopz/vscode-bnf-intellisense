# Review 3.1 (A shared + B ABNF): new diagnostics and quick fixes
Verdict: the algorithms are mostly sound and wired end to end. 212/212 tests pass; biome, typecheck and build are clean; every file is under 800 lines.
Not done yet: there are 2 HIGH and 8 MED findings.
Repro scripts are in /tmp/rv (h.ts harness, p1-p10.ts, perf*.ts, rfc3986.abnf, xml.ebnf).

## Examples / real grammars
- examples/json.{abnf,bnf,ebnf,rbnf}: 0 diagnostics each.
- XML 1.0 subset (xml.ebnf): only 2 unused hints (Names, Nmtoken). Both are correct.
- RFC 3986 ABNF: 5 false-positive bnf.unreachable-rule diagnostics (see M4).

## HIGH
H1. did-you-mean is quadratic. diagnostics.ts:44-80 calls suggestName (suggestions.ts:93-123) once per undefined name, against every definition.
  `ruleN ::= rulxN` x1000 takes 290ms, x2000 takes 1.3s and x8000 takes 21s, on every reparse. With did-you-mean off, the same input takes 50ms.
  Fix: bucket candidates by length so that only |len diff| <= limit are compared, and add a budget: stop suggesting after about 200 distinct names, or when targets x pool > 1e5. Alternatively compute the suggestion lazily in the code-action provider.
H2. The ISO->W3C conversion changes meaning silently (code-actions.ts:275-354).
  `[ "z" ]` is left as is, and in W3C it becomes a character class.
  `(* c *)` is left too and is then parsed as a group or reference: the result gives `undefined "c"` / `"note"`.
  `3 * "x"` is not converted, and neither is the `.` terminator.
  Fix: convert `[..]` to `(..)?`, `(* *)` to `/* */`, and `.` like `;`. If a production still holds something that cannot be converted (`n *`, `?..?`, `(/ /)`, `(: :)`), refuse to convert it. Re-parse the result in tests.

## MED
M1. Overlapping edits. `a = "x" , ;` produces a comma deletion [8,10) and a `;` deletion [9,11). VS Code rejects the whole WorkspaceEdit, which also kills the file-wide action (:319-351).
  Fix: merge the deletion spans before emitting them.
M2. Several ISO statements on one line form one stray. Only the first `=` and the last `;` are converted, so `a = "x" ; b = "y" ;` becomes `a ::= "x" ; b = "y"` (:296-302, :338).
  Fix: split at top-level terminators.
M3. Left recursion (analysis.ts:302-330, 390-414).
  - With `a ::= b | a "x"` and `b ::= a "y"`, the "indirect" message reads `a -> a`, because cyclePath takes the self-loop. The rule also gets a duplicate "direct" diagnostic, and `b` gets nothing.
  - Fix: on the first step from start, skip the `start -> start` edge. Emit one diagnostic per SCC member: direct when it has a self-edge, otherwise indirect with that member's path. This settles the granularity limitation.
M4. Unreachable is noisy (analysis.ts:445-480). Rules reached only from other top-level rules get flagged: in RFC 3986, relative-ref, relative-part, path-noscheme, segment-nz-nc and gen-delims.
  Fix: start the BFS from the start rule plus every rule that no other rule references. Then only orphan cycles are reported, which is exactly what unused misses, so the two never overlap.
M5. Removing an alternative scans characters and does not see comments (code-actions.ts:146-218).
  `a = "x" / ; or /⏎    "x"` becomes `a = "x" / ; or`: the comment is cut, a `/` is left dangling, and a new empty alternative appears.
  Fix: build the range from the BodyTokens, which carry positions and no comments. This also removes the "comment in between" skip (stated limitation 2): fix it now.
M6. Duplicates across `=/` are not detected (limitation 1; analysis.ts:507-541).
  Fix: keep one `seen` set per rule key for the top-level choice across all of the group's infos. findAltGroups must expose the top-level branch list even when it has a single branch. When a whole `=/` body is the duplicate, the removal should delete that `=/` rule.
M7. did-you-mean suggests lowercase core names, e.g. `"digit"`, and the rename writes `digit` (diagnostics.ts:52).
  Fix: use CORE_RULE_DEFINITIONS.map(r => r.name), which gives DIGIT.
M8. Settings.
  - The schema and defaults are fine and readGrammarConfig is used.
  - But nothing listens for onDidChangeConfiguration (extension.ts:48-62), so a new severity only takes effect after an edit.
  - getConfigValue ignores the dialect (diagnostics.ts:31-37), so `"[abnf]": {"bnf.diagnostics.*"}` overrides do nothing.
  - Fix: pass a `{languageId, uri}` scope into readGrammarConfig, and refresh all open grammar documents when affectsConfiguration("bnf").

## LOW
L1. `a = /` and `( | )` each give 2 identical empty-alternative diagnostics and actions (expression.ts:283-302: a leading empty branch borrows the next separator).
  The result is also an empty body or group.
  Fix: dedupe by range, and skip the fix when it would leave an empty group or body.
L2. "Create missing rule" inserts `name op⏎    ` with no body (code-actions.ts:233-238), so an empty-rule error appears right away. The `\n` is also hard-coded.
  Fix: use a SnippetTextEdit with a placeholder (check the 1.91 API) and doc.eol.
L3. Core rules are not seeded. LWSP is nullable, so `a = LWSP a "x"` is left-recursive, but this is missed (analysis.ts:576-585).
  Fix: seed nullable or expression data for core rules that the file does not redefine.
L4. `"abc" / %i"abc"` is not caught as a duplicate (expression.ts:418-433).
  Fix: normalize `%i"x"` to `"x"` lowercased.
L5. The message-regex fallbacks (code-actions.ts:24-27, 64-69, 76-81) are the same dead fallback that 3.1B #7 removed.
  Fix: match on code only, and read the name with doc.getText(diagnostic.range).
L6. The file-wide ISO action is offered even when the file has only one ISO production, which duplicates the per-production fix.
  Fix: offer it only when there are 2 or more.

## Verified OK
- Fixpoints: the worklist least fixpoint is correct.
  - ABNF `*`, `0*`, `[ ]`, `0x`, and W3C `? * +`, `-` and character classes all behave correctly.
  - Undefined references count as productive and non-nullable, which is the quieter choice.
  - Broken bodies are opaque.
  - `=/` is merged for left recursion, productive and unreachable.
  - Cross-file references are unknown, which makes them productive.
- unused and unreachable do not double-report.
- CRLF columns are correct.
- The Tarjan SCC and the BFS are linear (except H1).
- context.only works.
- 3.1B review findings 1-11 are all fixed, and the end-to-end check passes (p6.ts): =/ <-> =, wrong-kind closer, swap, case hint dedupe, only filtering, no `()` group.
