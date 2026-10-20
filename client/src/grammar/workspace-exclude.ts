import { type Uri, type WorkspaceFolder, workspace } from "vscode";

/**
 * Folders never indexed, wherever they sit in the tree.
 */
const NESTED_EXCLUDES = ["**/node_modules/**", "**/.git/**"];

/**
 * Build output folders, excluded only at the root of a workspace folder so
 * grammar folders that happen to be called `out` or `dist` stay indexed.
 */
const ROOT_EXCLUDES = ["out/**", "dist/**"];

/**
 * Expands `{a,b}` alternates into separate patterns. VS Code globs reject
 * nested alternates, so every pattern handed to `findFiles` goes through here.
 */
export function expandBraces(pattern: string): string[] {
  const open = findUnescaped(pattern, "{", 0);
  if (open < 0) {
    return [pattern];
  }
  let depth = 0;
  let close = -1;
  const commas: number[] = [];
  for (let i = open; i < pattern.length; i++) {
    const char = pattern.charAt(i);
    if (char === "\\") {
      i++;
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    } else if (char === "," && depth === 1) {
      commas.push(i);
    }
  }
  if (close < 0) {
    // Unbalanced brace: keep it literally.
    const rest = expandBraces(pattern.slice(open + 1));
    return rest.map((tail) => `${pattern.slice(0, open + 1)}${tail}`);
  }
  const head = pattern.slice(0, open);
  const tails = expandBraces(pattern.slice(close + 1));
  const bounds = [open, ...commas, close];
  const results: string[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = (bounds[i] ?? 0) + 1;
    const alternative = pattern.slice(start, bounds[i + 1]);
    for (const inner of expandBraces(alternative)) {
      for (const tail of tails) {
        results.push(`${head}${inner}${tail}`);
      }
    }
  }
  return results;
}

function findUnescaped(text: string, target: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    const char = text.charAt(i);
    if (char === "\\") {
      i++;
    } else if (char === target) {
      return i;
    }
  }
  return -1;
}

/**
 * Exclusion patterns for one workspace folder, relative to that folder:
 * dependency and build folders plus every `files.exclude` entry switched on.
 */
export function excludePatterns(folder: WorkspaceFolder | undefined): string[] {
  const configured = workspace
    .getConfiguration("files", folder?.uri)
    .get<Record<string, unknown>>("exclude", {});
  const patterns = [...NESTED_EXCLUDES, ...(folder ? ROOT_EXCLUDES : [])];
  for (const [pattern, enabled] of Object.entries(configured)) {
    // Entries such as `{ when: ... }` are conditional and never apply here.
    if (enabled === true) {
      patterns.push(pattern);
    }
  }
  return patterns.flatMap(expandBraces);
}

/**
 * Exclude glob for `findFiles`. Passing a pattern to `findFiles` replaces its
 * default exclusion, so the `files.exclude` setting is merged in here.
 */
export function excludeGlob(folder: WorkspaceFolder | undefined): string {
  const patterns = excludePatterns(folder);
  return patterns.length === 1
    ? (patterns[0] ?? "")
    : `{${patterns.join(",")}}`;
}

function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob.charAt(i);
    if (glob.startsWith("**/", i)) {
      source += "(?:.*/)?";
      i += 2;
    } else if (glob.startsWith("/**", i) && i + 3 === glob.length) {
      source += "(?:/.*)?";
      i += 2;
    } else if (glob.startsWith("**", i)) {
      source += ".*";
      i += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "\\" && i + 1 < glob.length) {
      i++;
      source += glob.charAt(i).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    } else if (char === "[" && findUnescaped(glob, "]", i + 2) > 0) {
      const close = findUnescaped(glob, "]", i + 2);
      const negated = glob.charAt(i + 1) === "!" || glob.charAt(i + 1) === "^";
      const members = glob
        .slice(i + (negated ? 2 : 1), close)
        .replace(/[\\^\][/]/g, "\\$&");
      source += negated ? `[^/${members}]` : `[${members}]`;
      i = close;
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * Tells whether a file is hidden from the workspace index.
 */
export type ExclusionMatcher = (uri: Uri) => boolean;

/**
 * Creates a matcher that compiles the exclusions of each workspace folder once
 * and reuses them. A matcher reflects the settings at its first use per
 * folder, so create a new one after `files.exclude` changes.
 */
export function createExclusionMatcher(): ExclusionMatcher {
  const compiled = new Map<string, RegExp[]>();
  return (uri) => {
    const folder = workspace.getWorkspaceFolder(uri);
    const key = folder?.uri.toString() ?? "";
    let matchers = compiled.get(key);
    if (!matchers) {
      matchers = excludePatterns(folder).map(globToRegExp);
      compiled.set(key, matchers);
    }
    const base = folder?.uri.path.replace(/\/$/, "") ?? "";
    const path = uri.path.startsWith(`${base}/`)
      ? uri.path.slice(base.length + 1)
      : uri.path.replace(/^\/+/, "");
    const segments = path.split("/");
    for (let end = 1; end <= segments.length; end++) {
      const candidate = segments.slice(0, end).join("/");
      if (matchers.some((matcher) => matcher.test(candidate))) {
        return true;
      }
    }
    return false;
  };
}
