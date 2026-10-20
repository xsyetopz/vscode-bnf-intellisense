import type { RuleDiagram } from "./diagrams.ts";
import { type LayoutOptions, renderDiagramSvg } from "./layout.ts";
import { escapeXml, truncateText } from "./svg.ts";

const NONCE_RE = /^[A-Za-z0-9+/_=-]{16,128}$/;
const RULE_ID_RE = /^rule-\d+$/;

/**
 * DOM id of a rule section.
 */
export function ruleDomId(id: number): string {
  return `rule-${id}`;
}

/**
 * Renders the sections for all rules of one document: an HTML fragment that
 * contains only escaped grammar text and SVG, with no inline styles or
 * scripts.
 */
export function renderRulesHtml(
  diagrams: readonly RuleDiagram[],
  options: LayoutOptions = {},
): string {
  if (diagrams.length === 0) {
    return '<p class="rr-empty">This document has no rules to draw.</p>';
  }
  return diagrams.map((d) => renderRuleSection(d, options)).join("\n");
}

function renderRuleSection(
  diagram: RuleDiagram,
  options: LayoutOptions,
): string {
  const name = escapeXml(diagram.name);
  const { svg } = renderDiagramSvg(
    diagram.node,
    `Railroad diagram of rule ${diagram.name}`,
    options,
  );
  const badges: string[] = [];
  if (diagram.parts > 1) {
    badges.push(
      `<span class="rr-badge">${diagram.parts} parts merged (=/)</span>`,
    );
  }
  if (diagram.warning !== undefined) {
    badges.push(
      `<span class="rr-badge rr-badge-warning" title="${escapeXml(diagram.warning)}">=/ without an earlier definition</span>`,
    );
  }
  if (diagram.error !== undefined) {
    badges.push(
      `<span class="rr-badge rr-badge-error" title="${escapeXml(diagram.error)}">parse error: showing what parsed</span>`,
    );
  }
  const comment =
    diagram.comment === undefined || diagram.comment === ""
      ? ""
      : `<p class="rr-comment">${escapeXml(truncateText(diagram.comment, 300))}</p>`;
  return (
    `<section class="rr-rule" id="${ruleDomId(diagram.id)}" data-rule-name="${name}">` +
    `<h2 class="rr-title">${name}${badges.join("")}</h2>${comment}` +
    `<div class="rr-scroll">${svg}</div></section>`
  );
}

/**
 * Checks that an id sent to the webview is a rule section id.
 */
export function isRuleDomId(value: unknown): value is string {
  return typeof value === "string" && RULE_ID_RE.test(value);
}

const STYLE = `
body { margin: 0; padding: 8px 16px 48px; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
h1 { font-size: 1.1em; font-weight: 600; margin: 8px 0 16px; }
.rr-rule { margin: 0 0 20px; padding: 6px 8px 8px; border-left: 3px solid transparent; border-radius: 3px; }
.rr-rule.rr-current { border-left-color: var(--vscode-focusBorder); background: var(--vscode-editor-lineHighlightBackground, transparent); }
.rr-title { font-size: 1em; font-weight: 600; margin: 0 0 4px; font-family: var(--vscode-editor-font-family); }
.rr-comment { margin: 0 0 4px; color: var(--vscode-descriptionForeground); }
.rr-scroll { overflow-x: auto; }
.rr-badge { margin-left: 10px; padding: 1px 6px; border-radius: 8px; font-size: 0.8em; font-weight: normal; font-family: var(--vscode-font-family); color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); }
.rr-badge-error { color: var(--vscode-editorError-foreground); background: transparent; border: 1px solid var(--vscode-editorError-foreground); }
.rr-badge-warning { color: var(--vscode-editorWarning-foreground); background: transparent; border: 1px solid var(--vscode-editorWarning-foreground); }
.rr-empty { color: var(--vscode-descriptionForeground); }
.rr-svg { display: block; font-family: var(--vscode-editor-font-family); font-size: 13px; }
.rr-svg path.rr-line { fill: none; stroke: var(--vscode-editorLineNumber-foreground); stroke-width: 2; }
.rr-svg text { fill: var(--vscode-editor-foreground); }
.rr-svg .rr-label { fill: var(--vscode-descriptionForeground); font-size: 11px; }
.rr-svg rect { fill: var(--vscode-editor-background); stroke-width: 1.5; }
.rr-term rect { stroke: var(--vscode-charts-green); }
.rr-term-prose rect, .rr-term-note rect { stroke-dasharray: 4 3; stroke: var(--vscode-descriptionForeground); }
.rr-term-numeric rect, .rr-term-range rect, .rr-term-charcode rect, .rr-term-class rect { stroke: var(--vscode-charts-orange); }
.rr-term-string-sensitive rect { stroke: var(--vscode-charts-yellow); }
.rr-nt rect { stroke: var(--vscode-textLink-foreground); }
.rr-nt-core rect { stroke: var(--vscode-charts-purple); fill: var(--vscode-textBlockQuote-background, var(--vscode-editor-background)); }
.rr-nt-undefined rect { stroke: var(--vscode-editorWarning-foreground); stroke-dasharray: 4 3; }
.rr-nt-local, .rr-nt-external { cursor: pointer; }
.rr-nt-local text, .rr-nt-external text { fill: var(--vscode-textLink-foreground); }
.rr-nt-local:hover rect, .rr-nt-external:hover rect, .rr-nt:focus rect { fill: var(--vscode-list-hoverBackground); }
.rr-nt:focus { outline: none; }
.rr-nt:focus rect { stroke: var(--vscode-focusBorder); stroke-width: 2.5; }
.rr-group { fill: none !important; stroke: var(--vscode-descriptionForeground); stroke-dasharray: 5 4; }
.rr-error rect { stroke: var(--vscode-editorError-foreground); stroke-dasharray: 4 3; }
.rr-error text { fill: var(--vscode-editorError-foreground); }
`;

const SCRIPT = `
(function () {
  var api = acquireVsCodeApi();
  var root = document.getElementById("rr-root");
  var ID_RE = /^rule-[0-9]+$/;
  function focusRule(id) {
    if (typeof id !== "string" || !ID_RE.test(id)) { return; }
    var current = root.querySelectorAll(".rr-current");
    for (var i = 0; i < current.length; i++) { current[i].classList.remove("rr-current"); }
    var el = document.getElementById(id);
    if (el) { el.classList.add("rr-current"); el.scrollIntoView({ block: "nearest" }); }
  }
  function reveal(target) {
    if (!(target instanceof Element)) { return false; }
    var el = target.closest("[data-rule]");
    if (!el) { return false; }
    api.postMessage({ type: "reveal", rule: el.getAttribute("data-rule") });
    return true;
  }
  root.addEventListener("click", function (e) { reveal(e.target); });
  root.addEventListener("keydown", function (e) {
    if ((e.key === "Enter" || e.key === " ") && reveal(e.target)) { e.preventDefault(); }
  });
  window.addEventListener("message", function (e) {
    var m = e.data;
    if (!m || typeof m !== "object") { return; }
    if (m.type === "render" && typeof m.html === "string") {
      root.innerHTML = m.html;
      focusRule(m.focus);
    } else if (m.type === "focus") {
      focusRule(m.id);
    }
  });
  focusRule(root.getAttribute("data-focus"));
})();
`;

/**
 * Options for the full webview page.
 */
export interface PageOptions {
  nonce: string;
  title: string;
  bodyHtml: string;
  /** Section id to highlight and scroll to on load. */
  focusId?: string | undefined;
}

/**
 * Content-Security-Policy for the preview: no network, no frames, scripts and
 * styles only with the page nonce.
 */
export function contentSecurityPolicy(nonce: string): string {
  return `default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
}

/**
 * Builds the full HTML document for the webview.
 */
export function renderPage(options: PageOptions): string {
  if (!NONCE_RE.test(options.nonce)) {
    throw new Error("Invalid nonce for the railroad preview");
  }
  const { nonce } = options;
  const focus =
    options.focusId !== undefined && isRuleDomId(options.focusId)
      ? ` data-focus="${options.focusId}"`
      : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(nonce)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeXml(options.title)}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<h1>${escapeXml(options.title)}</h1>
<main id="rr-root"${focus}>
${options.bodyHtml}
</main>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}
