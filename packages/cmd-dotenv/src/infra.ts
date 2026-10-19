import { resolveRepoDir } from "@axn-dev/core";

/** Where the infra repo lives — the `infra:` config section (project-local
 * config or `<repo>/infra/` also resolve via resolveRepoDir). */
export function resolveInfraRoot(): string {
  const dir = resolveRepoDir("infra");
  if (!dir) {
    throw new Error(
      "Cannot find infra repo. Set 'infra: /path/to/repo' in ~/.axn-dev/config.yaml",
    );
  }
  return dir;
}
