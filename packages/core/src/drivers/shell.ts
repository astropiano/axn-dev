import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { ScenarioInfo } from "../util/repo.js";
import type { ScenarioDriver, DriverStartOptions } from "../driver.js";

const execFileAsync = promisify(execFile);

/**
 * Built-in driver for shell-based scenarios: a scenario dir containing an
 * executable `scenario.sh`. Contract:
 *
 *   scenario.sh start  <scenario-dir>   — start the scenario
 *   scenario.sh stop   <scenario-dir>   — stop it
 *   scenario.sh status <scenario-dir>   — exit 0 when fully running
 *
 * No port model is imposed; `env:` from axn-dev.yaml and caller env are
 * passed through. This is the zero-dependency way to make a non-compose
 * scenario type runnable.
 */
export class ShellDriver implements ScenarioDriver {
  readonly type = "shell";

  private script(scenario: ScenarioInfo): string {
    return `${scenario.path.replace(/\/+$/, "")}/scenario.sh`;
  }

  isRunningSync(scenario: ScenarioInfo): boolean {
    try {
      execFileSync("bash", [this.script(scenario), "status", scenario.path], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  async isRunning(scenario: ScenarioInfo): Promise<boolean> {
    try {
      await execFileAsync("bash", [this.script(scenario), "status", scenario.path]);
      return true;
    } catch {
      return false;
    }
  }

  private run(
    scenario: ScenarioInfo,
    action: "start" | "stop",
    env?: Record<string, string>,
    inherit = true,
  ): Promise<number> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn("bash", [this.script(scenario), action, scenario.path], {
        stdio: inherit ? "inherit" : ["ignore", "inherit", "inherit"],
        env: {
          ...(scenario.env ?? {}),
          ...process.env,
          ...(env ?? {}),
        } as Record<string, string>,
      });
      child.on("error", reject);
      child.on("close", (code) => resolvePromise(code ?? 1));
    });
  }

  async start(scenario: ScenarioInfo, opts: DriverStartOptions): Promise<void> {
    const code = await this.run(scenario, "start", opts.env, opts.foreground ?? true);
    if (code !== 0) throw new Error(`scenario.sh start exited with code ${code}`);
  }

  async stop(scenario: ScenarioInfo): Promise<void> {
    const code = await this.run(scenario, "stop");
    if (code !== 0) throw new Error(`scenario.sh stop exited with code ${code}`);
  }
}
