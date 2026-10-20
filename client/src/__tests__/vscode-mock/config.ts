import { repoText } from "../repo-file.ts";

/**
 * Scope of every contributed setting, read from package.json. VS Code only
 * applies `"[language]"` overrides to settings that are language-overridable.
 */
export const settingScopes = new Map<string, string>(
  Object.entries(
    (
      JSON.parse(repoText("package.json")) as {
        contributes: {
          configuration: { properties: Record<string, { scope?: string }> };
        };
      }
    ).contributes.configuration.properties,
  ).map(([key, value]) => [key, value.scope ?? "window"]),
);

export const configurationValues = new Map<string, unknown>();

/**
 * Sets one VS Code configuration value for tests.
 */
export function setConfigurationValue(key: string, value: unknown): void {
  configurationValues.set(key, value);
}

/**
 * Sets a configuration value that applies to one workspace folder only.
 */
export function setFolderConfigurationValue(
  folderPath: string,
  key: string,
  value: unknown,
): void {
  configurationValues.set(`folder:file://${folderPath}:${key}`, value);
}

/**
 * Sets a language-scoped override such as `[abnf]` for `bnf.<key>`.
 */
export function setLanguageConfigurationValue(
  languageId: string,
  key: string,
  value: unknown,
): void {
  configurationValues.set(`[${languageId}]${key}`, value);
}

/**
 * Clears test configuration overrides.
 */
export function resetConfigurationValues(): void {
  configurationValues.clear();
}
