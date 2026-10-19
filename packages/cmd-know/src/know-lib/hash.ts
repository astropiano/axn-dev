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

/**
 * If the file is inside a git repo, return { repo, commit } where commit is
 * the SHA of the last commit that touched this file. Returns null if not in git.
 */
export function gitInfo(filePath: string): { repo: string; commit: string } | null {
  try {
    const repo = execSync("git rev-parse --show-toplevel", {
      cwd: dirname(filePath),
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();

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

/**
 * Determine if a tracked item needs re-indexing.
 * For git-tracked files: compare last-commit SHA.
 * For plain files: compare content hash.
 */
export function needsReindex(
  currentHash: string,
  currentGitCommit: string | undefined,
  storedHash: string,
  storedGitCommit: string | undefined,
): boolean {
  if (currentGitCommit && storedGitCommit) {
    return currentGitCommit !== storedGitCommit;
  }
  return currentHash !== storedHash;
}
