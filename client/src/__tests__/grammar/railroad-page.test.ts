import { describe, expect, test } from "bun:test";
import {
  charCells,
  type RefKind,
  renderDiagramSvg,
} from "../../grammar/railroad/layout.ts";
import { parseWebviewMessage } from "../../grammar/railroad/messages.ts";
import type { RailNode } from "../../grammar/railroad/model.ts";
import {
  contentSecurityPolicy,
  isRuleDomId,
  renderPage,
} from "../../grammar/railroad/page.ts";

const nt = (name: string): RailNode => ({ kind: "nonterminal", name });

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

describe("railroad page", () => {
  const nonce = "abcdef0123456789abcdef0123456789";
  const page = () => renderPage({ nonce, title: "T", bodyHtml: "<p>x</p>" });

  test("CSP allows only nonce-bound styles and scripts", () => {
    const csp = contentSecurityPolicy(nonce);

    expect(csp).toBe(
      `default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`,
    );
  });

  test.each(["unsafe", "http"])("CSP never mentions %s", (word) => {
    const csp = contentSecurityPolicy(nonce);

    expect(csp).not.toContain(word);
  });

  test("uses the nonce on exactly the style and the script", () => {
    const html = page();

    expect(html.match(new RegExp(`nonce="${nonce}"`, "g"))?.length).toBe(2);
    expect(html.match(/<script/g)?.length).toBe(1);
  });

  test.each([
    ["external URLs", /https?:\/\//],
    ["inline event handlers", /\son[a-z]+=/],
    ["inline style attributes", /\sstyle=/],
    ["external resource elements", /<(link|img|iframe|object|embed)/],
  ])("has no %s", (_name, pattern) => {
    const html = page();

    expect(html).not.toMatch(pattern);
  });

  test("uses the editor theme colours", () => {
    const html = page();

    expect(html).toContain("var(--vscode-editor-background)");
  });

  test("escapes the title", () => {
    const html = renderPage({
      nonce,
      title: "</title><script>alert(1)</script>",
      bodyHtml: "",
    });

    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;/title&gt;");
  });

  test.each([
    "",
    "short",
    `${nonce}"`,
    "a b c d e f g h i j k l m n o p",
    "x".repeat(200),
  ])("rejects the invalid nonce %p", (bad) => {
    const render = () => renderPage({ nonce: bad, title: "", bodyHtml: "" });

    expect(render).toThrow();
  });

  test("emits a focus id that is a rule id", () => {
    const html = renderPage({
      nonce,
      title: "",
      bodyHtml: "",
      focusId: "rule-3",
    });

    expect(html).toContain('data-focus="rule-3"');
  });

  test("omits a focus id that is not a rule id", () => {
    const html = renderPage({
      nonce,
      title: "",
      bodyHtml: "",
      focusId: '"><x',
    });

    expect(html).not.toContain("data-focus=");
  });

  test.each([
    ["rule-12", true],
    ["rule-", false],
    ["rule-1 ", false],
    [5, false],
  ])("isRuleDomId(%p) is %p", (id, expected) => {
    const result = isRuleDomId(id);

    expect(result).toBe(expected);
  });
});

describe("railroad webview message validation", () => {
  const known = (name: string) => name === "rule" || name === "<x y>";

  test("accepts a reveal of a known rule", () => {
    const message = parseWebviewMessage(
      { type: "reveal", rule: "rule" },
      known,
    );

    expect(message).toEqual({ type: "reveal", rule: "rule" });
  });

  test("accepts a rule name containing spaces and drops extra fields", () => {
    const message = parseWebviewMessage(
      { type: "reveal", rule: "<x y>", extra: 1 },
      known,
    );

    expect(message).toEqual({ type: "reveal", rule: "<x y>" });
  });

  test.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "reveal"],
    ["a number", 42],
    ["an array", []],
    ["an empty object", {}],
    ["a reveal without a rule", { type: "reveal" }],
    ["a non-string rule", { type: "reveal", rule: 5 }],
    ["an empty rule", { type: "reveal", rule: "" }],
    ["an unknown rule", { type: "reveal", rule: "nope" }],
    ["an oversized rule", { type: "reveal", rule: "x".repeat(10_000) }],
    ["a type in the wrong case", { type: "REVEAL", rule: "rule" }],
    ["an unknown type", { type: "exec", rule: "rule" }],
    ["an array type", { type: ["reveal"], rule: "rule" }],
    ["a missing type", { rule: "rule" }],
  ])("rejects %s", (_name, message) => {
    const parsed = parseWebviewMessage(message, known);

    expect(parsed).toBeUndefined();
  });

  test("rejects properties inherited through the prototype", () => {
    const inherited = Object.create({ type: "reveal", rule: "rule" });

    const parsed = parseWebviewMessage(inherited, known);

    expect(parsed).toBeUndefined();
  });

  test("rejects a rule inherited through the prototype", () => {
    const inherited = Object.assign(Object.create({ rule: "rule" }), {
      type: "reveal",
    });

    const parsed = parseWebviewMessage(inherited, known);

    expect(parsed).toBeUndefined();
  });

  test("rejects a message that smuggles fields through __proto__", () => {
    const raw = JSON.parse('{"__proto__":{"type":"reveal","rule":"rule"}}');

    const parsed = parseWebviewMessage(raw, known);

    expect(parsed).toBeUndefined();
  });

  test("rejects a constructor function as the message", () => {
    const parsed = parseWebviewMessage(Object, known);

    expect(parsed).toBeUndefined();
  });

  test("ignores an own __proto__ field next to valid fields", () => {
    const raw = JSON.parse(
      '{"type":"reveal","rule":"rule","__proto__":{"rule":"<x y>"}}',
    );

    const parsed = parseWebviewMessage(raw, known);

    expect(parsed).toEqual({ type: "reveal", rule: "rule" });
  });
});

describe("railroad text width", () => {
  const boxWidth = (label: string): number => {
    const { svg } = render(nt(label));
    return Number(/<rect[^>]* width="([\d.]+)"/.exec(svg)?.[1]);
  };

  test.each([
    ["a CJK ideograph", 0x6f22, 2],
    ["a fullwidth letter", 0xff21, 2],
    ["a Hangul syllable", 0xac00, 2],
    ["an emoji", 0x1f600, 2],
    ["a Latin letter", 0x41, 1],
    ["a combining accent", 0x301, 0],
  ])("counts %s as %i cells", (_name, codePoint, cells) => {
    expect(charCells(codePoint)).toBe(cells);
  });

  test("gives wide characters a wider box than the same number of Latin ones", () => {
    const latin = boxWidth("abcd");

    const wide = boxWidth("漢字漢字");

    expect(wide).toBeGreaterThan(latin);
  });

  test("gives emoji labels a wider box than the same number of Latin ones", () => {
    const latin = boxWidth("abc");

    const emoji = boxWidth("😀😀😀");

    expect(emoji).toBeGreaterThan(latin);
  });
});
