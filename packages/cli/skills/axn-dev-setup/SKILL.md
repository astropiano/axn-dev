---
name: axn-dev-setup
description: Bootstrap a development workspace. Run `axn-dev setup` to discover, clone, and register all GitLab group repos in ~/.axn-dev/config.yaml.
---

# axn-dev Setup Skill

Set up a new machine or workspace for multi-repo development. The `axn-dev setup` command uses `glab` to discover and clone all repos in a GitLab group (including subgroups), then updates `~/.axn-dev/config.yaml` so `axn-dev` can find them.

## When to use this skill

- Onboarding a new developer who needs all team repos locally.
- Rebuilding a dev machine from scratch.
- Adding a newly created repo or an entire new group to an existing `~/.axn-dev/config.yaml`.
- Preparing a workspace before running `axn-dev start`, `axn-dev git status`, or `axn-dev list`.

## What you need first

- `glab` installed and authenticated (`glab auth login`).
- Access to the GitLab group that owns your repos (e.g. `acme`).
- A parent directory where you want the checkouts, e.g. `~/dev`.

## Quick start

Set the default GitLab group in `~/.axn-dev/config.yaml`:

```yaml
gitlab-group: acme
```

Then run the setup command. It uses the configured group and asks for the
checkout directory interactively (default `~/repos`):

```bash
axn-dev setup --dir ~/dev
```

You can also pass a group name or URL directly, or a nested group path:

```bash
axn-dev setup --group acme
axn-dev setup --group https://gitlab.com/acme
axn-dev setup --group acme/dev --dir ~/dev --non-interactive
```

`axn-dev setup` will:

1. List every non-archived project in the group (including subgroups).
2. Skip repos that are already cloned.
3. Clone missing repos while preserving the GitLab namespace structure.
4. Place repos named `*-integration` under the `integration:` key.
5. Add all other repos under `repos:`.
6. Merge the results into `~/.axn-dev/config.yaml` — existing entries,
   including `env:` aliases and plugin-owned sections like `infra:`,
   are preserved.

Plugin-owned sections such as `infra:` are not written by setup; configure
them manually or per the owning plugin's docs.

## Configuration target

`axn-dev` reads repo and integration paths from `~/.axn-dev/config.yaml`:

```yaml
# Default GitLab group used by axn-dev setup
gitlab-group: acme

# Repositories that axn-dev knows about and injects as env vars.
# `env:` sets the variable prefix: APP_SERVER → APP_SERVER_ROOT.
repos:
  myapp-server: {path: ~/dev/myapp-server, env: APP_SERVER}
  myapp-frontend: {path: ~/dev/myapp-frontend, env: MYAPP_FRONTEND}
  myapp-hardware: {path: ~/dev/myapp-hardware, env: MYAPP_HARDWARE}
  myapp-contracts: {path: ~/dev/myapp-contracts, env: MYAPP_CONTRACTS}
  myapp-integration: {path: ~/dev/myapp-integration, env: MYAPP_INTEGRATION}

# Integration repos that provide global cross-repo scenarios
integration:
  - ~/dev/myapp-integration

# Plugin-owned section example (consumed by an infra plugin, if installed)
infra: ~/infra/infra-repo
```

Local values in `<git-root>/.axn-dev/config.yaml` take precedence over global values.

## Manual glab commands

If you prefer to run `glab` directly instead of using `axn-dev setup`, the same commands are available.

List every project in the group, including subgroups:

```bash
glab repo list -g acme --include-subgroups
```

Narrow the list if needed:

```bash
# Only non-archived projects
glab repo list -g acme --include-subgroups --archived=false

# Output as JSON for filtering
glab repo list -g acme --include-subgroups --output json
```

Clone a single repo:

```bash
cd ~/dev
glab repo clone acme/dev/myapp-server
```

Then add the checkout path to `~/.axn-dev/config.yaml` under `repos:`.

Clone an entire group while preserving the subgroup structure:

```bash
mkdir -p ~/dev
cd ~/dev
glab repo clone -g acme \
  --include-subgroups \
  --archived=false \
  --paginate \
  --preserve-namespace
```

After cloning, open `~/.axn-dev/config.yaml` and add the absolute paths for the repos you need:

```yaml
repos:
  myapp-server: {path: ~/dev/myapp-server, env: APP_SERVER}
  myapp-frontend: {path: ~/dev/myapp-frontend, env: MYAPP_FRONTEND}
  myapp-hardware: {path: ~/dev/myapp-hardware, env: MYAPP_HARDWARE}
  myapp-contracts: {path: ~/dev/myapp-contracts, env: MYAPP_CONTRACTS}
  myapp-integration: {path: ~/dev/myapp-integration, env: MYAPP_INTEGRATION}

integration:
  - ~/dev/myapp-integration

infra: ~/infra/infra-repo
```

To control the injected env-var names, use the object form of a `repos:`
entry — `myapp-server: {path: /x/myapp-server, env: APP_SERVER}`
yields `APP_SERVER_ROOT` instead of the derived `MYAPP_SERVER_ROOT`.

## Verify the setup

Once the config is written, confirm everything is wired:

```bash
# Should list scenarios from all configured repos
axn-dev list

# Should show every repo's branch and status
axn-dev git status
```

## Updating an existing workspace

When new repos are added to the group, re-run `axn-dev setup` for the same group and directory. It skips already-cloned repos, clones only the missing ones, and updates `~/.axn-dev/config.yaml` with any new entries.

## Source

- `packages/cli/src/commands/setup.ts` — `axn-dev setup` implementation
- `packages/core/src/util/config.ts` — `~/.axn-dev/config.yaml` parsing, loading, and saving
- `packages/cli/skills/axn-dev-cli/SKILL.md` — full `axn-dev` usage reference
