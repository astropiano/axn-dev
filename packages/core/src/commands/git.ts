import type { Command } from "./command.js";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, basename, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { loadAxnDevConfig, sectionRepos, type AxnDevConfig } from "../util/config.js";
import { getDefaultWorktreePath, getWorktreeInfo } from "../util/worktree.js";

export interface RepoInfo {
  name: string;
  path: string;
  group: string;
  branch: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  untracked: number;
  remoteBranchMissing: boolean;
}

/**
 * Read origin URL from .git/config directly — no git binary required.
 */
export function readOriginUrl(repoPath: string): string | null {
  const gitConfig = join(repoPath, ".git", "config");
  if (!existsSync(gitConfig)) return null;
  const content = readFileSync(gitConfig, "utf-8");
  const m = content.match(/\[remote "origin"\][^\[]*url\s*=\s*(.+)/);
  return m ? m[1].trim() : null;
}

/**
 * Extract group from a git remote URL.
 * git@gitlab.com:myorg/dev/tools/my-server.git → dev/tools
 * https://gitlab.com/myorg/dev/tools/my-server.git → dev/tools
 */
export function groupFromRemote(url: string): string {
  // Strip protocol + host prefix
  const path = url
    .replace(/^git@[^:]+:/, "")       // SSH: git@host:org/...
    .replace(/^https?:\/\/[^/]+\//, "") // HTTPS: https://host/org/...
    .replace(/\.git$/, "");

  const parts = path.split("/");
  // parts = ["myorg", "dev", "tools", "my-server"]
  // Drop org (first) and repo name (last) → middle is the group
  if (parts.length >= 3) {
    return parts.slice(1, -1).join("/");
  }
  return parts.slice(0, -1).join("/");
}

export function git(repoPath: string, ...args: string[]): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("git", args, { cwd: repoPath, encoding: "utf-8" });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
}

export function getRepoStatus(name: string, repoPath: string): RepoInfo {
  const originUrl = readOriginUrl(repoPath);
  const group = originUrl ? groupFromRemote(originUrl) : "unknown";

  const branchResult = git(repoPath, "branch", "--show-current");
  const branch = branchResult.status === 0 ? branchResult.stdout.trim() || null : null;

  // ahead/behind vs origin
  let ahead = 0;
  let behind = 0;
  let remoteBranchMissing = false;
  if (branch) {
    const abResult = git(repoPath, "rev-list", "--left-right", "--count", `origin/${branch}...HEAD`);
    if (abResult.status === 0) {
      const parts = abResult.stdout.trim().split(/\s+/);
      behind = parseInt(parts[0] ?? "0", 10);
      ahead = parseInt(parts[1] ?? "0", 10);
    } else {
      // Determine whether the remote branch is missing or it's a network/other error
      const verifyResult = git(repoPath, "rev-parse", "--verify", `origin/${branch}`);
      if (verifyResult.status !== 0) {
        remoteBranchMissing = true;
      }
    }
  }

  // dirty / untracked
  const statusResult = git(repoPath, "status", "--porcelain");
  const lines = statusResult.stdout.trim().split("\n").filter(Boolean);
  const dirty = lines.some((l) => !l.startsWith("??"));
  const untracked = lines.filter((l) => l.startsWith("??")).length;

  return { name, path: repoPath, group, branch, ahead, behind, dirty, untracked, remoteBranchMissing };
}

export function allRepos(): Array<{ name: string; path: string }> {
  const config = loadAxnDevConfig();
  const repos: Array<{ name: string; path: string }> = [];
  const seen = new Set<string>();

  const allRepoPaths = { ...sectionRepos(config), ...config.repos };
  for (const [name, path] of Object.entries(allRepoPaths)) {
    if (!seen.has(path) && existsSync(join(path, ".git"))) {
      repos.push({ name, path });
      seen.add(path);
    }
  }

  return repos;
}

export function filterByGroup(repos: Array<{ name: string; path: string }>, group: string | null) {
  if (!group) return repos;
  return repos.filter((r) => {
    const url = readOriginUrl(r.path);
    if (!url) return false;
    return groupFromRemote(url).endsWith(group) || groupFromRemote(url).includes(group);
  });
}

const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";
const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const ORANGE = "\x1b[38;5;208m";
const RED    = "\x1b[31m";
const CYAN   = "\x1b[36m";
const DIM    = "\x1b[2m";

function statusLine(r: RepoInfo): string {
  const branch = r.branch ?? "(detached)";
  const branchColor = r.branch ? CYAN : YELLOW;

  const indicators: string[] = [];
  if (r.remoteBranchMissing) indicators.push(`${RED}×${RESET}`);
  if (r.ahead > 0)    indicators.push(`${GREEN}↑${r.ahead}${RESET}`);
  if (r.behind > 0)   indicators.push(`${RED}↓${r.behind}${RESET}`);
  if (r.dirty)        indicators.push(`${YELLOW}~${RESET}`);
  if (r.untracked > 0) indicators.push(`${ORANGE}?${r.untracked}${RESET}`);

  const ind = indicators.length ? " " + indicators.join(" ") : ` ${GREEN}✓${RESET}`;
  return `  ${BOLD}${r.name.padEnd(30)}${RESET} ${branchColor}${branch.padEnd(30)}${RESET}${ind}`;
}

function worktreeLine(r: RepoInfo, mainPath: string): string {
  const branch = r.branch ?? "(detached)";
  const branchColor = r.branch ? CYAN : YELLOW;

  const indicators: string[] = [];
  if (r.remoteBranchMissing) indicators.push(`${RED}×${RESET}`);
  if (r.ahead > 0)    indicators.push(`${GREEN}↑${r.ahead}${RESET}`);
  if (r.behind > 0)   indicators.push(`${RED}↓${r.behind}${RESET}`);
  if (r.dirty)        indicators.push(`${YELLOW}~${RESET}`);
  if (r.untracked > 0) indicators.push(`${ORANGE}?${r.untracked}${RESET}`);

  const rel = relative(dirname(mainPath), r.path);
  const ind = indicators.length ? " " + indicators.join(" ") : ` ${GREEN}✓${RESET}`;
  return `    ${branchColor}${branch.padEnd(30)}${RESET} ${DIM}${rel.padEnd(30)}${RESET}${ind}`;
}

export function mergedToDevelop(repoPath: string, branch: string | null): string {
  if (!branch) return "no_branch";

  const targets = ["origin/develop", "develop"];
  for (const target of targets) {
    const verify = git(repoPath, "rev-parse", "--verify", target);
    if (verify.status !== 0) continue;

    // Fast path: history-based merge detection
    const ancestor = git(repoPath, "merge-base", "--is-ancestor", "HEAD", target);
    if (ancestor.status === 0) return "yes";

    // Slow path: content-based merge detection for squashed/rebased merges
    const baseResult = git(repoPath, "merge-base", "HEAD", target);
    if (baseResult.status !== 0) continue;
    const base = baseResult.stdout.trim();

    const mergeTree = git(repoPath, "merge-tree", "--write-tree", `--merge-base=${base}`, "HEAD", target);
    if (mergeTree.status !== 0) continue;
    const mergeTreeId = mergeTree.stdout.trim().split(/\s+/)[0];

    const targetTree = git(repoPath, "rev-parse", `${target}^{tree}`);
    if (targetTree.status !== 0) continue;
    const targetTreeId = targetTree.stdout.trim();

    if (mergeTreeId === targetTreeId) return "yes";
    return "no";
  }

  return "no_develop";
}

function machineStatusLine(r: RepoInfo, merged: string): string {
  const branch = r.branch ?? "(detached)";
  return [
    r.group,
    r.name,
    branch,
    String(r.ahead),
    String(r.behind),
    r.dirty ? "yes" : "no",
    String(r.untracked),
    r.remoteBranchMissing ? "yes" : "no",
    merged,
    r.path,
  ].join("|");
}

export class GitCommand implements Command {
  readonly name = "git";
  readonly description = "Multi-repo git operations across configured repos";

  private static readonly ACTIONS = ["status", "push", "pull", "fetch", "worktree"];
  private static readonly WORKTREE_SUBS = ["list", "prune", "add", "remove", "cleanup"];
  private static readonly FLAGS = ["--group", "-g", "--branch", "--dry-run", "--fetch", "--machine-readable", "--unmerged", "--help", "-h"];

  complete(words: string[]): string[] {
    const cur = words[words.length - 1] ?? "";
    if (words.length === 3) {
      return GitCommand.ACTIONS.filter((a) => a.startsWith(cur) && a !== cur);
    }
    if (words[2] === "worktree" && words.length === 4) {
      return GitCommand.WORKTREE_SUBS.filter((s) => s.startsWith(cur) && s !== cur);
    }
    return GitCommand.FLAGS.filter((f) => f.startsWith(cur) && f !== cur);
  }

  help(): string {
    return `
Usage: axn-dev git <action> [options]

Actions:
  status              Show branch + dirty state for all repos and linked worktrees
  push                Push repos (requires --group or --branch)
  pull                Pull repos (requires --group or --branch)
  fetch               Fetch all repos
  worktree            Manage git worktrees (list / prune / add / remove)

Options:
  --group <name>      Target repos in a remote group (e.g. tools).
                      push/pull only proceeds if ALL repos in the group
                      are on the same branch — aborts otherwise.
  --branch <name>     Target any repo (across all groups) on this branch.
  --dry-run           Print what would happen without executing
  --fetch             Fetch before status to show accurate remote state
  --machine-readable  Output status as pipe-delimited rows (no ANSI colours)
  --unmerged          Show only repos whose current branch is not merged into develop

Examples:
  axn-dev git status
  axn-dev git status --group tools
  axn-dev git status --fetch                  # fetch first for accurate remote state
  axn-dev git status --machine-readable       # pipe-delimited rows for scripts
  axn-dev git status --unmerged               # only repos with unmerged changes vs. develop
  axn-dev git push --group tools               # only if all on same branch
  axn-dev git push --branch feature/my-feature # push across all groups
  axn-dev git pull --group tools
  axn-dev git fetch
  axn-dev git worktree list
  axn-dev git worktree prune
`.trim();
  }

  async execute(args: string[]): Promise<void> {
    const [action, ...rest] = args;

    if (!action || action === "--help" || action === "-h") {
      console.log(this.help());
      return;
    }

    let group: string | null = null;
    let branch: string | null = null;
    let dryRun = false;
    let fetch = false;
    let machineReadable = false;
    let unmerged = false;

    for (let i = 0; i < rest.length; i++) {
      if ((rest[i] === "--group" || rest[i] === "-g") && rest[i + 1]) group = rest[++i];
      else if (rest[i] === "--branch" && rest[i + 1]) branch = rest[++i];
      else if (rest[i] === "--dry-run") dryRun = true;
      else if (rest[i] === "--fetch") fetch = true;
      else if (rest[i] === "--machine-readable") machineReadable = true;
      else if (rest[i] === "--unmerged") unmerged = true;
    }

    switch (action) {
      case "status": return this.status(group, fetch, machineReadable, unmerged);
      case "push":   return this.pushPull("push", group, branch, dryRun);
      case "pull":   return this.pushPull("pull", group, branch, dryRun);
      case "fetch":  return this.fetch(group, dryRun);
      case "worktree": return this.worktree(rest);
      default:
        throw new Error(`Unknown git action '${action}'. Run 'axn-dev git --help'.`);
    }
  }

  private status(group: string | null, fetch: boolean, machineReadable: boolean, unmerged: boolean): void {
    const repos = filterByGroup(allRepos(), group);

    if (repos.length === 0) {
      console.log("No repos found in config.");
      return;
    }

    // Fetch if requested
    if (fetch) {
      for (const r of repos) {
        const result = git(r.path, "fetch", "--prune");
        if (!machineReadable) {
          process.stdout.write(`fetching ${r.name.padEnd(30)} ... `);
          console.log(result.status === 0 ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`);
        }
      }
      if (!machineReadable) console.log();
    }

    // Gather all statuses and compute merge state vs. develop
    type StatusItem = { info: RepoInfo; merged: string };
    let items: StatusItem[] = repos.map((r) => {
      const info = getRepoStatus(r.name, r.path);
      const merged = mergedToDevelop(r.path, info.branch);
      return { info, merged };
    });

    if (unmerged) {
      items = items.filter((i) => i.merged === "no");
    }

    if (machineReadable) {
      for (const { info, merged } of items) {
        console.log(machineStatusLine(info, merged));
      }
      return;
    }

    // Group by remote group
    const groups = new Map<string, RepoInfo[]>();
    for (const { info } of items) {
      const g = groups.get(info.group) ?? [];
      g.push(info);
      groups.set(info.group, g);
    }

    for (const [grp, members] of [...groups.entries()].sort()) {
      console.log(`\n${BOLD}${grp}${RESET}`);
      for (const r of members) {
        console.log(statusLine(r));
        const { mainWorktree, worktrees } = getWorktreeInfo(r.path);
        const mainPath = mainWorktree?.path ?? r.path;
        for (const wt of worktrees.filter((w) => !w.isMain)) {
          const info = getRepoStatus(r.name, wt.path);
          console.log(worktreeLine(info, mainPath));
        }
      }
    }
    console.log();
  }

  private pushPull(op: "push" | "pull", group: string | null, branch: string | null, dryRun: boolean): void {
    if (!group && !branch) {
      console.log(`${YELLOW}Specify --group <name> or --branch <name>.${RESET}`);
      console.log(`  axn-dev git ${op} --group tools         # push if all on same branch`);
      console.log(`  axn-dev git ${op} --branch feature/xyz  # push all repos on that branch`);
      return;
    }

    let targets: RepoInfo[];

    if (branch) {
      // --branch: push any repo (across all groups) that is on this branch
      const infos = allRepos().map((r) => getRepoStatus(r.name, r.path));
      targets = infos.filter((r) => r.branch === branch);

      if (targets.length === 0) {
        console.log(`No repos found on branch '${CYAN}${branch}${RESET}'.`);
        return;
      }
    } else {
      // --group: all repos in the group must be on the same branch — abort otherwise
      const repos = filterByGroup(allRepos(), group);
      const infos = repos.map((r) => getRepoStatus(r.name, r.path));

      const branches = new Set(infos.map((r) => r.branch ?? "(detached)"));
      if (branches.size > 1) {
        console.log(`${RED}Aborted:${RESET} repos in group '${group}' are on different branches:\n`);
        const byBranch = new Map<string, string[]>();
        for (const r of infos) {
          const b = r.branch ?? "(detached)";
          byBranch.set(b, [...(byBranch.get(b) ?? []), r.name]);
        }
        for (const [b, names] of byBranch) {
          console.log(`  ${CYAN}${b}${RESET}: ${names.join(", ")}`);
        }
        console.log(`\nUse --branch <name> to target a specific branch across all repos.`);
        return;
      }

      targets = infos.filter((r) => r.branch !== null);
      if (targets.length === 0) {
        console.log("No repos with a current branch found.");
        return;
      }

      const sharedBranch = [...branches][0];
      console.log(`${BOLD}Group '${group}' — all on ${CYAN}${sharedBranch}${RESET}${BOLD}, running git ${op}...${RESET}\n`);
    }

    for (const r of targets) {
      if (dryRun) {
        console.log(`[dry-run] git ${op}  ${r.name.padEnd(28)} ${CYAN}${r.branch}${RESET}`);
        continue;
      }

      process.stdout.write(`git ${op}  ${r.name.padEnd(28)} ${CYAN}${r.branch}${RESET} ... `);
      const result = git(r.path, op);
      if (result.status === 0) {
        console.log(`${GREEN}✓${RESET}`);
      } else {
        console.log(`${RED}✗${RESET}`);
        console.error(result.stderr.trim());
      }
    }
  }

  private fetch(group: string | null, dryRun: boolean): void {
    const repos = filterByGroup(allRepos(), group);

    for (const r of repos) {
      if (dryRun) {
        console.log(`[dry-run] git fetch — ${r.name}`);
        continue;
      }
      process.stdout.write(`fetching ${r.name.padEnd(30)} ... `);
      const result = git(r.path, "fetch", "--prune");
      console.log(result.status === 0 ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`);
    }
  }

  private worktree(args: string[]): void {
    const [sub, ...rest] = args;

    if (!sub || sub === "--help" || sub === "-h") {
      console.log(`
Usage: axn-dev git worktree <subcommand>

Subcommands:
  list                             List all worktrees for configured repos
  prune                            Prune stale worktrees for all repos
  add <repo> <branch> [path]       Add a new worktree for a repo/branch
                                   (default: <worktrees>/<repo>-<branch-slug>)
  remove <repo> <path>             Remove a worktree for a repo
  cleanup <repo> <branch>          Remove a worktree and delete the local branch
                                   (pass --remote to also delete the remote branch)

Examples:
  axn-dev git worktree list
  axn-dev git worktree prune
  axn-dev git worktree add my-server feat/abc
  axn-dev git worktree add my-server feat/abc ../my-server-feat-abc
  axn-dev git worktree remove my-server ../my-server-feat-abc
`.trim());
      return;
    }

    const config = loadAxnDevConfig();

    switch (sub) {
      case "list":
        return this.worktreeList(config);
      case "prune":
        return this.worktreePrune(config);
      case "add":
        return this.worktreeAdd(config, rest);
      case "remove":
        return this.worktreeRemove(config, rest);
      case "cleanup":
        return this.worktreeCleanup(config, rest);
      default:
        throw new Error(`Unknown worktree subcommand '${sub}'. Run 'axn-dev git worktree --help'.`);
    }
  }

  private worktreeList(config: AxnDevConfig): void {
    const repoPaths = new Set([
      ...Object.values(config.repos),
      ...Object.values(sectionRepos(config)),
    ]);

    for (const repoPath of repoPaths) {
      const { mainWorktree, worktrees } = getWorktreeInfo(repoPath);
      if (worktrees.length === 0) continue;

      const mainPath = mainWorktree?.path ?? repoPath;
      console.log(`\n${BOLD}${worktrees[0].repoName}${RESET}`);
      for (const wt of worktrees) {
        const branch = wt.branch ?? "(detached)";
        const rel = wt.isMain ? "." : relative(dirname(mainPath), wt.path);
        const dirty = getRepoStatus(wt.repoName, wt.path).dirty ? ` ${YELLOW}~${RESET}` : "";
        console.log(`  ${branch.padEnd(30)} ${DIM}${rel}${RESET}${dirty}`);
      }
    }
    console.log();
  }

  private worktreePrune(config: AxnDevConfig): void {
    const repoPaths = new Set([
      ...Object.values(config.repos),
      ...Object.values(sectionRepos(config)),
    ]);

    for (const repoPath of repoPaths) {
      process.stdout.write(`pruning ${basename(repoPath).padEnd(30)} ... `);
      const result = git(repoPath, "worktree", "prune");
      console.log(result.status === 0 ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`);
    }
    console.log();
  }

  private worktreeAdd(config: AxnDevConfig, rest: string[]): void {
    const [repoName, branch, ...pathParts] = rest;
    const pathArg = pathParts.join(" ");

    if (!repoName || !branch) {
      console.log(`${YELLOW}Usage: axn-dev git worktree add <repo> <branch> [path]${RESET}`);
      return;
    }

    const repoPath = config.repos[repoName];
    if (!repoPath) {
      console.log(`${RED}Repo '${repoName}' not found in ~/.axn-dev/config.yaml.${RESET}`);
      return;
    }

    const worktreePath = pathArg
      ? pathArg
      : getDefaultWorktreePath(config, repoName, branch);

    const mainPath = getWorktreeInfo(repoPath).mainWorktree?.path ?? repoPath;
    mkdirSync(dirname(worktreePath), { recursive: true });

    process.stdout.write(`adding worktree for ${CYAN}${branch}${RESET} at ${DIM}${worktreePath}${RESET} ... `);
    const result = git(mainPath, "worktree", "add", "-b", branch, worktreePath);
    console.log(result.status === 0 ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`);
    if (result.status !== 0 && result.stderr) {
      console.error(result.stderr.trim());
    }
  }

  private worktreeRemove(config: AxnDevConfig, rest: string[]): void {
    const [repoName, ...pathParts] = rest;
    const path = pathParts.join(" ");

    if (!repoName || !path) {
      console.log(`${YELLOW}Usage: axn-dev git worktree remove <repo> <path>${RESET}`);
      return;
    }

    const repoPath = config.repos[repoName];
    if (!repoPath) {
      console.log(`${RED}Repo '${repoName}' not found in ~/.axn-dev/config.yaml.${RESET}`);
      return;
    }

    const mainPath = getWorktreeInfo(repoPath).mainWorktree?.path ?? repoPath;
    process.stdout.write(`removing worktree ${CYAN}${path}${RESET} ... `);
    const result = git(mainPath, "worktree", "remove", path);
    console.log(result.status === 0 ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`);
    if (result.status !== 0 && result.stderr) {
      console.error(result.stderr.trim());
    }
  }

  private worktreeCleanup(config: AxnDevConfig, rest: string[]): void {
    const [repoName, branch, ...flags] = rest;
    const deleteRemote = flags.includes("--remote");

    if (!repoName || !branch) {
      console.log(`${YELLOW}Usage: axn-dev git worktree cleanup <repo> <branch> [--remote]${RESET}`);
      return;
    }

    const repoPath = config.repos[repoName];
    if (!repoPath) {
      console.log(`${RED}Repo '${repoName}' not found in ~/.axn-dev/config.yaml.${RESET}`);
      return;
    }

    const mainPath = getWorktreeInfo(repoPath).mainWorktree?.path ?? repoPath;
    const { worktrees } = getWorktreeInfo(mainPath);
    const wt = worktrees.find((w) => w.branch === branch && !w.isMain);

    if (!wt) {
      console.log(`${RED}No non-main worktree on branch '${branch}' for ${repoName}.${RESET}`);
      return;
    }

    process.stdout.write(`removing worktree ${CYAN}${branch}${RESET} ... `);
    const removeResult = git(mainPath, "worktree", "remove", wt.path);
    console.log(removeResult.status === 0 ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`);
    if (removeResult.status !== 0 && removeResult.stderr) {
      console.error(removeResult.stderr.trim());
      return;
    }

    process.stdout.write(`deleting local branch ${CYAN}${branch}${RESET} ... `);
    const branchResult = git(mainPath, "branch", "-d", branch);
    console.log(branchResult.status === 0 ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`);
    if (branchResult.status !== 0 && branchResult.stderr) {
      console.error(branchResult.stderr.trim());
    }

    if (deleteRemote) {
      process.stdout.write(`deleting remote branch ${CYAN}${branch}${RESET} ... `);
      const remoteResult = git(mainPath, "push", "origin", "--delete", branch);
      console.log(remoteResult.status === 0 ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`);
      if (remoteResult.status !== 0 && remoteResult.stderr) {
        console.error(remoteResult.stderr.trim());
      }
    }
  }
}
