import type { RailNode } from "./model.ts";
import { escapeXml, num, sanitizeText, truncateText } from "./svg.ts";

/**
 * How a nonterminal resolves, which decides how it is drawn and whether it
 * is a link.
 */
export type RefKind = "local" | "external" | "core" | "undefined";

/**
 * Options for laying out one rule.
 */
export interface LayoutOptions {
  /** Classifies a nonterminal name. Defaults to `"local"` for all names. */
  resolveRef?: (name: string) => RefKind;
  /** Sequences wider than this wrap onto several rows. */
  maxRowWidth?: number;
}

// Geometry, in SVG user units.
const R = 8;
const GAP = 16;
const BOX_HALF = 13;
const CHAR_W = 7.8;
const TEXT_PAD = 12;
const VGAP = 10;
const ROW_GAP = 4 * R;
const MAX_LABEL = 48;
const DEFAULT_MAX_ROW = 800;
const MIN_BOX_W = 22;
const LOOP_LABEL_H = 16;

/**
 * A laid-out node: width, extent above and below its baseline, and a drawer
 * that returns SVG markup with the baseline at the given point.
 */
export interface Box {
  w: number;
  up: number;
  down: number;
  draw(x: number, y: number): string;
}

interface Context {
  resolveRef: (name: string) => RefKind;
  maxRowWidth: number;
}

function hline(x1: number, x2: number, y: number): string {
  return x2 > x1 ? `M${num(x1)} ${num(y)}H${num(x2)}` : "";
}

function path(d: string): string {
  return d === "" ? "" : `<path class="rr-line" d="${d}"/>`;
}

const WIDE_CHAR_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals, symbols, punctuation
  [0x3041, 0x33ff], // Kana, CJK compatibility
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe6f], // CJK compatibility forms
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x1f300, 0x1faff], // Emoji and pictographs
  [0x20000, 0x3fffd], // CJK extensions B and later
];

/**
 * Estimated advance of one code point, in characters of the base font: wide
 * East Asian and emoji code points take two, combining marks and joiners none.
 */
export function charCells(codePoint: number): number {
  if (
    (codePoint >= 0x300 && codePoint <= 0x36f) ||
    codePoint === 0x200d ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  ) {
    return 0;
  }
  return WIDE_CHAR_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi)
    ? 2
    : 1;
}

function textWidth(text: string): number {
  let cells = 0;
  for (const char of text) {
    cells += charCells(char.codePointAt(0) as number);
  }
  return Math.max(MIN_BOX_W, cells * CHAR_W + TEXT_PAD * 2);
}

const EMPTY_BOX: Box = { w: 0, up: 0, down: 0, draw: () => "" };

function emptyBox(): Box {
  return EMPTY_BOX;
}

function labelBox(
  text: string,
  className: string,
  fullText: string | undefined,
  link: string | undefined,
  shape: "pill" | "rect",
): Box {
  const shown = sanitizeText(truncateText(text, MAX_LABEL));
  const w = textWidth(shown);
  const tooltip =
    fullText !== undefined || shown !== sanitizeText(text)
      ? `<title>${escapeXml(fullText ?? text)}</title>`
      : "";
  return {
    w,
    up: BOX_HALF,
    down: BOX_HALF,
    draw: (x, y) => {
      const radius = shape === "pill" ? BOX_HALF : 3;
      const body =
        `<rect x="${num(x)}" y="${num(y - BOX_HALF)}" width="${num(w)}" height="${BOX_HALF * 2}" rx="${radius}"/>` +
        `<text x="${num(x + w / 2)}" y="${num(y + 4)}" text-anchor="middle">${escapeXml(shown)}</text>`;
      return link === undefined
        ? `<g class="${className}">${tooltip}${body}</g>`
        : `<g class="${className}" ${link}>${tooltip}${body}</g>`;
    },
  };
}

function nonterminalBox(name: string, ctx: Context): Box {
  const kind = ctx.resolveRef(name);
  const escaped = escapeXml(name);
  const link =
    kind === "local" || kind === "external"
      ? `data-rule="${escaped}" tabindex="0" role="link" aria-label="Go to rule ${escaped}"`
      : undefined;
  const hint: Record<RefKind, string> = {
    local: name,
    external: `${name} (defined in another file)`,
    core: `${name} (ABNF core rule)`,
    undefined: `${name} (not defined)`,
  };
  return labelBox(name, `rr-nt rr-nt-${kind}`, hint[kind], link, "rect");
}

function seqRows(boxes: readonly Box[], maxRow: number): Box[][] {
  const rows: Box[][] = [];
  let row: Box[] = [];
  let width = 0;
  for (const box of boxes) {
    const next = width + (row.length > 0 ? GAP : 0) + box.w;
    if (row.length > 0 && next > maxRow) {
      rows.push(row);
      row = [];
      width = 0;
    }
    width += (row.length > 0 ? GAP : 0) + box.w;
    row.push(box);
  }
  if (row.length > 0) {
    rows.push(row);
  }
  return rows;
}

function rowBox(row: readonly Box[]): Box {
  const w = row.reduce((sum, b) => sum + b.w, 0) + GAP * (row.length - 1);
  return {
    w,
    up: Math.max(...row.map((b) => b.up)),
    down: Math.max(...row.map((b) => b.down)),
    draw: (x, y) => {
      let cursor = x;
      let lines = "";
      let out = "";
      for (const [i, box] of row.entries()) {
        if (i > 0) {
          lines += hline(cursor, cursor + GAP, y);
          cursor += GAP;
        }
        out += box.draw(cursor, y);
        cursor += box.w;
      }
      return path(lines) + out;
    },
  };
}

function seqBox(items: readonly RailNode[], ctx: Context): Box {
  const boxes = items.map((item) => layoutNode(item, ctx));
  const rows = seqRows(boxes, ctx.maxRowWidth).map(rowBox);
  const first = rows[0];
  if (!first) {
    return emptyBox();
  }
  if (rows.length === 1) {
    return first;
  }
  const inner = Math.max(...rows.map((r) => r.w));
  const w = inner + 4 * R;
  const baselines: number[] = [0];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1] as Box;
    const row = rows[i] as Box;
    baselines.push((baselines[i - 1] as number) + prev.down + ROW_GAP + row.up);
  }
  const last = rows[rows.length - 1] as Box;
  return {
    w,
    up: first.up,
    down: (baselines[rows.length - 1] as number) + last.down,
    draw: (x, y) => {
      let out = "";
      let lines = "";
      for (const [i, row] of rows.entries()) {
        const rowY = y + (baselines[i] as number);
        out += row.draw(x + 2 * R, rowY);
        if (i < rows.length - 1) {
          const nextY = y + (baselines[i + 1] as number);
          const nextRow = rows[i + 1] as Box;
          const mid = (rowY + row.down + nextY - nextRow.up) / 2;
          const endX = x + 2 * R + row.w;
          lines +=
            `M${num(endX)} ${num(rowY)}H${num(x + w - R)}` +
            `a${R} ${R} 0 0 1 ${R} ${R}V${num(mid - R)}` +
            `a${R} ${R} 0 0 1 ${-R} ${R}H${num(x + R)}` +
            `a${R} ${R} 0 0 0 ${-R} ${R}V${num(nextY - R)}` +
            `a${R} ${R} 0 0 0 ${R} ${R}H${num(x + 2 * R)}`;
        }
      }
      return path(lines) + out;
    },
  };
}

/**
 * Stacks branches around the baseline. `normal` stays on the baseline,
 * earlier branches go above it, later ones below it.
 */
function choiceBox(branches: readonly Box[], normal: number): Box {
  const inner = Math.max(...branches.map((b) => b.w));
  const w = inner + 4 * R;
  const offsets: number[] = new Array(branches.length).fill(0);
  for (let i = normal + 1; i < branches.length; i++) {
    const prev = branches[i - 1] as Box;
    const cur = branches[i] as Box;
    offsets[i] = Math.max(
      (offsets[i - 1] as number) + prev.down + VGAP + cur.up,
      i === normal + 1 ? 2 * R : 0,
    );
  }
  for (let i = normal - 1; i >= 0; i--) {
    const next = branches[i + 1] as Box;
    const cur = branches[i] as Box;
    offsets[i] = Math.min(
      (offsets[i + 1] as number) - next.up - VGAP - cur.down,
      i === normal - 1 ? -2 * R : 0,
    );
  }
  let up = 0;
  let down = 0;
  for (const [i, b] of branches.entries()) {
    up = Math.max(up, b.up - (offsets[i] as number));
    down = Math.max(down, b.down + (offsets[i] as number));
  }
  return {
    w,
    up,
    down,
    draw: (x, y) => {
      let lines = "";
      let out = "";
      for (const [i, b] of branches.entries()) {
        const dy = offsets[i] as number;
        const bx = x + 2 * R + (inner - b.w) / 2;
        const by = y + dy;
        out += b.draw(bx, by);
        if (dy === 0) {
          lines += hline(x, bx, by) + hline(bx + b.w, x + w, by);
          continue;
        }
        const dir = dy > 0 ? 1 : -1;
        // dir 1: down, curves clockwise then counter-clockwise; -1 mirrored.
        const s1 = dir > 0 ? 1 : 0;
        const s2 = dir > 0 ? 0 : 1;
        lines +=
          `M${num(x)} ${num(y)}a${R} ${R} 0 0 ${s1} ${R} ${dir * R}` +
          `V${num(by - dir * R)}a${R} ${R} 0 0 ${s2} ${R} ${dir * R}` +
          hline(x + 2 * R, bx, by) +
          hline(bx + b.w, x + w - 2 * R, by) +
          `M${num(x + w - 2 * R)} ${num(by)}a${R} ${R} 0 0 ${s2} ${R} ${-dir * R}` +
          `V${num(y + dir * R)}a${R} ${R} 0 0 ${s1} ${R} ${-dir * R}`;
      }
      return path(lines) + out;
    },
  };
}

function loopLabel(min: number, max: number | null): string | undefined {
  if (max === null) {
    return min <= 1 ? undefined : `${min}+×`;
  }
  return min === max ? `${min}×` : `${min}–${max}×`;
}

/** One-or-more loop with a return path below the item. */
function loopBox(item: Box, label: string | undefined): Box {
  const w = item.w + 4 * R;
  const loopY = item.down + VGAP + R;
  const down = loopY + (label === undefined ? 2 : LOOP_LABEL_H);
  return {
    w,
    up: item.up,
    down,
    draw: (x, y) => {
      const ly = y + loopY;
      const lines =
        hline(x, x + 2 * R, y) +
        hline(x + 2 * R + item.w, x + w, y) +
        `M${num(x + w - 2 * R)} ${num(y)}a${R} ${R} 0 0 1 ${R} ${R}` +
        `V${num(ly - R)}a${R} ${R} 0 0 1 ${-R} ${R}H${num(x + 2 * R)}` +
        `a${R} ${R} 0 0 1 ${-R} ${-R}V${num(y + R)}a${R} ${R} 0 0 1 ${R} ${-R}`;
      const text =
        label === undefined
          ? ""
          : `<text class="rr-label" x="${num(x + w / 2)}" y="${num(ly + 13)}" text-anchor="middle">${escapeXml(label)}</text>`;
      return path(lines) + item.draw(x + 2 * R, y) + text;
    },
  };
}

function groupBox(item: Box, caption: string): Box {
  const w = item.w + 12;
  const up = item.up + 18;
  const down = item.down + 6;
  return {
    w,
    up,
    down,
    draw: (x, y) =>
      `<rect class="rr-group" x="${num(x)}" y="${num(y - up)}" width="${num(w)}" height="${num(up + down)}" rx="6"/>` +
      `<text class="rr-label" x="${num(x + 8)}" y="${num(y - item.up - 5)}">${escapeXml(caption)}</text>` +
      path(hline(x, x + 6, y) + hline(x + 6 + item.w, x + w, y)) +
      item.draw(x + 6, y),
  };
}

function layoutNode(node: RailNode, ctx: Context): Box {
  switch (node.kind) {
    case "empty":
      return emptyBox();
    case "seq":
      return seqBox(node.items, ctx);
    case "choice":
      return node.branches.length === 0
        ? emptyBox()
        : choiceBox(
            node.branches.map((b) => layoutNode(b, ctx)),
            0,
          );
    case "optional":
      return choiceBox([emptyBox(), layoutNode(node.item, ctx)], 1);
    case "loop": {
      const inner = layoutNode(node.item, ctx);
      const looped = loopBox(inner, loopLabel(node.min, node.max));
      return node.min === 0 ? choiceBox([emptyBox(), looped], 1) : looped;
    }
    case "terminal":
      return labelBox(
        node.text,
        `rr-term rr-term-${node.terminal}`,
        node.title === undefined
          ? undefined
          : `${node.text} \u2014 ${node.title}`,
        undefined,
        "pill",
      );
    case "nonterminal":
      return nonterminalBox(node.name, ctx);
    case "except":
      return exceptBox(node, ctx);
    case "error":
      return labelBox(
        `⚠ ${node.text}`,
        "rr-error",
        `Syntax error near: ${node.text}`,
        undefined,
        "rect",
      );
    default:
      return emptyBox();
  }
}

function exceptBox(
  node: Extract<RailNode, { kind: "except" }>,
  ctx: Context,
): Box {
  const base = layoutNode(node.base, ctx);
  const excluded = groupBox(layoutNode(node.excluded, ctx), "not");
  return rowBox([base, excluded]);
}

/**
 * Rendered SVG of one rule diagram.
 */
export interface RenderedDiagram {
  svg: string;
  width: number;
  height: number;
}

const MARGIN = 14;
const TERMINATOR = 12;

/**
 * Lays out a node and returns a complete `<svg>` element. Pure: depends only
 * on its arguments.
 */
export function renderDiagramSvg(
  node: RailNode,
  label: string,
  options: LayoutOptions = {},
): RenderedDiagram {
  const ctx: Context = {
    resolveRef: options.resolveRef ?? (() => "local"),
    maxRowWidth: options.maxRowWidth ?? DEFAULT_MAX_ROW,
  };
  const body =
    node.kind === "empty"
      ? labelBox(
          "(empty)",
          "rr-term rr-term-note",
          undefined,
          undefined,
          "pill",
        )
      : layoutNode(node, ctx);
  const width = Math.ceil(body.w + 2 * (MARGIN + TERMINATOR + GAP / 2));
  const height = Math.ceil(body.up + body.down + 2 * MARGIN);
  const y = MARGIN + body.up;
  const startX = MARGIN;
  const bodyX = startX + TERMINATOR + GAP / 2;
  const endX = bodyX + body.w + GAP / 2;
  const frame = path(
    hline(startX + 4, bodyX, y) +
      hline(bodyX + body.w, endX + 4, y) +
      `M${num(startX)} ${num(y - 7)}V${num(y + 7)}` +
      `M${num(endX + 4)} ${num(y - 7)}V${num(y + 7)}` +
      `M${num(endX + 8)} ${num(y - 7)}V${num(y + 7)}`,
  );
  const svg =
    `<svg class="rr-svg" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(label)}">` +
    frame +
    body.draw(bodyX, y) +
    "</svg>";
  return { svg, width, height };
}
