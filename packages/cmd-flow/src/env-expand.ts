const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Expand ${VAR} and ${VAR:-default} references inside env values against the env itself.
 *
 * A value referencing its own key — `<var name="X" value="${X:-fallback}"/>` — resolves against
 * `outer` (the process env by default), i.e. the value X had before the flow overlaid it. Without
 * that, the flow's literal would shadow the shell value and expand to itself.
 */
export function expandEnvVars(
  env: Record<string, string>,
  outer: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const result = { ...env };

  for (const key of Object.keys(result)) {
    result[key] = result[key].replace(VAR_PATTERN, (match, name: string, def?: string) => {
      if (name !== key) return match;
      const prior = outer[name];
      if (prior !== undefined && prior !== env[key]) return prior;
      return def ?? "";
    });
  }

  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    for (const key of Object.keys(result)) {
      const expanded = result[key].replace(VAR_PATTERN, (match, name: string, def?: string) => {
        if (name in result) {
          changed = true;
          return result[name];
        }
        return def !== undefined ? ((changed = true), def) : match;
      });
      if (expanded !== result[key]) result[key] = expanded;
    }
    if (!changed) break;
  }
  return result;
}

/** The flow's own `<env>` vars, expanded — what to hand to a scenario start as overrides. */
export function expandFlowEnv(
  flowEnv: Record<string, string>,
  outer: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const all = expandEnvVars({ ...(outer as Record<string, string>), ...flowEnv }, outer);
  return Object.fromEntries(Object.keys(flowEnv).map((k) => [k, all[k]]));
}
