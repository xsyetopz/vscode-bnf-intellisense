import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../..");

/**
 * Absolute path of a repository-relative path.
 */
export function repoPath(relativePath: string): string {
  return resolve(REPO_ROOT, relativePath);
}

/**
 * Text of a repository file by repository-relative path.
 */
export function repoText(relativePath: string): string {
  return readFileSync(repoPath(relativePath), "utf8");
}
