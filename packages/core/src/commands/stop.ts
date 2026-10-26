import type { Command, CommandExecuteOptions } from "./command.js";
import { ScenarioDiscoveryService } from "../util/scenario-discovery.js";
import { getComposeProjectName, runCompose } from "../util/compose.js";
import { driverFor } from "../driver.js";
import { stopDevServers } from "../util/dev-servers.js";
import { getRunningComposeProjects, getRunningScenarioPort, getSinglePortInfo, isScenarioRunning } from "../util/ports.js";
import { applyRepoRootOverrides } from "../util/config.js";
import { resolveWorkbaseRoots } from "../util/worktree.js";
import { scenarioCompleter } from "../completion-helpers.js";

export class StopCommand implements Command {
  readonly name = "stop";
  readonly description = "Stop a Docker Compose scenario";

  complete = scenarioCompleter([
    "--scenario", "-s", "--global", "-g", "--port", "-p",
    "--workbase", "--help", "-h",
  ]);

  help(): string {
    return `
axn-dev stop [<name>] [--scenario <name>] [--global] [--port <port>] [--workbase <branch>] [-- <docker-compose args>]

Stops a running scenario.

Options:
  --scenario, -s <name>   Scenario to stop (default: auto-detect)
  --global, -g            Use global (cross-concern) scenarios
  --port, -p <port>       Single-port scenario: port the scenario was started on
  --workbase <branch>     Use the checkout or worktree on <branch> for the integration repo
  --                      Pass remaining args to docker-compose

Examples:
  axn-dev stop                       # stop default scenario
  axn-dev stop demo-mock             # stop the 'demo-mock' scenario
  axn-dev stop --scenario mock       # stop the 'mock' scenario
  axn-dev stop -g -s demo-mock         # stop the global scenario
  axn-dev stop -g -s demo-full -p 8091   # stop single-port scenario on port 8091
  axn-dev stop -g -s demo-full -p 8091 --workbase feature/single-port
  axn-dev stop -s mock -- -v         # stop mock and remove volumes
`;
  }

  async execute(args: string[], options?: CommandExecuteOptions): Promise<void> {
    let scenarioName: string | null = null;
    let useGlobal = false;
    let portFlag: number | null = null;
    let workbase: string | null = null;
    const composeArgs: string[] = ["down"];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--scenario" || arg === "-s") {
        scenarioName = args[++i];
        if (!scenarioName) {
          throw new Error("--scenario requires a value");
        }
      } else if (arg === "--global" || arg === "-g") {
        useGlobal = true;
      } else if (arg === "--port" || arg === "-p") {
        const value = args[++i];
        const parsed = value ? parseInt(value, 10) : NaN;
        if (isNaN(parsed) || parsed <= 0 || parsed > 65535) {
          throw new Error("--port requires a valid port number (1-65535)");
        }
        portFlag = parsed;
      } else if (arg === "--workbase") {
        const value = args[++i];
        if (!value) {
          throw new Error("--workbase requires a value");
        }
        workbase = value;
      } else if (arg === "--help" || arg === "-h") {
        console.log(this.help());
        return;
      } else if (arg === "--") {
        composeArgs.push(...args.slice(i + 1));
        break;
      } else if (!arg.startsWith("-")) {
        if (scenarioName === null) {
          scenarioName = arg;
        } else {
          throw new Error(`Unexpected argument '${arg}' — compose args go after --`);
        }
      } else {
        composeArgs.push(arg);
      }
    }

    // Use the discovery service for unified scenario resolution
    const discovery = new ScenarioDiscoveryService(process.cwd(), workbase ?? undefined);
    const workspace = discovery.getWorkspaceConfig();

    if (workbase) {
      const repoRootValues: string[] = [];
      for (const { repoName, path } of resolveWorkbaseRoots(discovery.getConfig(), workbase)) {
        repoRootValues.push(`${repoName}=${path}`);
      }
      applyRepoRootOverrides(workspace, repoRootValues);
    }

    // Print detection info
    discovery.printDetectionInfo();
    console.log("");

    // Resolve the scenario
    let resolution;
    if (!scenarioName && !useGlobal) {
      // No scenario specified - auto-detect based on context
      const repoContext = discovery.getRepoContext();
      resolution = repoContext
        ? discovery.resolveProjectScenario(null)
        : discovery.resolveScenario(null);
    } else {
      // Explicit name or --global: global first, local project fallback
      resolution = discovery.resolveScenario(scenarioName);
    }

    // Always print whether it's a global or project scenario
    const scopeLabel = resolution.source === "global" ? "Global" : "Project";
    console.log(`${scopeLabel} scenario: ${resolution.scenario.name}`);
    if (resolution.scenario.description) {
      console.log(`  ${resolution.scenario.description}`);
    }
    console.log(`  Path: ${resolution.scenario.path}`);
    console.log("");

    const scenario = resolution.scenario;

    // Non-compose scenario types delegate to their registered driver.
    if ((scenario.type ?? "compose") !== "compose") {
      const driver = await driverFor(scenario);
      if (!(await driver.isRunning(scenario))) {
        console.error("\x1b[31mScenario is not running.\x1b[0m");
        process.exit(1);
      }
      await driver.stop(scenario);
      // Dev servers this scenario spawned die with it; reused ones stay up.
      stopDevServers(scenario);
      return;
    }

    // Determine the SCENARIO_PORT for single-port scenarios
    const singlePort = getSinglePortInfo(scenario.path, scenario.env ?? {});
    let scenarioPort: number | null = null;

    if (portFlag !== null) {
      if (!singlePort.isSinglePort) {
        throw new Error(`Scenario '${scenario.name}' does not support --port; it is not a single-port scenario`);
      }
      scenarioPort = portFlag;
    } else if (singlePort.isSinglePort) {
      // Try to read the actual port from a running container
      const runningPort = getRunningScenarioPort(scenario.path);
      scenarioPort = runningPort ?? singlePort.scenarioPort;
      if (scenarioPort === null) {
        throw new Error(`Single-port scenario '${scenario.name}' requires --port (no running instance or default found)`);
      }
    }

    const stopEnv: Record<string, string> = {
      ...(scenario.env ?? {}),
      ...(scenarioPort !== null ? { SCENARIO_PORT: String(scenarioPort) } : {}),
    };

    // Prefer the live project name from running containers — the derived name
    // bakes in the branch at `up` time and won't match after a branch switch.
    const runningProjects = getRunningComposeProjects(scenario.path);
    let projectName = getComposeProjectName(scenario.path, stopEnv);
    if (runningProjects.length === 1) {
      projectName = runningProjects[0];
    } else if (runningProjects.length > 1 && scenarioPort !== null) {
      projectName = runningProjects.find((p) => p.endsWith(`-${scenarioPort}`)) ?? projectName;
    }

    if (!isScenarioRunning(scenario.path, projectName ?? undefined)) {
      console.error("\x1b[31mScenario is not running.\x1b[0m");
      process.exit(1);
    }

    const exitCode = await runCompose({
      scenarioPath: scenario.path,
      reposRoot: scenario.path,
      args: composeArgs,
      repoEnv: workspace.repoEnv,
      env: stopEnv,
      projectName: projectName ?? undefined,
      silent: options?.quiet === true,
      onOutput: options?.onOutput,
    });

    if (exitCode !== 0) {
      throw new Error(`docker compose exited with code ${exitCode}`);
    }

    // Dev servers this scenario spawned die with it; reused ones stay up.
    stopDevServers(scenario);
  }
}
