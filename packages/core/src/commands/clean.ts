import type { Command } from "./command.js";
import { ScenarioDiscoveryService } from "../util/scenario-discovery.js";
import { getComposeProjectName, runCompose } from "../util/compose.js";
import { getRunningComposeProjects, isScenarioRunning } from "../util/ports.js";
import { scenarioCompleter } from "../completion-helpers.js";
import * as readline from "node:readline";

export class CleanCommand implements Command {
  readonly name = "clean";
  readonly description = "Remove all data volumes for a scenario (destructive)";

  complete = scenarioCompleter([
    "--scenario", "-s", "--global", "-g", "--yes", "-y", "--help", "-h",
  ]);

  help(): string {
    return `
axn-dev clean [<name>] [--scenario <name>] [--global] [--yes] [-- <docker-compose args>]

Stops the scenario (if running) and removes all named volumes, effectively
wiping all persistent data (databases, uploaded files, etc.).

Options:
  --scenario, -s <name>   Scenario to clean (default: auto-detect or prompt)
  --global, -g            Use global (cross-concern) scenarios
  --yes, -y               Skip confirmation prompt

Examples:
  axn-dev clean                          # clean default scenario
  axn-dev clean --scenario mock          # clean the 'mock' scenario
  axn-dev clean -g -s demo-mock         # clean a global scenario
  axn-dev clean -s mock -y              # clean without confirmation
`;
  }

  async execute(args: string[]): Promise<void> {
    let scenarioName: string | null = null;
    let useGlobal = false;
    let skipConfirm = false;
    const extraComposeArgs: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--scenario" || arg === "-s") {
        scenarioName = args[++i];
        if (!scenarioName) throw new Error("--scenario requires a value");
      } else if (arg === "--global" || arg === "-g") {
        useGlobal = true;
      } else if (arg === "--yes" || arg === "-y") {
        skipConfirm = true;
      } else if (arg === "--help" || arg === "-h") {
        console.log(this.help());
        return;
      } else if (arg === "--") {
        extraComposeArgs.push(...args.slice(i + 1));
        break;
      } else if (!arg.startsWith("-")) {
        if (scenarioName === null) {
          scenarioName = arg;
        } else {
          throw new Error(`Unexpected argument '${arg}' — compose args go after --`);
        }
      } else {
        extraComposeArgs.push(arg);
      }
    }

    // Use the discovery service for unified scenario resolution
    const discovery = new ScenarioDiscoveryService(process.cwd());
    const workspace = discovery.getWorkspaceConfig();

    // Print detection info
    discovery.printDetectionInfo();
    console.log("");

    // Resolve the scenario
    let resolution;
    if (!scenarioName && !useGlobal) {
      const repoContext = discovery.getRepoContext();
      resolution = repoContext
        ? discovery.resolveProjectScenario(null)
        : discovery.resolveScenario(null);
    } else {
      resolution = discovery.resolveScenario(scenarioName);
    }

    const scopeLabel = resolution.source === "global" ? "Global" : "Project";
    console.log(`${scopeLabel} scenario: ${resolution.scenario.name}`);
    if (resolution.scenario.description) {
      console.log(`  ${resolution.scenario.description}`);
    }
    console.log(`  Path: ${resolution.scenario.path}`);
    console.log("");

    const scenario = resolution.scenario;

    if ((scenario.type ?? "compose") !== "compose") {
      console.error(`\x1b[31mclean only supports compose scenarios (got type '${scenario.type}').\x1b[0m`);
      process.exit(1);
    }

    if (!skipConfirm) {
      const confirmed = await this.confirm(
        `\x1b[33mThis will permanently delete all data volumes for '${scenario.name}'.\x1b[0m\nContinue? [y/N] `
      );
      if (!confirmed) {
        console.log("Aborted.");
        return;
      }
      console.log("");
    }

    // Prefer the live project name from running containers — the derived name
    // bakes in the branch at `up` time and won't match after a branch switch.
    const runningProjects = getRunningComposeProjects(scenario.path);
    const projectName = runningProjects.length === 1
      ? runningProjects[0]
      : getComposeProjectName(scenario.path, scenario.env);

    const composeOptions = {
      scenarioPath: scenario.path,
      reposRoot: scenario.path,
      repoEnv: workspace.repoEnv,
      env: scenario.env,
      projectName: projectName ?? undefined,
    };

    if (runningProjects.length > 0 || isScenarioRunning(scenario.path)) {
      console.log("Stopping running scenario...");
      const downCode = await runCompose({ ...composeOptions, args: ["down"] });
      if (downCode !== 0) {
        throw new Error(`docker compose down exited with code ${downCode}`);
      }
      console.log("");
    }

    console.log("Removing volumes...");
    const exitCode = await runCompose({
      ...composeOptions,
      args: ["down", "--volumes", "--remove-orphans", ...extraComposeArgs],
    });

    if (exitCode !== 0) {
      throw new Error(`docker compose down --volumes exited with code ${exitCode}`);
    }

    console.log("\x1b[32mAll volumes removed.\x1b[0m");
  }

  private confirm(prompt: string): Promise<boolean> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase() === "y");
      });
    });
  }

}
