/**
 * Scenario type drivers — the second plugin axis.
 *
 * A scenario's `type` decides who owns its lifecycle. `compose` and `shell`
 * are built in; further types are contributed by plugin packages declaring
 * `axn-dev.scenarioTypes` in their package.json manifest:
 *
 *   "axn-dev": {
 *     "scenarioTypes": [
 *       { "type": "qemu", "markers": ["sim.yaml"], "entry": "dist/index.js" }
 *     ]
 *   }
 *
 * `markers` are filenames probed inside a scenario directory — they let the
 * type be *detected* (and `axn-dev.yaml`'s explicit `type:` be defaulted)
 * without loading the driver module. The module is imported lazily the first
 * time a scenario of that type is actually driven. The driver module exports
 * `driver` (or a default export) implementing `ScenarioDriver`.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioInfo } from "./util/repo.js";

export interface DriverStartOptions {
  foreground?: boolean;
  env?: Record<string, string>;
}

export interface DriverPortEnvOptions {
  /** --auto-port behaviour: reassign busy declared ports from the range. */
  autoPort: boolean;
  autoPortRange: string | null;
  /** `--port <n>` on the CLI maps onto the driver's primary port. */
  primaryPort?: number | null;
  /** Env vars captured from a previously running instance (sticky ports). */
  stickyEnv?: Record<string, string>;
}

export interface DriverPortEnvResult {
  env: Record<string, string>;
  /** The port that identifies this instance to the user (e.g. control port). */
  primaryPort?: number;
}

/** Lifecycle driver for one scenario type. */
export interface ScenarioDriver {
  readonly type: string;

  isRunning(scenario: ScenarioInfo): Promise<boolean>;
  /** Sync variant for list/dashboard contexts. */
  isRunningSync?(scenario: ScenarioInfo): boolean;

  start(scenario: ScenarioInfo, opts: DriverStartOptions): Promise<void>;
  stop(scenario: ScenarioInfo): Promise<void>;

  /** Env the driver sources from files (e.g. <scenario>/.env layering). */
  fileEnv?(scenarioPath: string): Record<string, string>;
  /** Env vars captured from the currently running instance — auto-assigned
   * ports exist only in the running process. */
  runningEnv?(scenarioPath: string): Record<string, string>;
  /** Resolve the host ports/env an instance should bind, honouring
   * auto-port reassignment and sticky ports from `stickyEnv`. */
  resolvePortEnv?(
    scenario: ScenarioInfo,
    baseEnv: Record<string, string>,
    opts: DriverPortEnvOptions,
  ): Promise<DriverPortEnvResult>;
  /** Env vars exposed for `${VAR}` expansion in axn-dev.yaml URLs. */
  urlEnv?(scenario: ScenarioInfo): Record<string, string>;
  /** Labeled endpoints shown by `axn-dev list` and the serve dashboard for a
   * running instance. `default: true` marks the preferred view. */
  endpoints?(scenario: ScenarioInfo): { label: string; url: string; default?: boolean }[];
}

/** A registered scenario type: marker probing without module loading. */
export interface ScenarioDriverSpec {
  type: string;
  /** Filenames inside a scenario dir that imply this type. */
  markers: string[];
  /** Lazily produces the driver instance (cached after first call). */
  load(): Promise<ScenarioDriver> | ScenarioDriver;
}

const specs = new Map<string, ScenarioDriverSpec>();
const instances = new Map<string, Promise<ScenarioDriver>>();

// Built-in scenario types. Registered eagerly — marker order decides ties:
// compose.yaml wins over any plugin marker; scenario.sh is the generic
// fallback for script-driven scenarios.
registerScenarioDriver({
  type: "compose",
  markers: ["compose.yaml", "docker-compose.yaml", "docker-compose.yml"],
  load: async () => new (await import("./drivers/compose.js")).ComposeDriver(),
});
registerScenarioDriver({
  type: "shell",
  markers: ["scenario.sh"],
  load: async () => new (await import("./drivers/shell.js")).ShellDriver(),
});

/** Register a scenario type. Later registrations lose marker conflicts. */
export function registerScenarioDriver(spec: ScenarioDriverSpec): void {
  if (specs.has(spec.type)) return;
  specs.set(spec.type, spec);
}

/** All registered scenario types, in registration order. */
export function scenarioDriverSpecs(): ScenarioDriverSpec[] {
  return [...specs.values()];
}

/** Is a driver registered for this scenario type (without loading it)? */
export function hasDriver(type: string): boolean {
  return specs.has(type);
}

/**
 * Detect the scenario type of a directory from registered markers.
 * `compose.yaml`/`docker-compose.yaml` win first (registration order), so a
 * dir carrying both a compose file and a type marker stays compose.
 * Returns null when nothing matches — the dir is not a scenario.
 */
export function detectScenarioType(scenarioPath: string): string | null {
  for (const spec of specs.values()) {
    for (const marker of spec.markers) {
      if (existsSync(join(scenarioPath, marker))) return spec.type;
    }
  }
  return null;
}

/** The driver instance for a scenario (or type name). Modules load lazily
 * and are cached per type. */
export async function driverFor(
  scenario: Pick<ScenarioInfo, "type" | "name">,
): Promise<ScenarioDriver> {
  const type = scenario.type ?? "compose";
  let instance = instances.get(type);
  if (!instance) {
    const spec = specs.get(type);
    if (!spec) {
      throw new Error(
        `Unknown scenario type '${type}' for scenario '${scenario.name}'. ` +
        `Registered types: ${[...specs.keys()].join(", ") || "(none)"}. ` +
        `Install a plugin package declaring it via axn-dev.scenarioTypes.`,
      );
    }
    instance = Promise.resolve(spec.load());
    instances.set(type, instance);
  }
  return instance;
}

/** Sync check for "is any non-compose driver instance running at this dir". */
export async function getRunningDriverDirs(
  scenarios: { path: string; type?: string }[],
): Promise<Set<string>> {
  const dirs = new Set<string>();
  await Promise.all(
    scenarios.map(async (s) => {
      const type = s.type ?? "compose";
      if (type === "compose") return;
      try {
        const driver = await driverFor({ type, name: s.path });
        if (await driver.isRunning(s as ScenarioInfo)) {
          dirs.add(s.path.replace(/\/+$/, ""));
        }
      } catch {
        // driver unavailable — treat as not running
      }
    }),
  );
  return dirs;
}
