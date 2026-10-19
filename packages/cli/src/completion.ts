/**
 * Shell tab-completion engine for axn-dev.
 *
 * Called by the shell hook via:
 *   axn-dev --complete <word0> <word1> ...
 *
 * Completion contributions come from the commands themselves:
 * each command may implement `complete(words)` (see Command in
 * @axn-dev/core). Command names come from the registry, so plugin
 * commands complete like built-in ones.
 */

import type { CommandRegistry } from "@axn-dev/core";

export async function complete(words: string[], registry: CommandRegistry): Promise<string[]> {
  const cur = words[words.length - 1] ?? "";

  // Completing the command name itself
  if (words.length <= 2) {
    return registry.names().filter((c) => c.startsWith(cur) && c !== cur);
  }

  // Intentionally `get`, not `resolve`: LazyCommand.complete decides whether
  // the manifest's static flags suffice (no module load) or the real command
  // must be loaded for value completions.
  const command = registry.get(words[1] ?? "");
  return (await command?.complete?.(words)) ?? [];
}
