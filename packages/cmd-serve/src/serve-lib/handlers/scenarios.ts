import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { runCompose } from "@axn-dev/core";
import { discoverAllProjectScenariosAsync, findScenario as findRepoScenario, scenarioMatches } from "@axn-dev/core";
import type { ScenarioInfo } from "@axn-dev/core";
import {
  checkPortConflictsAsync,
  getRunningComposeProjectsAsync,
  getRunningPortOverridesAsync,
  getRunningScenarioPortAsync,
  getSinglePortInfo,
  isScenarioRunningAsync,
  resolveAutoPorts,
  resolveEndpoints,
  substituteEnvVars,
} from "@axn-dev/core";
import { parseBody } from "./utils.js";
import { driverFor, hasDriver } from "@axn-dev/core";
import { devServerUrlEnv, startDevServers, stopDevServers } from "@axn-dev/core";
import type { ServeContext, ScenarioInstance } from "../types.js";

export async function handleListScenarios(ctx: ServeContext, res: ServerResponse): Promise<void> {
  const config = ctx.discovery.getConfig();
  const [globalScenarios, projectScenarios] = await Promise.all([
    ctx.discovery.getGlobalScenariosAsync(),
    discoverAllProjectScenariosAsync(config),
  ]);

  const globalScenariosWithMeta = globalScenarios.map((s) => ({
    ...s,
    source: "global" as const,
    repoName: "global",
  }));

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    project: projectScenarios,
    global: globalScenariosWithMeta,
  }));
}

export async function findScenario(
  ctx: ServeContext,
  scenarioName: string,
  source?: string,
  repoName?: string,
): Promise<ScenarioInfo | null> {
  const config = ctx.discovery.getConfig();

  if (source === "global" || (!source && !repoName)) {
    const globalScenarios = await ctx.discovery.getGlobalScenariosAsync();
    const found = globalScenarios.find((s) => scenarioMatches(s, scenarioName));
    if (found) return found;
  }

  if (source === "project" || repoName) {
    const candidateRepo = repoName || "";
    // discoverAllProjectScenarios covers variant roots
    // (gen_a/v2/scenarios/ via scenarios.roots) and linked worktrees — a path-join
    // under <repo>/scenarios/ would miss both.
    const found = (await discoverAllProjectScenariosAsync(config)).find(
      (s) => (!candidateRepo || s.repoName === candidateRepo) && scenarioMatches(s, scenarioName),
    );
    if (found) return found;
  }

  return null;
}

export async function handleStartScenario(ctx: ServeContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await parseBody(req);
  const { scenarioName, source, repoName } = body;

  if (!scenarioName) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing scenarioName" }));
    return;
  }

  const scenario = await findScenario(ctx, scenarioName, source, repoName);

  if (!scenario) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Scenario not found" }));
    return;
  }

  // Optional explicit port for single-port scenarios (equivalent of `start -p`)
  let requestedPort: number | null = null;
  if (body.port !== undefined && body.port !== null && body.port !== "") {
    const parsed = parseInt(String(body.port), 10);
    if (isNaN(parsed) || parsed <= 0 || parsed > 65535) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "port must be a valid port number (1-65535)" }));
      return;
    }
    requestedPort = parsed;
  }

  const workspace = ctx.discovery.getWorkspaceConfig();

  const composeEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    ...workspace.repoEnv,
    ...(scenario.env ?? {}),
  };

  // Single-port scenario handling (same semantics as `axn-dev start`).
  // Non-compose scenarios have no SCENARIO_PORT — `port` maps onto the
  // driver's primary port iff it implements resolvePortEnv.
  const isCompose = (scenario.type ?? "compose") === "compose";
  const driver = !isCompose && hasDriver(scenario.type!)
    ? await driverFor(scenario)
    : null;
  const singlePort = getSinglePortInfo(scenario.path, composeEnv);
  let scenarioPort: number | null = null;
  if (requestedPort !== null) {
    const supportsPort = isCompose ? singlePort.isSinglePort : driver?.resolvePortEnv !== undefined;
    if (!supportsPort) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Scenario '${scenario.name}' does not support port; it is not a single-port scenario` }));
      return;
    }
    scenarioPort = requestedPort;
  } else if (singlePort.isSinglePort) {
    scenarioPort = singlePort.scenarioPort;
    if (scenarioPort === null) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Single-port scenario '${scenario.name}' requires a port (no SCENARIO_PORT default configured)` }));
      return;
    }
  }

  if (ctx.scenarioRuns.isStarting(scenario.name)) {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Scenario '${scenario.name}' is already starting` }));
    return;
  }

  // `docker compose up --build` routinely outlives Node's default HTTP
  // requestTimeout (5 min), which killed the fetch while the stack kept
  // coming up. Run it in the background; the dashboard polls
  // GET /api/scenario-runs for progress.
  const run = ctx.scenarioRuns.begin(
    scenario.name,
    source === "global" ? "global" : "project",
    typeof repoName === "string" && repoName ? repoName : undefined,
  );

  res.writeHead(202, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ success: true, scenario: scenario.name, runId: run.id }));

  performScenarioStart(ctx, run.id, scenario, { source, requestedPort, scenarioPort }).catch((err) => {
    ctx.scenarioRuns.fail(run.id, err instanceof Error ? err.message : String(err));
  });
}

async function performScenarioStart(
  ctx: ServeContext,
  runId: string,
  scenario: ScenarioInfo,
  opts: { source?: string; requestedPort: number | null; scenarioPort: number | null },
): Promise<void> {
  const runs = ctx.scenarioRuns;
  const onOutput = (chunk: string) => runs.appendTail(runId, chunk);
  const workspace = ctx.discovery.getWorkspaceConfig();
  const axnConfig = ctx.discovery.getConfig();

  const composeEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    ...workspace.repoEnv,
    ...(scenario.env ?? {}),
  };
  if (opts.scenarioPort !== null) {
    composeEnv.SCENARIO_PORT = String(opts.scenarioPort);
  }

  // Non-compose scenarios delegate to their registered driver — same
  // restart + auto-port semantics as the compose path below.
  const scenarioType = scenario.type ?? "compose";
  if (scenarioType !== "compose") {
    const driver = await driverFor(scenario);
    // Stop before resolving ports — otherwise the running instance's own
    // ports count as conflicts. Sticky ports keep auto-port assignments
    // across restarts.
    const running = await driver.isRunning(scenario);
    const stickyEnv = running ? (driver.runningEnv?.(scenario.path) ?? {}) : {};
    if (running) {
      runs.update(runId, { phase: "Stopping existing instance..." });
      try {
        await driver.stop(scenario);
      } catch (err) {
        runs.fail(runId, err instanceof Error ? err.message : String(err));
        return;
      }
    }
    let resolvedEnv: Record<string, string> = {};
    let primaryPort: number | undefined;
    try {
      const resolved = driver.resolvePortEnv
        ? await driver.resolvePortEnv(scenario, composeEnv, {
            autoPort: axnConfig.autoPort,
            autoPortRange: axnConfig.autoPortRange,
            primaryPort: opts.requestedPort,
            stickyEnv,
          })
        : { env: {} };
      resolvedEnv = resolved.env;
      primaryPort = resolved.primaryPort;
    } catch (err) {
      runs.fail(runId, err instanceof Error ? err.message : String(err));
      return;
    }
    runs.update(runId, { phase: `${scenarioType} start` });
    try {
      await driver.start(scenario, { env: resolvedEnv });
    } catch (err) {
      runs.fail(runId, err instanceof Error ? err.message : String(err));
      return;
    }
    runs.update(runId, { phase: "dev servers" });
    const endpointEnv = {
      ...composeEnv,
      ...(driver.urlEnv?.(scenario) ?? {}),
      ...devServerUrlEnv(scenario.devServers ?? []),
    };
    try {
      await startDevServers(scenario, endpointEnv, axnConfig);
    } catch (err) {
      runs.fail(runId, err instanceof Error ? err.message : String(err));
      return;
    }

    // Register the instance so the dashboard can iframe the driver's
    // endpoints. Only web endpoints are offered (fwd hints like
    // `ssh -p ...` are informational, not browsable).
    const instanceId = randomUUID();
    const driverEndpoints = driver.endpoints?.(scenario) ?? [];
    const endpoints: Record<string, string> = {};
    for (const { label, url } of driverEndpoints) {
      if (/^https?:\/\//.test(url)) endpoints[label] ??= url;
    }
    const frontendName = Array.isArray(scenario.frontend)
      ? scenario.frontend[0]
      : scenario.frontend;
    const defaultEndpoint = driverEndpoints.find((e) => e.default)?.label
      ?? Object.keys(endpoints)[0];
    const instance: ScenarioInstance = {
      id: instanceId,
      // Registered under the qualified name the dashboard addresses it by
      // (gen2/sim) so stop-deregistration and the view lookup match.
      scenarioName: scenario.variant ? `${scenario.variant}/${scenario.name}` : scenario.name,
      description: scenario.description,
      proxies: {},
      endpoints,
      frontend: frontendName && endpoints[frontendName] ? frontendName : defaultEndpoint,
      links: (scenario.links ?? []).map((l) => ({
        ...l,
        url: substituteEnvVars(l.url, endpointEnv),
      })),
      registeredAt: new Date(),
      source: opts.source === "global" ? "global" : "project",
      scenarioPath: scenario.path,
    };
    ctx.registry.set(instanceId, instance);
    console.log(`Auto-registered ${scenarioType} scenario: ${scenario.name} (${instanceId})`);
    runs.succeed(runId, primaryPort);
    return;
  }

  // If any instance of this scenario is already running, tear it down first —
  // resolve the actually running SCENARIO_PORT so the right compose project is
  // removed even when its port was auto-assigned.
  let stickyEnv: Record<string, string> = {};
  if (await isScenarioRunningAsync(scenario.path)) {
    runs.update(runId, { phase: "Stopping existing instance..." });
    console.log(`Scenario ${scenario.name} already running — restarting...`);
    // Capture the ports the running instance actually bound before it goes
    // down — auto-port assignments stick across restarts.
    const [overrides, runningPort] = await Promise.all([
      getRunningPortOverridesAsync(scenario.path, composeEnv),
      getRunningScenarioPortAsync(scenario.path),
    ]);
    stickyEnv = overrides;
    if (runningPort !== null) {
      stickyEnv.SCENARIO_PORT = String(runningPort);
      if (opts.requestedPort === null) {
        opts.scenarioPort = runningPort;
        composeEnv.SCENARIO_PORT = String(runningPort);
      }
    }
    // An explicitly requested port wins over the sticky assignment.
    if (opts.requestedPort !== null) delete stickyEnv.SCENARIO_PORT;
    const downPort = runningPort ?? opts.scenarioPort;
    // Recover the live project name — the derived name bakes in the branch
    // at `up` time and won't match after a branch switch.
    const runningProjects = await getRunningComposeProjectsAsync(scenario.path);
    const downCode = await runCompose({
      scenarioPath: scenario.path,
      reposRoot: scenario.path,
      args: ["down"],
      repoEnv: workspace.repoEnv,
      env: {
        ...(scenario.env ?? {}),
        ...(downPort !== null ? { SCENARIO_PORT: String(downPort) } : {}),
      },
      projectName: runningProjects.length === 1 ? runningProjects[0] : undefined,
      onOutput,
    });
    if (downCode !== 0) {
      runs.fail(runId, `docker compose down exited with code ${downCode}`);
      return;
    }
  }

  // Honour the auto-port configuration (same as `axn-dev start`).
  // An explicitly requested port locks SCENARIO_PORT against reassignment.
  const lockedEnv = opts.requestedPort !== null ? new Set(["SCENARIO_PORT"]) : undefined;
  let autoPortEnv: Record<string, string> = {};
  try {
    autoPortEnv = axnConfig.autoPort
      ? await resolveAutoPorts(scenario.path, composeEnv, axnConfig.autoPort, axnConfig.autoPortRange, false, lockedEnv, stickyEnv)
      : {};
  } catch (err) {
    runs.fail(runId, err instanceof Error ? err.message : String(err));
    return;
  }
  const effectiveEnv = { ...composeEnv, ...autoPortEnv };

  // Pre-flight: check for port conflicts before docker fails halfway through "up"
  const conflicts = await checkPortConflictsAsync(scenario.path, effectiveEnv);
  if (conflicts.length > 0) {
    const details = conflicts
      .map((c) => `port ${c.port} (${c.service}) is in use by ${c.usedBy}`)
      .join("; ");
    runs.fail(
      runId,
      `Port conflicts detected: ${details}. ` +
        "Stop the conflicting services first or enable auto-port in ~/.axn-dev/config.yaml.",
    );
    return;
  }

  runs.update(runId, { phase: "docker compose up --build" });
  const exitCode = await runCompose({
    scenarioPath: scenario.path,
    reposRoot: scenario.path,
    args: ["up", "--build", "-d"],
    repoEnv: workspace.repoEnv,
    env: {
      ...(scenario.env ?? {}),
      ...(opts.scenarioPort !== null ? { SCENARIO_PORT: String(opts.scenarioPort) } : {}),
      ...autoPortEnv,
    },
    onOutput,
  });

  if (exitCode !== 0) {
    runs.fail(runId, `docker compose up exited with code ${exitCode}`);
    return;
  }

  // Auxiliary dev servers declared in axn-dev.yaml — same as `axn-dev start`.
  if ((scenario.devServers ?? []).length > 0) {
    runs.update(runId, { phase: "dev servers" });
    try {
      await startDevServers(
        scenario,
        { ...effectiveEnv, ...devServerUrlEnv(scenario.devServers ?? []) },
        axnConfig,
      );
    } catch (err) {
      runs.fail(runId, err instanceof Error ? err.message : String(err));
      return;
    }
  }

  const frontendMap = scenario.frontendServices ?? scenario.proxies;
  if (frontendMap) {
    const instanceId = randomUUID();
    const endpointMap = resolveEndpoints(frontendMap, {
      ...effectiveEnv,
      ...devServerUrlEnv(scenario.devServers ?? []),
    });
    const proxyMap: Record<string, number> = {};
    const urlMap: Record<string, string> = {};
    for (const [name, ep] of Object.entries(endpointMap)) {
      proxyMap[name] = ep.port;
      urlMap[name] = ep.url;
    }
    const instance: ScenarioInstance = {
      id: instanceId,
      scenarioName: scenario.name,
      description: scenario.description,
      proxies: proxyMap,
      endpoints: urlMap,
      frontend: scenario.frontend,
      links: scenario.links,
      registeredAt: new Date(),
      source: opts.source === "global" ? "global" : "project",
      scenarioPath: scenario.path,
    };
    ctx.registry.set(instanceId, instance);
    console.log(`Auto-registered scenario: ${scenario.name} (${instanceId})`);
  }

  const effectivePort = autoPortEnv.SCENARIO_PORT
    ? parseInt(autoPortEnv.SCENARIO_PORT, 10)
    : opts.scenarioPort;

  runs.succeed(runId, effectivePort ?? undefined);
}

/** GET /api/scenario-runs — JSON list of tracked scenario starts (for polling). */
export function handleScenarioRuns(ctx: ServeContext, res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(ctx.scenarioRuns.list()));
}

export async function handleStopScenario(ctx: ServeContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await parseBody(req);
  const { scenarioName, source, repoName } = body;

  if (!scenarioName) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing scenarioName" }));
    return;
  }

  for (const [id, instance] of ctx.registry.entries()) {
    if (instance.scenarioName === scenarioName) {
      ctx.registry.delete(id);
      console.log(`Deregistered scenario: ${scenarioName} (${id})`);
    }
  }

  let scenario = await findScenario(ctx, scenarioName, source, repoName);

  if (!scenario && !source) {
    // Same lookup order as discovery.resolveScenario() (global → local
    // project) but through async discovery so the request path stays
    // non-blocking.
    try {
      const repoCtx = ctx.discovery.getRepoContext();
      scenario =
        (await ctx.discovery.getGlobalScenariosAsync()).find((s) =>
          scenarioMatches(s, scenarioName),
        ) ?? (repoCtx ? findRepoScenario(repoCtx, scenarioName) : null);
    } catch { /* ignore */ }
  }

  if (!scenario) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Scenario not found" }));
    return;
  }

  // Non-compose scenarios stop through their registered driver — no
  // compose project exists to `down`. Dev servers we spawned die with it.
  if ((scenario.type ?? "compose") !== "compose") {
    try {
      const driver = await driverFor(scenario);
      await driver.stop(scenario);
      stopDevServers(scenario);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : "driver stop failed" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, scenario: scenarioName }));
    return;
  }

  const workspace = ctx.discovery.getWorkspaceConfig();

  // Resolve the running SCENARIO_PORT for single-port scenarios so the
  // correct compose project is torn down (the port may have been auto-assigned).
  const singlePort = getSinglePortInfo(scenario.path, scenario.env ?? {});
  const scenarioPort = singlePort.isSinglePort
    ? (await getRunningScenarioPortAsync(scenario.path)) ?? singlePort.scenarioPort
    : null;

  // Recover the live project name — the derived name bakes in the branch
  // at `up` time and won't match after a branch switch.
  const runningProjects = await getRunningComposeProjectsAsync(scenario.path);
  const exitCode = await runCompose({
    scenarioPath: scenario.path,
    reposRoot: scenario.path,
    args: ["down"],
    repoEnv: workspace.repoEnv,
    env: {
      ...(scenario.env ?? {}),
      ...(scenarioPort !== null ? { SCENARIO_PORT: String(scenarioPort) } : {}),
    },
    projectName: runningProjects.length === 1 ? runningProjects[0] : undefined,
  });

  if (exitCode !== 0) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "docker-compose down failed" }));
    return;
  }

  // Dev servers this scenario spawned die with it; reused ones stay up.
  stopDevServers(scenario);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ success: true, scenario: scenarioName }));
}
