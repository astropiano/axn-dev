import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname } from "node:path";

/**
 * SHA-256 hash of a file's contents.
 */
export function hashFile(filePath: string): string {
  const buf = readFileSync(filePath);
  return "sha256:" + createHash("sha256").update(buf).digest("hex");
}

const repoRootByDir = new Map<string, string | null>();

function repoRoot(dir: string): string | null {
  if (!repoRootByDir.has(dir)) {
    try {
      repoRootByDir.set(dir, execSync("git rev-parse --show-toplevel", {
        cwd: dir,
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf-8",
      }).trim());
    } catch {
      repoRootByDir.set(dir, null);
    }
  }
  return repoRootByDir.get(dir)!;
}

/**
 * If the file is inside a git repo, return { repo, commit } where commit is
 * the SHA of the last commit that touched this file. Returns null if not in git.
 * Costs a `git log` per call, so call it only for files being re-indexed.
 */
export function gitInfo(filePath: string): { repo: string; commit: string } | null {
  const repo = repoRoot(dirname(filePath));
  if (!repo) return null;
  try {
    const commit = execSync(`git log -1 --format=%H -- "${filePath}"`, {
      cwd: repo,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();

    return commit ? { repo, commit } : null;
  } catch {
    return null;
  }
}
