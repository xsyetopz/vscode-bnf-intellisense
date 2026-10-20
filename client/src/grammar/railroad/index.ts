import type { Disposable } from "vscode";
import { createVscodeHost, type RailroadHost } from "./host.ts";
import {
  type RailroadOptions,
  RailroadPreview,
  type RailroadWorkspace,
  SHOW_RAILROAD_COMMAND,
} from "./panel.ts";

export { SHOW_RAILROAD_COMMAND } from "./panel.ts";

/**
 * Registers the `bnf.showRailroadDiagram` command. The returned disposables
 * belong in `context.subscriptions`; disposing them closes any open panel.
 */
export function registerRailroadPreview(
  grammarWorkspace: RailroadWorkspace,
  host: RailroadHost = createVscodeHost(),
  options?: RailroadOptions,
): Disposable[] {
  const preview = new RailroadPreview(grammarWorkspace, host, options);
  return [
    preview,
    host.registerCommand(SHOW_RAILROAD_COMMAND, () => preview.show()),
  ];
}
