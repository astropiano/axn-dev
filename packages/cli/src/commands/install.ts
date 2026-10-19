import { existsSync, mkdirSync, cpSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Command } from "@axn-dev/core";
import { findSkill, listAllSkills } from "../skill-sources.js";
import { installPlugin } from "../plugins.js";

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

function getSkillSourcePath(skillName: string): string | null {
  return findSkill(skillName)?.dir ?? null;
}

function listSkillNames(): string[] {
  return listAllSkills().map((s) => s.name);
}

function installToTarget(skillSource: string, skillName: string, targetBase: string, label: string): void {
  const skillTarget = join(targetBase, skillName);

  console.log(`Installing to ${label}: ${skillTarget}`);

  mkdirSync(skillTarget, { recursive: true });
  cpSync(skillSource, skillTarget, { recursive: true });
  console.log(`  ✓ Installed`);
}

function installToAgent(agent: AgentConfig, skillSource: string, skillName: string, projectLevel: boolean, repo?: string): void {
  const basePath = repo
    ? resolve(repo, agent.projectPath)
    : projectLevel
    ? agent.projectPath
    : agent.personalPath;
  if (!basePath) {
    console.log(`Skipping ${agent.name}: ${projectLevel ? "project-level" : "personal"} installation not supported`);
    return;
  }
  const label = repo ? `${agent.name} (repo)` : projectLevel ? `${agent.name} (project)` : `${agent.name} (personal)`;
  installToTarget(skillSource, skillName, basePath, label);
}

function installToAgentsRepo(skillSource: string, skillName: string, repo: string): void {
  const skillTarget = resolve(repo, ".agents", skillName);
  console.log(`Installing to repo .agents: ${skillTarget}`);
  mkdirSync(skillTarget, { recursive: true });
  cpSync(skillSource, skillTarget, { recursive: true });
  console.log(`  ✓ Installed`);
}

export class InstallCommand implements Command {
  readonly name = "install";
  readonly description = "Install skills for AI agents, shell completion, or plugin packages";

  complete(words: string[]): string[] {
    const prev = words[words.length - 2] ?? "";
    const cur = words[words.length - 1] ?? "";
    if (prev === "--skill") {
      return listSkillNames().filter((s) => s.startsWith(cur));
    }
    if (prev === "--agent") {
      return AGENTS.map((a) => a.name).filter((n) => n.startsWith(cur));
    }
    if (prev === "--shell") {
      return ["zsh", "bash"].filter((s) => s.startsWith(cur) && s !== cur);
    }
    if (prev === "--repo") return [];
    return [
      "--skill", "--skills", "--plugin", "--completion", "--project", "--repo",
      "--devin", "--vibe", "--agent", "--all-agents", "--shell", "--help", "-h",
    ].filter((f) => f.startsWith(cur) && f !== cur);
  }

  help(): string {
    return `
axn-dev install <target> [options]

Targets:
  --skill <name>      Install a specific skill by name
  --skills            Install all available skills
  --plugin <spec>     Install a plugin package into ~/.axn-dev/plugins
                      (npm spec: name, name@version, or local path)
  --completion        Install shell tab-completion into your shell profile

Options:
  --project           Install at project level (default: personal/global)
  --repo <path>       Install into a repo's .agents folder (standard agent skills)
  --devin             Use Devin-specific paths (.devin/skills in repo, ~/.config/devin/skills user-level)
  --vibe              Use Vibe-specific paths (.vibe/skills in repo, ~/.vibe/skills user-level)
  --agent <name>      Install only for specific agent (claude, openclaw, codex, cursor, devin, vibe)
  --all-agents        Install for all configured agents (default: detected agents)
  -h, --help          Show this help

Options (--completion):
  --shell <zsh|bash>  Shell to install for (auto-detected if omitted)

Examples:
  axn-dev install --skill axn-dev-cli
  axn-dev install --skills
  axn-dev install --skills --project
  axn-dev install --skills --agent claude
  axn-dev install --skills --agent vibe
  axn-dev install --skills --repo /path/to/repo            # .agents
  axn-dev install --skills --repo /path/to/repo --devin    # .devin/skills
  axn-dev install --skills --devin                         # ~/.config/devin/skills
  axn-dev install --skills --vibe                          # ~/.vibe/skills
  axn-dev install --completion
  axn-dev install --completion --shell bash
  axn-dev install --plugin @acme/axn-dev-foo
  axn-dev install --plugin @acme/axn-dev-foo@1.2.0
  axn-dev install --plugin ../my-plugin     # local dir for development
`;
  }

  async execute(args: string[]): Promise<void> {
    if (!args.length || args[0] === "--help" || args[0] === "-h") {
      console.log(this.help());
      return;
    }

    const pluginEquals = args.find((a) => a.startsWith("--plugin="));
    const pluginIdx = args.indexOf("--plugin");
    const pluginSpec = pluginEquals
      ? pluginEquals.split("=")[1]
      : pluginIdx >= 0 ? args[pluginIdx + 1] : undefined;
    if (pluginIdx >= 0 || pluginEquals) {
      if (!pluginSpec || pluginSpec.startsWith("-")) {
        throw new Error("Missing plugin spec. Usage: axn-dev install --plugin <name[@version]|path>");
      }
      installPlugin(pluginSpec);
      return;
    }

    if (args[0] === "--completion") {
      const shellIdx = args.indexOf("--shell");
      const shellFlag = shellIdx >= 0 ? args[shellIdx + 1] : null;
      await this.installCompletion(shellFlag || null);
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

    let skillsToInstall: string[];
    if (target === "--skills") {
      skillsToInstall = listSkillNames();
      if (skillsToInstall.length === 0) {
        throw new Error("No skills found. Run 'pnpm build' in the axn-dev-cli workspace, or reinstall the package.");
      }
    } else if (target === "--skill" || target.startsWith("--skill=")) {
      const skillName = target.startsWith("--skill=") ? target.split("=")[1] : rest[0];
      if (!skillName) {
        throw new Error("Missing skill name. Usage: axn-dev install --skill <name>");
      }
      skillsToInstall = [skillName];
    } else {
      throw new Error(`Unknown target '${target}'. Run 'axn-dev install --help'.`);
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
      console.log("No agents detected. Use --agent <name> to force installation to a specific agent.");
      return;
    }

    for (const skillName of skillsToInstall) {
      const skillSource = getSkillSourcePath(skillName);

      if (!skillSource) {
        if (skillsToInstall.length === 1) {
          throw new Error(
            `Skill source not found for '${skillName}'. Run 'pnpm build' in the axn-dev-cli workspace, or reinstall the linked package.`
          );
        }
        console.error(`  ✗ Skipping '${skillName}': source not found.`);
        continue;
      }

      console.log(`\nInstalling ${skillName} skill...\n`);

      if (useAgentsRepo && repo) {
        try {
          installToAgentsRepo(skillSource, skillName, repo);
        } catch (err) {
          console.error(`  ✗ Failed to install to repo .agents: ${err instanceof Error ? err.message : err}`);
        }
        continue;
      }

      for (const agent of agents) {
        try {
          installToAgent(agent, skillSource, skillName, projectLevel, repo);
        } catch (err) {
          console.error(`  ✗ Failed to install to ${agent.name}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    console.log("\nDone. Restart your AI agent to load the skill.");
  }

  private async installCompletion(shell: string | null): Promise<void> {
    const detectedShell = shell ?? process.env["SHELL"]?.split("/").pop() ?? "zsh";
    const supported = ["zsh", "bash"];
    if (!supported.includes(detectedShell)) {
      throw new Error(`Shell '${detectedShell}' not supported. Use --shell zsh or --shell bash.`);
    }

    const { ZSH_SCRIPT, BASH_SCRIPT } = await import("./completion.js");

    if (detectedShell === "zsh") {
      await this.installZshCompletion(ZSH_SCRIPT);
    } else {
      await this.installBashCompletion(BASH_SCRIPT);
    }
  }

  private async installZshCompletion(script: string): Promise<void> {
    // Write _axn-dev into ~/.zsh/completions/ (standard fpath location)
    const completionsDir = join(homedir(), ".zsh", "completions");
    const completionFile = join(completionsDir, "_axn-dev");

    mkdirSync(completionsDir, { recursive: true });
    writeFileSync(completionFile, script, "utf-8");
    console.log(`✅ Written: ${completionFile}`);

    // Ensure fpath and compinit are in .zshrc (one-time, idempotent)
    const zshrc = join(homedir(), ".zshrc");
    const fpathLine = `fpath=(~/.zsh/completions $fpath)`;
    const compInitLine = `autoload -Uz compinit && compinit`;

    const existing = existsSync(zshrc) ? readFileSync(zshrc, "utf-8") : "";
    const needsFpath = !existing.includes(".zsh/completions");
    const needsCompinit = !existing.includes("compinit");

    if (needsFpath || needsCompinit) {
      const lines: string[] = ["\n# axn-dev shell completion"];
      if (needsFpath) lines.push(fpathLine);
      if (needsCompinit) lines.push(compInitLine);
      appendFileSync(zshrc, lines.join("\n") + "\n");
      console.log(`✅ Updated ~/.zshrc with fpath + compinit`);
    } else {
      console.log(`✓ ~/.zshrc already has fpath + compinit`);
    }

    console.log(`\nRun to activate: autoload -Uz compinit && compinit`);
    console.log(`Or restart your shell.`);
  }

  private async installBashCompletion(script: string): Promise<void> {
    const completionsDir = join(homedir(), ".bash_completion.d");
    const completionFile = join(completionsDir, "axn-dev");

    mkdirSync(completionsDir, { recursive: true });
    writeFileSync(completionFile, script, "utf-8");
    console.log(`✅ Written: ${completionFile}`);

    // Ensure ~/.bash_completion.d is sourced from ~/.bashrc
    const bashrc = join(homedir(), ".bashrc");
    const sourceLine = `\n# axn-dev shell completion\nfor f in ~/.bash_completion.d/*; do source "$f"; done\n`;
    const existing = existsSync(bashrc) ? readFileSync(bashrc, "utf-8") : "";

    if (!existing.includes(".bash_completion.d")) {
      appendFileSync(bashrc, sourceLine);
      console.log(`✅ Updated ~/.bashrc to source ~/.bash_completion.d/`);
    } else {
      console.log(`✓ ~/.bashrc already sources ~/.bash_completion.d/`);
    }

    console.log(`\nRun to activate: source ~/.bashrc`);
  }
}
