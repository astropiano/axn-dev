---
name: axn-dev
description: Use the `axn-dev` CLI to manage Docker Compose dev scenarios across multiple configured repos — start/stop/patch scenarios, multi-repo git operations, the serve dashboard, dotenv backups, and plugin management.
---

# axn-dev CLI Skill

`axn-dev` is a modular development CLI. Its core job is running **local dev scenarios**: start/stop Docker Compose stacks discovered in repo-local `scenarios/` folders or in configured integration repos (global scenarios). Additional commands (flow tests, dotenv backup, hardware, infra) ship as plugins.

## When to use this skill

- Starting/stopping a dev stack (mock or full) across several repos.
- Checking the state of all configured repos at once (`axn-dev git status`).
- Running a scenario from a feature-branch worktree (`--workbase`).
- Managing plugins (`axn-dev install --plugin`).

## Configuration

All repo paths and integration repos are configured in `~/.axn-dev/config.yaml` (global) or `<git-root>/.axn-dev/config.yaml` (project-local, takes precedence):

```yaml
# Integration repos — searched in order for global scenarios
integration:
  - /path/to/app-integration

# Repo checkout paths — injected as env vars for docker-compose
repos:
  myapp-server: /path/to/myapp-server
  myapp-frontend: /path/to/myapp-frontend
  myapp-hardware: /path/to/myapp-hardware

# Plugin-owned section example (consumed by an infra plugin, if installed)
infra: /path/to/infra-repo
```

Plugin packages may own additional top-level sections (e.g. `infra:`). The core CLI only interprets `repos:`, `integration:`, `worktrees:`, `auto-port:` and `gitlab-group:`.

## Repo layout

```
axn-dev/                      # The CLI monorepo (pnpm workspace)
├── packages/
│   ├── core/                 # Shared library: plugin loader, drivers, scenario discovery
│   ├── cli/                  # The axn-dev bin + built-in commands
│   ├── cmd-*/                # Command plugins (flow, serve, know, dotenv, overview, ...)
│   ├── adapter-*/            # Flow adapter plugins
│   └── type-*/               # Scenario type/driver plugins
└── docs/                     # plugins.adoc, flow.adoc, scenarios.adoc, ...

<integration-repo>/           # e.g. app-integration (path from config)
├── scenarios/                # Global cross-repo scenarios (e.g. app-mock)
│   └── <scenario>/compose.yaml + axn-dev.yaml (metadata: description, tags, env, frontendServices, backendServices)
└── .axn-dev.yaml             # Optional product test suite definitions (test plugin)
```

## Core commands

### Local scenarios

```bash
axn-dev list                          # Show available scenarios (repo-local + global)
axn-dev start                         # Auto-detect single scenario in current repo
axn-dev start -s mock -- -d           # Start named scenario, pass -d to compose
axn-dev start -g -s app-mock -- -d    # Start a global scenario
axn-dev start -s mock -f              # Foreground mode (attached, shows logs)
axn-dev start -s mock --build-no-cache # Rebuild images without layer cache
axn-dev start -s mock --auto-port     # Pick free ports when defaults are taken
axn-dev start -g -s app-full -p 8091  # Single-port scenario on an explicit port
axn-dev stop -s mock
axn-dev stop -s mock -- -v            # Also remove volumes
axn-dev clean -s mock -y              # Stop + remove all named volumes (destructive)
axn-dev start -s mock --clean -y      # Wipe data volumes, then start fresh
```

#### `--workbase` and `--repo-root`

`start`, `stop`, `patch` and `serve` accept `--workbase <branch>`: every
configured repo (including `integration:` repos) is resolved to the checkout
or linked worktree on that branch. This is the supported way to run a
scenario from a feature branch without editing `~/.axn-dev/config.yaml`:

```bash
axn-dev start -g -s app-full -p 8091 --workbase feature/my-branch
```

If `axn-dev` is run **inside an integration repo checkout** (a `*-integration`
repo containing `scenarios/`), that checkout is automatically used as the
primary global scenario source — no `--workbase` needed.

`--repo-root <name>=<path>` overrides individual repo roots for one run, e.g.
`--repo-root myapp-frontend=/path/to/worktree`. Explicit `--repo-root`
wins over `--workbase`.

#### Single-port scenarios

A scenario whose `compose.yaml` references `SCENARIO_PORT` is a *single-port*
scenario: it publishes exactly one host port (typically a reverse proxy
that routes by `Host` header / `.localhost` subdomain). For those, `-p/--port`
selects the port:

```bash
axn-dev start -g -s app-full -p 8091
axn-dev stop  -g -s app-full -p 8091
axn-dev patch -g -s app-full -p 8091 api
```

`-p` is rejected on multi-port scenarios. Without `-p`, `stop`/`patch`
discover the running port from Docker. Port conflicts are detected before
`docker compose up` and report the owning container, compose project and
scenario name. See `docs/scenarios.adoc` for the full model.

### Patching a running scenario

Rebuild and/or restart specific services without touching the rest of the stack. The scenario must already be running.

```bash
axn-dev patch -s app-dev app-server              # restart only (fastest)
axn-dev patch -s app-dev app-server --build      # rebuild + restart
axn-dev patch -s app-dev app-server --no-cache   # rebuild without layer cache + restart
axn-dev patch -s app-dev svc1 svc2 --build      # patch multiple services at once
```

Uses `docker compose build` + `docker compose up -d --no-deps <services>` — `--no-deps` prevents restarting dependent services. Fails immediately if the scenario is not running.

The CLI auto-detects the current repo by walking up from `cwd`. Per-repo paths from `~/.axn-dev/config.yaml` are injected as env vars for compose files (e.g. `MYAPP_SERVER_ROOT`, `MYAPP_FRONTEND_ROOT`).

With `-s`, global scenarios (from integration repos) are checked first, falling back to the current repo's project scenario. Without `-s` inside a repo, the project scenario is auto-selected. Output always indicates whether a **Project** or **Global** scenario is being used.

## Git (multi-repo)

The `axn-dev git` command provides a **fast, aggregated overview** of all repos configured in `~/.axn-dev/config.yaml`. In a multi-repo setup, running `git status` in every directory manually is slow and error-prone. This command collects everything into one view.

### How it works

1. Reads the `repos:` section and plugin-owned dir sections from `~/.axn-dev/config.yaml`.
2. Walks each repo and reads `.git/config` directly (no git binary needed) to discover the remote group from the origin URL.
3. Runs `git branch --show-current`, `git rev-list --left-right --count`, and `git status --porcelain` per repo.
4. Groups output by remote path (e.g. `dev/myapp`, `dev/otherteam`).

### Output indicators

```
  myapp-server               main                           ↑2 ~
  myapp-frontend             feature/grid-renderer      ↓1 ?3
```

| Indicator | Meaning |
|---|---|
| `×` | Remote branch does not exist (local branch has never been pushed) |
| `↑N` | Ahead of origin by N commits |
| `↓N` | Behind origin by N commits |
| `~` | Dirty — tracked files have uncommitted changes |
| `?N` | N untracked files present |
| `✓` | Clean — no local changes, in sync with origin |

### Actions

```bash
axn-dev git status                          # All repos, grouped by remote group
axn-dev git status --group myapp            # Only repos in the myapp group
axn-dev git status --machine-readable       # Pipe-delimited rows for scripts
axn-dev git status --unmerged               # Only repos whose branch is not merged into develop
axn-dev git fetch                           # Fetch all repos with --prune
axn-dev git push --group myapp              # Push all repos in group (same branch required)
axn-dev git push --branch feature/my-work   # Push every repo on this branch
axn-dev git pull --group myapp              # Pull all repos in group
```

### Machine-readable output

`axn-dev git status --machine-readable` prints one pipe-delimited row per configured repo, with no ANSI colours or headers. This is useful for `grep`/`awk`/spreadsheet analysis.

```
group|name|branch|ahead|behind|dirty|untracked|remoteBranchMissing|mergedToDevelop|path
```

- `ahead` / `behind` counts are relative to `origin/<branch>`.
- `dirty` and `remoteBranchMissing` are `yes` or `no`.
- `mergedToDevelop` is `yes` if the current branch is fully contained in `origin/develop` (or `develop`), `no` if it is not, `no_develop` if no develop branch exists, and `no_branch` if HEAD is detached.
- Combine with `--group`, `--fetch`, or `--unmerged` as usual, e.g. `axn-dev git status --group myapp --machine-readable`.

**Safety guard:** `push` and `pull` with `--group` will **abort** if repos in that group are on different branches. Use `--branch` to target a specific branch across all groups instead.

### Common tasks (cookbook)

**"Check if any repo has uncommitted work before leaving":**
```bash
axn-dev git status
```

**"Fetch everything after a morning standup":**
```bash
axn-dev git fetch
```

**"Push the current feature across all affected repos":**
```bash
axn-dev git push --branch feature/my-work
```

## Serve (dashboard)

`axn-dev serve` starts a persistent local proxy server (default port `7079`):

- Live dashboard at `http://localhost:7079` listing global + project scenarios
- Start/stop scenarios and browse their endpoints from the browser
- Management API: `POST /register`, `DELETE /register/:id`, `GET /status`, `POST /stop`, `GET /scenarios`, `POST /scenarios/start`, `POST /scenarios/stop`, `GET /health`
- `POST /scenarios/start` accepts `{scenarioName, source, repoName, port?}` — `port` behaves like `start -p` for single-port scenarios. Starts run the same preflight as `axn-dev start`: restart-if-running, `auto-port` from config, and a port-conflict check that fails with `409` before `docker compose up`.
- `frontendServices`/`backendServices` from each `axn-dev.yaml` are resolved and shown as clickable links (including `.localhost` subdomain URLs for single-port scenarios, using the running `SCENARIO_PORT`)
- Scenario tags from each `axn-dev.yaml` and flow tags from `<tags>` in flow XML are shown as badges and can be filtered; tag search matches prefixes and path segments, so `myapp` also matches `myapp/e2e`
- Scenarios and flows each have a **Table** view (sortable list with tag badges) and a **Tree** view (slash-separated tags become folders; untagged items are grouped first); the selected view is remembered in `localStorage`
- `--workbase <branch>` applies the same worktree resolution as `start`/`stop`/`patch`
- `axn-dev serve --stop` stops a running server; `Ctrl+C` or `POST /stop` also work
- Config is re-read on every request, so changes to `~/.axn-dev/config.yaml` or scenario `axn-dev.yaml` files are picked up on refresh without restarting

## Init / Install / Completion

```bash
axn-dev init                          # Interactively create ~/.axn-dev/config.yaml
axn-dev init --local                  # Write <git-root>/.axn-dev/config.yaml
axn-dev init --scan <dir> --force     # Auto-discover repos under <dir>, overwrite

axn-dev install --skills              # Install agent skills (Claude, Devin, ...)
axn-dev install --skill axn-dev-cli --project
axn-dev install --completion          # Append shell completion to ~/.zshrc/~/.bashrc
axn-dev install --plugin <pkg[@ver]>  # Install plugin into ~/.axn-dev/plugins
axn-dev uninstall --plugin <pkg>      # Remove a plugin package
axn-dev uninstall --skills            # Remove installed skills

axn-dev completion zsh > ~/.zsh/completions/_axn-dev   # Print completion script
```

## Plugins

`axn-dev` is modular: commands, scenario drivers, flow adapters and skills ship in plugin packages discovered via the `axn-dev` manifest field in `package.json`. Plugins are scanned from the CLI's sibling packages and `~/.axn-dev/plugins/node_modules` (populated by `axn-dev install --plugin <pkg>`).

See `docs/plugins.adoc` for authoring plugins.

## Backup / Restore (.env files)

Provided by the bundled `@axn-dev/cmd-dotenv` plugin:

```bash
axn-dev backup dotenv --infra * --tar --to ~/mybackup.tar   # All infra .env files → tar
axn-dev backup dotenv -s dev                                # Scenario .env → directory
axn-dev backup dotenv --infra * --bitwarden                 # Store as Bitwarden secure notes
axn-dev restore dotenv --from ~/mybackup.tar --base ~/repos
axn-dev restore dotenv --bitwarden --infra * --force
```

## Plugin commands

Additional commands come from installed plugins — each ships its own skill:

- `axn-dev flow` — XML-defined flow tests (`@axn-dev/cmd-flow`, see `axn-dev-flow` skill)
- `axn-dev know` — BM25 knowledge index (`@axn-dev/cmd-know`, see `axn-dev-know` skill)
- `axn-dev overview` — machine-wide work report (`@axn-dev/cmd-overview`, see `axn-dev-overview` skill)

## When to read more

- Plugin authoring: `docs/plugins.adoc`
- Scenario model: `docs/scenarios.adoc`
- Flow format: `packages/cmd-flow/docs/flow.adoc`
- Top-level overview: `README.adoc`
