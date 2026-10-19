import type { Command } from "@axn-dev/core";
import { flagCompleter } from "@axn-dev/core";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { scanWorkspaceTree } from "../repo-scan.js";

const CONFIG_DIR = ".axn-dev";
const CONFIG_FILE = "config.yaml";

function ask(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

function askYN(question: string, defaultYes: boolean = true): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  return new Promise((resolve) => {
    rl.question(`${question} ${hint}: `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (!a) resolve(defaultYes);
      else resolve(a === "y" || a === "yes");
    });
  });
}


export class InitCommand implements Command {
  readonly name = "init";
  readonly description = "Initialize ~/.axn-dev/config.yaml with repo paths";

  complete = flagCompleter([
    "--global", "--local", "--force", "-f", "--scan", "--help", "-h",
  ]);

  help(): string {
    return `
Usage: axn-dev init [options]

Initialize the axn-dev configuration file.

Options:
  --global          Write to ~/.axn-dev/config.yaml (default)
  --local           Write to <git-root>/.axn-dev/config.yaml
  --force           Overwrite existing config without prompting
  --scan <dir>      Scan a directory tree for git checkouts to register:
                    *-integration dirs go to integration:, others to repos:

If run without options, interactively prompts for repo paths.
`.trim();
  }

  async execute(args: string[]): Promise<void> {
    let scope: "global" | "local" = "global";
    let force = false;
    let scanDir: string | null = null;

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--help" || a === "-h") {
        console.log(this.help());
        return;
      }
      if (a === "--global") scope = "global";
      else if (a === "--local") scope = "local";
      else if (a === "--force" || a === "-f") force = true;
      else if (a === "--scan" && args[i + 1]) {
        scanDir = resolve(args[++i]);
      }
    }

    // Determine target path
    let configDir: string;
    if (scope === "local") {
      const gitRoot = this.findGitRoot(process.cwd());
      if (!gitRoot) {
        throw new Error("Not inside a git repository. Cannot write local config.");
      }
      configDir = join(gitRoot, CONFIG_DIR);
    } else {
      configDir = join(homedir(), CONFIG_DIR);
    }

    const configPath = join(configDir, CONFIG_FILE);

    // Check if already exists
    if (existsSync(configPath) && !force) {
      console.log(`Config already exists: ${configPath}`);
      const existing = readFileSync(configPath, "utf-8");
      console.log("\n--- Current config ---");
      console.log(existing);
      console.log("--- End ---\n");
      const overwrite = await askYN("Overwrite?", false);
      if (!overwrite) {
        console.log("Aborted.");
        return;
      }
    }

    // Gather info
    let integration: string[] = [];
    const repos: Record<string, string> = {};

    if (scanDir) {
      console.log(`Scanning ${scanDir} for repos...`);
      const scan = scanWorkspaceTree(scanDir);
      integration = scan.integration;
      Object.assign(repos, scan.repos);
    } else {
      // Interactive mode
      console.log("\naxn-dev init — Configure your development environment\n");

      // Integration repos
      console.log("Integration repos contain global scenarios (compose stacks).");
      let addMore = true;
      while (addMore) {
        const path = await ask("Integration repo path (empty to skip)");
        if (path) {
          const resolved = resolve(path);
          if (existsSync(resolved)) {
            integration.push(resolved);
          } else {
            console.log(`  Path does not exist: ${resolved}`);
            const addAnyway = await askYN("  Add anyway?", false);
            if (addAnyway) integration.push(resolved);
          }
          addMore = await askYN("Add another integration repo?", false);
        } else {
          addMore = false;
        }
      }

      // Individual repos
      console.log("\nAdd repo checkout paths (these become env vars for docker-compose).");
      console.log("Press Enter with empty path to finish.\n");

      let addMoreRepos = await askYN("Add repos?", false);
      while (addMoreRepos) {
        const name = await ask("  Repo name");
        if (!name) break;
        const path = await ask(`  Path for ${name}`);
        if (path) repos[name] = resolve(path);
        addMoreRepos = await askYN("  Add another?", false);
      }
    }

    // Generate YAML
    const yaml = this.generateYaml(integration, repos);

    // Write
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, yaml, "utf-8");
    console.log(`\nConfig written to: ${configPath}`);
    console.log("\nYou can edit this file anytime. Run 'axn-dev list' to verify scenarios are found.");
  }

  private generateYaml(
    integration: string[],
    repos: Record<string, string>,
  ): string {
    const lines: string[] = [
      "# axn-dev CLI configuration",
      "",
    ];

    // Integration
    lines.push("# Integration repos — searched in order for global scenarios");
    if (integration.length > 0) {
      lines.push("integration:");
      for (const p of integration) {
        lines.push(`  - ${p}`);
      }
    } else {
      lines.push("# integration:");
      lines.push("#   - /path/to/my-integration-repo");
    }
    lines.push("");

    // Repos
    lines.push("# Repo checkout paths — injected as env vars for docker-compose");
    lines.push("# Object form sets the env var name: my-repo: {path: /x, env: MYREPO}");
    if (Object.keys(repos).length > 0) {
      lines.push("repos:");
      for (const [name, path] of Object.entries(repos)) {
        lines.push(`  ${name}: ${path}`);
      }
    } else {
      lines.push("# repos:");
      lines.push("#   my-repo: /path/to/my-repo");
      lines.push("#   other-repo: /path/to/other-repo");
    }
    lines.push("");

    // Plugin-owned sections
    lines.push("# Command plugins may declare their own top-level keys here");
    lines.push("# (e.g. an infra plugin might use `infra: /path/to/infra-repo`).");
    lines.push("");

    return lines.join("\n");
  }

  private findGitRoot(startDir: string): string | null {
    let dir = resolve(startDir);
    while (dir !== "/") {
      if (existsSync(join(dir, ".git"))) return dir;
      dir = resolve(dir, "..");
    }
    return null;
  }
}
