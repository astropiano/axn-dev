---
name: axn-dev-know
description: Use `axn-dev know` to build and search a local BM25 knowledge index over files and git repos. Supports multiple named corpora, global (personal) and project scope, and snippet-level search results.
---

# axn-dev know Skill

`axn-dev know` is the knowledge indexing sub-system. It lets you track files (docs, code, configs), index them with BM25 full-text search, and retrieve relevant snippets with a plain-language query.

## When to use this skill

- Searching across architectural docs, runbooks, or design notes without needing to remember filenames.
- Building a personal or project-level knowledge base that can be queried from the CLI.
- Preparing a searchable corpus for AI agent context injection (future: SKILL file generation).

## Storage layout

```
~/.axn-dev/                              # global scope (default)
  corpora/
    <corpus-name>/                       # default corpus name: "personal"
      corpus.yaml                        # corpus config (name, indexing technique)
      items/
        <slug>.yaml                      # one file per tracked source file
      index.json                         # serialised BM25 index (rebuilt by `index`)

<git-root-or-cwd>/.axn-dev/             # project scope (-s project)
  corpora/
    <corpus-name>/                       # default corpus name: "project"
      ...same layout...
```

**Item YAML** (one per tracked file):
```yaml
path: /abs/path/to/file.md
added: 2026-05-10T10:00:00Z
hash: sha256:abc123          # content hash for plain files
git_repo: /abs/path/to/repo  # present if file is inside a git repo
git_commit: a1b2c3d          # per-file last-commit SHA at last index run
chunks:
  - offset: 0
    text: "first paragraph..."
  - offset: 1
    text: "second heading and its content..."
```

Re-indexing is skipped for a file if `git_commit` (or `hash` for non-git files) is unchanged since the last `index` run.

## Core commands

```bash
# Track a file (no indexing yet)
axn-dev know add path/to/file.md

# Track all text files in a directory recursively
axn-dev know add docs/

# Track into a named corpus
axn-dev know add file.md -c architecture

# Track into project scope (stored in .axn-dev/ at git root)
axn-dev know add file.md -s project

# Re-index all changed files in the default corpus, rebuild index.json
axn-dev know index

# Index a specific corpus / scope
axn-dev know index -s project -c myproject

# Search — returns top 5 snippets by default
axn-dev know find "how to boot the device"

# Search with more results
axn-dev know find "docker compose" -n 10

# Search in a specific corpus
axn-dev know find "keycloak config" -c architecture -s project
```

## Options (all subcommands)

| Flag | Default | Description |
|---|---|---|
| `--scope / -s` | `global` | `global` → `~/.axn-dev/`, `project` → `<git-root>/.axn-dev/` |
| `--corpus / -c` | `personal` (global) or `project` (project) | Named corpus within the scope. Can be passed multiple times to `find` for cross-corpus search. |
| `--indexing / -i` | `bm25` | Indexing technique: `bm25`, `vector`, or `hybrid` |
| `-n` | `5` | Number of results (`find` only) |

## How indexing works

1. `add` writes an item YAML stub (no chunks, no hash yet).
2. `index` reads all item YAMLs in the corpus, checks each file for changes (git commit SHA or content hash), re-chunks changed files into paragraphs/headings, saves updated YAMLs, then rebuilds `index.json` using wink-bm25-text-search.
3. `find` loads `index.json`, runs BM25 query, then fetches the best-matching chunk from each matching item YAML for the snippet display.

BM25 indexes the full concatenated text of each file. Snippet retrieval is done by simple term-overlap scoring over the stored chunks — no re-embedding needed.

## Supported file types (for directory `add`)

`.md`, `.txt`, `.ts`, `.js`, `.py`, `.yaml`, `.yml`, `.json`, `.sh`, `.adoc`, `.rst`, `.toml`, `.env`, `.conf`, `.cfg`

## Common tasks (cookbook)

**"Index all docs in a repo":**
```bash
axn-dev know add docs/ -s project
axn-dev know index -s project
```

**"Search personal notes for a topic":**
```bash
axn-dev know find "raspberry pi boot config"
```

**"Re-index after editing files":**
```bash
axn-dev know index   # only changed files are re-processed
```

**"Use a named corpus to separate concerns":**
```bash
axn-dev know add infra/docs/ -c infra
axn-dev know index -c infra
axn-dev know find "vpn setup" -c infra
```

**"Search multiple corpora in one query":**
```bash
axn-dev know find "auth" -c axn-dev -c myapp-server -c myapp-docs
```

**"Set up cross-repo code search across all configured repos":**

1. Make sure all repos are registered in `~/.axn-dev/config.yaml` under `repos:`.
2. Create a project corpus per repo and index it:
   ```bash
   for repo in myapp-server myapp-frontend; do
     (cd ~/dev/$repo && axn-dev know add . -s project && axn-dev know index -s project)
   done
   ```
3. Search across corpora:
   ```bash
   axn-dev know find "auth middleware" -c project -s project
   ```

## Gotchas

- `add` does **not** index — always run `index` afterwards.
- `find` returns no results if `index` has never been run for that corpus.
- wink-bm25 requires at least 3 documents to build a valid index; the engine pads automatically if fewer are present.
- For git-tracked files, stale detection uses the per-file last-commit SHA (not HEAD of repo). A file only triggers re-index when it was actually changed in git.
- The `.axn-dev/` folder in project scope should be added to `.gitignore` if you do not want to commit the index.

## Source files

- `packages/cmd-know/src/commands/know.ts` — subcommand router (`add`, `index`, `find`)
- `packages/cmd-know/src/util/know/storage.ts` — scope/corpus resolution, item YAML I/O
- `packages/cmd-know/src/util/know/hash.ts` — file hashing, git per-file commit tracking
- `packages/cmd-know/src/util/know/chunker.ts` — paragraph/heading splitter
- `packages/cmd-know/src/util/know/bm25.ts` — wink-bm25 build/search/serialize wrapper
- `packages/cmd-know/src/util/know/types.ts` — shared TypeScript types
