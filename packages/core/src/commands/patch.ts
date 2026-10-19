import type { Command } from "./command.js";
import { ScenarioDiscoveryService } from "../util/scenario-discovery.js";
import { getComposeProjectName, runCompose, getComposeCommand } from "../util/compose.js";
import { getRunningComposeProjects, getRunningScenarioPort, getSinglePortInfo, isScenarioRunning } from "../util/ports.js";
import { applyRepoRootOverrides } from "../util/config.js";
import { resolveWorkbaseRoots } from "../util/worktree.js";
import { scenarioCompleter } from "../completion-helpers.js";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { execSync } from "node:child_process";
import { load as yamlLoad } from "js-yaml";

export class PatchCommand implements Command {
  readonly name = "patch";
  readonly description = "Rebuild and/or restart specific services in a running scenario";

  complete = scenarioCompleter([
    "--scenario", "-s", "--global", "-g", "--port", "-p",
    "--workbase", "--build", "--no-cache", "--help", "-h",
  ]);

  help(): string {
    return `
axn-dev patch [--scenario <name>] [--global] [--port <port>] [--workbase <branch>] [--build] [--no-cache] [service1 service2 ...]

Restarts one or more specific services in a running scenario without touching
the rest of the stack. Use --build to rebuild the image(s) first.

When no services are given, automatically detects stale services by comparing
the newest file mtime in each build context against the container creation time.

Options:
  --scenario, -s <name>   Scenario the services belong to (default: auto-detect)
  --global, -g            Use global (cross-concern) scenarios
  --port, -p <port>       Single-port scenario: port the scenario was started on
  --workbase <branch>     Use the checkout or worktree on <branch> for the integration repo
  --build                 Rebuild image(s) before restarting
  --no-cache              Rebuild without Docker layer cache (implies --build)

Examples:
  axn-dev patch -s dev                                           # auto-detect stale + rebuild
  axn-dev patch -s demo-full -p 8091 api                         # restart only
  axn-dev patch -g -s demo-full -p 8091 --workbase feature/single-port api
  axn-dev patch -s dev api                                       # restart only
  axn-dev patch -s dev api --build                               # rebuild + restart
  axn-dev patch -s dev api --no-cache                            # rebuild without cache + restart
  axn-dev patch -s dev api web --build                           # patch two services
`;
  }

  async execute(args: string[]): Promise<void> {
    let scenarioName: string | null = null;
    let useGlobal = false;
    let portFlag: number | null = null;
    let workbase: string | null = null;
    let build = false;
    let noCache = false;
    const services: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--scenario" || arg === "-s") {
        scenarioName = args[++i];
        if (!scenarioName) throw new Error("--scenario requires a value");
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
        if (!value) throw new Error("--workbase requires a value");
        workbase = value;
      } else if (arg === "--build") {
        build = true;
      } else if (arg === "--no-cache") {
        noCache = true;
        build = true;
      } else if (arg === "--help" || arg === "-h") {
        console.log(this.help());
        return;
      } else if (!arg.startsWith("-")) {
        services.push(arg);
      }
    }

    // services may be empty — auto-detection runs later after scenario resolution

    const discovery = new ScenarioDiscoveryService(process.cwd(), workbase ?? undefined);
    const workspace = discovery.getWorkspaceConfig();

    if (workbase) {
      const repoRootValues: string[] = [];
      for (const { repoName, path } of resolveWorkbaseRoots(discovery.getConfig(), workbase)) {
        repoRootValues.push(`${repoName}=${path}`);
      }
      applyRepoRootOverrides(workspace, repoRootValues);
    }

    discovery.printDetectionInfo();
    console.log("");

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
      console.error(`\x1b[31mpatch only supports compose scenarios (got type '${scenario.type}').\x1b[0m`);
      process.exit(1);
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
      const runningPort = getRunningScenarioPort(scenario.path);
      scenarioPort = runningPort ?? singlePort.scenarioPort;
      if (scenarioPort === null) {
        throw new Error(`Single-port scenario '${scenario.name}' requires --port (no running instance or default found)`);
      }
    }

    const patchEnv: Record<string, string> = {
      ...(scenario.env ?? {}),
      ...(scenarioPort !== null ? { SCENARIO_PORT: String(scenarioPort) } : {}),
    };

    // Prefer the live project name from running containers — the derived name
    // bakes in the branch at `up` time and won't match after a branch switch.
    const runningProjects = getRunningComposeProjects(scenario.path);
    let projectName = getComposeProjectName(scenario.path, patchEnv);
    if (runningProjects.length === 1) {
      projectName = runningProjects[0];
    } else if (runningProjects.length > 1 && scenarioPort !== null) {
      projectName = runningProjects.find((p) => p.endsWith(`-${scenarioPort}`)) ?? projectName;
    }

    if (!isScenarioRunning(scenario.path, projectName ?? undefined)) {
      console.error("\x1b[31mScenario is not running.\x1b[0m");
      const portOpt = scenarioPort !== null ? ` -p ${scenarioPort}` : "";
      console.error(`Start it first with: axn-dev start -s ${scenario.name}${portOpt}`);
      process.exit(1);
    }

    const composeOptions = {
      scenarioPath: scenario.path,
      reposRoot: scenario.path,
      repoEnv: workspace.repoEnv,
      env: patchEnv,
      projectName: projectName ?? undefined,
    };

    // Auto-detect stale services when none specified
    if (services.length === 0) {
      const detected = detectStaleServices(scenario.path, scenario.composePath ?? "", workspace.repoEnv, scenario.env ?? {});
      if (detected.length === 0) {
        console.log("\x1b[32m✓ All services are up to date.\x1b[0m");
        return;
      }
      services.push(...detected);
      build = true; // auto-detect always implies rebuild
      console.log(`\x1b[33mAuto-detected stale services: ${detected.join(", ")}\x1b[0m\n`);
    }

    if (services.length === 0) {
      console.error("\x1b[31mError: at least one service name is required.\x1b[0m");
      console.error("Usage: axn-dev patch -s <scenario> [service1 ...] [--build]");
      process.exit(1);
    }

    const serviceList = services.join(", ");

    if (build) {
      const buildLabel = noCache ? "without cache" : "with cache";
      console.log(`\x1b[33mBuilding ${serviceList} (${buildLabel})...\x1b[0m\n`);
      const buildArgs = ["build", ...(noCache ? ["--no-cache"] : []), ...services];
      const buildCode = await runCompose({ ...composeOptions, args: buildArgs });
      if (buildCode !== 0) {
        throw new Error(`docker compose build exited with code ${buildCode}`);
      }
      console.log("");
    }

    console.log(`\x1b[33mRestarting ${serviceList}...\x1b[0m\n`);
    const upArgs = ["up", "-d", "--no-deps", ...services];
    const upCode = await runCompose({ ...composeOptions, args: upArgs });
    if (upCode !== 0) {
      throw new Error(`docker compose up exited with code ${upCode}`);
    }

    console.log(`\n\x1b[32m✓ ${serviceList} updated.\x1b[0m`);
  }
}

// --- Stale service detection ---

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", "bin", "obj", ".nx", "__pycache__", ".cache"]);
const IGNORE_EXTENSIONS = new Set([".log", ".lock", ".map", ".d.ts"]);

/**
 * Get container creation time in ms for the container running a compose service.
 * Uses `docker compose ps -q <service>` to find the container id, then `docker inspect`.
 * Returns 0 if the container is not found.
 */
function containerCreatedAt(scenarioPath: string, serviceName: string, env: Record<string, string>): number {
  try {
    const cmd = getComposeCommand();
    const id = execSync(
      [cmd.binary, ...cmd.prefixArgs, "ps", "-q", serviceName].join(" "),
      { cwd: scenarioPath, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] }
    ).toString().trim().split("\n")[0];
    if (!id) return 0;
    const created = execSync(
      `docker inspect --format "{{.Created}}" ${id}`,
      { stdio: ["pipe", "pipe", "pipe"] }
    ).toString().trim();
    return created ? new Date(created).getTime() : 0;
  } catch {
    return 0;
  }
}

/**
 * Resolve a context path (which may be an env-var expression like ${VAR:-fallback})
 * against the scenario path and repoEnv.
 */
function resolveContextPath(raw: string, scenarioPath: string, repoEnv: Record<string, string>, env: Record<string, string>): string {
  const resolved = raw.replace(/\$\{([^}]+)\}/g, (_, inner) => {
    const sepIdx = inner.indexOf(":-");
    if (sepIdx !== -1) {
      const varName = inner.slice(0, sepIdx);
      const fallback = inner.slice(sepIdx + 2);
      return repoEnv[varName] ?? env[varName] ?? process.env[varName] ?? fallback;
    }
    return repoEnv[inner] ?? env[inner] ?? process.env[inner] ?? raw;
  });
  return isAbsolute(resolved) ? resolved : resolve(scenarioPath, resolved);
}

/**
 * Detect which built services have source files newer than their running container.
 */
function detectStaleServices(
  scenarioPath: string,
  composePath: string,
  repoEnv: Record<string, string>,
  env: Record<string, string>
): string[] {
  const allEnv = { ...repoEnv, ...env };
  const buildContexts = parseBuildContextsSync(composePath, scenarioPath, repoEnv, env);
  const stale: string[] = [];

  for (const [service, contexts] of buildContexts) {
    const createdAt = containerCreatedAt(scenarioPath, service, allEnv);
    let label = service;

    if (createdAt === 0) {
      console.log(`  ${label}: \x1b[33mnot running\x1b[0m — skipping`);
      continue;
    }

    let newestSource = 0;
    let newestFile = "";
    for (const ctx of contexts) {
      const mt = newestMtimeWithFile(ctx, createdAt);
      if (mt.mtime > newestSource) {
        newestSource = mt.mtime;
        newestFile = mt.file;
      }
    }

    if (newestSource > createdAt) {
      const age = Math.round((newestSource - createdAt) / 1000);
      console.log(`  ${label}: \x1b[33mSTALE\x1b[0m (${newestFile} is ${age}s newer than container)`);
      stale.push(service);
    } else {
      console.log(`  ${label}: \x1b[32mup to date\x1b[0m`);
    }
  }

  return stale;
}

/** newestMtime variant that also returns the triggering file path */
function newestMtimeWithFile(dir: string, cutoff = 0): { mtime: number; file: string } {
  if (!existsSync(dir)) return { mtime: 0, file: "" };
  let newest = 0;
  let newestFile = "";
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return { mtime: 0, file: "" }; }
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const ext = entry.name.includes(".") ? entry.name.slice(entry.name.lastIndexOf(".")) : "";
    if (IGNORE_EXTENSIONS.has(ext)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = newestMtimeWithFile(full, cutoff);
      if (sub.mtime > newest) { newest = sub.mtime; newestFile = sub.file; }
    } else {
      try {
        const mt = statSync(full).mtimeMs;
        if (mt > newest) { newest = mt; newestFile = full; }
      } catch { /* skip */ }
    }
  }
  return { mtime: newest, file: newestFile };
}

/** Parse compose yaml and extract build contexts (sync). */
function parseBuildContextsSync(
  composePath: string,
  scenarioPath: string,
  repoEnv: Record<string, string>,
  env: Record<string, string>
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (!existsSync(composePath)) return result;

  let raw: string;
  try { raw = readFileSync(composePath, "utf-8"); } catch { return result; }

  let doc: Record<string, unknown>;
  try {
    doc = yamlLoad(raw) as Record<string, unknown>;
  } catch { return result; }

  const services = doc?.services as Record<string, unknown> | undefined;
  if (!services) return result;

  for (const [name, svc] of Object.entries(services)) {
    const service = svc as Record<string, unknown>;
    if (!service?.build) continue;

    const build = service.build as Record<string, unknown> | string;
    const contextRaw = typeof build === "string" ? build : (build as Record<string, unknown>).context as string | undefined;
    if (!contextRaw) continue;

    const contexts: string[] = [resolveContextPath(contextRaw, scenarioPath, repoEnv, env)];

    const additional = typeof build !== "string"
      ? (build as Record<string, unknown>).additional_contexts as Record<string, string> | undefined
      : undefined;
    if (additional) {
      for (const ctxPath of Object.values(additional)) {
        contexts.push(resolveContextPath(ctxPath, scenarioPath, repoEnv, env));
      }
    }

    result.set(name, contexts);
  }

  return result;
}
