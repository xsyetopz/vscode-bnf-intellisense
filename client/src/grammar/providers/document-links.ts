import {
  type CancellationToken,
  DocumentLink,
  type DocumentLinkProvider,
  Range,
  type TextDocument,
  Uri,
} from "vscode";
import { grammarDialectFromLanguageId } from "../grammar.ts";
import { layoutGrammar } from "../rule-layout.ts";

const RFC_BASE_URL = "https://www.rfc-editor.org/rfc/rfc";
/**
 * `RFC 5234`, `RFC5234`, `rfc-5234`, `RFC<tab>5234`, but not `XRFC 5234`,
 * `RFC 52345678`, or `RFC5234bis`.
 */
const RFC_RE = /(?<![A-Za-z0-9])RFC[ \t-]?(\d{1,5})(?![\dA-Za-z])/gi;
/** Plain URLs are already linked by VS Code, including any `RFC` inside. */
const URL_RE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/g;
const LINE_SPLIT_RE = /\r\n|\n|\r/;

function urlSpans(line: string): Array<[number, number]> {
  return Array.from(line.matchAll(URL_RE), (match) => [
    match.index ?? 0,
    (match.index ?? 0) + match[0].length,
  ]);
}

/**
 * VS Code document link provider: turns `RFC 1234` mentions inside comments
 * into links to the rfc-editor.org page. The extension itself never fetches
 * anything; VS Code opens the link when the user follows it.
 */
export class GrammarDocumentLinkProvider implements DocumentLinkProvider {
  provideDocumentLinks(
    doc: TextDocument,
    token?: CancellationToken,
  ): DocumentLink[] {
    const dialect = grammarDialectFromLanguageId(doc.languageId);
    const { comments } = layoutGrammar(doc.getText(), dialect);
    const links: DocumentLink[] = [];
    for (const comment of comments) {
      if (token?.isCancellationRequested) {
        break;
      }
      // Block comments span lines: scan each line on its own.
      const lines = comment.text.split(LINE_SPLIT_RE);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const column = i === 0 ? comment.column : 0;
        const urls = urlSpans(line);
        for (const match of line.matchAll(RFC_RE)) {
          const start = match.index ?? 0;
          const end = start + match[0].length;
          const number = Number.parseInt(match[1] ?? "", 10);
          if (
            number < 1 ||
            urls.some(([from, to]) => start < to && end > from)
          ) {
            continue;
          }
          links.push(
            new DocumentLink(
              new Range(
                comment.line + i,
                column + start,
                comment.line + i,
                column + end,
              ),
              Uri.parse(`${RFC_BASE_URL}${number}`),
            ),
          );
        }
      }
    }
    return links;
  }
}
