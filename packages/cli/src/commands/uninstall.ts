import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Command } from "@axn-dev/core";
import { listAllSkills } from "../skill-sources.js";
import { installedPluginNames, uninstallPlugin } from "../plugins.js";

interface AgentConfig {
  name: string;
  personalPath: string;
  projectPath: string;
  detect?: () => boolean;
}

const AGENTS: AgentConfig[] = [
  {
    name: "claude",
    personalPath: join(homedir(), ".claude/skills"),
    projectPath: ".claude/skills",
    detect: () => existsSync(join(homedir(), ".claude")) || existsSync(".claude"),
  },
  {
    name: "openclaw",
    personalPath: join(homedir(), ".openclaw/skills"),
    projectPath: ".openclaw/skills",
    detect: () => existsSync(join(homedir(), ".openclaw")) || existsSync(".openclaw"),
  },
  {
    name: "codex",
    personalPath: join(homedir(), ".codex/skills"),
    projectPath: ".codex/skills",
    detect: () => existsSync(join(homedir(), ".codex")) || existsSync(".codex"),
  },
  {
    name: "cursor",
    personalPath: "", // Cursor only supports project-level
    projectPath: ".cursor/skills",
    detect: () => existsSync(".cursor"),
  },
  {
    name: "devin",
    personalPath: join(homedir(), ".config", "devin", "skills"),
    projectPath: ".devin/skills",
    detect: () =>
      existsSync(join(homedir(), ".config", "devin")) ||
      existsSync(join(homedir(), ".devin")) ||
      existsSync(".devin") ||
      existsSync(".agents"),
  },
  {
    name: "vibe",
    personalPath: join(homedir(), ".vibe/skills"),
    projectPath: ".vibe/skills",
    detect: () => existsSync(join(homedir(), ".vibe")) || existsSync(".vibe"),
  },
];

function findAvailableAgents(): AgentConfig[] {
  return AGENTS.filter((agent) => agent.detect?.() ?? true);
}

function uninstallFromTarget(skillName: string, targetBase: string, label: string): void {
  const skillTarget = join(targetBase, skillName);

  if (!existsSync(skillTarget)) {
    console.log(`Skipping: skill not installed at ${skillTarget}`);
    return;
  }

  console.log(`Uninstalling from ${label}: ${skillTarget}`);

  rmSync(skillTarget, { recursive: true, force: true });
  console.log(`  ✓ Uninstalled`);
}

function uninstallFromAgent(agent: AgentConfig, skillName: string, projectLevel: boolean, repo?: string): void {
  const basePath = repo
    ? resolve(repo, agent.projectPath)
    : projectLevel
    ? agent.projectPath
    : agent.personalPath;
  if (!basePath) {
    console.log(`Skipping ${agent.name}: ${projectLevel ? "project-level" : "personal"} uninstallation not supported`);
    return;
  }
  const label = repo ? `${agent.name} (repo)` : projectLevel ? `${agent.name} (project)` : `${agent.name} (personal)`;
  uninstallFromTarget(skillName, basePath, label);
}

function uninstallFromAgentsRepo(skillName: string, repo: string): void {
  const skillTarget = resolve(repo, ".agents", skillName);
  if (!existsSync(skillTarget)) {
    console.log(`Skipping: skill not installed at ${skillTarget}`);
    return;
  }
  console.log(`Uninstalling from repo .agents: ${skillTarget}`);
  rmSync(skillTarget, { recursive: true, force: true });
  console.log(`  ✓ Uninstalled`);
}

export class UninstallCommand implements Command {
  readonly name = "uninstall";
  readonly description = "Uninstall skills from AI agents or plugin packages";

  complete(words: string[]): string[] {
    const prev = words[words.length - 2] ?? "";
    const cur = words[words.length - 1] ?? "";
    if (prev === "--agent") {
      return AGENTS.map((a) => a.name).filter((n) => n.startsWith(cur));
    }
    if (prev === "--plugin") {
      return installedPluginNames().filter((n) => n.startsWith(cur));
    }
    return [
      "--skills", "--plugin", "--project", "--repo", "--devin", "--vibe",
      "--agent", "--all-agents", "--help", "-h",
    ].filter((f) => f.startsWith(cur) && f !== cur);
  }

  help(): string {
    return `
axn-dev uninstall <target> [options]

Targets:
  --skills            Uninstall axn-dev skill from AI agents
  --plugin <name>     Uninstall a plugin package from ~/.axn-dev/plugins

Options:
  --project           Uninstall from project level (default: personal/global)
  --repo <path>       Uninstall from a repo's .agents folder (standard agent skills)
  --devin             Uninstall Devin-specific paths (.devin/skills in repo, ~/.config/devin/skills user-level)
  --vibe              Uninstall Vibe-specific paths (.vibe/skills in repo, ~/.vibe/skills user-level)
  --agent <name>      Uninstall only from specific agent (claude, openclaw, codex, cursor, devin, vibe)
  --all-agents        Uninstall from all available agents (default)
  -h, --help         Show this help

Examples:
  axn-dev uninstall --skills                         # Uninstall from all detected agents (personal)
  axn-dev uninstall --skills --project               # Uninstall from project level
  axn-dev uninstall --skills --agent claude          # Uninstall only from Claude Code
  axn-dev uninstall --skills --agent vibe            # Uninstall only from Vibe
  axn-dev uninstall --skills --repo /path/to/repo    # Uninstall from .agents
  axn-dev uninstall --skills --repo /path/to/repo --devin  # Uninstall from .devin/skills
  axn-dev uninstall --skills --devin                 # Uninstall from ~/.config/devin/skills
  axn-dev uninstall --skills --vibe                  # Uninstall from ~/.vibe/skills
  axn-dev uninstall --plugin @acme/axn-dev-foo       # Remove a plugin package
`;
  }

  async execute(args: string[]): Promise<void> {
    if (!args.length || args[0] === "--help" || args[0] === "-h") {
      console.log(this.help());
      return;
    }

    const pluginEquals = args.find((a) => a.startsWith("--plugin="));
    const pluginIdx = args.indexOf("--plugin");
    const pluginName = pluginEquals
      ? pluginEquals.split("=")[1]
      : pluginIdx >= 0 ? args[pluginIdx + 1] : undefined;
    if (pluginIdx >= 0 || pluginEquals) {
      if (!pluginName || pluginName.startsWith("-")) {
        throw new Error("Missing plugin name. Usage: axn-dev uninstall --plugin <name>");
      }
      uninstallPlugin(pluginName);
      return;
    }

    const [target, ...rest] = args;
    const projectLevel = rest.includes("--project");
    const devinFlag = rest.includes("--devin");
    const vibeFlag = rest.includes("--vibe");
    const explicitAllAgents = rest.includes("--all-agents");

    const agentEquals = rest.find((a) => a.startsWith("--agent="));
    const agentIdx = rest.indexOf("--agent");
    const specificAgent = agentEquals ? agentEquals.split("=")[1] : agentIdx >= 0 ? rest[agentIdx + 1] : undefined;

    const repoEquals = rest.find((a) => a.startsWith("--repo="));
    const repoIdx = rest.indexOf("--repo");
    const repoArg = repoEquals ? repoEquals.split("=")[1] : repoIdx >= 0 ? rest[repoIdx + 1] : undefined;
    const repo = repoArg ? resolve(repoArg) : undefined;

    const useAgentsRepo = repo && !specificAgent && !devinFlag && !vibeFlag && !explicitAllAgents;
    const allAgents = !specificAgent && !repo && !devinFlag && !vibeFlag && !explicitAllAgents;

    if (target !== "--skills") {
      throw new Error(`Unknown target '${target}'. Run 'axn-dev uninstall --help'.`);
    }

    const skillNames = listAllSkills().map((s) => s.name);
    if (skillNames.length === 0) {
      throw new Error("No skills found. Run 'pnpm build' in the axn-dev-cli workspace, or reinstall the package.");
    }

    const agents = specificAgent
      ? AGENTS.filter((a) => a.name === specificAgent)
      : devinFlag
      ? AGENTS.filter((a) => a.name === "devin")
      : vibeFlag
      ? AGENTS.filter((a) => a.name === "vibe")
      : allAgents
      ? findAvailableAgents()
      : AGENTS;

    if (!useAgentsRepo && agents.length === 0) {
      console.log("No agents detected. Use --agent <name> to force uninstallation from a specific agent.");
      return;
    }

    for (const skillName of skillNames) {
      console.log(`\nUninstalling ${skillName} skill...\n`);

      if (useAgentsRepo && repo) {
        try {
          uninstallFromAgentsRepo(skillName, repo);
        } catch (err) {
          console.error(`  ✗ Failed to uninstall from repo .agents: ${err instanceof Error ? err.message : err}`);
        }
      } else {
        for (const agent of agents) {
          try {
            uninstallFromAgent(agent, skillName, projectLevel, repo);
          } catch (err) {
            console.error(`  ✗ Failed to uninstall from ${agent.name}: ${err instanceof Error ? err.message : err}`);
          }
        }
      }
    }

    console.log("\nDone. Restart your AI agent to apply changes.");
  }
}
