/**
 * Skill source aggregation.
 *
 * Skills live in a `skills/` directory at a package root, contributed by:
 *   - this CLI package   (skills/axn-dev-cli, skills/axn-dev-setup)
 *   - @axn-dev/core      (skills/axn-dev-worktree)
 *   - every discovered plugin package (e.g. @axn-dev/cmd-flow → skills/axn-dev-flow)
 *
 * A plugin may override the directory via its axn-dev manifest "skills" field.
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { discoverPlugins, pluginSkillsDir } from "@axn-dev/core";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface SkillSource {
  name: string;
  dir: string;
}

function listSkillsIn(root: string): SkillSource[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => ({ name: e.name, dir: join(root, e.name) }));
}

/** All directories that may contain contributed skills. */
export function skillRoots(): string[] {
  const roots: string[] = [];

  // This CLI package's own skills/ (works for src/ and dist/ layouts).
  roots.push(join(__dirname, "..", "skills"));

  // Skills bundled with @axn-dev/core.
  try {
    const require = createRequire(import.meta.url);
    const coreEntry = require.resolve("@axn-dev/core");
    roots.push(join(dirname(coreEntry), "..", "skills"));
  } catch { /* core not resolvable — skip */ }

  // Skills contributed by plugin packages.
  for (const pkg of discoverPlugins([join(__dirname, "..", "..")])) {
    const dir = pluginSkillsDir(pkg);
    if (dir) roots.push(dir);
  }

  return roots;
}

/** Every contributed skill, deduplicated by name (first root wins). */
export function listAllSkills(): SkillSource[] {
  const seen = new Set<string>();
  const skills: SkillSource[] = [];
  for (const root of skillRoots()) {
    for (const skill of listSkillsIn(root)) {
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        skills.push(skill);
      }
    }
  }
  return skills;
}

export function findSkill(name: string): SkillSource | null {
  return listAllSkills().find((s) => s.name === name) ?? null;
}
