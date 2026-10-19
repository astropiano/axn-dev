import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface WorkspaceScan {
  /** Repo dirs registered under `integration` (global-scenario carriers). */
  integration: string[];
  /** Repo dirs registered under `repos` (name → path). */
  repos: Record<string, string>;
}

/** Classify a repo by name: repos named `*-integration` carry global
 * scenarios (`integration:` list); anything else is a plain repo — its
 * own `scenarios/` dir, if any, yields project scenarios. */
export function classifyRepo(repoName: string): "integration" | "repo" {
  return repoName.endsWith("-integration") ? "integration" : "repo";
}

/**
 * Recursively scan a directory tree (up to `maxDepth` levels) for repos.
 * A directory with `.git` is a repo, classified by name. Scanning does
 * not descend into repos or noise dirs.
 */
export function scanWorkspaceTree(dir: string, maxDepth = 4): WorkspaceScan {
  const scan: WorkspaceScan = { integration: [], repos: {} };

  const walk = (d: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules" || entry === "dist") continue;
      const full = join(d, entry);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      if (!existsSync(join(full, ".git"))) {
        walk(full, depth + 1);
        continue;
      }
      if (classifyRepo(entry) === "integration") {
        console.log(`  Found integration repo: ${entry} → ${full}`);
        scan.integration.push(full);
      } else {
        console.log(`  Found repo: ${entry} → ${full}`);
        scan.repos[entry] = full;
      }
    }
  };

  walk(dir, 0);
  return scan;
}
