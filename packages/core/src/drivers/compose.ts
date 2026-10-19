import type { ScenarioInfo } from "../util/repo.js";
import { getComposeProjectName, runCompose } from "../util/compose.js";
import { getRunningComposeProjects, isScenarioRunning } from "../util/ports.js";
import type { ScenarioDriver, DriverStartOptions } from "../driver.js";

/**
 * Built-in driver for `compose.yaml`/`docker-compose.yaml` scenarios.
 *
 * The commands keep their richer compose-specific start/stop paths (auto-port,
 * port pre-flight, frontend service reporting); this driver provides the
 * generic interface so type-agnostic call sites (serve, list, plugin code)
 * can drive compose scenarios uniformly.
 */
export class ComposeDriver implements ScenarioDriver {
  readonly type = "compose";

  async isRunning(scenario: ScenarioInfo): Promise<boolean> {
    return isScenarioRunning(scenario.path);
  }

  isRunningSync(scenario: ScenarioInfo): boolean {
    return isScenarioRunning(scenario.path);
  }

  async start(scenario: ScenarioInfo, opts: DriverStartOptions): Promise<void> {
    const args = ["up", "--build"];
    if (!opts.foreground) args.push("-d");
    const code = await runCompose({
      scenarioPath: scenario.path,
      reposRoot: scenario.path,
      args,
      env: { ...(scenario.env ?? {}), ...(opts.env ?? {}) },
    });
    if (code !== 0) throw new Error(`docker compose up exited with code ${code}`);
  }

  async stop(scenario: ScenarioInfo): Promise<void> {
    // Recover the live project name — the derived name bakes in the branch
    // at `up` time and won't match after a branch switch.
    const running = getRunningComposeProjects(scenario.path);
    const projectName = running.length === 1
      ? running[0]
      : getComposeProjectName(scenario.path, scenario.env) ?? undefined;
    const code = await runCompose({
      scenarioPath: scenario.path,
      reposRoot: scenario.path,
      args: ["down"],
      env: scenario.env,
      projectName,
    });
    if (code !== 0) throw new Error(`docker compose down exited with code ${code}`);
  }
}
