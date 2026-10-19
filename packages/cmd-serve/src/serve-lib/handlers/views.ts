import type { ServerResponse } from "node:http";
import { dashboardHtml, type MenuCounts } from "../html.js";
import { scenarioViewHtml } from "../scenarioView.js";
import { flowsListHtml, flowViewHtml, flowReportHtml } from "../flowViews.js";
import { discoverAllFlowsAsync, flowRootsAsync, listFlowReports, loadFlowReport, isReportPathAllowed } from "../flows.js";
import { loadFlowsFromFileSafe } from "@axn-dev/flow-format";
import { discoverAllProjectScenariosAsync, scenarioMatches, type ScenarioInfo } from "@axn-dev/core";
import {
  getComposePortsAsync,
  getRunningComposeProjectDirsAsync,
  getRunningPortOverridesAsync,
  getRunningScenarioPortAsync,
  resolveEndpoints,
  substituteEnvVars,
} from "@axn-dev/core";
import { driverFor, getRunningDriverDirs, hasDriver } from "@axn-dev/core";
import { devServerUrlEnv } from "@axn-dev/core";
import type { ServeContext, ScenarioInstance } from "../types.js";
import type { ScenarioLink } from "@axn-dev/core";

function menuCountsFrom(
  globalScenarios: ScenarioInfo[],
  projectScenarios: ScenarioInfo[],
  runningDirs: Set<string>,
  flowTotal: number,
  flowRunning: number,
): MenuCounts {
  const isRunning = (s: { path: string }) => runningDirs.has(s.path.replace(/\/+$/, ""));
  return {
    scenarioTotal: globalScenarios.length + projectScenarios.length,
    scenarioRunning: [...globalScenarios, ...projectScenarios].filter(isRunning).length,
    flowTotal,
    flowRunning,
  };
}

/**
 * Menu badge counts for the shared page shell. Fully async — all discovery
 * (git) and status (docker) subprocesses run off the event loop so a request
 * for one page never stalls the others.
 */
export async function menuCountsAsync(ctx: ServeContext): Promise<MenuCounts> {
  const config = ctx.discovery.getConfig();
  const [globalScenarios, projectScenarios, flows] = await Promise.all([
    ctx.discovery.getGlobalScenariosAsync(),
    discoverAllProjectScenariosAsync(config),
    discoverAllFlowsAsync(config),
  ]);
  const runningDirs = await runningDirsFor([...globalScenarios, ...projectScenarios]);
  const runningRuns = ctx.flowRuns.list().filter((r) => r.status === "running").length;
  return menuCountsFrom(globalScenarios, projectScenarios, runningDirs, flows.length, runningRuns);
}

/** Compose project dirs unioned with running non-compose scenario dirs
 * (probed through their registered drivers). */
async function runningDirsFor(scenarios: { path: string; type?: string }[]): Promise<Set<string>> {
  const [dirs, driverDirs] = await Promise.all([
    getRunningComposeProjectDirsAsync(),
    getRunningDriverDirs(scenarios),
  ]);
  for (const dir of driverDirs) dirs.add(dir);
  return dirs;
}

/**
 * Resolve the links for one dashboard row: endpoints/ports of the running
 * instance (frontend map resolved against live env, or compose-published
 * ports as a fallback) merged with the scenario's static links.
 */
async function dashboardRowLinks(
  s: ScenarioInfo,
  running: boolean,
  repoEnv: Record<string, string>,
): Promise<ScenarioLink[]> {
  const linksMap = new Map<string, ScenarioLink>();
  const env = { ...process.env as Record<string, string>, ...repoEnv, ...s.env };
  if (running) {
    try {
      const frontendMap: Record<string, string> = s.frontendServices ?? s.proxies ?? {};
      const backendMap: Record<string, string> = s.frontendServices ? (s.backendServices ?? {}) : {};
      // Overlay the ports the running containers actually published — env
      // vars reassigned by --auto-port only exist on the docker side.
      const [overrides, runningPort] = await Promise.all([
        getRunningPortOverridesAsync(s.path, env),
        getRunningScenarioPortAsync(s.path),
      ]);
      Object.assign(env, overrides);
      if (runningPort !== null) {
        env.SCENARIO_PORT = String(runningPort);
      }

      if (Object.keys(frontendMap).length > 0) {
        for (const [name, ep] of Object.entries(resolveEndpoints(frontendMap, env))) {
          linksMap.set(ep.url, { label: name, url: ep.url });
        }
        for (const [name, ep] of Object.entries(resolveEndpoints(backendMap, env))) {
          linksMap.set(ep.url, { label: `${name} (backend)`, url: ep.url });
        }
      } else {
        const ports = await getComposePortsAsync(s.path, env);
        for (const [port, svc] of ports) {
          const url = `http://localhost:${port}`;
          linksMap.set(url, { label: `${svc}:${port}`, url });
        }
      }
    } catch {
      // port info unavailable
    }
  }
  for (const l of s.links ?? []) {
    const link = { ...l, url: substituteEnvVars(l.url, env) };
    if (!linksMap.has(link.url)) linksMap.set(link.url, link);
  }
  return [...linksMap.values()];
}

export async function handleDashboard(ctx: ServeContext, res: ServerResponse): Promise<void> {
  const config = ctx.discovery.getConfig();
  const repoEnv = ctx.discovery.getWorkspaceConfig().repoEnv;
  const [globalScenarios, projectScenarios, flows] = await Promise.all([
    ctx.discovery.getGlobalScenariosAsync(),
    discoverAllProjectScenariosAsync(config),
    discoverAllFlowsAsync(config),
  ]);
  const all = [...globalScenarios, ...projectScenarios];
  const runningDirs = await runningDirsFor(all);

  // Precompute per-row link lists — running scenarios need async docker
  // lookups, and resolving them here keeps the HTML render itself pure.
  const linksByScenario = new Map<ScenarioInfo, ScenarioLink[]>();
  await Promise.all(
    all.map(async (s) => {
      const key = s.path.replace(/\/+$/, "");
      linksByScenario.set(s, await dashboardRowLinks(s, runningDirs.has(key), repoEnv));
    }),
  );

  const runningRuns = ctx.flowRuns.list().filter((r) => r.status === "running").length;
  const counts = menuCountsFrom(globalScenarios, projectScenarios, runningDirs, flows.length, runningRuns);
  const html = dashboardHtml(projectScenarios, globalScenarios, runningDirs, counts, linksByScenario);
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
}

export async function handleFlows(ctx: ServeContext, res: ServerResponse): Promise<void> {
  const config = ctx.discovery.getConfig();
  const [roots, flows, counts] = await Promise.all([
    flowRootsAsync(config),
    discoverAllFlowsAsync(config),
    menuCountsAsync(ctx),
  ]);
  const reports = listFlowReports(roots);
  const runs = ctx.flowRuns.list();

  const html = flowsListHtml(flows, reports, runs, counts);
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
}

export async function handleFlowView(ctx: ServeContext, url: URL, res: ServerResponse): Promise<void> {
  const file = url.searchParams.get("file") ?? "";
  const name = url.searchParams.get("name") ?? "";
  const config = ctx.discovery.getConfig();

  const flow = (await discoverAllFlowsAsync(config)).find((f) => f.file === file && f.name === name);
  if (!flow) {
    res.writeHead(404, { "Content-Type": "text/html" });
    res.end("<h1>Flow not found</h1>");
    return;
  }

  const parsed = loadFlowsFromFileSafe(file).find((f) => f.name === name) ?? null;
  const reports = listFlowReports([flow.root]);
  const runs = ctx.flowRuns.list().filter((r) => r.file === file && r.flowName === name);

  const html = flowViewHtml(flow, parsed, reports, runs, await menuCountsAsync(ctx));
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
}

export async function handleFlowReportView(ctx: ServeContext, url: URL, res: ServerResponse): Promise<void> {
  const file = url.searchParams.get("file") ?? "";
  const flowName = url.searchParams.get("flow") ?? "";
  const config = ctx.discovery.getConfig();

  if (!isReportPathAllowed(file, await flowRootsAsync(config))) {
    res.writeHead(403, { "Content-Type": "text/html" });
    res.end("<h1>Forbidden</h1>");
    return;
  }

  const report = loadFlowReport(file);
  if (!report) {
    res.writeHead(404, { "Content-Type": "text/html" });
    res.end("<h1>Report not found</h1>");
    return;
  }

  const html = flowReportHtml(file, report, flowName || undefined, await menuCountsAsync(ctx));
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
}

export async function handleScenarioView(ctx: ServeContext, url: URL, res: ServerResponse): Promise<void> {
  const scenarioName = decodeURIComponent(url.pathname.replace("/scenario/", ""));
  const config = ctx.discovery.getConfig();

  let instance: ScenarioInstance | undefined;
  for (const inst of ctx.registry.values()) {
    if (inst.scenarioName === scenarioName) {
      instance = inst;
      break;
    }
  }

  // Discovery + running detection run up front (all async/parallel) — needed
  // for the running-scenario switcher and for the fallback resolution below.
  const [globalScenarios, projectScenarios] = await Promise.all([
    ctx.discovery.getGlobalScenariosAsync(),
    discoverAllProjectScenariosAsync(config),
  ]);
  const all = [...globalScenarios, ...projectScenarios];
  const runningDirs = await runningDirsFor(all);

  let frontendServices: Record<string, string> = {};
  let frontend: string | string[] | undefined;
  let links: ScenarioLink[] = [];

  if (instance) {
    frontendServices = instance.endpoints ?? {};
    frontend = instance.frontend;
    links = instance.links ?? [];
  } else {
    try {
      // Multiple repos can declare the same scenario name (dev, mock, …)
      // — prefer the instance that is actually running so the view shows
      // the right axn-dev.yaml's services.
      const matches = all.filter((s) => scenarioMatches(s, scenarioName));
      const scenario =
        matches.find((s) => runningDirs.has(s.path.replace(/\/+$/, ""))) ?? matches[0];
      // Non-compose scenarios have no compose env — drivers expose their
      // resolved endpoints as env vars so axn-dev.yaml frontend-services
      // and links survive auto-port reassignment.
      const driver = scenario?.type && scenario.type !== "compose" && hasDriver(scenario.type)
        ? await driverFor(scenario)
        : null;
      const driverEnv = scenario && driver
        ? {
            ...(driver.urlEnv?.(scenario) ?? {}),
            ...devServerUrlEnv(scenario.devServers ?? []),
          }
        : {};
      const env = {
        ...process.env as Record<string, string>,
        ...ctx.discovery.getWorkspaceConfig().repoEnv,
        ...scenario?.env,
        ...driverEnv,
      };
      const frontendMap = scenario?.frontendServices ?? scenario?.proxies;
      if (frontendMap) {
        if (scenario?.path) {
          // Overlay the ports the running containers actually published — env
          // vars reassigned by --auto-port only exist on the docker side.
          const [overrides, runningPort] = await Promise.all([
            getRunningPortOverridesAsync(scenario.path, env),
            getRunningScenarioPortAsync(scenario.path),
          ]);
          Object.assign(env, overrides);
          if (runningPort !== null) {
            env.SCENARIO_PORT = String(runningPort);
          }
        }
        const endpoints = resolveEndpoints(frontendMap, env);
        frontendServices = Object.fromEntries(
          Object.entries(endpoints).map(([name, ep]) => [name, ep.url]),
        );
      }
      if (scenario && driver) {
        // Driver-exposed endpoints always available, even without
        // frontend-services; one may be marked as the default view.
        for (const { label, url, default: isDefault } of driver.endpoints?.(scenario) ?? []) {
          frontendServices[label] ??= url;
          if (isDefault) frontend ??= label;
        }
      }
      frontend = scenario?.frontend ?? frontend;
      links = (scenario?.links ?? []).map((l) => ({
        ...l,
        url: substituteEnvVars(l.url, env),
      }));
    } catch { /* ignore */ }
  }

  // The switcher lists running scenarios only — detected compose/sim
  // instances plus serve-registered ones — and renders only when more than
  // one is running. Detected scenarios need a viewable frontend (same rule
  // as the dashboard's Open button) so the dropdown never leads to an
  // empty view.
  const runningNames = new Set<string>();
  for (const s of all) {
    const hasFrontend =
      Object.keys(s.frontendServices ?? s.proxies ?? {}).length > 0 ||
      (s.type !== undefined && s.type !== "compose" && hasDriver(s.type));
    if (hasFrontend && runningDirs.has(s.path.replace(/\/+$/, ""))) {
      runningNames.add(s.variant ? `${s.variant}/${s.name}` : s.name);
    }
  }
  for (const inst of ctx.registry.values()) {
    if (inst.endpoints && Object.keys(inst.endpoints).length > 0) {
      runningNames.add(inst.scenarioName);
    }
  }

  const switchable = runningNames.size > 1
    ? [...runningNames]
        .filter((n) => n !== scenarioName)
        .sort((a, b) => a.localeCompare(b))
        .map((name) => ({ name, url: `/scenario/${encodeURIComponent(name)}` }))
    : [];

  const html = scenarioViewHtml(scenarioName, frontendServices, links, frontend, switchable);
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
}
