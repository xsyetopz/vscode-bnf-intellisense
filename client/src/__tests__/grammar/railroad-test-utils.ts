/**
 * Helpers that read a rendered railroad SVG the way a user sees it: the
 * visible texts, where they are drawn, and how tall the diagram is.
 */

const XML_ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&amp;": "&",
};

export function decodeXml(text: string): string {
  return text.replace(
    /&(?:lt|gt|quot|#39|amp);/g,
    (entity) => XML_ENTITIES[entity] as string,
  );
}

const TEXT_RE = /<text[^>]* x="([\d.]+)" y="([\d.-]+)"[^>]*>([^<]*)<\/text>/g;

/** The texts a reader sees in the diagram, in drawing order. */
export function labelsOf(svg: string): string[] {
  return [...svg.matchAll(TEXT_RE)].map((m) => decodeXml(m[3] as string));
}

/** Where the label with this text is drawn. */
export function positionOf(
  svg: string,
  label: string,
): { x: number; y: number } {
  const match = [...svg.matchAll(TEXT_RE)].find(
    (m) => decodeXml(m[3] as string) === label,
  );
  if (!match) {
    throw new Error(`label ${label} is not drawn`);
  }
  return { x: Number(match[1]), y: Number(match[2]) };
}

/** The height of the first diagram in the markup. */
export function heightOf(markup: string): number {
  const match = /<svg[^>]* height="(\d+)"/.exec(markup);
  if (!match) {
    throw new Error("no svg in markup");
  }
  return Number(match[1]);
}
