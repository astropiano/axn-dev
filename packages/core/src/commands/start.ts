import type { Command } from "./command.js";
import { ScenarioDiscoveryService } from "../util/scenario-discovery.js";
import { getComposeProjectName, runCompose } from "../util/compose.js";
import { driverFor } from "../driver.js";
import { devServerUrlEnv, startDevServers } from "../util/dev-servers.js";
import {
  checkPortConflicts,
  getRunningPortOverrides,
  getRunningScenarioPort,
  getServiceEndpoints,
  getSinglePortInfo,
  isScenarioRunning,
  resolveAutoPorts,
  resolveEndpoints,
} from "../util/ports.js";
import { applyRepoRootOverrides } from "../util/config.js";
import { resolveWorkbaseRoots } from "../util/worktree.js";
import { scenarioCompleter } from "../completion-helpers.js";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";

function checkGitSubmodules(repoRoot: string | undefined) {
  if (!repoRoot) return;
  try {
    const out = execSync("git submodule status", { cwd: repoRoot, encoding: "utf8" });
    const lines = out.split("\n").filter((l) => l.trim().length > 0);
    const uninitialized = lines.filter((l) => l.startsWith("-"));
    if (uninitialized.length > 0) {
      const names = uninitialized.map((l) => l.split(" ")[1] ?? l);
      throw new Error(
        "Cannot start scenario — git submodules are not initialized.\n" +
        "Run the following from the repo root and try again:\n" +
        "  git -c protocol.file.allow=always submodule update --init\n\n" +
        "Missing submodules:\n  " + names.join("\n  ")
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Cannot start scenario")) throw e;
    // If git or .gitmodules is missing, we cannot verify — continue.
    console.warn("Could not verify git submodules:", e instanceof Error ? e.message : String(e));
  }
}

export class StartCommand implements Command {
  readonly name = "start";
  readonly description = "Start a Docker Compose scenario";

  complete = scenarioCompleter([
    "--scenario", "-s", "--global", "-g", "--foreground", "-f",
    "--port", "-p", "--auto-port", "--build-no-cache", "--no-build", "--clean",
    "--yes", "-y", "--workbase", "--repo-root", "--help", "-h",
  ]);

  help(): string {
    return `
axn-dev start [<name>] [--scenario <name>] [--global] [--foreground] [--port <port>] [--auto-port] [--build-no-cache] [--clean] [--workbase <branch>] [--repo-root <name>=<path>[,<name>=<path>...]] [-- <docker-compose args>]

Starts a scenario in detached mode (background) by default.
After starting, prints the URLs where services are available.

Options:
  --scenario, -s <name>   Scenario to start (default: auto-detect or prompt)
  --global, -g            Use global (cross-concern) scenarios
  --foreground, -f        Run in foreground (attached mode, shows logs)
  --port, -p <port>       Single-port scenario: override the SCENARIO_PORT (only valid for Caddy scenarios)
  --auto-port             Resolve port conflicts by picking a free port from the configured range
  --build-no-cache        Build images without Docker layer cache
  --no-build              Skip the image build — start from existing images
                          (fails fast if a service has no image yet)
  --clean                 Wipe all scenario data volumes before starting (destructive;
                          same semantics as 'axn-dev clean' followed by start)
  -y, --yes               Skip the confirmation prompt for --clean
  --workbase <branch>     Use the checkout or worktree on <branch> for all configured repos (including integration)
  --repo-root             Override repo root path(s) for this run, e.g. my-frontend=/path/to/wt
  --                      Pass remaining args to docker-compose up

Examples:
  axn-dev start                              # start default scenario (detached)
  axn-dev start mock                         # start the 'mock' scenario
  axn-dev start --scenario mock              # start the 'mock' scenario
  axn-dev start -g -s demo-mock              # start the global scenario
  axn-dev start -s mock -f                   # start mock in foreground
  axn-dev start -s demo-full -p 8091         # start single-port scenario on port 8091
  axn-dev start -s dev --auto-port           # pick free ports on conflicts
  axn-dev start -s dev --build-no-cache      # rebuild without cache
  axn-dev start -s dev --clean -y            # wipe volumes then start fresh
  axn-dev start -s dev --workbase feat/my-branch
  axn-dev start -g -s demo-full -p 8091 --workbase feature/single-port
  axn-dev start -s shell --repo-root my-frontend=/home/me/.../my-frontend-wt
`;
  }

  async execute(args: string[], options?: { env?: Record<string, string> }): Promise<void> {
    let scenarioName: string | null = null;
    let useGlobal = false;
    let foreground = false;
    let portFlag: number | null = null;
    let autoPortFlag = false;
    let noCache = false;
    let noBuild = false;
    let cleanStart = false;
    let yes = false;
    let workbase: string | null = null;
    const explicitRepoRoots: string[] = [];
    const extraComposeArgs: string[] = [];

    // Parse args
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--scenario" || arg === "-s") {
        scenarioName = args[++i];
        if (!scenarioName) {
          throw new Error("--scenario requires a value");
        }
      } else if (arg === "--global" || arg === "-g") {
        useGlobal = true;
      } else if (arg === "--foreground" || arg === "-f") {
        foreground = true;
      } else if (arg === "--port" || arg === "-p") {
        const value = args[++i];
        const parsed = value ? parseInt(value, 10) : NaN;
        if (isNaN(parsed) || parsed <= 0 || parsed > 65535) {
          throw new Error("--port requires a valid port number (1-65535)");
        }
        portFlag = parsed;
      } else if (arg === "--auto-port") {
        autoPortFlag = true;
      } else if (arg === "--build-no-cache") {
        noCache = true;
      } else if (arg === "--no-build") {
        noBuild = true;
      } else if (arg === "--clean") {
        cleanStart = true;
      } else if (arg === "--yes" || arg === "-y") {
        yes = true;
      } else if (arg === "--workbase") {
        const value = args[++i];
        if (!value) {
          throw new Error("--workbase requires a value");
        }
        workbase = value;
      } else if (arg === "--repo-root") {
        const value = args[++i];
        if (!value) {
          throw new Error("--repo-root requires a value");
        }
        explicitRepoRoots.push(value);
      } else if (arg === "--help" || arg === "-h") {
        console.log(this.help());
        return;
      } else if (arg === "--") {
        extraComposeArgs.push(...args.slice(i + 1));
        break;
      } else if (!arg.startsWith("-") && scenarioName === null) {
        scenarioName = arg;
      } else {
        extraComposeArgs.push(arg);
      }
    }

    if (noBuild && noCache) {
      throw new Error("--no-build and --build-no-cache are incompatible");
    }

    const composeArgs = noBuild ? ["up"] : ["up", "--build"];
    if (!foreground) composeArgs.push("-d");
    composeArgs.push(...extraComposeArgs);

    // Use the discovery service for unified scenario resolution
    const discovery = new ScenarioDiscoveryService(process.cwd(), workbase ?? undefined);
    const workspace = discovery.getWorkspaceConfig();
    const axnConfig = discovery.getConfig();

    // Resolve --workbase into implicit --repo-root values; explicit --repo-root wins
    const repoRootValues: string[] = [];
    if (workbase) {
      for (const { repoName, path } of resolveWorkbaseRoots(axnConfig, workbase)) {
        repoRootValues.push(`${repoName}=${path}`);
      }
    }
    repoRootValues.push(...explicitRepoRoots);

    applyRepoRootOverrides(workspace, repoRootValues);
    const autoPortEnabled = axnConfig.autoPort || autoPortFlag;
    const autoPortRange = axnConfig.autoPortRange;

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
    const overrideEnv = options?.env ?? {};

    // Non-compose scenario types delegate to their registered driver.
    const scenarioType = scenario.type ?? "compose";
    if (scenarioType !== "compose") {
      const driver = await driverFor(scenario);
      // A running instance is restarted, keeping the ports it actually bound
      // (auto-port assignments live only in the running process environ).
      // Stop before resolving — otherwise its own ports count as conflicts.
      const running = await driver.isRunning(scenario);
      const stickyEnv = running ? (driver.runningEnv?.(scenario.path) ?? {}) : {};
      if (running) {
        console.log("\x1b[33mScenario already running — restarting...\x1b[0m\n");
        await driver.stop(scenario);
      }
      const { env: portEnv } = driver.resolvePortEnv
        ? await driver.resolvePortEnv(
            scenario,
            { ...process.env as Record<string, string>, ...(scenario.env ?? {}), ...overrideEnv },
            { autoPort: autoPortEnabled, autoPortRange, primaryPort: portFlag, stickyEnv },
          )
        : { env: {} };
      await driver.start(scenario, { foreground, env: portEnv });
      // Auxiliary dev servers declared in axn-dev.yaml — reused if already
      // up, spawned + logged otherwise.
      await startDevServers(scenario, {
        ...(driver.fileEnv?.(scenario.path) ?? {}),
        ...process.env as Record<string, string>,
        ...(scenario.env ?? {}),
        ...portEnv,
        ...(driver.urlEnv?.(scenario) ?? {}),
        ...devServerUrlEnv(scenario.devServers ?? []),
      }, axnConfig);
      return;
    }

    // Pre-flight: ensure git submodules are initialized (compose scenarios
    // build from the repo)
    checkGitSubmodules(discovery.getRepoContext()?.repoRoot);

    if (cleanStart) {
      if (!yes) {
        const confirmed = await this.confirm(
          `\x1b[33mThis will permanently delete all data volumes for '${scenario.name}' before starting.\x1b[0m\nContinue? [y/N] `
        );
        if (!confirmed) {
          console.log("Aborted.");
          return;
        }
      }
      console.log("\x1b[33mCleaning scenario (removing volumes)...\x1b[0m\n");
      // Resolve the actually-running SCENARIO_PORT for single-port scenarios so
      // the compose project name matches the deployment that owns the volumes
      // (the running port may have been auto-assigned).
      const singlePortInfo = getSinglePortInfo(scenario.path, scenario.env ?? {});
      const runningPort = singlePortInfo.isSinglePort ? getRunningScenarioPort(scenario.path) : null;
      const cleanCode = await runCompose({
        scenarioPath: scenario.path,
        reposRoot: scenario.path,
        args: ["down", "--volumes", "--remove-orphans"],
        repoEnv: workspace.repoEnv,
        env: {
          ...(scenario.env ?? {}),
          ...(runningPort !== null ? { SCENARIO_PORT: String(runningPort) } : {}),
        },
      });
      if (cleanCode !== 0) {
        throw new Error(`docker compose down --volumes exited with code ${cleanCode}`);
      }
      console.log("");
    }

    // Build compose environment
    const composeEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...workspace.repoEnv,
      ...scenario.env,
      ...overrideEnv,
    };

    // Determine single-port scenario settings and validate --port usage
    const singlePort = getSinglePortInfo(scenario.path, composeEnv);
    let scenarioPort: number | null = null;
    if (portFlag !== null) {
      if (!singlePort.isSinglePort) {
        throw new Error(`Scenario '${scenario.name}' does not support --port; it is not a single-port scenario`);
      }
      scenarioPort = portFlag;
    } else if (singlePort.isSinglePort) {
      if (singlePort.scenarioPort === null) {
        throw new Error(`Single-port scenario '${scenario.name}' requires --port (no SCENARIO_PORT default configured)`);
      }
      scenarioPort = singlePort.scenarioPort;
    }

    if (scenarioPort !== null) {
      composeEnv.SCENARIO_PORT = String(scenarioPort);
    }

    // Compose project name distinguishes different ports of the same scenario.
    // With an explicit --port only the instance on that port is restarted (a
    // differently-ported instance is a deliberate parallel deployment).
    // Without --port any running instance of this scenario is restarted — its
    // project name may carry an auto-assigned SCENARIO_PORT we don't know yet.
    const projectName = getComposeProjectName(scenario.path, composeEnv);
    const running = isScenarioRunning(
      scenario.path,
      portFlag !== null ? projectName ?? undefined : undefined,
    );

    const stickyEnv: Record<string, string> = {};
    if (running) {
      // Capture the ports the running instance actually bound before it is
      // torn down — auto-port assignments stick across restarts, and `down`
      // must target the compose project it was started under.
      Object.assign(stickyEnv, getRunningPortOverrides(scenario.path, composeEnv));
      const runningPort = singlePort.isSinglePort ? getRunningScenarioPort(scenario.path) : null;
      if (runningPort !== null) {
        stickyEnv.SCENARIO_PORT = String(runningPort);
        if (portFlag === null) {
          scenarioPort = runningPort;
          composeEnv.SCENARIO_PORT = String(runningPort);
        }
      }
      // Explicit user choices (--port, env overrides) win over sticky ports
      if (portFlag !== null || overrideEnv.SCENARIO_PORT) delete stickyEnv.SCENARIO_PORT;
      for (const key of Object.keys(overrideEnv)) delete stickyEnv[key];

      console.log("\x1b[33mScenario already running — restarting...\x1b[0m\n");
      const downEnv = { ...overrideEnv, ...(scenario.env ?? {}), ...(scenarioPort !== null ? { SCENARIO_PORT: String(scenarioPort) } : {}) };
      const downCode = await runCompose({
        scenarioPath: scenario.path,
        reposRoot: scenario.path,
        args: ["down"],
        repoEnv: workspace.repoEnv,
        env: downEnv,
      });
      if (downCode !== 0) {
        throw new Error(`docker compose down exited with code ${downCode}`);
      }
      console.log("");
    }

    // Resolve dynamic ports before the conflict check.
    // Lock SCENARIO_PORT when the user explicitly chose it with --port or with an env override.
    const lockedEnv =
      portFlag !== null || overrideEnv.SCENARIO_PORT
        ? new Set(["SCENARIO_PORT"])
        : undefined;
    const autoPortEnv = autoPortEnabled
      ? await resolveAutoPorts(scenario.path, composeEnv, axnConfig.autoPort, autoPortRange, autoPortFlag, lockedEnv, stickyEnv)
      : {};
    const effectiveEnv = { ...composeEnv, ...autoPortEnv };
    const startEnv: Record<string, string> = {
      ...overrideEnv,
      ...(scenario.env ?? {}),
      ...(scenarioPort !== null ? { SCENARIO_PORT: String(scenarioPort) } : {}),
      ...autoPortEnv,
    };

    // Pre-flight: check for port conflicts
    const conflicts = checkPortConflicts(scenario.path, effectiveEnv);
    if (conflicts.length > 0) {
      console.error("\x1b[31mPort conflicts detected:\x1b[0m\n");
      for (const c of conflicts) {
        console.error(`  Port ${c.port} (needed by ${c.service})`);
        console.error(`    └─ in use by: ${c.usedBy}`);
      }
      console.error("");
      throw new Error(
        "Cannot start scenario — ports already in use.\n" +
        "Stop the conflicting services first, use --auto-port, or override ports via env vars."
      );
    }

    // --no-cache requires a separate build step first (not a valid flag for 'up')
    if (noCache) {
      console.log("\x1b[33mBuilding images without cache...\x1b[0m\n");
      const buildCode = await runCompose({
        scenarioPath: scenario.path,
        reposRoot: scenario.path,
        args: ["build", "--no-cache"],
        repoEnv: workspace.repoEnv,
        env: startEnv,
      });
      if (buildCode !== 0) {
        throw new Error(`docker compose build --no-cache exited with code ${buildCode}`);
      }
      console.log("");
    }

    const exitCode = await runCompose({
      scenarioPath: scenario.path,
      reposRoot: scenario.path,
      args: composeArgs,
      repoEnv: workspace.repoEnv,
      env: startEnv,
    });

    if (exitCode !== 0) {
      throw new Error(`docker compose exited with code ${exitCode}`);
    }

    // In detached mode, print service URLs
    if (!foreground) {
      console.log("");
      console.log("\x1b[32mServices running:\x1b[0m\n");

      const frontendMap = scenario.frontendServices ?? scenario.proxies;
      if (frontendMap && Object.keys(frontendMap).length > 0) {
        const friendly = resolveEndpoints(frontendMap, effectiveEnv);
        const maxName = Math.max(...Object.keys(friendly).map((n) => n.length));
        for (const [name, ep] of Object.entries(friendly).sort(([a], [b]) => a.localeCompare(b))) {
          console.log(`  ${name.padEnd(maxName)}  ${ep.url}`);
        }
      } else {
        const endpoints = getServiceEndpoints(scenario.path, effectiveEnv);
        const maxName = Math.max(...endpoints.map(e => e.service.length), 0);
        for (const ep of endpoints) {
          console.log(`  ${ep.service.padEnd(maxName)}  ${ep.url}`);
        }
      }
      console.log("");

      const portOpt = scenarioPort !== null ? ` -p ${scenarioPort}` : "";
      const stopCmd = resolution.source === "global"
        ? `axn-dev stop -g -s ${scenario.name}${portOpt}`
        : `axn-dev stop -s ${scenario.name}${portOpt}`;
      console.log(`Stop with: ${stopCmd}`);
    }
  }

  private confirm(prompt: string): Promise<boolean> {
    return new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase() === "y");
      });
    });
  }
}
