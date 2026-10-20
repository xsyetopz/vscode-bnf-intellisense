import { type Diagnostic, DiagnosticSeverity, Range } from "vscode";
import { AbnfDiagnosticCode } from "./diagnostic-codes.ts";
import { tokenizeDocument } from "./tokenizer.ts";
import { AbnfTokenKind } from "./types.ts";

const UPPERCASE_RE = /[A-Z]/;

/**
 * Opt-in hints for quoted strings that contain uppercase letters. In ABNF
 * `"GET"` matches `get` and `Get` too (RFC 5234); `%s"GET"` (RFC 7405) matches
 * the exact case only. Strings without uppercase letters are never reported,
 * so lowercase keywords stay quiet. The caller decides, from a setting that
 * is off by default, whether to call this.
 */
export function collectAbnfCaseHints(text: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const token of tokenizeDocument(text)) {
    if (
      token.kind !== AbnfTokenKind.String ||
      !UPPERCASE_RE.test(token.text) ||
      token.text.length < 2 ||
      !token.text.endsWith('"')
    ) {
      continue;
    }
    diagnostics.push({
      message: `String ${token.text} also matches other letter cases (RFC 5234); write %s${token.text} to match the exact case`,
      range: new Range(
        token.line,
        token.column,
        token.line,
        token.column + token.text.length,
      ),
      severity: DiagnosticSeverity.Hint,
      code: AbnfDiagnosticCode.CaseInsensitiveString,
      source: "abnf",
    });
  }
  return diagnostics;
}
