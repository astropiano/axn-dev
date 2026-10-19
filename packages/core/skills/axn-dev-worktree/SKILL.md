---
name: axn-dev-worktree
description: Work with git worktrees via the `axn-dev` CLI. Create, list, run scenarios from and clean up worktrees across your configured repositories.
---

# axn-dev Worktree Skill

`axn-dev` is worktree-aware. Repositories can be checked out multiple times as git worktrees, and `axn-dev start|stop|list|serve|git` understand them.

## Conventions

- Worktrees live **outside the main checkout**.
- Recommended default: a `worktrees/` folder at the concern level, e.g.
  `myapp/worktrees/myapp-hardware-feat-driver-split`.
- Sibling worktrees (`../myapp-hardware-feat-driver-split`) are also fine.
- Worktree directory names should match the branch name with path separators
  replaced by `-` or `_`.

## Discovery

`axn-dev` discovers worktrees via `git worktree list` for every configured repo.
You do **not** need to list each worktree in `~/.axn-dev/config.yaml`.

## Creating a worktree

```bash
axn-dev git worktree add <repo> <branch> [path]
```

If `<path>` is omitted, the worktree is created at the configured `worktrees` parent
(default: the common parent directory of your configured repos + `worktrees/`), with
a folder name of `<repo>-<branch-slug>` (e.g. `myapp-hardware-feat-driver-split`).

Example with explicit path:

```bash
axn-dev git worktree add myapp-hardware feat/driver-split \
  /home/dev/worktrees/myapp-hardware-feat-driver-split
```

Example using the default path:

```bash
axn-dev git worktree add myapp-hardware feat/driver-split
```

This runs `git worktree add -b feat/driver-split <path>` from the main checkout.
You can override the default parent directory with the `worktrees:` key in
`~/.axn-dev/config.yaml`:

```yaml
worktrees: /home/dev/worktrees
```

## Listing worktrees

```bash
axn-dev git worktree list
```

Shows every configured repo, the branch each worktree is on, and a short
relative path from the main checkout.

You can also see all linked worktrees in the single repo overview from
`axn-dev git status` — it prints the main checkout plus every linked worktree
under it. (Machine-readable mode, `--machine-readable`, only prints one row per
configured repo — use `git worktree list` for worktree rows.)

```bash
axn-dev git worktree prune   # Prune stale worktree registrations in all repos
axn-dev git worktree remove <repo> <path>   # Remove a worktree (keep the branch)
```

## Selecting a worktree for a run: `--workbase`

`axn-dev start`, `stop`, `patch` and `serve` accept `--workbase <branch>`:

```bash
axn-dev start -g -s app-full -p 8091 --workbase feature/my-branch
```

Every configured repo — including `integration:` repos — is resolved to the
checkout or linked worktree on `<branch>`. Repos that have no such worktree
keep their configured path. This lets you run a scenario from a feature
worktree without editing `~/.axn-dev/config.yaml`.

Two shortcuts exist when you don't pass `--workbase`:

- Running `axn-dev` **inside an integration repo checkout** (a `*-integration`
  repo containing `scenarios/`) automatically uses that checkout as the primary
  global scenario source — the checked-out branch is the workbase.
- Running `axn-dev` inside any configured repo's worktree overrides that
  repo's `*_ROOT` env var to the active checkout.

`--repo-root <name>=<path>` on `start` overrides a single repo for one run and
wins over `--workbase`.

## Starting/stopping a scenario from a worktree

When you run `axn-dev start` inside a worktree, the CLI:

- recognises the canonical repo name from the git remote
- sets `MYAPP_HARDWARE_ROOT` / `MYAPP_SERVER_ROOT` / etc. to the active checkout
- gives the Docker Compose project a unique name so worktrees do not collide

```bash
cd /home/dev/worktrees/myapp-hardware-feat-driver-split
axn-dev start -s mock
```

`axn-dev list` also shows scenarios discovered in every worktree and annotates
them with the branch and relative path.

## Serve dashboard

`axn-dev serve` renders a worktree badge on each project scenario card when the
scenario lives in a linked worktree.

## Post-MR cleanup

After a merge request is merged, remove the feature worktree and branch:

```bash
axn-dev git worktree cleanup myapp-hardware feat/driver-split
```

To also delete the remote branch:

```bash
axn-dev git worktree cleanup myapp-hardware feat/driver-split --remote
```

This command:

1. removes the worktree at the worktree path
2. deletes the local branch
3. (with `--remote`) deletes the remote branch

Before running, make sure no scenario is running from the worktree. If a
docker-compose project is still active, `git worktree remove` may fail. Stop it
with `axn-dev stop -s <scenario>` from the worktree first.

## Identifying stale worktrees

`axn-dev git status` shows every linked worktree under its parent repo, along
with the current branch, relative path, and status indicators. This is the
fastest way to discover worktrees across all configured repos from one command.

A worktree is likely stale and safe to clean up when any of these are true:

- It is clean (`✓`) and the branch is already merged into `develop`.
- The remote branch is missing (`×`), which usually means the MR was merged and
  the remote branch was deleted.
- It is behind `develop` and no longer being used.

Once a worktree is stale, remove it and its local branch:

```bash
axn-dev git worktree cleanup <repo> <branch>
```

For example, to remove `feat-serve-urls` from the `axn-dev-cli` repo:

```bash
axn-dev git worktree cleanup axn-dev-cli feat-serve-urls
```

## Source

- `packages/core/src/util/worktree.ts` — worktree discovery and canonical repo naming
- `packages/core/src/util/repo.ts` — worktree-aware `detectRepo` and `discoverAllProjectScenarios`
- `packages/core/src/util/compose.ts` — unique `COMPOSE_PROJECT_NAME` for worktree scenarios
- `packages/core/src/commands/git.ts` — `axn-dev git worktree` subcommands
- `packages/cmd-serve/src/serve-lib/ (serve dashboard)` — serve dashboard worktree badge
