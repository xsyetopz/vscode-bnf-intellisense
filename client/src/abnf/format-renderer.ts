import type { AbnfFormatterConfig, RuleBlock } from "./format.ts";
import type { AbnfToken } from "./types.ts";
import { AbnfTokenKind } from "./types.ts";

type BodyAtom = { kind: "token"; tok: AbnfToken } | { kind: "hardBreak" };

function isContinuationNewline(
  bodyTokens: readonly AbnfToken[],
  newlineIndex: number,
): boolean {
  const next = bodyTokens[newlineIndex + 1];
  return (
    next !== undefined &&
    next.kind === AbnfTokenKind.Whitespace &&
    next.column === 0
  );
}

function buildBodyAtoms(
  bodyTokens: readonly AbnfToken[],
  config: AbnfFormatterConfig,
): BodyAtom[] {
  const atoms: BodyAtom[] = [];

  for (let i = 0; i < bodyTokens.length; i++) {
    const tok = bodyTokens[i];
    if (tok === undefined) {
      continue;
    }

    if (tok.kind === AbnfTokenKind.Whitespace) {
      continue;
    }

    if (tok.kind === AbnfTokenKind.Newline) {
      if (
        config.preserveContinuationLineBreaks &&
        isContinuationNewline(bodyTokens, i)
      ) {
        atoms.push({ kind: "hardBreak" });
      }
      continue;
    }

    if (tok.kind === AbnfTokenKind.Comment) {
      // A comment alone on its line stays on its own line.
      if (atoms.length > 0 && isOwnLine(bodyTokens, i)) {
        pushHardBreak(atoms);
      }
      atoms.push({ kind: "token", tok });
      // ABNF comments end the line; if more tokens follow, they must start on a continuation line.
      atoms.push({ kind: "hardBreak" });
      continue;
    }

    atoms.push({ kind: "token", tok });
  }

  while (atoms.length > 0 && atoms[atoms.length - 1]?.kind === "hardBreak") {
    atoms.pop();
  }

  return atoms;
}

function isOwnLine(tokens: readonly AbnfToken[], index: number): boolean {
  let j = index - 1;
  while (j >= 0 && tokens[j]?.kind === AbnfTokenKind.Whitespace) {
    j--;
  }
  return j >= 0 && tokens[j]?.kind === AbnfTokenKind.Newline;
}

function pushHardBreak(atoms: BodyAtom[]): void {
  if (atoms[atoms.length - 1]?.kind !== "hardBreak") {
    atoms.push({ kind: "hardBreak" });
  }
}

function containsHardBreak(atoms: BodyAtom[]): boolean {
  return atoms.some((a) => a.kind === "hardBreak");
}

function containsComment(atoms: BodyAtom[]): boolean {
  return atoms.some(
    (a) => a.kind === "token" && a.tok.kind === AbnfTokenKind.Comment,
  );
}

function updateDepth(depth: number, tok: AbnfToken): number {
  if (
    tok.kind === AbnfTokenKind.ParenOpen ||
    tok.kind === AbnfTokenKind.BracketOpen
  ) {
    return depth + 1;
  }
  if (
    tok.kind === AbnfTokenKind.ParenClose ||
    tok.kind === AbnfTokenKind.BracketClose
  ) {
    return depth - 1;
  }
  return depth;
}

function estimateInlineBodyLength(atoms: BodyAtom[]): number {
  let prev: AbnfToken | null = null;
  let len = 0;

  for (const atom of atoms) {
    if (atom.kind === "hardBreak") {
      return Number.POSITIVE_INFINITY;
    }
    const tok = atom.tok;
    if (tok.kind === AbnfTokenKind.Comment) {
      return Number.POSITIVE_INFINITY;
    }
    if (prev && needsSpaceBetween(prev, tok)) {
      len += 1;
    }
    len += tok.text.length;
    prev = tok;
  }

  return len;
}

function hasTopLevelAlternation(atoms: BodyAtom[]): boolean {
  let depth = 0;
  for (const atom of atoms) {
    if (atom.kind === "hardBreak") {
      continue;
    }
    const tok = atom.tok;
    if (tok.kind === AbnfTokenKind.Alternation && depth === 0) {
      return true;
    }
    depth = updateDepth(depth, tok);
  }
  return false;
}

function computeEffectiveBreakAlternatives(
  atoms: BodyAtom[],
  config: AbnfFormatterConfig,
  definitionPrefixLength: number,
): boolean {
  if (!hasTopLevelAlternation(atoms)) {
    return false;
  }
  if (config.breakAlternatives === "always") {
    return true;
  }
  if (config.breakAlternatives === "never") {
    return false;
  }

  const maxLen = config.maxLineLength > 0 ? config.maxLineLength : 0;
  if (maxLen <= 0) {
    return true;
  }

  if (containsHardBreak(atoms) || containsComment(atoms)) {
    return true;
  }

  const estimated = estimateInlineBodyLength(atoms);
  return definitionPrefixLength + estimated > maxLen;
}

function splitAlternatives(
  atoms: BodyAtom[],
  multilineAlternatives: boolean,
): BodyAtom[][] {
  if (!multilineAlternatives) {
    return [atoms];
  }

  const alternatives: BodyAtom[][] = [];
  let current: BodyAtom[] = [];
  let depth = 0;

  for (const atom of atoms) {
    if (atom.kind === "hardBreak") {
      current.push(atom);
      continue;
    }

    const tok = atom.tok;
    if (tok.kind === AbnfTokenKind.Alternation && depth === 0) {
      alternatives.push(current);
      current = [];
      continue;
    }

    current.push(atom);
    depth = updateDepth(depth, tok);
  }

  alternatives.push(current);
  return alternatives;
}

function splitHardBreakLines(atoms: BodyAtom[]): AbnfToken[][] {
  const lines: AbnfToken[][] = [];
  let current: AbnfToken[] = [];

  for (const atom of atoms) {
    if (atom.kind === "hardBreak") {
      if (current.length > 0) {
        lines.push(current);
        current = [];
      }
      continue;
    }
    current.push(atom.tok);
  }

  if (current.length > 0) {
    lines.push(current);
  }

  return lines;
}

function buildDefinitionPrefix(
  rule: RuleBlock,
  nameWidth: number,
  config: AbnfFormatterConfig,
): string {
  const paddedName = config.alignEquals
    ? rule.name.padEnd(nameWidth)
    : rule.name;
  return `${paddedName} ${rule.operator} `;
}

function computeRuleIndents(
  definitionPrefix: string,
  config: AbnfFormatterConfig,
): { bodyIndent: string; altContinuationIndent: string } {
  // Continuation lines must be indented, or they would start a new rule.
  const width = Number.isFinite(config.continuationIndent)
    ? Math.max(1, Math.floor(config.continuationIndent))
    : 4;
  const continuationIndent = " ".repeat(width);

  const bodyIndent =
    config.alternativeIndent === "align"
      ? " ".repeat(definitionPrefix.length)
      : continuationIndent;

  const altContinuationIndent =
    config.alternativeIndent === "align"
      ? " ".repeat(bodyIndent.length + 2)
      : continuationIndent;

  return { bodyIndent, altContinuationIndent };
}

function computeLinePrefixes(
  definitionPrefix: string,
  bodyIndent: string,
  altContinuationIndent: string,
  altIndex: number,
  lineIndex: number,
): { firstPrefix: string; wrapPrefix: string } {
  const isFirstAlt = altIndex === 0;
  const isFirstLineInAlt = lineIndex === 0;

  const firstPrefix = isFirstLineInAlt
    ? isFirstAlt
      ? definitionPrefix
      : `${bodyIndent}/ `
    : isFirstAlt
      ? bodyIndent
      : altContinuationIndent;

  const wrapPrefix = isFirstLineInAlt
    ? isFirstAlt
      ? bodyIndent
      : altContinuationIndent
    : firstPrefix;

  return { firstPrefix, wrapPrefix };
}

function formatAlternativeLines(
  logicalLines: AbnfToken[][],
  config: AbnfFormatterConfig,
  definitionPrefix: string,
  bodyIndent: string,
  altContinuationIndent: string,
  altIndex: number,
): string[] {
  const out: string[] = [];

  for (let lineIndex = 0; lineIndex < logicalLines.length; lineIndex++) {
    const lineTokens = logicalLines[lineIndex] ?? [];
    if (lineTokens.length === 0) {
      continue;
    }

    const { firstPrefix, wrapPrefix } = computeLinePrefixes(
      definitionPrefix,
      bodyIndent,
      altContinuationIndent,
      altIndex,
      lineIndex,
    );

    out.push(
      ...renderTokensWrapped(lineTokens, config, firstPrefix, wrapPrefix),
    );
  }

  return out;
}

function formatRuleBodyLines(
  atoms: BodyAtom[],
  config: AbnfFormatterConfig,
  definitionPrefix: string,
  bodyIndent: string,
  altContinuationIndent: string,
): string[] {
  const multilineAlternatives = computeEffectiveBreakAlternatives(
    atoms,
    config,
    definitionPrefix.length,
  );
  const alternatives = splitAlternatives(atoms, multilineAlternatives);

  const outLines: string[] = [];

  for (let altIndex = 0; altIndex < alternatives.length; altIndex++) {
    const altAtoms = alternatives[altIndex];
    if (altAtoms === undefined) {
      continue;
    }

    const logicalLines = splitHardBreakLines(altAtoms);
    if (logicalLines.length === 0) {
      // An empty alternative still carries its "/" (or the bare definition).
      outLines.push(
        altIndex === 0 ? definitionPrefix.trimEnd() : `${bodyIndent}/`,
      );
      continue;
    }

    outLines.push(
      ...formatAlternativeLines(
        logicalLines,
        config,
        definitionPrefix,
        bodyIndent,
        altContinuationIndent,
        altIndex,
      ),
    );
  }

  return outLines;
}

export function formatRule(
  rule: RuleBlock,
  nameWidth: number,
  config: AbnfFormatterConfig,
  eol = "\n",
): string {
  const definitionPrefix = buildDefinitionPrefix(rule, nameWidth, config);

  const atoms = buildBodyAtoms(rule.bodyTokens, config);
  if (atoms.length === 0) {
    return definitionPrefix.trimEnd();
  }

  const { bodyIndent, altContinuationIndent } = computeRuleIndents(
    definitionPrefix,
    config,
  );

  return formatRuleBodyLines(
    atoms,
    config,
    definitionPrefix,
    bodyIndent,
    altContinuationIndent,
  ).join(eol);
}

interface TokenRender {
  tok: AbnfToken;
  breakBefore: boolean;
}

function isRepetitionPrefix(tok: AbnfToken, prev: AbnfToken | null): boolean {
  if (prev === null) {
    return false;
  }
  if (
    (prev.kind === AbnfTokenKind.Asterisk ||
      prev.kind === AbnfTokenKind.Integer) &&
    (tok.kind === AbnfTokenKind.Rulename ||
      tok.kind === AbnfTokenKind.String ||
      tok.kind === AbnfTokenKind.CaseSensitiveString ||
      tok.kind === AbnfTokenKind.CaseInsensitiveString ||
      tok.kind === AbnfTokenKind.NumericValue ||
      tok.kind === AbnfTokenKind.ProseValue ||
      tok.kind === AbnfTokenKind.ParenOpen ||
      tok.kind === AbnfTokenKind.BracketOpen)
  ) {
    return true;
  }
  if (
    prev.kind === AbnfTokenKind.Integer &&
    tok.kind === AbnfTokenKind.Asterisk
  ) {
    return true;
  }
  if (
    prev.kind === AbnfTokenKind.Asterisk &&
    tok.kind === AbnfTokenKind.Integer
  ) {
    return true;
  }
  return false;
}

function needsSpaceBetween(prev: AbnfToken, tok: AbnfToken): boolean {
  if (
    tok.kind === AbnfTokenKind.ParenClose ||
    tok.kind === AbnfTokenKind.BracketClose
  ) {
    return false;
  }
  if (
    prev.kind === AbnfTokenKind.ParenOpen ||
    prev.kind === AbnfTokenKind.BracketOpen
  ) {
    return false;
  }
  if (prev.kind === AbnfTokenKind.Alternation) {
    return true;
  }
  if (tok.kind === AbnfTokenKind.Alternation) {
    return true;
  }
  if (isRepetitionPrefix(tok, prev)) {
    return false;
  }
  return true;
}

function renderTokens(
  tokens: TokenRender[],
  config: AbnfFormatterConfig,
): string {
  let out = "";
  let prev: AbnfToken | null = null;

  for (const { tok, breakBefore } of tokens) {
    if (!tok) {
      continue;
    }

    if (tok.kind === AbnfTokenKind.Comment) {
      const spaces =
        out === ""
          ? ""
          : " ".repeat(
              Math.max(0, Math.floor(config.spaceBeforeInlineComment)),
            );
      out += `${spaces}${tok.text}`;
      break;
    }

    if (prev && breakBefore) {
      out += " ";
    }

    out += tok.text;
    prev = tok;
  }

  return out;
}

function buildTokenRenders(tokens: readonly AbnfToken[]): TokenRender[] {
  const renders: TokenRender[] = [];
  let prev: AbnfToken | null = null;

  for (const tok of tokens) {
    if (tok.kind === AbnfTokenKind.Comment) {
      renders.push({ tok, breakBefore: false });
      prev = tok;
      continue;
    }
    const breakBefore = prev ? needsSpaceBetween(prev, tok) : false;
    renders.push({ tok, breakBefore });
    prev = tok;
  }

  return renders;
}

function findLastBreakIndex(tokens: TokenRender[]): number | null {
  for (let i = tokens.length - 1; i >= 1; i--) {
    if (tokens[i]?.breakBefore) {
      return i;
    }
  }
  return null;
}

function renderTokensWrapped(
  tokens: readonly AbnfToken[],
  config: AbnfFormatterConfig,
  firstPrefix: string,
  wrapPrefix: string,
): string[] {
  const maxLen =
    config.maxLineLength > 0 ? Math.floor(config.maxLineLength) : 0;
  const renders = buildTokenRenders(tokens);

  if (maxLen <= 0) {
    return [`${firstPrefix}${renderTokens(renders, config)}`];
  }

  const lines: string[] = [];
  let currentTokens: TokenRender[] = [];
  let currentPrefix = firstPrefix;

  for (const render of renders) {
    currentTokens.push(render);

    while (true) {
      const rendered = renderTokens(currentTokens, config);
      if (currentPrefix.length + rendered.length <= maxLen) {
        break;
      }

      const breakIndex = findLastBreakIndex(currentTokens);
      if (breakIndex === null) {
        break;
      }

      const left = currentTokens.slice(0, breakIndex);
      const right = currentTokens.slice(breakIndex);

      if (left.length === 0) {
        break;
      }

      lines.push(`${currentPrefix}${renderTokens(left, config)}`);
      currentTokens = right;
      currentPrefix = wrapPrefix;
    }
  }

  if (currentTokens.length > 0) {
    lines.push(`${currentPrefix}${renderTokens(currentTokens, config)}`);
  }

  return lines;
}
