import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "@axn-dev/core";
import { scanRepo } from "./c4model-lib/scan.js";
import { render, defaultWorkdir, slugify, type RenderFormat } from "./c4model-lib/render.js";

const LEVEL_STUBS: Record<string, string> = {
  "01-context.md": `<!-- Level 1 — System Context.
Audience: everyone, including non-technical stakeholders.
Answer: What is this? Who uses it? Why does it exist? Which external systems does it touch?
Keep it to ~1 page of prose plus ONE Mermaid diagram (C4Context / flowchart). -->
`,
  "02-containers.md": `<!-- Level 2 — Containers.
Audience: PMs with technical interest, architects.
Answer: Which applications, services, databases, and queues make up the solution?
Prose plus ONE Mermaid diagram (C4Container / flowchart). -->
`,
  "03-components.md": `<!-- Level 3 — Components.
Audience: developers.
Answer: Which major modules, classes, or services live inside each container, and what are their responsibilities and interactions?
Prose plus ONE Mermaid diagram per container that matters. -->
`,
  "04-code.md": `<!-- Level 4 — Code (optional, deepest zoom).
Audience: developers implementing or reviewing.
Answer: Key interfaces, data structures, and call paths. Reference real files with paths.
Small Mermaid class/sequence diagrams allowed. -->
`,
};

export class C4ModelCommand implements Command {
  readonly name = "c4model";
  readonly description = "C4 decomposition helpers for AI agents (scan, init, render)";

  private static readonly SUBS = ["scan", "init", "render"];
  private static readonly FLAGS = ["--repo", "--title", "--input", "--dir", "--format", "--out", "--help", "-h"];

  complete(words: string[]): string[] {
    const cur = words[words.length - 1] ?? "";
    if (words.length === 3) {
      return C4ModelCommand.SUBS.filter((s) => s.startsWith(cur) && s !== cur);
    }
    return C4ModelCommand.FLAGS.filter((f) => f.startsWith(cur) && f !== cur);
  }

  help(): string {
    return `
axn-dev c4model <subcommand> [options]

Deterministic helpers for the c4-decomposition skill. The skill (AI agent)
does the analysis; this command provides repo grounding and output rendering.

Subcommands:
  scan                 Print JSON context about a repository (tree, manifests,
                       readme excerpt, source stats) for grounding diagrams
  init                 Create a working directory with meta.yaml, input.md and
                       level stubs to fill in
  render               Assemble level files into final output (single file or
                       multi-file folder)

Options:
  scan:
    --repo <path>        Repo path to scan (default: current directory)
  init:
    --title <text>       Title of the requirement (required)
    --input <file|->     Requirement text from a file, or '-' for stdin
    --dir <path>         Working directory (default: .axn-dev/c4model/<slug>)
  render:
    --dir <path>         Working directory created by init (required)
    --format <single|multi>  Output format (default: single)
    --out <path>         Output file (single) or directory (multi).
                         Defaults to <dir>/c4-decomposition.md or <dir>/c4/
  -h, --help             Show this help

Examples:
  axn-dev c4model scan --repo /path/to/repo
  axn-dev c4model init --title "SSO login" --input ticket.md
  axn-dev c4model init --title "SSO login" --input - < ticket.md
  axn-dev c4model render --dir .axn-dev/c4model/sso-login --format multi --out docs/c4
`;
  }

  async execute(args: string[]): Promise<void> {
    const [sub, ...rest] = args;
    if (!sub || sub === "--help" || sub === "-h") {
      console.log(this.help());
      return;
    }
    switch (sub) {
      case "scan":   return this.scan(rest);
      case "init":   return this.init(rest);
      case "render": return this.renderCmd(rest);
      default:
        throw new Error(`Unknown c4model subcommand: '${sub}'\nRun 'axn-dev c4model --help' for usage.`);
    }
  }

  private scan(args: string[]): void {
    let repo = process.cwd();
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--repo") repo = resolve(args[++i]);
      else if (a === "--help" || a === "-h") { console.log(this.help()); return; }
      else throw new Error(`Unknown option: ${a}. Run 'axn-dev c4model --help'.`);
    }
    if (!existsSync(repo)) throw new Error(`Repo path does not exist: ${repo}`);
    console.log(JSON.stringify(scanRepo(repo), null, 2));
  }

  private async init(args: string[]): Promise<void> {
    let title: string | null = null;
    let input: string | null = null;
    let dir: string | null = null;

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--title") title = args[++i];
      else if (a === "--input") input = args[++i];
      else if (a === "--dir") dir = resolve(args[++i]);
      else if (a === "--help" || a === "-h") { console.log(this.help()); return; }
      else throw new Error(`Unknown option: ${a}. Run 'axn-dev c4model --help'.`);
    }

    if (!title) throw new Error("Missing --title. Run 'axn-dev c4model --help'.");

    const workdir = dir ?? defaultWorkdir(slugify(title));
    mkdirSync(join(workdir, "levels"), { recursive: true });

    writeFileSync(
      join(workdir, "meta.yaml"),
      `title: "${title.replace(/"/g, '\\"')}"\ndate: ${new Date().toISOString().slice(0, 10)}\n`,
      "utf-8",
    );

    if (input) {
      const text = input === "-" ? await this.readStdin() : readFileSync(resolve(input), "utf-8");
      writeFileSync(join(workdir, "input.md"), text, "utf-8");
    } else {
      writeFileSync(join(workdir, "input.md"), `<!-- Paste the requirement / ticket text here. -->\n`, "utf-8");
    }

    for (const [file, stub] of Object.entries(LEVEL_STUBS)) {
      const p = join(workdir, "levels", file);
      if (!existsSync(p)) writeFileSync(p, stub, "utf-8");
    }

    console.log(`Working directory: ${workdir}`);
    console.log(`\nNext steps:`);
    console.log(`  1. Put the requirement text into ${join(workdir, "input.md")}`);
    console.log(`  2. (Optional) run 'axn-dev c4model scan --repo <path>' to ground against a codebase`);
    console.log(`  3. Fill in the level files in ${join(workdir, "levels")}/`);
    console.log(`  4. Run 'axn-dev c4model render --dir ${workdir} --format single|multi [--out <path>]'`);
  }

  private renderCmd(args: string[]): void {
    let dir: string | null = null;
    let format: RenderFormat = "single";
    let out = "";

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--dir") dir = args[++i];
      else if (a === "--format") {
        const v = args[++i];
        if (v !== "single" && v !== "multi") throw new Error(`--format must be 'single' or 'multi', got '${v}'`);
        format = v;
      } else if (a === "--out") out = args[++i];
      else if (a === "--help" || a === "-h") { console.log(this.help()); return; }
      else throw new Error(`Unknown option: ${a}. Run 'axn-dev c4model --help'.`);
    }

    if (!dir) throw new Error("Missing --dir. Run 'axn-dev c4model --help'.");

    const result = render(dir, format, out);
    console.log(`Rendered ${result.format} output: ${result.output}`);
    console.log(`Levels: ${result.levels.join(", ")}`);
  }

  private readStdin(): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      let data = "";
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", (chunk) => (data += chunk));
      process.stdin.on("end", () => resolvePromise(data));
      process.stdin.on("error", reject);
    });
  }
}
