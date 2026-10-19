---
name: axn-dev-overview
description: Collect a machine-wide overview of ongoing development work across all configured repos — uncommitted changes, unpushed commits, unmerged branches, linked worktrees, remotes that moved, and open GitLab merge requests (when glab is authenticated). Use when the user asks "what am I working on", "what's in flight", or before switching context.
---

# axn-dev Overview Skill

The overview is built from `axn-dev` (which reads `~/.axn-dev/config.yaml`) plus targeted `git` and optional `glab` calls.

## One-shot markdown report

The preferred way to generate the overview is the built-in `overview` command. It fetches all remotes, gathers open work for every configured repo and linked worktree, and prints a grouped Markdown report.

```bash
axn-dev overview
```

Options:
- `--group <name>` — limit to one remote group (e.g. `myapp`).
- `--no-fetch` — use current local state without fetching.
- `--no-mr` — skip GitLab merge-request lookups.

## What it reports

The Markdown output is grouped by **repository**. Only repos with open work are shown.

```markdown
## <group> / <repo-name>

- **main:** `<branch>` on `<path>` — status markers (e.g. `~`, `?1`, `↓2`, `↑5`, `×`)
- **worktrees:**
  - `<branch>` at `<worktree-path>` — `<state>`
- **uncommitted:** `git status --porcelain` (only if dirty or untracked)
- **unpushed / remote missing:** up to 5 `git log --oneline` commits above `develop` or `origin/<branch>`
- **stale (remote moved):** up to 5 new commits on `origin/<branch>` above `HEAD`
- **open MRs:** title, source/target, draft, reviewer (only if `glab` succeeded; for this repo)
```

If there is nothing to show, the repo is omitted. The report ends with:

> All other configured repos are clean, in sync, and merged to `develop`/main.

## Manual fallback

If `axn-dev overview` is unavailable, the same data can be gathered by hand:

1. Fetch all remotes:
   ```bash
   axn-dev git status --fetch
   ```

2. Get machine-readable fields and paths:
   ```bash
   axn-dev git status --machine-readable
   ```

   Fields: `group|name|branch|ahead|behind|dirty|untracked|remoteBranchMissing|mergedToDevelop|path`

3. For each repo or worktree that is not clean, in-sync, and merged, gather details:
   - `git -C <path> status --porcelain` for uncommitted/untracked files
   - `git -C <path> log --oneline -5` for recent local commits
   - `git -C <path> log --oneline origin/<branch>..HEAD` for unpushed commits
   - `git -C <path> log --oneline HEAD..origin/<branch>` for new remote commits
   - For linked worktrees: `git -C <main-repo-path> worktree list --porcelain`

4. If `glab` is installed and authenticated (`glab auth status` exits 0), list open MRs:
   ```bash
   glab --repo <namespace/project> mr list --source-branch <branch> --output text
   ```

   If `glab` is missing or unauthenticated, skip MRs without mentioning them.
