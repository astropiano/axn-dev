import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { Command } from "@axn-dev/core";
import { flagCompleter } from "@axn-dev/core";
import {
  allRepos,
  filterByGroup,
  getRepoStatus,
  readOriginUrl,
  git as runGit,
  type RepoInfo,
} from "@axn-dev/core";
import { getWorktreeInfo } from "@axn-dev/core";

function refExists(repoPath: string, ref: string): boolean {
  return runGit(repoPath, "show-ref", ref).status === 0;
}

function baseBranchForUnpushed(repoPath: string, branch: string | null): string | null {
  if (branch === "main" && refExists(repoPath, "refs/remotes/origin/main")) return "origin/main";
  if (refExists(repoPath, "refs/remotes/origin/develop")) return "origin/develop";
  if (branch && refExists(repoPath, `refs/remotes/origin/${branch}`)) return `origin/${branch}`;
  return null;
}

function unpushedLog(repoPath: string, branch: string | null): string {
  const base = baseBranchForUnpushed(repoPath, branch);
  if (!base) return "";
  const result = runGit(repoPath, "log", "--oneline", `${base}..HEAD`);
  return result.status === 0 ? result.stdout.trim() : "";
}

function staleLog(repoPath: string, branch: string | null): string {
  if (!branch) return "";
  if (!refExists(repoPath, `refs/remotes/origin/${branch}`)) return "";
  const result = runGit(repoPath, "log", "--oneline", `HEAD..origin/${branch}`);
  return result.status === 0 ? result.stdout.trim() : "";
}

function uncommittedLog(repoPath: string): string {
  const result = runGit(repoPath, "status", "--porcelain");
  return result.status === 0 ? result.stdout.trim() : "";
}

function gitlabSlugFromUrl(url: string): string | null {
  const m = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

let glabAuthChecked = false;
let glabAuthenticated = false;

function isGlabAuthenticated(): boolean {
  if (glabAuthChecked) return glabAuthenticated;
  glabAuthChecked = true;
  const result = spawnSync("glab", ["auth", "status"], { encoding: "utf-8" });
  glabAuthenticated = result.status === 0;
  return glabAuthenticated;
}

function listOpenMrs(slug: string, branch: string): string {
  const result = spawnSync(
    "glab",
    ["--repo", slug, "mr", "list", "--source-branch", branch, "--output", "text"],
    { encoding: "utf-8" },
  );
  if (result.status !== 0) return "";
  const text = result.stdout.trim();
  if (!text || text.includes("No open merge requests")) return "";
  return text;
}

function linesOf(text: string): string[] {
  return text ? text.split("\n").filter(Boolean) : [];
}

function markerString(
  dirty: boolean,
  untracked: number,
  behind: number,
  ahead: number,
  remoteBranchMissing: boolean,
): string {
  const parts: string[] = [];
  if (remoteBranchMissing) parts.push("×");
  if (dirty) parts.push("~");
  if (untracked > 0) parts.push(`?${untracked}`);
  if (behind > 0) parts.push(`↓${behind}`);
  if (ahead > 0) parts.push(`↑${ahead}`);
  return parts.length ? parts.join(" ") : "clean";
}

export class OverviewCommand implements Command {
  readonly name = "overview";
  readonly description = "Generate a markdown overview of open work across configured repos";

  complete = flagCompleter([
    "--group", "-g", "--no-fetch", "--no-mr", "--oneline", "--output",
    "--porcelain", "--prune", "--repo", "--source-branch", "--help", "-h",
  ]);

  help(): string {
    return `
Usage: axn-dev overview [options]

Generate a machine-wide markdown overview of ongoing development work —
uncommitted changes, unpushed commits, linked worktrees, stale branches,
and open GitLab merge requests.

Options:
  --group <name>   Limit to one remote group (e.g. tools).
  --no-fetch       Skip fetching before generating the report.
  --no-mr          Skip GitLab merge request lookups.
  -h, --help       Show this help.

Examples:
  axn-dev overview                    # full overview (fetches first)
  axn-dev overview --group tools      # only the tools group
  axn-dev overview --no-fetch         # use current local state
`.trim();
  }

  async execute(args: string[]): Promise<void> {
    let group: string | null = null;
    let fetch = true;
    let lookupMrs = true;

    for (let i = 0; i < args.length; i++) {
      if ((args[i] === "--group" || args[i] === "-g") && args[i + 1]) group = args[++i];
      else if (args[i] === "--no-fetch") fetch = false;
      else if (args[i] === "--no-mr") lookupMrs = false;
      else if (args[i] === "--help" || args[i] === "-h") {
        console.log(this.help());
        return;
      }
    }

    const repos = filterByGroup(allRepos(), group);
    if (repos.length === 0) {
      console.log("No repos found.");
      return;
    }

    if (fetch) {
      for (const r of repos) {
        process.stdout.write(`fetching ${r.name.padEnd(30)} ... `);
        const result = runGit(r.path, "fetch", "--prune");
        console.log(result.status === 0 ? "✓" : "✗");
      }
      console.log();
    }

    const glabOk = lookupMrs ? isGlabAuthenticated() : false;
    const output: string[] = [];

    for (const r of repos) {
      const mainPath = r.path;
      const info = getRepoStatus(r.name, mainPath);
      const worktreeInfo = getWorktreeInfo(mainPath);
      const originPath = worktreeInfo.mainWorktree?.path ?? mainPath;
      const originUrl = readOriginUrl(originPath);
      const slug = originUrl ? gitlabSlugFromUrl(originUrl) : null;

      const mainUnpushed = unpushedLog(mainPath, info.branch);
      const mainStale = staleLog(mainPath, info.branch);
      const mainUncommitted = uncommittedLog(mainPath);
      const mainMrs =
        glabOk && slug && info.branch ? listOpenMrs(slug, info.branch) : "";

      const mainAhead = linesOf(mainUnpushed).length;
      const mainBehind = linesOf(mainStale).length;

      const mainMarker = markerString(
        info.dirty,
        info.untracked,
        mainBehind,
        mainAhead,
        info.remoteBranchMissing,
      );

      const worktreeBlocks: string[] = [];
      for (const wt of worktreeInfo.worktrees) {
        if (wt.path === mainPath) continue;

        const wtInfo = getRepoStatus(r.name, wt.path);
        const wtUnpushed = unpushedLog(wt.path, wtInfo.branch);
        const wtStale = staleLog(wt.path, wtInfo.branch);
        const wtUncommitted = uncommittedLog(wt.path);
        const wtMrs =
          glabOk && slug && wtInfo.branch ? listOpenMrs(slug, wtInfo.branch) : "";

        const wtAhead = linesOf(wtUnpushed).length;
        const wtBehind = linesOf(wtStale).length;
        const wtMarker = markerString(
          wtInfo.dirty,
          wtInfo.untracked,
          wtBehind,
          wtAhead,
          wtInfo.remoteBranchMissing,
        );

        const hasWtWork =
          wtUncommitted || wtUnpushed || wtStale || wtMrs;
        if (!hasWtWork) continue;

        const rel = relative(join(originPath, ".."), wt.path);
        const wtLines: string[] = [
          `- \`${wtInfo.branch ?? "(detached)"}\` at \`${wt.path}\` — ${wtMarker}`,
        ];
        if (wtUncommitted) {
          wtLines.push("  - **uncommitted:**");
          for (const line of linesOf(wtUncommitted)) {
            wtLines.push(`    \`${line}\``);
          }
        }
        if (wtUnpushed) {
          wtLines.push("  - **unpushed / remote missing:**");
          for (const line of linesOf(wtUnpushed).slice(0, 5)) {
            wtLines.push(`    ${line}`);
          }
        }
        if (wtStale) {
          wtLines.push("  - **stale (remote moved):**");
          for (const line of linesOf(wtStale).slice(0, 5)) {
            wtLines.push(`    ${line}`);
          }
        }
        if (wtMrs) {
          wtLines.push("  - **open MRs:**");
          for (const line of linesOf(wtMrs)) {
            wtLines.push(`    ${line}`);
          }
        }
        worktreeBlocks.push(wtLines.join("\n"));
      }

      const hasMainWork =
        mainUncommitted || mainUnpushed || mainStale || mainMrs;
      if (!hasMainWork && worktreeBlocks.length === 0) continue;

      output.push("");
      output.push(`## ${info.group} / ${r.name}`);
      output.push(
        `- **main:** \`${info.branch ?? "(detached)"}\` on \`${mainPath}\` — ${mainMarker}`,
      );

      if (worktreeBlocks.length > 0) {
        output.push("- **worktrees:**");
        for (const block of worktreeBlocks) {
          output.push("  " + block.replace(/\n/g, "\n  "));
        }
      }

      if (mainUncommitted) {
        output.push("- **uncommitted:**");
        for (const line of linesOf(mainUncommitted)) {
          output.push(`  \`${line}\``);
        }
      }
      if (mainUnpushed) {
        output.push("- **unpushed / remote missing:**");
        for (const line of linesOf(mainUnpushed).slice(0, 5)) {
          output.push(`  ${line}`);
        }
      }
      if (mainStale) {
        output.push("- **stale (remote moved):**");
        for (const line of linesOf(mainStale).slice(0, 5)) {
          output.push(`  ${line}`);
        }
      }
      if (mainMrs) {
        output.push("- **open MRs:**");
        for (const line of linesOf(mainMrs)) {
          output.push(`  ${line}`);
        }
      }
    }

    if (output.length === 0) {
      console.log("All configured repos are clean, in sync, and merged to `develop`/main.");
      return;
    }

    output.push("");
    output.push("All other configured repos are clean, in sync, and merged to `develop`/main.");
    console.log(output.join("\n"));
  }
}
