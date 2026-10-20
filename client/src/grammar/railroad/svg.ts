/**
 * Escaping and text helpers for the railroad SVG and HTML output. Grammar
 * files are untrusted, so every piece of grammar text goes through
 * `escapeXml` before it reaches markup.
 */

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const XML_SPECIAL_RE = /[&<>"']/g;
/**
 * Replaces control characters with their Unicode control pictures and line
 * breaks and tabs with visible escapes, so text is safe for XML and keeps a
 * single line.
 */
export function sanitizeText(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029) {
      out += "\u21b5";
    } else if (code === 0x09) {
      out += "\u21e5";
    } else if (code < 0x20) {
      out += String.fromCharCode(0x2400 + code);
    } else if (code === 0x7f) {
      out += "\u2421";
    } else if (code === 0xfffe || code === 0xffff) {
      out += "\ufffd";
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text.slice(i, i + 2);
        i++;
      } else {
        out += "\ufffd";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += "\ufffd";
    } else {
      out += text[i];
    }
  }
  return out;
}

/**
 * Escapes text for use as XML/HTML character data or attribute value.
 */
export function escapeXml(text: string): string {
  return sanitizeText(text).replace(
    XML_SPECIAL_RE,
    (ch) => XML_ESCAPES[ch] as string,
  );
}

/**
 * Shortens text to `max` code points, ending with an ellipsis when cut.
 */
export function truncateText(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join("")}…`;
}

/**
 * Formats a number for SVG coordinates.
 */
export function num(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
