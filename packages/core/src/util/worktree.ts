import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { sectionRepos } from "./config.js";

/**
 * Minimal repo source for the worktree/workbase helpers. `AxnDevConfig`
 * satisfies this structurally; callers that only need repo resolution do not
 * have to carry the full config type.
 */
export interface RepoSource {
  /** Map of repo name → absolute checkout path */
  repos: Record<string, string>;
  /**
   * Plugin-owned config sections — a scalar section whose value resolves to
   * an existing directory contributes its basename as a repo.
   */
  sections?: Record<string, unknown>;
  /** Default parent directory for new worktrees */
  worktrees?: string;
}

/** Union of `repos` and the repos contributed by path-valued sections. */
function allRepoPaths(source: RepoSource): string[] {
  return [
    ...Object.values(source.repos),
    ...Object.values(sectionRepos(source)),
  ];
}

export interface Worktree {
  /** Absolute path to the worktree root */
  path: string;
  /** Canonical repo name (e.g. "my-repo") */
  repoName: string;
  /** Branch name, or null when detached */
  branch: string | null;
  /** HEAD commit hash */
  head: string;
  /** Is this the main (linked) checkout rather than a linked worktree? */
  isMain: boolean;
}

export interface WorktreeInfo {
  worktrees: Worktree[];
  mainWorktree: Worktree | null;
}

function git(repoPath: string, ...args: string[]): { stdout: string; status: number } {
  const result = spawnSync("git", args, { cwd: repoPath, encoding: "utf-8" });
  return {
    stdout: result.stdout ?? "",
    status: result.status ?? 1,
  };
}

const execFileAsync = promisify(execFile);

/** Non-blocking variant of `git` — used by `axn-dev serve` so request
 * handlers never stall the event loop on a subprocess. */
async function gitAsync(repoPath: string, ...args: string[]): Promise<{ stdout: string; status: number }> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: repoPath, encoding: "utf-8" });
    return { stdout: stdout ?? "", status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; code?: unknown };
    return {
      stdout: e.stdout ?? "",
      status: typeof e.code === "number" ? e.code : 1,
    };
  }
}

/**
 * Read the origin URL from .git/config, handling both main checkouts
 * (where .git is a directory) and worktrees (where .git is a file).
 */
function readOriginUrl(repoPath: string): string | null {
  const gitMarker = join(repoPath, ".git");
  if (!existsSync(gitMarker)) return null;

  let configPath: string;
  const stat = lstatSync(gitMarker);
  if (stat.isDirectory()) {
    configPath = join(gitMarker, "config");
  } else if (stat.isFile()) {
    // .git is a file in a linked worktree: it contains `gitdir: <main-git>/worktrees/<name>`
    const content = readFileSync(gitMarker, "utf-8");
    const m = content.match(/^gitdir:\s*(.+)$/m);
    if (!m) return null;
    const worktreeGitDir = m[1].trim();
    // Main .git is two directories up from .git/worktrees/<name>
    const mainGitDir = dirname(dirname(worktreeGitDir));
    configPath = join(mainGitDir, "config");
  } else {
    return null;
  }

  if (!existsSync(configPath)) return null;
  const content = readFileSync(configPath, "utf-8");
  const m = content.match(/\[remote "origin"\][^\[]*url\s*=\s*(.+)/);
  return m ? m[1].trim() : null;
}

/**
 * Extract the canonical repo name from a git remote URL or a local path.
 * `git@host:org/group/my-hardware.git` -> `my-hardware`
 * `https://host/org/group/my-hardware.git` -> `my-hardware`
 */
export function getCanonicalRepoName(repoPath: string): string {
  const originUrl = readOriginUrl(repoPath);
  if (originUrl) {
    const last = originUrl.split("/").pop() ?? "";
    return last.replace(/\.git$/, "");
  }
  return basename(repoPath);
}

function commonParentDir(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const parents = paths.map((p) => dirname(p)).map((p) => p.split("/").filter(Boolean));
  const first = parents[0];
  const common: string[] = [];
  for (let i = 0; i < first.length; i++) {
    if (parents.every((parts) => parts[i] === first[i])) {
      common.push(first[i]);
    } else {
      break;
    }
  }
  return common.length > 0 ? "/" + common.join("/") : null;
}

function sanitizeBranchName(branch: string): string {
  return branch.replace(/\//g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Compute a default worktree path for a repo/branch.
 *
 * Resolution order:
 * 1. `worktrees` directory from `~/.axn-dev/config.yaml`
 * 2. Common parent directory of all configured repo paths + `worktrees/`
 * 3. Parent directory of the target repo + `worktrees/`
 *
 * The directory name is `<repoName>-<branch-slug>` (e.g. `my-repo-feat-driver-split`).
 */
export function getDefaultWorktreePath(
  source: RepoSource,
  repoName: string,
  branch: string,
): string {
  const repoPath = source.repos[repoName];
  const baseCandidates = allRepoPaths(source);

  const home = homedir();
  const common = commonParentDir(baseCandidates);

  let base: string;
  if (source.worktrees) {
    base = source.worktrees;
  } else if (common && common !== "/" && common !== home) {
    base = join(common, "worktrees");
  } else if (repoPath) {
    base = join(dirname(repoPath), "worktrees");
  } else {
    base = resolve(process.cwd(), "worktrees");
  }

  const slug = sanitizeBranchName(branch) || "worktree";
  return resolve(join(base, `${repoName}-${slug}`));
}

/**
 * Parse `git worktree list --porcelain` for a single repo checkout.
 */
export function getWorktrees(repoPath: string): Worktree[] {
  const { stdout, status } = git(repoPath, "worktree", "list", "--porcelain");
  if (status !== 0) return [];
  return parseWorktreeList(stdout, getCanonicalRepoName(repoPath));
}

/** Async variant of getWorktrees for long-running servers (axn-dev serve). */
export async function getWorktreesAsync(repoPath: string): Promise<Worktree[]> {
  const { stdout, status } = await gitAsync(repoPath, "worktree", "list", "--porcelain");
  if (status !== 0) return [];
  return parseWorktreeList(stdout, getCanonicalRepoName(repoPath));
}

function parseWorktreeList(stdout: string, repoName: string): Worktree[] {
  const worktrees: Worktree[] = [];
  let current: Partial<Worktree> = {};

  const flush = () => {
    if (!current.path) return;
    // Skip stale/prunable worktrees whose directory no longer exists
    const gitMarker = join(current.path, ".git");
    if (!existsSync(gitMarker)) return;
    worktrees.push({
      path: current.path,
      repoName,
      branch: current.branch ?? null,
      head: current.head ?? "",
      isMain: lstatSync(gitMarker).isDirectory(),
    } as Worktree);
  };

  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) {
      flush();
      current = {};
      continue;
    }

    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ").trim();

    switch (key) {
      case "worktree":
        current.path = value;
        break;
      case "HEAD":
        current.head = value;
        break;
      case "branch":
        current.branch = value.replace(/^refs\/heads\//, "");
        break;
    }
  }

  // Flush the last entry if the output did not end with a blank line.
  flush();

  return worktrees;
}

export function getAllWorktrees(source: RepoSource): Worktree[] {
  const worktrees: Worktree[] = [];
  const seen = new Set<string>();

  const repoPaths = allRepoPaths(source);
  for (const repoPath of repoPaths) {
    for (const wt of getWorktrees(repoPath)) {
      if (!seen.has(wt.path)) {
        seen.add(wt.path);
        worktrees.push(wt);
      }
    }
  }

  return worktrees;
}

export function getWorktreeInfo(repoPath: string): WorktreeInfo {
  const worktrees = getWorktrees(repoPath);
  const mainWorktree = worktrees.find((w) => w.isMain) ?? null;
  return { worktrees, mainWorktree };
}

export async function getWorktreeInfoAsync(repoPath: string): Promise<WorktreeInfo> {
  const worktrees = await getWorktreesAsync(repoPath);
  const mainWorktree = worktrees.find((w) => w.isMain) ?? null;
  return { worktrees, mainWorktree };
}

/**
 * Pick the best checkout of a repo for the requested branch.
 * If a linked worktree is on `branch`, use it; if the main checkout is on
 * `branch`, use that; otherwise fall back to the original path.
 */
export function resolveCheckoutForBranch(repoPath: string, branch: string): string {
  try {
    const wtInfo = getWorktreeInfo(repoPath);
    const linked = wtInfo.worktrees.find((w) => w.branch === branch && !w.isMain);
    if (linked) return linked.path;
    if (wtInfo.mainWorktree?.branch === branch) return wtInfo.mainWorktree.path;
  } catch {
    // ignore — not a git repo or worktree info unavailable
  }
  return repoPath;
}

export function getWorktreeForPath(
  source: RepoSource,
  targetPath: string,
): Worktree | null {
  const repoPaths = allRepoPaths(source);
  for (const repoPath of repoPaths) {
    for (const wt of getWorktrees(repoPath)) {
      if (targetPath.startsWith(wt.path.replace(/\/+$/, "") + "/")) {
        return wt;
      }
    }
  }

  return null;
}

export interface WorkbaseRoot {
  /** Canonical repo name used for *_ROOT env vars */
  repoName: string;
  /** Absolute path to the selected checkout */
  path: string;
  /** Where the resolved path came from */
  source: "main" | "worktree" | "fallback";
}

/**
 * Resolve the best checkout path for each configured repo for the given branch.
 *
 * - If the main checkout is on `branch`, use it.
 * - Else if a linked worktree is on `branch`, use the worktree.
 * - Else fall back to the main checkout path (current branch) without warning.
 *
 * This is intended to feed the --repo-root mechanism in `axn-dev start`.
 */
export function resolveWorkbaseRoots(source: RepoSource, branch: string): WorkbaseRoot[] {
  const roots: WorkbaseRoot[] = [];
  const seen = new Set<string>();

  function addRepo(repoName: string, mainPath: string) {
    if (seen.has(repoName)) return;
    seen.add(repoName);

    const wtInfo = getWorktreeInfo(mainPath);
    const main = wtInfo.mainWorktree;

    if (main?.branch === branch) {
      roots.push({ repoName, path: main.path, source: "main" });
      return;
    }

    const linked = wtInfo.worktrees.find((w) => w.branch === branch && !w.isMain);
    if (linked) {
      roots.push({ repoName, path: linked.path, source: "worktree" });
      return;
    }

    roots.push({ repoName, path: main?.path ?? mainPath, source: "fallback" });
  }

  for (const [repoName, repoPath] of Object.entries(source.repos)) {
    addRepo(repoName, repoPath);
  }
  for (const [repoName, repoPath] of Object.entries(sectionRepos(source))) {
    addRepo(repoName, repoPath);
  }

  return roots;
}
