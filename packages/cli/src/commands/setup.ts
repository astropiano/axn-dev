import type { Command } from "@axn-dev/core";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { loadAxnDevConfigFile, saveAxnDevConfigFile, flagCompleter, configSection } from "@axn-dev/core";
import { classifyRepo } from "../repo-scan.js";

interface GitlabProject {
  path: string;
  path_with_namespace: string;
  name: string;
}

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

function normalizeGroup(input: string): string {
  const s = input.trim().replace(/\/+$/, "");

  // Full URL with or without scheme: https://gitlab.com/myorg/...
  const urlMatch = s.match(/^(?:https?:)?\/\/[^/]+\/(.+)$/);
  if (urlMatch) return urlMatch[1];

  // Bare host/path: gitlab.com/myorg/...
  const bareMatch = s.match(/^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z0-9.-]+\/(.+)$/);
  if (bareMatch) return bareMatch[1];

  // Plain group name or nested group path
  return s;
}

function glabExists(): boolean {
  return spawnSync("glab", ["--version"], { stdio: "ignore" }).status === 0;
}

function listGroupProjects(group: string): GitlabProject[] {
  const projects: GitlabProject[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const result = spawnSync("glab", [
      "repo", "list",
      "-g", group,
      "-G",
      "--archived=false",
      "--output", "json",
      "--per-page", String(perPage),
      "--page", String(page),
    ], { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 });

    if (result.error) {
      throw new Error(`Failed to run glab: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(`glab repo list failed: ${result.stderr || result.stdout}`);
    }

    let batch: unknown;
    try {
      batch = JSON.parse(result.stdout);
    } catch {
      throw new Error(`glab repo list returned invalid JSON: ${result.stdout.slice(0, 200)}`);
    }

    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const p of batch as GitlabProject[]) {
      if (typeof p.path_with_namespace === "string" && typeof p.path === "string") {
        projects.push(p);
      }
    }

    if ((batch as GitlabProject[]).length < perPage) break;
    page++;
  }

  return projects;
}

function relativeProjectPath(group: string, pathWithNamespace: string): string {
  const prefix = `${group}/`;
  return pathWithNamespace.startsWith(prefix)
    ? pathWithNamespace.slice(prefix.length)
    : pathWithNamespace;
}

export class SetupCommand implements Command {
  readonly name = "setup";
  readonly description = "Clone a GitLab group and register repos in ~/.axn-dev/config.yaml";

  complete = flagCompleter([
    "--group", "-g", "--dir", "--non-interactive", "--output",
    "--page", "--per-page", "--help", "-h",
  ]);

  help(): string {
    return `
Usage: axn-dev setup [options]

Clone a GitLab group (including subgroups) into a local workspace
directory and add the discovered repositories to ~/.axn-dev/config.yaml.
Repos named *-integration are registered as global-scenario carriers;
everything else lands in repos:. Plugin-owned config sections (e.g. an
infra path) are left untouched — configure them per plugin docs.

Options:
  --group <name-or-url>
    GitLab group name, nested path (e.g. myorg/dev), or group URL.
    Also read from the gitlab-group key in ~/.axn-dev/config.yaml.
  --dir <path>
    Parent directory for checkouts (default: ~/repos)
  --non-interactive
    Skip prompts; requires --group or gitlab-group in config
  -h, --help
    Show this help
`.trim();
  }

  async execute(args: string[]): Promise<void> {
    if (args.includes("--help") || args.includes("-h")) {
      console.log(this.help());
      return;
    }

    if (!glabExists()) {
      throw new Error("glab is not installed. Install it and run 'glab auth login' first.");
    }

    const globalConfigPath = join(homedir(), ".axn-dev", "config.yaml");
    const globalCfg = loadAxnDevConfigFile(globalConfigPath);

    let group: string | undefined = globalCfg
      ? configSection<string>(globalCfg, "gitlab-group")
      : undefined;
    let targetDir = resolve(homedir(), "repos");
    const interactive = !args.includes("--non-interactive");

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--group" && args[i + 1]) group = args[++i];
      else if (a === "--dir" && args[i + 1]) targetDir = resolve(args[++i]);
    }

    if (group) {
      group = normalizeGroup(group);
    }

    if (!group) {
      if (interactive) {
        const answer = await ask("GitLab group or URL");
        group = normalizeGroup(answer);
      } else {
        throw new Error(
          "GitLab group is required. Use --group <name-or-url> or set gitlab-group in ~/.axn-dev/config.yaml",
        );
      }
    }

    if (!group) {
      throw new Error("GitLab group is required.");
    }

    if (interactive) {
      const dirAnswer = await ask("Target directory", targetDir);
      targetDir = resolve(dirAnswer || targetDir);
    }

    mkdirSync(targetDir, { recursive: true });

    console.log(`Discovering repositories in GitLab group '${group}'...`);
    const projects = listGroupProjects(group);

    if (projects.length === 0) {
      console.log("No repositories found.");
      return;
    }

    console.log(`Found ${projects.length} repositories. Checking local checkouts...`);

    const integration: string[] = [];
    const repos: Record<string, string> = {};

    const cloned: string[] = [];
    const existing: string[] = [];
    const failed: string[] = [];

    for (const p of projects) {
      const relative = relativeProjectPath(group, p.path_with_namespace);
      const localPath = resolve(targetDir, relative);
      const name = p.path;
      const category = classifyRepo(name);

      if (existsSync(localPath)) {
        if (existsSync(join(localPath, ".git"))) {
          console.log(`  ${relative} already cloned — skipping`);
          existing.push(relative);
        } else {
          console.log(`  ${relative} exists but is not a git repo — skipping`);
          failed.push(`${relative} (existing non-git directory)`);
          continue;
        }
      } else {
        console.log(`  ${relative} not found locally — cloning`);
        mkdirSync(dirname(localPath), { recursive: true });
        const clone = spawnSync("glab", [
          "repo", "clone",
          p.path_with_namespace,
          localPath,
        ], { stdio: "inherit" });
        if (clone.status === 0) {
          cloned.push(relative);
        } else {
          failed.push(relative);
          continue;
        }
      }

      if (category === "integration") {
        integration.push(localPath);
      } else {
        if (repos[name] && repos[name] !== localPath) {
          console.warn(`  Duplicate repo name '${name}' — using ${localPath}`);
        }
        repos[name] = localPath;
      }
    }

    const configPath = join(homedir(), ".axn-dev", "config.yaml");
    saveAxnDevConfigFile(
      configPath,
      { integration, repos },
      { merge: true },
    );

    console.log(`\nUpdated: ${configPath}`);

    if (cloned.length > 0) {
      console.log(`\nCloned ${cloned.length} new repo(s):`);
      for (const r of cloned) console.log(`  + ${r}`);
    }

    if (existing.length > 0) {
      console.log(`\nAlready present (${existing.length}):`);
      for (const r of existing) console.log(`  ✓ ${r}`);
    }

    if (failed.length > 0) {
      console.log(`\nFailed to clone (${failed.length}):`);
      for (const r of failed) console.log(`  ✗ ${r}`);
    }

    if (integration.length > 0) {
      console.log("\nIntegration repos:");
      for (const p of integration) console.log(`  ${p}`);
    }
  }
}
