import { execFile, execFileSync, execSync } from "node:child_process";
import { promisify } from "node:util";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { load as yamlLoad } from "js-yaml";
import { getComposeCommand, resolveComposeCommand } from "./compose.js";

export interface PortConflict {
  /** Host port that is already in use */
  port: number;
  /** Service name from docker-compose that wants this port */
  service: string;
  /** Description of what is using the port */
  usedBy: string;
}

/**
 * Run `docker compose config` and extract all published host ports.
 * Returns a map of port → service name.
 */
function runDockerComposeConfig(
  cwd: string,
  composeArgs: string[],
  env: Record<string, string>,
): string {
  const cmd = getComposeCommand();
  return execFileSync(
    cmd.binary,
    [...cmd.prefixArgs, ...composeArgs, "config"],
    { cwd, env, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
  );
}

/** Async variant of runDockerComposeConfig — used by `axn-dev serve`. */
async function runDockerComposeConfigAsync(
  cwd: string,
  composeArgs: string[],
  env: Record<string, string>,
): Promise<string> {
  const cmd = await resolveComposeCommand();
  const { stdout } = await execFileAsync(
    cmd.binary,
    [...cmd.prefixArgs, ...composeArgs, "config"],
    { cwd, env, encoding: "utf-8" },
  );
  return stdout;
}

/**
 * Run `docker compose config` with explicit compose-args (e.g. -f <file> --env-file <file>)
 * and extract all published host ports. Returns a map of port → service name.
 * Used for cases where the compose file isn't auto-discovered from cwd (e.g. infra deploys).
 */
export function getComposePortsWithArgs(
  cwd: string,
  composeArgs: string[],
  env: Record<string, string>,
): Map<number, string> {
  let output: string;
  try {
    output = runDockerComposeConfig(cwd, composeArgs, env);
  } catch {
    process.stderr.write(
      "\x1b[33mWarning: port conflict pre-check skipped" +
      " (docker compose config failed — check compose file for errors).\x1b[0m\n" +
      "\x1b[33mContinuing without port validation." +
      " Docker may fail if ports are already in use.\x1b[0m\n\n",
    );
    return new Map();
  }
  return parseComposeConfigPorts(output);
}

function parseComposeConfigPorts(output: string): Map<number, string> {
  const ports = new Map<number, string>();
  let inServices = false;
  let currentService: string | null = null;

  for (const line of output.split("\n")) {
    // Track when we enter/leave the top-level "services:" section
    if (line === "services:") {
      inServices = true;
      currentService = null;
      continue;
    }
    if (inServices && line.match(/^\S/)) {
      // A non-indented key ends the services section
      inServices = false;
      currentService = null;
    }

    // Service name lines are at exactly 2-space indent under "services:"
    if (inServices) {
      const svcMatch = line.match(/^  (\S+):$/);
      if (svcMatch) {
        currentService = svcMatch[1];
        continue;
      }
    }

    // Published port lines look like: published: "5001" or published: 5001
    // Skip published: "0" (dynamic/unbound ports)
    const pubMatch = line.match(/^\s+published:\s+"?(\d+)"?/);
    if (pubMatch && currentService) {
      const port = parseInt(pubMatch[1], 10);
      if (port > 0) {
        ports.set(port, currentService);
      }
    }
  }

  return ports;
}

/** Async variant of getComposePortsWithArgs — same warning semantics. */
export async function getComposePortsWithArgsAsync(
  cwd: string,
  composeArgs: string[],
  env: Record<string, string>,
): Promise<Map<number, string>> {
  let output: string;
  try {
    output = await runDockerComposeConfigAsync(cwd, composeArgs, env);
  } catch {
    process.stderr.write(
      "\x1b[33mWarning: port conflict pre-check skipped" +
      " (docker compose config failed — check compose file for errors).\x1b[0m\n" +
      "\x1b[33mContinuing without port validation." +
      " Docker may fail if ports are already in use.\x1b[0m\n\n",
    );
    return new Map();
  }
  return parseComposeConfigPorts(output);
}

/**
 * Auto-discover the compose file in scenarioPath (docker-compose.yaml / compose.yaml)
 * and its adjacent .env file, then extract published host ports.
 */
export function getComposePorts(
  scenarioPath: string,
  env: Record<string, string>,
): Map<number, string> {
  const envFile = join(scenarioPath, ".env");
  const composeArgs = existsSync(envFile) ? ["--env-file", envFile] : [];
  return getComposePortsWithArgs(scenarioPath, composeArgs, env);
}

/** Async variant of getComposePorts. */
export async function getComposePortsAsync(
  scenarioPath: string,
  env: Record<string, string>,
): Promise<Map<number, string>> {
  const envFile = join(scenarioPath, ".env");
  const composeArgs = existsSync(envFile) ? ["--env-file", envFile] : [];
  return getComposePortsWithArgsAsync(scenarioPath, composeArgs, env);
}

/**
 * Extract a scenario name from a docker-compose working directory, e.g.
 * ".../scenarios/demo-full" -> "demo-full". Returns null when the path
 * does not look like a scenario directory.
 */
function extractScenarioName(dir: string | null | undefined): string | null {
  if (!dir) return null;
  const parts = dir.split(/[\\/]+/).filter(Boolean);
  const idx = parts.lastIndexOf("scenarios");
  if (idx >= 0 && idx + 1 < parts.length) {
    return parts[idx + 1];
  }
  return null;
}

/**
 * If a Docker container publishes this port, return its compose project name.
 * Returns null when a non-Docker process owns the port or it is free.
 */
export function portOwnerComposeProject(port: number): string | null {
  try {
    const dockerOut = execSync(
      `docker ps --format '{{.Ports}}\t{{.Label "com.docker.compose.project"}}'`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    for (const line of dockerOut.trim().split("\n")) {
      if (!line) continue;
      const [portsStr, project] = line.split("\t");
      if (portsStr && portsStr.includes(`:${port}->`)) {
        return project || null;
      }
    }
  } catch {
    // docker not available
  }
  return null;
}

/**
 * Check if a port is in use and return a description of what's using it.
 */
export function identifyPortUser(port: number): string | null {
  // First, check if a Docker container is using it
  try {
    const dockerOut = execSync(
      `docker ps --format '${DOCKER_PS_FULL_FORMAT}'`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const owner = portOwnerFromDockerPs(dockerOut, port);
    if (owner) return owner;
  } catch {
    // docker not available or failed, continue to lsof
  }

  // Fall back to lsof for non-Docker processes
  try {
    const lsofOut = execSync(
      `lsof -i :${port} -sTCP:LISTEN -P -n 2>/dev/null | tail -1`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const parts = lsofOut.trim().split(/\s+/);
    if (parts.length >= 2) {
      return `process ${parts[0]} (PID ${parts[1]})`;
    }
  } catch {
    // lsof failed or not available
  }

  // Last resort: just try to connect
  try {
    execSync(
      `nc -z 127.0.0.1 ${port} 2>/dev/null`,
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    return "unknown process";
  } catch {
    return null; // Port is free
  }
}

const DOCKER_PS_FULL_FORMAT =
  '{{.ID}}\t{{.Names}}\t{{.Ports}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}';

/** Describe the container publishing `port` from a `docker ps` dump, if any. */
function portOwnerFromDockerPs(dockerOut: string, port: number): string | null {
  for (const line of dockerOut.trim().split("\n")) {
    if (!line) continue;
    const [id, name, portsStr, project, projectDir] = line.split("\t");
    if (portsStr && portsStr.includes(`:${port}->`)) {
      const scenarioName = extractScenarioName(projectDir);
      let info = `Docker container ${name} [${id.slice(0, 12)}]`;
      if (scenarioName) info += `\n       scenario:        ${scenarioName}`;
      if (project) info += `\n       compose project: ${project}`;
      if (projectDir) info += `\n       project dir:     ${projectDir}`;
      return info;
    }
  }
  return null;
}

/**
 * Async variant of identifyPortUser — docker/lsof/nc all run off the event
 * loop so `axn-dev serve` stays responsive.
 */
export async function identifyPortUserAsync(port: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["ps", "--format", DOCKER_PS_FULL_FORMAT],
      { encoding: "utf-8" },
    );
    const owner = portOwnerFromDockerPs(stdout, port);
    if (owner) return owner;
  } catch {
    // docker not available or failed, continue to lsof
  }

  try {
    const { stdout } = await execFileAsync(
      "lsof",
      ["-i", `:${port}`, "-sTCP:LISTEN", "-P", "-n"],
      { encoding: "utf-8" },
    );
    const lines = stdout.trim().split("\n");
    const last = lines[lines.length - 1] ?? "";
    const parts = last.trim().split(/\s+/);
    if (parts.length >= 2) {
      return `process ${parts[0]} (PID ${parts[1]})`;
    }
  } catch {
    // lsof failed or not available
  }

  try {
    await execFileAsync("nc", ["-z", "127.0.0.1", String(port)]);
    return "unknown process";
  } catch {
    return null; // Port is free
  }
}

/**
 * Resolve a service value that may be a bare port, an env expression, or a full URL expression.
 * Returns the concrete URL and the TCP port for health checks.
 * If the resolved value has no scheme but is host:port, http:// is assumed.
 */
export function resolveEndpointUrl(
  value: string,
  env: Record<string, string>,
): { url: string; port: number } | null {
  const resolved = substituteEnvVars(value, env);

  if (!resolved) return null;

  // Bare number → localhost port.
  if (/^\d+$/.test(resolved)) {
    const port = parseInt(resolved, 10);
    return { url: `http://localhost:${port}`, port };
  }

  // Ensure scheme for URLs like api.localhost:8090.
  let urlStr = resolved;
  if (!/^https?:\/\//i.test(urlStr)) {
    urlStr = "http://" + urlStr;
  }

  try {
    const u = new URL(urlStr);
    const port = u.port
      ? parseInt(u.port, 10)
      : (u.protocol === "https:" ? 443 : 80);
    return { url: urlStr, port };
  } catch {
    return null;
  }
}

/**
 * Resolve a name → URL map (from `frontend-services` or `backend-services`) into
 * concrete endpoint URLs and ports. Values may be bare numbers, env expressions,
 * or full URL expressions such as `http://api.localhost:${API_PROXY_PORT}`.
 */
export function resolveEndpoints(
  services: Record<string, string>,
  env: Record<string, string>,
): Record<string, { url: string; port: number }> {
  const resolved: Record<string, { url: string; port: number }> = {};
  for (const [name, value] of Object.entries(services)) {
    const ep = resolveEndpointUrl(value, env);
    if (ep) resolved[name] = ep;
  }
  return resolved;
}

/**
 * Resolve a name → port-expression map (from `frontend-services`,
 * `backend-services`, or the legacy `proxies` key in axn-dev.yaml) into
 * concrete port numbers using the given environment.
 * Port expressions may be bare numbers ("8091"), shell-style variable
 * references ("${COCKPIT_PORT:-8091}"), or full URL expressions.
 */
export function resolveProxies(
  proxies: Record<string, string>,
  env: Record<string, string>,
): Record<string, number> {
  const resolved: Record<string, number> = {};
  for (const [name, value] of Object.entries(proxies)) {
    const ep = resolveEndpointUrl(value, env);
    resolved[name] = ep ? ep.port : NaN;
  }
  return resolved;
}

export interface ServiceEndpoint {
  /** Service name from docker-compose */
  service: string;
  /** Host port */
  port: number;
  /** URL to access the service */
  url: string;
}

/**
 * Get service URLs from the resolved compose config.
 */
export function getServiceEndpoints(
  scenarioPath: string,
  env: Record<string, string>,
): ServiceEndpoint[] {
  const ports = getComposePorts(scenarioPath, env);
  const endpoints: ServiceEndpoint[] = [];

  for (const [port, service] of ports) {
    endpoints.push({
      service,
      port,
      url: `http://localhost:${port}`,
    });
  }

  return endpoints;
}

export interface SinglePortInfo {
  /** Whether the scenario exposes its services on a single SCENARIO_PORT */
  isSinglePort: boolean;
  /** Default port configured in compose.yaml / axn-dev.yaml, if any */
  defaultPort: number | null;
  /** Resolved port from explicit env or default */
  scenarioPort: number | null;
}

function hasScenarioPortExpression(scenarioPath: string): boolean {
  const composeFile = findComposeFile(scenarioPath);
  if (!composeFile) return false;

  const raw = readFileSync(composeFile, "utf-8");
  return raw.includes("SCENARIO_PORT");
}

/**
 * Inspect a scenario to decide whether it is a single-port Caddy scenario.
 * A scenario is single-port when its compose.yaml exposes services through a
 * single `${SCENARIO_PORT}` variable. The default is extracted from the
 * first `${SCENARIO_PORT:-<port>}` fallback found in compose.yaml or from
 * an explicit SCENARIO_PORT value in the scenario env.
 */
export function getSinglePortInfo(
  scenarioPath: string,
  env: Record<string, string> = {},
): SinglePortInfo {
  if (!hasScenarioPortExpression(scenarioPath)) {
    return { isSinglePort: false, defaultPort: null, scenarioPort: null };
  }

  const composeFile = findComposeFile(scenarioPath)!;
  const raw = readFileSync(composeFile, "utf-8");
  const match = raw.match(/\$\{SCENARIO_PORT:-(\d+)\}/);
  const defaultPort = match ? parseInt(match[1], 10) : null;

  let scenarioPort: number | null = null;
  if (env.SCENARIO_PORT) {
    const parsed = parseInt(env.SCENARIO_PORT, 10);
    if (!isNaN(parsed)) scenarioPort = parsed;
  } else if (defaultPort !== null) {
    scenarioPort = defaultPort;
  }

  return { isSinglePort: true, defaultPort, scenarioPort };
}

/**
 * Read the SCENARIO_PORT env var from a running container for the given scenario path.
 * Useful when stopping/patching a single-port scenario that was started without an
 * explicit --port.
 */
export function getRunningScenarioPort(scenarioPath: string): number | null {
  try {
    const workingDir = scenarioPath.replace(/\/+$/, "");
    const ids = execFileSync(
      "docker",
      [
        "ps",
        "--filter",
        `label=com.docker.compose.project.working_dir=${workingDir}`,
        "--format",
        "{{.ID}}",
      ],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    )
      .trim()
      .split("\n")
      .filter(Boolean);

    if (ids.length === 0) return null;

    for (const id of ids) {
      const envOut = execFileSync(
        "docker",
        ["inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", id],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );

      const port = scenarioPortFromEnvDump(envOut);
      if (port !== null) return port;
    }
  } catch {
    // ignore — scenario not running or docker unavailable
  }
  return null;
}

const execFileAsync = promisify(execFile);

/** Extract SCENARIO_PORT from a `docker inspect` env dump. */
function scenarioPortFromEnvDump(envOut: string): number | null {
  for (const line of envOut.split("\n")) {
    const [k, v] = line.split("=");
    if (k === "SCENARIO_PORT" && v) {
      const parsed = parseInt(v, 10);
      if (!isNaN(parsed)) return parsed;
    }
  }
  return null;
}

/**
 * Async variant of getRunningScenarioPort — same logic, but the docker calls
 * run off the event loop so `axn-dev serve` stays responsive.
 */
export async function getRunningScenarioPortAsync(scenarioPath: string): Promise<number | null> {
  try {
    const workingDir = scenarioPath.replace(/\/+$/, "");
    const { stdout } = await execFileAsync(
      "docker",
      [
        "ps",
        "--filter",
        `label=com.docker.compose.project.working_dir=${workingDir}`,
        "--format",
        "{{.ID}}",
      ],
      { encoding: "utf-8" },
    );

    const ids = stdout.trim().split("\n").filter(Boolean);
    if (ids.length === 0) return null;

    const envDumps = await Promise.all(
      ids.map((id) =>
        execFileAsync(
          "docker",
          ["inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", id],
          { encoding: "utf-8" },
        ).then((r) => r.stdout).catch(() => ""),
      ),
    );

    for (const envOut of envDumps) {
      const port = scenarioPortFromEnvDump(envOut);
      if (port !== null) return port;
    }
  } catch {
    // ignore — scenario not running or docker unavailable
  }
  return null;
}

/**
 * Parse a `docker ps` {{.Ports}} cell like
 * "0.0.0.0:10001->80/tcp, [::]:10001->80/tcp" into host→target bindings.
 */
export function parseDockerPortBindings(portsStr: string): { host: number; target: number }[] {
  const bindings: { host: number; target: number }[] = [];
  const seen = new Set<string>();
  for (const m of portsStr.matchAll(/(\d+)->(\d+)\/(tcp|udp)/gi)) {
    const key = `${m[1]}->${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bindings.push({ host: parseInt(m[1], 10), target: parseInt(m[2], 10) });
  }
  return bindings;
}

/**
 * Map compose port entries to the host ports their services actually bound,
 * returning env-var overrides (e.g. APP_TOOLS_PORT=10001).
 */
export function buildPortOverrides(
  entries: PortEntry[],
  published: Map<string, { host: number; target: number }[]>,
): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.varName) continue;
    const bindings = published.get(entry.service);
    if (!bindings || bindings.length === 0) continue;
    const target = parseInt(entry.target, 10);
    const match =
      bindings.find((b) => b.target === target) ??
      (bindings.length === 1 ? bindings[0] : undefined);
    if (match) overrides[entry.varName] = String(match.host);
  }
  return overrides;
}

/**
 * Discover the host ports a running compose project actually published and
 * return env overrides mapping each port variable to its real binding.
 * This surfaces --auto-port reassignments (e.g. APP_TOOLS_PORT=10001)
 * that the declared scenario env cannot see, because the override only
 * exists on the docker side — unlike SCENARIO_PORT it is not injected into
 * the container environment.
 */
const DOCKER_PS_SERVICE_PORTS_FORMAT = '{{.Label "com.docker.compose.service"}}\t{{.Ports}}';

/** Parse `docker ps` rows (service<TAB>ports) into service → bindings. */
function publishedPortsByService(out: string): Map<string, { host: number; target: number }[]> {
  const published = new Map<string, { host: number; target: number }[]>();
  for (const line of out.trim().split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const service = line.slice(0, tab);
    const bindings = parseDockerPortBindings(line.slice(tab + 1));
    if (!service || bindings.length === 0) continue;
    const existing = published.get(service) ?? [];
    existing.push(...bindings);
    published.set(service, existing);
  }
  return published;
}

export function getRunningPortOverrides(
  scenarioPath: string,
  env: Record<string, string> = {},
): Record<string, string> {
  const workingDir = scenarioPath.replace(/\/+$/, "");
  let out: string;
  try {
    out = execFileSync(
      "docker",
      [
        "ps",
        "--filter",
        `label=com.docker.compose.project.working_dir=${workingDir}`,
        "--format",
        DOCKER_PS_SERVICE_PORTS_FORMAT,
      ],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch {
    return {};
  }

  const published = publishedPortsByService(out);
  if (published.size === 0) return {};

  return buildPortOverrides(parseScenarioPortEntries(workingDir, env), published);
}

/**
 * Async variant of getRunningPortOverrides — same logic, but `docker ps`
 * runs off the event loop so `axn-dev serve` stays responsive.
 */
export async function getRunningPortOverridesAsync(
  scenarioPath: string,
  env: Record<string, string> = {},
): Promise<Record<string, string>> {
  const workingDir = scenarioPath.replace(/\/+$/, "");
  let out: string;
  try {
    const res = await execFileAsync(
      "docker",
      [
        "ps",
        "--filter",
        `label=com.docker.compose.project.working_dir=${workingDir}`,
        "--format",
        DOCKER_PS_SERVICE_PORTS_FORMAT,
      ],
      { encoding: "utf-8" },
    );
    out = res.stdout;
  } catch {
    return {};
  }

  const published = publishedPortsByService(out);
  if (published.size === 0) return {};

  return buildPortOverrides(parseScenarioPortEntries(workingDir, env), published);
}

/**
 * Returns the set of compose project working_dirs that currently have running containers.
 * Single docker ps call — use this to batch-check multiple scenarios.
 */
export function getRunningComposeProjectDirs(): Set<string> {
  try {
    const out = execSync(
      `docker ps --format '{{.Label "com.docker.compose.project.working_dir"}}'`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return parseComposeWorkingDirs(out);
  } catch {
    return new Set();
  }
}

function parseComposeWorkingDirs(out: string): Set<string> {
  const dirs = new Set<string>();
  for (const line of out.trim().split("\n")) {
    const normalised = line.replace(/\/+$/, "");
    if (normalised) dirs.add(normalised);
  }
  return dirs;
}

/** Async variant of getRunningComposeProjectDirs — used by `axn-dev serve`. */
export async function getRunningComposeProjectDirsAsync(): Promise<Set<string>> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["ps", "--format", '{{.Label "com.docker.compose.project.working_dir"}}'],
      { encoding: "utf-8" },
    );
    return parseComposeWorkingDirs(stdout);
  } catch {
    return new Set();
  }
}

/**
 * Compose project names of running containers for the given scenario path.
 * The project name bakes in the branch at `up` time, so it cannot always be
 * recomputed (the repo may have moved to another branch since). Recovering it
 * from the container labels is the reliable way to target `down`/lifecycle
 * commands at the actually-running project.
 */
export function getRunningComposeProjects(scenarioPath: string): string[] {
  try {
    const workingDir = scenarioPath.replace(/\/+$/, "");
    const out = execFileSync(
      "docker",
      [
        "ps",
        "--filter",
        `label=com.docker.compose.project.working_dir=${workingDir}`,
        "--format",
        '{{.Label "com.docker.compose.project"}}',
      ],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return [...new Set(out.trim().split("\n").map((l) => l.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

/** Async variant of getRunningComposeProjects — used by `axn-dev serve`. */
export async function getRunningComposeProjectsAsync(scenarioPath: string): Promise<string[]> {
  try {
    const workingDir = scenarioPath.replace(/\/+$/, "");
    const { stdout } = await execFileAsync(
      "docker",
      [
        "ps",
        "--filter",
        `label=com.docker.compose.project.working_dir=${workingDir}`,
        "--format",
        '{{.Label "com.docker.compose.project"}}',
      ],
      { encoding: "utf-8" },
    );
    return [...new Set(stdout.trim().split("\n").map((l) => l.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

/**
 * Check if a compose project is already running from the given scenario path.
 * Looks for containers whose compose project working_dir matches.
 * If a projectName is supplied, also requires a matching com.docker.compose.project label.
 */
export function isScenarioRunning(scenarioPath: string, projectName?: string): boolean {
  try {
    const workingDir = scenarioPath.replace(/\/+$/, "");
    const args = [
      "ps",
      "--filter",
      `label=com.docker.compose.project.working_dir=${workingDir}`,
      "--format",
      "{{.Names}}",
    ];
    if (projectName) {
      args.push("--filter", `label=com.docker.compose.project=${projectName}`);
    }
    const out = execFileSync(
      "docker",
      args,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/** Async variant of isScenarioRunning — used by `axn-dev serve`. */
export async function isScenarioRunningAsync(
  scenarioPath: string,
  projectName?: string,
): Promise<boolean> {
  try {
    const workingDir = scenarioPath.replace(/\/+$/, "");
    const args = [
      "ps",
      "--filter",
      `label=com.docker.compose.project.working_dir=${workingDir}`,
      "--format",
      "{{.Names}}",
    ];
    if (projectName) {
      args.push("--filter", `label=com.docker.compose.project=${projectName}`);
    }
    const { stdout } = await execFileAsync("docker", args, { encoding: "utf-8" });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export interface PortEntry {
  service: string;
  /** Name of the env variable that controls the published port, if any */
  varName: string | null;
  /** Default value if the env variable is not set */
  defaultValue: number | null;
  /** Whether the published port is hardcoded (no env variable) */
  swappable: boolean;
  /** The host port expression as written in the compose file */
  hostExpr: string;
  /** The container-side (target) port as written in the compose file */
  target: string;
}

function parsePortExpression(hostExpr: string): { varName: string | null; defaultValue: number | null } {
  const trimmed = hostExpr.trim().replace(/^["']|["']$/g, "");

  const plainMatch = trimmed.match(/^\d+$/);
  if (plainMatch) {
    return { varName: null, defaultValue: parseInt(plainMatch[0], 10) };
  }

  const varMatch = trimmed.match(/^\$\{([^}]+)\}$/);
  if (varMatch) {
    const inner = varMatch[1];
    const sepIdx = inner.indexOf(":-");
    if (sepIdx !== -1) {
      const varName = inner.slice(0, sepIdx);
      const defaultValue = parseInt(inner.slice(sepIdx + 2), 10);
      return { varName, defaultValue: isNaN(defaultValue) ? null : defaultValue };
    }
    return { varName: inner, defaultValue: null };
  }

  return { varName: null, defaultValue: null };
}

function resolvePortExpression(
  entry: PortEntry,
  env: Record<string, string>,
): number | null {
  if (entry.varName && env[entry.varName] !== undefined) {
    const parsed = parseInt(env[entry.varName], 10);
    if (!isNaN(parsed)) return parsed;
  }
  return entry.defaultValue;
}

function splitPortString(portStr: string): { hostExpr: string; target: string } | null {
  // Strip optional protocol suffix like /tcp
  const protoMatch = portStr.match(/^(.*)\/(tcp|udp)$/i);
  const clean = protoMatch ? protoMatch[1] : portStr;

  // Find the last colon that is not inside ${...} or "..." or '...'.
  let braceDepth = 0;
  let inSingle = false;
  let inDouble = false;
  let lastColon = -1;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === "{" && !inSingle && !inDouble) {
      if (clean[i - 1] === "$") braceDepth++;
    } else if (ch === "}" && !inSingle && !inDouble) {
      braceDepth = Math.max(0, braceDepth - 1);
    } else if (ch === ":" && braceDepth === 0 && !inSingle && !inDouble) {
      lastColon = i;
    }
  }

  if (lastColon === -1) {
    // No host:target split; treat whole string as the single port
    return { hostExpr: clean, target: clean };
  }

  let hostExpr = clean.slice(0, lastColon).trim();
  const target = clean.slice(lastColon + 1).trim();

  // Strip leading IP address if present (e.g. 127.0.0.1:${PORT:-8000} -> ${PORT:-8000})
  const ipMatch = hostExpr.match(/^(\d{1,3}\.){3}\d{1,3}:(.*)$/);
  if (ipMatch) {
    hostExpr = ipMatch[2].trim();
  }

  return { hostExpr, target };
}

function parseComposePortEntry(raw: unknown, service: string): PortEntry | null {
  let hostExpr = "";
  let target = "";

  if (typeof raw === "string") {
    const split = splitPortString(raw);
    if (!split) return null;
    hostExpr = split.hostExpr;
    target = split.target;
  } else if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (obj.published !== undefined) {
      hostExpr = String(obj.published);
    } else if (obj.target !== undefined) {
      hostExpr = String(obj.target);
    } else {
      return null;
    }
    if (obj.target !== undefined) target = String(obj.target);
  } else {
    return null;
  }

  hostExpr = hostExpr.replace(/^["']|["']$/g, "");

  const { varName, defaultValue } = parsePortExpression(hostExpr);

  return {
    service,
    varName,
    defaultValue,
    swappable: varName !== null,
    hostExpr,
    target,
  };
}

export async function isPortFree(port: number): Promise<boolean> {
  if ((await identifyPortUserAsync(port)) !== null) {
    return false;
  }
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      server.close();
      resolve(err.code !== "EADDRINUSE" && err.code !== "EACCES");
    });
    server.once("listening", () => {
      server.close();
      resolve(true);
    });
    server.listen(port, "127.0.0.1");
  });
}

export async function findFreePort(
  min: number,
  max: number,
  exclude: Set<number>,
): Promise<number> {
  for (let port = min; port <= max; port++) {
    if (exclude.has(port)) continue;
    if (await isPortFree(port)) {
      return port;
    }
  }
  throw new Error(`No free port found in auto-port range ${min}-${max}`);
}

export function parseAutoPortRange(rangeStr: string): { min: number; max: number } {
  const match = rangeStr.trim().match(/^(\d+)\s*-\s*(\d+)$/);
  if (!match) {
    throw new Error(`Invalid auto-port-range: "${rangeStr}". Expected format: min-max`);
  }
  const min = parseInt(match[1], 10);
  const max = parseInt(match[2], 10);
  if (isNaN(min) || isNaN(max) || min >= max || min < 1024 || max > 65535) {
    throw new Error(`Invalid auto-port-range: "${rangeStr}". Expected 1024-65535 and min < max`);
  }
  return { min, max };
}

function findComposeFile(scenarioPath: string): string | null {
  const candidates = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
  for (const name of candidates) {
    const path = join(scenarioPath, name);
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * Substitute ${VAR} / ${VAR:-default} placeholders in an include path using the
 * compose environment (repo roots, scenario env, explicit overrides).
 */
function resolveIncludePath(rawPath: string, env: Record<string, string>): string {
  return substituteEnvVars(rawPath, env);
}

/**
 * Substitute ${VAR} / ${VAR:-default} placeholders in a string using the
 * given environment (missing vars without a default are left verbatim).
 */
export function substituteEnvVars(value: string, env: Record<string, string>): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, inner) => {
    const sepIdx = inner.indexOf(":-");
    if (sepIdx !== -1) {
      return env[inner.slice(0, sepIdx)] ?? inner.slice(sepIdx + 2);
    }
    return env[inner] ?? match;
  });
}

/**
 * Collect the target files of a compose `include:` section. Entries may be
 * plain strings or objects with a `path` key (string or list of strings).
 */
function includeTargets(include: unknown): string[] {
  const items = Array.isArray(include) ? include : [include];
  const targets: string[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      targets.push(item);
    } else if (item && typeof item === "object") {
      const path = (item as Record<string, unknown>).path;
      if (typeof path === "string") targets.push(path);
      else if (Array.isArray(path)) {
        for (const p of path) {
          if (typeof p === "string") targets.push(p);
        }
      }
    }
  }
  return targets;
}

function parseComposeFilePortEntries(
  composeFile: string,
  env: Record<string, string>,
  visited: Set<string>,
): PortEntry[] {
  const canonical = resolve(composeFile);
  if (visited.has(canonical)) return [];
  visited.add(canonical);

  const raw = readFileSync(composeFile, "utf-8");
  const doc = yamlLoad(raw) as Record<string, unknown> | null;
  if (!doc) return [];

  const entries: PortEntry[] = [];
  const services = doc.services as Record<string, unknown> | undefined;
  if (services) {
    for (const [serviceName, serviceDef] of Object.entries(services)) {
      const svc = serviceDef as Record<string, unknown>;
      const ports = svc.ports;
      if (!Array.isArray(ports)) continue;
      for (const portEntry of ports) {
        const parsed = parseComposePortEntry(portEntry, serviceName);
        if (parsed) entries.push(parsed);
      }
    }
  }

  // Follow compose `include:` so ports declared in included files are seen too.
  for (const target of includeTargets(doc.include)) {
    const resolved = resolveIncludePath(target, env);
    const includePath = isAbsolute(resolved)
      ? resolved
      : resolve(dirname(composeFile), resolved);
    if (existsSync(includePath)) {
      entries.push(...parseComposeFilePortEntries(includePath, env, visited));
    }
  }

  return entries;
}

function parseScenarioPortEntries(
  scenarioPath: string,
  env: Record<string, string> = {},
): PortEntry[] {
  const composeFile = findComposeFile(scenarioPath);
  if (!composeFile) return [];
  return parseComposeFilePortEntries(composeFile, env, new Set());
}

/**
 * Resolve port conflicts by overriding env variables that control published host ports.
 * Returns env vars to inject into docker-compose.
 *
 * stickyEnv carries the ports a previously running instance of the same
 * scenario actually bound (see getRunningPortOverrides). A sticky port beats
 * the declared default so auto-port assignments survive restarts, but an
 * explicit value already present in env always wins.
 */
export async function resolveAutoPorts(
  scenarioPath: string,
  env: Record<string, string>,
  autoPort: boolean,
  autoPortRange: string | null,
  autoPortFlag: boolean,
  lockedEnv?: Set<string>,
  stickyEnv?: Record<string, string>,
): Promise<Record<string, string>> {
  const enabled = autoPort || autoPortFlag;
  if (!enabled) return {};

  if (!autoPortRange) {
    throw new Error("auto-port is enabled but no auto-port-range is configured in ~/.axn-dev/config.yaml");
  }

  const { min, max } = parseAutoPortRange(autoPortRange);
  const entries = parseScenarioPortEntries(scenarioPath, env);
  const overrides: Record<string, string> = {};
  const assigned = new Set<number>();

  // Resolve all intended ports first
  const resolvedEntries = entries.map((entry) => ({
    entry,
    resolved: resolvePortExpression(entry, env),
  }));

  for (const { entry, resolved } of resolvedEntries) {
    if (resolved === null) {
      if (entry.swappable) {
        throw new Error(
          `Service "${entry.service}" has a published port with no default value and no env variable set: ${entry.hostExpr}`
        );
      }
      throw new Error(
        `Service "${entry.service}" has a published port that cannot be resolved: ${entry.hostExpr}`
      );
    }

    if (resolved <= 0) {
      continue;
    }

    if (entry.swappable) {
      const current = entry.varName ? env[entry.varName] : undefined;
      const isDefault =
        current === undefined ||
        (entry.defaultValue !== null && current === String(entry.defaultValue));
      const sticky = isDefault && entry.varName ? stickyEnv?.[entry.varName] : undefined;
      const stickyPort = sticky !== undefined ? parseInt(sticky, 10) : NaN;
      const target = !isDefault
        ? parseInt(current, 10)
        : !isNaN(stickyPort)
          ? stickyPort
          : resolved;

      if (!isNaN(target) && !assigned.has(target) && (await isPortFree(target))) {
        assigned.add(target);
        if (!isDefault || target !== resolved) {
          // explicit or sticky value — must be carried into the compose env
          overrides[entry.varName!] = String(target);
          if (isDefault && target === stickyPort) {
            console.log(`\x1b[33mauto-port: reusing ${entry.service} ${entry.varName}=${target}\x1b[0m`);
          }
        }
        continue;
      }

      // A locked env var (e.g. SCENARIO_PORT set by --port) must not be auto-reassigned.
      if (lockedEnv?.has(entry.varName!)) {
        throw new Error(
          `Port ${target} (explicitly requested via ${entry.varName}) is already in use. ` +
          "Use a different --port or free the port first."
        );
      }

      // Conflict or duplicate; pick a new port
      const freePort = await findFreePort(min, max, assigned);
      assigned.add(freePort);
      overrides[entry.varName!] = String(freePort);
      console.log(`\x1b[33mauto-port: ${entry.service} ${entry.varName}=${freePort} (was ${target})\x1b[0m`);
    } else {
      // Hardcoded port
      if (!assigned.has(resolved) && (await isPortFree(resolved))) {
        assigned.add(resolved);
        continue;
      }
      throw new Error(
        `Port ${resolved} (hardcoded for service "${entry.service}") is already in use. ` +
        `Change compose.yaml to use an env variable like \${PORT_VAR:-${resolved}} to enable --auto-port.`
      );
    }
  }

  return overrides;
}

/**
 * Check all published ports from a docker-compose scenario for conflicts.
 * Returns an array of conflicts (empty = all clear).
 */
export function checkPortConflicts(
  scenarioPath: string,
  env: Record<string, string>,
): PortConflict[] {
  const composePorts = getComposePorts(scenarioPath, env);
  const conflicts: PortConflict[] = [];

  for (const [port, service] of composePorts) {
    const usedBy = identifyPortUser(port);
    if (usedBy) {
      conflicts.push({ port, service, usedBy });
    }
  }

  return conflicts;
}

/**
 * Async variant of checkPortConflicts — port checks run in parallel and off
 * the event loop. Preserves compose-port ordering of the result.
 */
export async function checkPortConflictsAsync(
  scenarioPath: string,
  env: Record<string, string>,
): Promise<PortConflict[]> {
  const composePorts = await getComposePortsAsync(scenarioPath, env);
  const results = await Promise.all(
    [...composePorts].map(async ([port, service]) => ({
      port,
      service,
      usedBy: await identifyPortUserAsync(port),
    })),
  );
  return results
    .filter((r): r is { port: number; service: string; usedBy: string } => r.usedBy !== null)
    .map(({ port, service, usedBy }) => ({ port, service, usedBy }));
}
