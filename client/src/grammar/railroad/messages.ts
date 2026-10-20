/**
 * Messages the webview may send to the extension.
 */
export type WebviewMessage = { type: "reveal"; rule: string };

const MAX_RULE_NAME = 500;

/**
 * Validates an untrusted message from the webview. Only own properties are
 * read, only known message types are accepted, and a rule name must be a bounded string that `isKnownRule`
 * accepts. Returns `undefined` for everything else.
 */
export function parseWebviewMessage(
  raw: unknown,
  isKnownRule: (name: string) => boolean,
): WebviewMessage | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  if (!(Object.hasOwn(raw, "type") && Object.hasOwn(raw, "rule"))) {
    return undefined;
  }
  const message = raw as Record<string, unknown>;
  if (message["type"] !== "reveal") {
    return undefined;
  }
  const rule = message["rule"];
  if (
    typeof rule !== "string" ||
    rule.length === 0 ||
    rule.length > MAX_RULE_NAME ||
    !isKnownRule(rule)
  ) {
    return undefined;
  }
  return { type: "reveal", rule };
}
