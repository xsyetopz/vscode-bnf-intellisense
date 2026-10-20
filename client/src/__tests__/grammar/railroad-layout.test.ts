import { describe, expect, test } from "bun:test";
import {
  buildAbnfBody,
  buildProductionBody,
} from "../../grammar/railroad/build.ts";
import {
  type RefKind,
  renderDiagramSvg,
} from "../../grammar/railroad/layout.ts";
import {
  choiceOf,
  optionalOf,
  type RailNode,
  repeatOf,
  seqOf,
} from "../../grammar/railroad/model.ts";
import {
  escapeXml,
  sanitizeText,
  truncateText,
} from "../../grammar/railroad/svg.ts";
import { labelsOf, positionOf } from "./railroad-test-utils.ts";

const term = (text: string): RailNode => ({
  kind: "terminal",
  terminal: "string",
  text,
});
const nt = (name: string): RailNode => ({ kind: "nonterminal", name });

const ALLOWED_TAGS = new Set(["svg", "path", "g", "rect", "text", "title"]);
const ALLOWED_ATTRS = new Set([
  "class",
  "xmlns",
  "width",
  "height",
  "viewBox",
  "role",
  "aria-label",
  "d",
  "x",
  "y",
  "rx",
  "text-anchor",
  "data-rule",
  "tabindex",
]);

function assertSafeSvg(svg: string): void {
  const tagRe = /<(\/?)([A-Za-z][\w-]*)((?:\s+[\w:-]+="[^"<>]*")*)\s*(\/?)>/g;
  const stack: string[] = [];
  let last = 0;
  for (const match of svg.matchAll(tagRe)) {
    const between = svg.slice(last, match.index);
    expect(between).not.toMatch(/[<>]/);
    last = (match.index ?? 0) + match[0].length;
    const [, closing, name, attrs, selfClosing] = match;
    expect(ALLOWED_TAGS.has(name as string)).toBe(true);
    for (const attr of (attrs as string).matchAll(/([\w:-]+)="/g)) {
      expect(ALLOWED_ATTRS.has(attr[1] as string)).toBe(true);
    }
    if (closing) {
      expect(stack.pop()).toBe(name as string);
    } else if (!selfClosing) {
      stack.push(name as string);
    }
  }
  expect(svg.slice(last)).not.toMatch(/[<>]/);
  expect(stack).toEqual([]);
}

function render(
  node: RailNode,
  resolveRef?: (name: string) => RefKind,
  maxRowWidth?: number,
) {
  return renderDiagramSvg(node, "test", {
    ...(resolveRef ? { resolveRef } : {}),
    ...(maxRowWidth === undefined ? {} : { maxRowWidth }),
  });
}

function drawBody(text: string, dialect: "bnf" | "ebnf" | "rbnf") {
  const { node, broken } = buildProductionBody(text, dialect);
  return { ...render(node), broken };
}

describe("railroad escaping", () => {
  test("escapeXml escapes every markup character", () => {
    const escaped = escapeXml(`<a href="x">&'</a>`);

    expect(escaped).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  });

  test("sanitizeText replaces control characters and line breaks", () => {
    const sanitized = sanitizeText("a\nb\tc\u0000d\u007fe");

    expect(sanitized).toBe("a↵b⇥c␀d␡e");
  });

  test("sanitizeText replaces lone surrogates", () => {
    const sanitized = sanitizeText("a\ud800b");

    expect(sanitized).toBe("a�b");
  });

  test("sanitizeText keeps valid surrogate pairs", () => {
    const sanitized = sanitizeText("😀");

    expect(sanitized).toBe("😀");
  });

  test.each([
    ["U+2028 line separator", "\u2028"],
    ["U+2029 paragraph separator", "\u2029"],
  ])("sanitizeText shows the %s as a line break symbol", (_name, separator) => {
    const sanitized = sanitizeText(`a${separator}b`);

    expect(sanitized).toBe("a↵b");
  });

  test("truncateText shortens long text with an ellipsis", () => {
    const truncated = truncateText("abcdef", 4);

    expect(truncated).toBe("abc…");
  });

  test("truncateText leaves short text alone", () => {
    const truncated = truncateText("abc", 4);

    expect(truncated).toBe("abc");
  });

  test("truncateText counts code points", () => {
    const truncated = truncateText("😀😀😀", 2);

    expect(Array.from(truncated)).toEqual(["😀", "…"]);
  });

  describe("hostile terminals and names", () => {
    const hostile = [
      "</script><script>alert(1)</script>",
      '"><img src=x onerror=alert(1)>',
      "&amp;&lt;]]>",
      "'; DROP",
      "\u0000\u001f</svg>",
    ];
    const node = seqOf([
      ...hostile.map(term),
      ...hostile.map(nt),
      { kind: "error", text: hostile[0] as string },
    ]);

    test("never produce unsafe markup", () => {
      const { svg } = render(node);

      assertSafeSvg(svg);
    });

    test.each(["<script", "</script", "<img"])("never produce %s", (markup) => {
      const { svg } = render(node);

      expect(svg).not.toContain(markup);
    });

    test.each(["&lt;/script&gt;", "&amp;amp;"])(
      "are shown escaped as %s",
      (escaped) => {
        const { svg } = render(node);

        expect(svg).toContain(escaped);
      },
    );
  });

  test("escapes a hostile data-rule value as an attribute", () => {
    const { svg } = render(nt('x" onclick="alert(1)'), () => "local");

    assertSafeSvg(svg);
    expect(svg).toContain('data-rule="x&quot; onclick=&quot;alert(1)"');
  });

  test("escapes the aria-label", () => {
    const { svg } = renderDiagramSvg(term("a"), '"><script>', {});

    assertSafeSvg(svg);
    expect(svg).toContain('aria-label="&quot;&gt;&lt;script&gt;"');
  });
});

describe("railroad layout constructs", () => {
  test("draws terminals and linked nonterminals as focusable boxes", () => {
    const { svg } = render(seqOf([term('"abc"'), nt("rule")]), () => "local");

    assertSafeSvg(svg);
    expect(svg).toContain('class="rr-term rr-term-string"');
    expect(svg).toContain('class="rr-nt rr-nt-local"');
    expect(svg).toContain('data-rule="rule"');
    expect(svg).toContain('tabindex="0"');
  });

  test.each([
    ["core", false],
    ["undefined", false],
    ["local", true],
    ["external", true],
  ] as const)("%s nonterminal is a link: %p", (kind, link) => {
    const { svg } = render(nt("x"), () => kind);

    expect(svg).toContain(`rr-nt-${kind}`);
    expect(svg.includes("data-rule=")).toBe(link);
  });

  test("sequence puts items left to right", () => {
    const { svg } = render(seqOf([nt("a"), nt("b"), nt("c")]));

    const xs = [...svg.matchAll(/<rect x="([\d.]+)"/g)].map((m) =>
      Number(m[1]),
    );
    expect(xs.length).toBe(3);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  });

  test("choice stacks branches vertically", () => {
    const { svg } = render(choiceOf([nt("a"), nt("b"), nt("c")]));

    const ys = [...svg.matchAll(/<rect x="[\d.]+" y="([\d.-]+)"/g)].map((m) =>
      Number(m[1]),
    );
    assertSafeSvg(svg);
    expect(ys[0]).toBeLessThan(ys[1] as number);
    expect(ys[1]).toBeLessThan(ys[2] as number);
  });

  test("optional is taller than its item because of the bypass", () => {
    const plain = render(nt("a"));

    const opt = render(optionalOf(nt("a")));

    expect(opt.height).toBeGreaterThan(plain.height);
  });

  test("one-or-more adds a return path below the item and no label", () => {
    const plain = render(nt("a"));

    const { svg, height } = render(repeatOf(nt("a"), 1, null));

    assertSafeSvg(svg);
    expect(svg).not.toContain("rr-label");
    expect(height).toBeGreaterThan(plain.height);
  });

  test("zero-or-more is taller than one-or-more because it adds a bypass", () => {
    const one = render(repeatOf(nt("a"), 1, null));

    const zero = render(repeatOf(nt("a"), 0, null));

    expect(zero.height).toBeGreaterThan(one.height);
  });

  test.each([
    [2, 5, "2–5×"],
    [3, 3, "3×"],
    [2, null, "2+×"],
    [0, 4, "0–4×"],
  ] as const)("counted repetition %p*%p is labelled %p", (min, max, label) => {
    const { svg } = render(repeatOf(nt("a"), min, max));

    assertSafeSvg(svg);
    expect(svg).toContain(`>${label}</text>`);
  });

  test("exclusion draws a labelled dashed group", () => {
    const { svg } = render({
      kind: "except",
      base: nt("Char"),
      excluded: term("'-'"),
    });

    assertSafeSvg(svg);
    expect(svg).toContain("rr-group");
    expect(svg).toContain(">not</text>");
  });

  test("error nodes are marked and show their text", () => {
    const { svg } = render({ kind: "error", text: "::=" });

    assertSafeSvg(svg);
    expect(svg).toContain('class="rr-error"');
    expect(svg).toContain("::=");
  });

  test("empty body shows a placeholder", () => {
    const { svg } = render({ kind: "empty" });

    assertSafeSvg(svg);
    expect(svg).toContain("(empty)");
  });

  test("empty alternatives draw a straight bypass instead of a box", () => {
    const { svg } = render(choiceOf([nt("a"), { kind: "empty" }, nt("b")]));

    assertSafeSvg(svg);
    expect(svg.match(/<rect/g)?.length).toBe(2);
  });

  test("empty sequence items and empty choices render safely", () => {
    const node: RailNode = {
      kind: "seq",
      items: [{ kind: "empty" }, { kind: "choice", branches: [] }, nt("a")],
    };

    const { svg } = render(node);

    assertSafeSvg(svg);
  });
});

describe("railroad repetition normalisation", () => {
  const drawn = (node: RailNode) => render(node).svg;

  test("exactly once is drawn as the item itself", () => {
    const once = drawn(repeatOf(nt("a"), 1, 1));

    expect(once).toBe(drawn(nt("a")));
  });

  test("zero or once is drawn as an optional", () => {
    const zeroOrOnce = drawn(repeatOf(nt("a"), 0, 1));

    expect(zeroOrOnce).toBe(drawn(optionalOf(nt("a"))));
    expect(render(repeatOf(nt("a"), 0, 1)).height).toBeGreaterThan(
      render(nt("a")).height,
    );
  });

  test("zero times is drawn as a note that matches nothing", () => {
    const { svg } = render(repeatOf(nt("a"), 0, 0));

    expect(labelsOf(svg)).toEqual(["0×"]);
    expect(svg).toContain("Repeated zero times: matches nothing");
  });

  test("repeating nothing is drawn as nothing", () => {
    const nothing = drawn(repeatOf({ kind: "empty" }, 0, null));

    expect(nothing).toBe(drawn({ kind: "empty" }));
  });

  test("one-or-more of an optional is drawn as zero-or-more", () => {
    const loop = drawn(repeatOf(optionalOf(nt("a")), 1, null));

    expect(loop).toBe(drawn(repeatOf(nt("a"), 0, null)));
  });

  test("an optional of an optional is drawn as one optional", () => {
    const nested = drawn(optionalOf(optionalOf(nt("a"))));

    expect(nested).toBe(drawn(optionalOf(nt("a"))));
  });

  test("an optional of one-or-more is drawn as zero-or-more", () => {
    const loop = drawn(optionalOf(repeatOf(nt("a"), 1, null)));

    expect(loop).toBe(drawn(repeatOf(nt("a"), 0, null)));
  });

  test("invalid bounds are labelled as written", () => {
    const { svg } = render(repeatOf(nt("a"), 5, 2));

    expect(labelsOf(svg)).toContain("5–2×");
  });
});

describe("railroad layout limits", () => {
  test("truncates long terminals", () => {
    const long = `"${"x".repeat(200)}"`;

    const { svg, width } = render(term(long));

    assertSafeSvg(svg);
    expect(width).toBeLessThan(600);
    expect(svg).toContain("…</text>");
  });

  test("keeps the full text of a truncated terminal in a tooltip", () => {
    const long = `"${"x".repeat(200)}"`;

    const { svg } = render(term(long));

    expect(svg).toContain(`<title>${escapeXml(long)}</title>`);
  });

  test("wraps a very long sequence onto several rows", () => {
    const items = Array.from({ length: 200 }, (_, i) => nt(`rule${i}`));

    const { svg, width, height } = render(seqOf(items));

    assertSafeSvg(svg);
    expect(width).toBeLessThan(1100);
    expect(height).toBeGreaterThan(200);
    expect(svg.match(/<rect/g)?.length).toBe(200);
  });

  test("keeps every box of a wrapped sequence inside the diagram", () => {
    const items = Array.from({ length: 200 }, (_, i) => nt(`rule${i}`));

    const { svg, width } = render(seqOf(items));

    const rects = [
      ...svg.matchAll(/<rect x="([\d.]+)" y="[\d.-]+" width="([\d.]+)"/g),
    ];
    const rows = new Set(
      [...svg.matchAll(/<rect x="[\d.]+" y="([\d.-]+)"/g)].map((m) => m[1]),
    );
    expect(rows.size).toBeGreaterThan(1);
    expect(rects).toHaveLength(200);
    for (const [, x, w] of rects) {
      expect(Number(x) + Number(w)).toBeLessThanOrEqual(width);
    }
  });

  test("shows the labels of a wrapped sequence in reading order", () => {
    const items = Array.from({ length: 60 }, (_, i) => nt(`rule${i}`));

    const { svg } = render(seqOf(items));

    expect(labelsOf(svg)).toEqual(
      items.map((item) => (item as { name: string }).name),
    );
  });

  test("widens the diagram as a sequence gets longer", () => {
    const short = render(seqOf([nt("a"), nt("b")]));

    const long = render(
      seqOf(Array.from({ length: 6 }, (_, i) => nt(`rule${i}`))),
    );

    expect(long.width).toBeGreaterThan(short.width);
  });

  test("wraps a sequence sooner when the row width is smaller", () => {
    const items = Array.from({ length: 30 }, (_, i) => nt(`rule${i}`));

    const narrow = render(seqOf(items), undefined, 300);
    const wide = render(seqOf(items), undefined, 3000);

    expect(narrow.width).toBeLessThan(wide.width);
    expect(narrow.height).toBeGreaterThan(wide.height);
  });

  test("renders a choice of 500 branches", () => {
    const branches = Array.from({ length: 500 }, (_, i) => term(`"t${i}"`));

    const { svg, height } = render(choiceOf(branches));

    assertSafeSvg(svg);
    expect(height).toBeGreaterThan(500 * 26);
    expect(svg.match(/<rect/g)?.length).toBe(500);
  });

  test("renders deeply nested groups", () => {
    let node: RailNode = nt("leaf");
    for (let i = 0; i < 90; i++) {
      node =
        i % 2 ? optionalOf(seqOf([nt("x"), node])) : choiceOf([node, nt("y")]);
    }

    const { svg } = render(node);

    assertSafeSvg(svg);
    expect(svg).toContain("leaf");
  });
});

describe("railroad body builders", () => {
  test("flags deeply nested production input as broken", () => {
    const text = `${"(".repeat(5000)}a${")".repeat(5000)}`;

    const { broken } = drawBody(text, "bnf");

    expect(broken).toBe(true);
  });

  test("flattens deeply nested production input with a note", () => {
    const text = `${"(".repeat(5000)}a${")".repeat(5000)}`;

    const { svg } = drawBody(text, "bnf");

    assertSafeSvg(svg);
    expect(labelsOf(svg)).toContain("…");
  });

  test("collapses 10000 stacked suffixes into one zero-or-more loop", () => {
    const stacked = drawBody(`a${"?*+".repeat(3000)}`, "ebnf");

    const single = drawBody("a*", "ebnf");

    expect(stacked.svg).toBe(single.svg);
  });

  test("keeps what parsed after an unclosed group", () => {
    const open = drawBody("a ( b | c", "ebnf");

    expect(open.broken).toBe(true);
    expect(labelsOf(open.svg)).toEqual(["a", "b", "c"]);
  });

  test("keeps what parsed after an unmatched closer", () => {
    const close = drawBody("a ) b", "bnf");

    expect(close.broken).toBe(true);
    expect(labelsOf(close.svg)).toContain("b");
  });

  test("binds an exclusion to its neighbouring operands", () => {
    const { svg, broken } = drawBody("Char - '-' | x", "ebnf");

    expect(broken).toBe(false);
    expect(labelsOf(svg)).toEqual(["Char", "not", "'-'", "x"]);
    expect(positionOf(svg, "Char").y).toBe(positionOf(svg, "'-'").y);
    expect(positionOf(svg, "x").y).toBeGreaterThan(positionOf(svg, "Char").y);
  });

  test("accepts a group as an exclusion operand", () => {
    const { svg, broken } = drawBody("a - (b | c)", "ebnf");

    expect(broken).toBe(false);
    expect(labelsOf(svg)).toEqual(["a", "not", "b", "c"]);
    expect(positionOf(svg, "c").y).toBeGreaterThan(positionOf(svg, "b").y);
  });

  test.each([
    ["a leading exclusion operator", "- a"],
    ["a trailing exclusion operator", "a -"],
  ])("flags %s as broken", (_name, text) => {
    const { broken } = drawBody(text, "ebnf");

    expect(broken).toBe(true);
  });

  test("treats RBNF bare words as terminals and repeats with ...", () => {
    const repeated = drawBody("word <ref> ...", "rbnf");

    const once = drawBody("word <ref>", "rbnf");

    expect(labelsOf(repeated.svg)).toEqual(["word", "<ref>"]);
    expect(repeated.svg).toContain("rr-term rr-term-word");
    expect(repeated.svg).toContain("rr-nt rr-nt-local");
    expect(repeated.height).toBeGreaterThan(once.height);
  });

  test("treats BNF bare names as references and keeps string quotes", () => {
    const { svg } = drawBody("a 'b'", "bnf");

    expect(labelsOf(svg)).toEqual(["a", "'b'"]);
    expect(svg).toContain("rr-nt rr-nt-local");
    expect(svg).toContain("rr-term rr-term-string");
  });

  test("recognises EBNF character classes and character codes", () => {
    const { svg } = drawBody("[a-z] #x20", "ebnf");

    expect(labelsOf(svg)).toEqual(["[a-z]", "#x20"]);
    expect(svg).toContain("rr-term rr-term-class");
    expect(svg).toContain("rr-term rr-term-charcode");
  });

  test("treats braces as repeats and brackets as optionals", () => {
    const plain = drawBody("a", "bnf");

    const repeat = drawBody("{ a }", "bnf");
    const optional = drawBody("[ a ]", "bnf");

    expect(repeat.height).toBeGreaterThan(plain.height);
    expect(optional.height).toBeGreaterThan(plain.height);
    expect(repeat.height).toBeGreaterThan(optional.height);
    expect(labelsOf(repeat.svg)).toEqual(["a"]);
    expect(labelsOf(optional.svg)).toEqual(["a"]);
  });

  test("flags an unterminated string as broken", () => {
    const { broken } = drawBody("'abc", "bnf");

    expect(broken).toBe(true);
  });

  test("flags a stray assignment as broken and shows it as an error", () => {
    const stray = drawBody("a ::= b", "bnf");

    expect(stray.broken).toBe(true);
    expect(stray.svg).toContain('class="rr-error"');
    expect(labelsOf(stray.svg)).toContain("⚠ ::=");
  });

  test("draws an empty production body as an empty placeholder", () => {
    const body = drawBody("", "bnf");

    expect(body.broken).toBe(false);
    expect(labelsOf(body.svg)).toEqual(["(empty)"]);
  });

  test("flags a missing ABNF expression as broken", () => {
    const { broken } = buildAbnfBody(undefined);

    expect(broken).toBe(true);
  });
});
