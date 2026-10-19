---
name: c4-decomposition
description: Decompose a high-level requirement (freeform text, ticket, user story) into a C4 model — Mermaid diagrams plus prose at four zoom levels (Context → Containers → Components → Code). Produces either one Markdown document or a folder of per-level files, readable by both non-technical PMs and developers.
---

# c4-decomposition Skill

Decompose a problem (*analysis* in the original Greek sense: breaking a whole into its parts) into a C4 model. The result is a set of Mermaid diagrams plus textual descriptions at four zoom levels — from "what is this and why" down to "which classes and call paths implement it". The zoom-in / zoom-out structure lets a non-technical PM and a developer read the same artifact at the altitude they need.

## When to use this skill

- A JIRA ticket, requirement, or problem statement needs to be broken down before implementation.
- A PM or stakeholder needs a visual, zoomable explanation of a feature or problem.
- You want architecture documentation grounded in the real codebase rather than invented.

## Division of labour

| Role | Responsibility |
|---|---|
| `axn-dev c4model` | Deterministic "hands": repo scanning, working-directory scaffolding, final rendering. |
| The agent (you) | The "brain": reading the requirement, analysis, writing prose and Mermaid diagrams per level. |

Never hand-generate the final document layout — write the level files and let `axn-dev c4model render` assemble them. This keeps `--format` a pure output decision the user can change without regenerating content.

## Workflow

```bash
# 1. Scaffold the working directory
axn-dev c4model init --title "SSO login for admin portal" --input ticket.md
#    or: cat ticket.md | axn-dev c4model init --title "..." --input -
#    or: axn-dev c4model init --title "..."            # write input.md yourself

# 2. (Optional but recommended) ground against a codebase
axn-dev c4model scan --repo /path/to/repo > /tmp/scan.json
#    Prints JSON: git info, README excerpt, manifests + dependency lists,
#    shallow file tree, source file counts, notable infra files.

# 3. Analyse the requirement and write the four level files:
#    <workdir>/levels/01-context.md
#    <workdir>/levels/02-containers.md
#    <workdir>/levels/03-components.md
#    <workdir>/levels/04-code.md          (optional — deepest zoom)

# 4. Render the final artifact in the user's chosen format
axn-dev c4model render --dir <workdir> --format single --out c4-decomposition.md
axn-dev c4model render --dir <workdir> --format multi  --out docs/c4/
```

The working directory defaults to `.axn-dev/c4model/<slug>/` inside the current project. If the user did not specify a format or output path, ask — or default to `single` and tell them both formats are available.

## The four levels

Each level file is Markdown: a short prose section followed by **one** Mermaid diagram (more only where genuinely needed, e.g. one per container at level 3).

### Level 1 — Context (`01-context.md`)

- **Audience**: everyone, including non-technical PMs.
- **Content**: the problem in plain language. Who is affected, what changes, which external systems are involved, why it matters. No jargon.
- **Diagram**: `C4Context` (or a plain `flowchart` with people/systems). Show actors, the system under discussion, and external systems only.

### Level 2 — Containers (`02-containers.md`)

- **Audience**: PMs with technical interest, architects, new team members.
- **Content**: the running parts — apps, services, databases, queues, frontends. One short paragraph per container: what it does and which technology it uses.
- **Diagram**: `C4Container` (or `flowchart`). Containers, their protocols, and the data flows between them.

### Level 3 — Components (`03-components.md`)

- **Audience**: developers.
- **Content**: the major modules/classes inside each relevant container, their responsibilities and interactions. Where the codebase was scanned, name real modules and paths.
- **Diagram**: `C4Component` (or `flowchart`), one per container that matters.

### Level 4 — Code (`04-code.md`, optional)

- **Audience**: developers implementing or reviewing.
- **Content**: key interfaces, data structures, and call paths. Reference real files (`src/foo/bar.ts`). Skip this level when the requirement has no meaningful code-level detail yet.
- **Diagram**: small Mermaid `classDiagram` or `sequenceDiagram` if helpful.

## Mermaid guidelines

- Prefer `C4Context` / `C4Container` / `C4Component` / `C4Dynamic` diagram types where the renderer supports them; fall back to `flowchart`, `sequenceDiagram`, or `classDiagram` — they render everywhere.
- Keep diagrams small enough to read: ≤ ~10 nodes per diagram. Split rather than cram.
- Label every relationship edge (`-->|uses HTTPS|`). Unlabeled arrows are worthless to non-technical readers.
- Validate syntax mentally before writing — a broken Mermaid block fails silently in most renderers.

## Output formats (user-controlled)

- **`--format single`** → one `c4-decomposition.md` with a generated table of contents and each level as a `##` section. Best for pasting into Confluence/GitLab/MR descriptions.
- **`--format multi`** → a folder with `index.md` linking to `01-context.md` … `04-code.md`. Best for committing to a repo's `docs/` folder.

## Common tasks (cookbook)

**"Decompose this ticket for the PM":**
```bash
axn-dev c4model init --title "…" --input ticket.txt
# write levels — focus on Level 1 + 2 quality, keep Level 3 light, skip Level 4
axn-dev c4model render --dir <workdir> --format single --out c4-decomposition.md
```

**"Grounded decomposition against this repo":**
```bash
axn-dev c4model init --title "…" --input -
axn-dev c4model scan --repo . > /tmp/scan.json
# read scan.json, then inspect the specific files it surfaced before writing levels 2–4
axn-dev c4model render --dir <workdir> --format multi --out docs/c4/<slug>
```

## Gotchas

- `init` only scaffolds — it never writes diagram content. All analysis is yours.
- `render` requires at least one `levels/*.md` file; `04-code.md` is optional.
- Level files are sorted by C4 order (context → code), not alphabetically; keep the `NN-` numeric prefix.
- If the requirement is ambiguous, note open questions inside the level files rather than inventing answers — flag them clearly for the PM.
- `.axn-dev/` is a working directory; the rendered output is the artifact to commit or share.

## Source files

- `axn-dev-cli/packages/cmd-c4model/src/c4model.ts` — subcommand router (`scan`, `init`, `render`)
- `axn-dev-cli/packages/cmd-c4model/src/c4model-lib/scan.ts` — repo context scanner (JSON output)
- `axn-dev-cli/packages/cmd-c4model/src/c4model-lib/render.ts` — level-file assembly into single/multi output
