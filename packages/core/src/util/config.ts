import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { load as loadYaml } from "js-yaml";

/**
 * Optional metadata file (axn-dev.yaml) that can live alongside
 * a docker-compose.yaml in any scenario folder.
 */
export interface ScenarioConfig {
  /** Explicit scenario type override — normally inferred from driver
   * markers (compose.yaml, scenario.sh, plugin-declared markers). */
  type?: string;
  /** Human-readable description shown in `axn-dev list` */
  description?: string;
  /** Default environment variables passed to docker-compose */
  env?: Record<string, string>;
  /**
   * UI-visible services shown as tabs in `axn-dev serve`.
   * Keys are friendly names; values are port expressions.
   * If the underlying compose service is named "caddy" or "nginx" the
   * friendly name from this map is used instead of the service name.
   */
  frontendServices?: Record<string, string>;
  /**
   * Backend-only services (APIs, databases, etc.) that are NOT shown as
   * tabs in `axn-dev serve` but are listed on the scenario card for
   * reference. Keys are friendly names; values are port expressions.
   */
  backendServices?: Record<string, string>;
  /** @deprecated Use frontendServices / backendServices instead. */
  proxies?: Record<string, string>;
  /** Name(s) of the frontend service(s) in the scenario */
  frontend?: string | string[];
  /**
   * Optional list of interesting links shown as a dropdown next to the
   * matching service (matched by port in the URL) in `axn-dev serve`'s
   * dashboard cards and scenario-view tabs.
   */
  links?: ScenarioLink[];
  /**
   * Optional tags for grouping/filtering in `axn-dev serve`.
   * Supports plain tags and slash-separated folder paths such as
   * "mobile" or "mobile/e2e".
   */
  tags?: string[];
  /**
   * Auxiliary dev servers the scenario needs while running — e.g. a vite
   * dev server in another repo. Started on `axn-dev start`, killed on
   * `stop` (only processes we spawned). Each server's URL is exposed to
   * frontend-services/links as ${<LABEL>_URL} / ${<LABEL>_PORT}.
   */
  devServers?: DevServerSpec[];
}

export interface DevServerSpec {
  /** Display label; also the env prefix: label "dashboard" → ${DASHBOARD_URL}. */
  label: string;
  /** Repo name from the axn-dev repo map; defaults to the scenario's repo. */
  repo?: string;
  /** Shell command run from the repo root (e.g. "pnpm nx serve sim"). */
  command: string;
  /** Port the server binds. A listener already answering is reused, not
   * replaced; a foreign occupant makes the server get skipped. Omit for
   * daemons that bind no port (pidfile liveness still prevents
   * double-spawns). */
  port?: number;
  /** How the port is probed for reuse/readiness: "http" (default — a
   * GET / must answer), "tcp" (a bare connect suffices — for non-HTTP
   * daemons), or "none" (no probing; the port is only informational). */
  probe?: "http" | "tcp" | "none";
  /** Extra env for the child process as "KEY=value" entries; ${VAR}
   * placeholders resolve against the scenario's env (CONTROL_URL, …). */
  env?: string[];
}

export interface ScenarioLink {
  label: string;
  url: string;
}

/**
 * Parse a YAML document into a plain object. Non-map documents (scalars,
 * arrays, empty files) return {} — axn-dev config files are always maps.
 * Throws on malformed YAML; callers wrapping this for a specific file
 * should add the path to the error.
 */
export function parseYaml(content: string): Record<string, unknown> {
  const parsed = loadYaml(content);
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/** Coerce a YAML map's values to strings — env maps and port expressions
 * keep the Record<string,string> contract even for bare scalars like
 * `PORT: 8099` (YAML number) or `FLAG: true` (boolean). */
function toStringMap(v: unknown): Record<string, string> | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, String(val)]),
  );
}

/**
 * Load axn-dev.yaml from a scenario folder, if it exists.
 */
export function loadScenarioConfig(scenarioPath: string): ScenarioConfig {
  const configPath = join(scenarioPath, "axn-dev.yaml");

  if (!existsSync(configPath)) {
    return {};
  }

  const raw = readFileSync(configPath, "utf-8");
  let parsed: Record<string, unknown>;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new Error(`Invalid YAML in ${configPath}: ${e instanceof Error ? e.message : e}`);
  }

  let frontend: string | string[] | undefined;
  if (typeof parsed.frontend === "string") {
    frontend = parsed.frontend;
  } else if (Array.isArray(parsed.frontend)) {
    frontend = parsed.frontend.map(String);
  }

  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.map((t: unknown) => String(t)).filter(Boolean)
    : undefined;

  return {
    type: typeof parsed.type === "string" ? parsed.type : undefined,
    description: typeof parsed.description === "string" ? parsed.description : undefined,
    env: toStringMap(parsed.env),
    frontendServices: toStringMap(parsed["frontend-services"]),
    backendServices: toStringMap(parsed["backend-services"]),
    frontend,
    proxies: toStringMap(parsed.proxies),
    links: parseLinks(parsed.links),
    tags,
    devServers: parseDevServers(parsed["dev-servers"]),
  };
}

function parseDevServers(value: unknown): DevServerSpec[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const servers = (value as Array<Record<string, unknown>>)
    .filter((entry) => typeof entry?.label === "string" && typeof entry?.command === "string")
    .map((entry) => ({
      label: String(entry.label),
      repo: typeof entry.repo === "string" ? entry.repo : undefined,
      command: String(entry.command),
      port: entry.port !== undefined && !isNaN(Number(entry.port)) ? Number(entry.port) : undefined,
      probe: entry.probe === "tcp" ? "tcp" as const : entry.probe === "none" ? "none" as const : undefined,
      env: Array.isArray(entry.env) ? entry.env.map(String) : undefined,
    }));

  return servers.length > 0 ? servers : undefined;
}

function parseLinks(value: unknown): ScenarioLink[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const links = (value as Array<Record<string, string>>)
    .filter((entry) => typeof entry?.label === "string" && typeof entry?.url === "string")
    .map((entry) => ({ label: entry.label, url: entry.url }));

  return links.length > 0 ? links : undefined;
}

// --- Central axn-dev config (.axn-dev/config.yaml) ---

/**
 * Central CLI configuration.
 *
 * Resolution order (first found wins, values are merged):
 *   1. <git-repo-root>/.axn-dev/config.yaml   (project-local)
 *   2. ~/.axn-dev/config.yaml                  (global / user-level)
 *
 * Example:
 *   integration:
 *     - /Users/me/repos/demo-integration
 *   infra: /Users/me/repos/infra                 # plugin-owned section
 *   repos:
 *     my-server: {path: /Users/me/repos/my-server, env: APP_SERVER}
 *     my-tool: /Users/me/repos/my-tool           # plain form → MY_TOOL_ROOT
 */
export interface AxnDevConfig {
  /** Ordered list of integration repo paths (searched in order for global scenarios) */
  integration: string[];
  /** Map of repo name → absolute path (used for docker-compose env vars) */
  repos: Record<string, string>;
  /**
   * Map of repo name → env-var stem, from `repos:` entries declared in object
   * form (`name: {path: ..., env: FOO_SERVER}` → `FOO_SERVER_ROOT`). Names
   * without an alias use the naive `NAME_ROOT` convention.
   */
  repoAliases: Record<string, string>;
  /** Whether --auto-port is enabled by default for axn-dev start */
  autoPort: boolean;
  /** Port range to use for auto-port, e.g. "10000-10999" */
  autoPortRange: string | null;
  /** Default parent directory for new git worktrees */
  worktrees?: string;
  /**
   * Top-level config.yaml keys not owned by core. Each command package
   * owns and interprets its own section (e.g. `infra` for an infra plugin, `adapters` for
   * a flow plugin, `gitlab-group` for axn-dev setup).
   * Local config merges over global per section.
   */
  sections: Record<string, unknown>;
}

/** Top-level config.yaml keys owned by core — everything else is a section. */
const CORE_CONFIG_KEYS = new Set([
  "integration",
  "repos",
  "auto-port",
  "auto-port-range",
  "worktrees",
]);

/**
 * Read a plugin-owned config section, typed by the owning package.
 * Returns undefined when the section is absent.
 */
export function configSection<T>(config: AxnDevConfig, name: string): T | undefined {
  const value = config.sections[name];
  return value === undefined ? undefined : (value as T);
}

/**
 * Directory names scanned inside each repo/scenario root for flows and
 * scenarios — the `paths:` config section:
 *
 *   paths:
 *     flows: qa/flows | [qa/flows, e2e/flows]
 *     scenarios: qa/scenarios
 *
 * Precedence: $AXN_FLOW_DIRS / $AXN_SCENARIO_DIRS (comma-separated) >
 * repo .axn-dev/config.yaml > ~/.axn-dev/config.yaml > default
 * ("flows" / "scenarios"). Entries may be paths relative to a scanned
 * root (including subpaths) or absolute — absolute entries are scanned
 * as standalone directories.
 */
function splitDirList(v: unknown): string[] | null {
  if (v === undefined || v === null) return null;
  const items = (Array.isArray(v) ? v : String(v).split(","))
    .map((s) => String(s).trim())
    .filter(Boolean);
  return items.length ? items : null;
}

function cfgDirNames(
  config: { sections?: Record<string, unknown> } | null | undefined,
  key: "flows" | "scenarios",
): string[] | null {
  const sect = config?.sections?.["paths"];
  if (!sect || typeof sect !== "object" || Array.isArray(sect)) return null;
  return splitDirList((sect as Record<string, unknown>)[key]);
}

/** Configured flow directory names (see {@link cfgDirNames} docs). */
export function flowDirNames(
  config?: { sections?: Record<string, unknown> } | null,
): string[] {
  return splitDirList(process.env.AXN_FLOW_DIRS) ?? cfgDirNames(config, "flows") ?? ["flows"];
}

/** Configured scenario directory names (see {@link cfgDirNames} docs). */
export function scenarioDirNames(
  config?: { sections?: Record<string, unknown> } | null,
): string[] {
  return splitDirList(process.env.AXN_SCENARIO_DIRS) ?? cfgDirNames(config, "scenarios") ?? ["scenarios"];
}

/**
 * Scalar sections whose value resolves to an existing directory are
 * treated as repo declarations: a command package owning such a section
 * (e.g. `infra:` owned by a plugin) contributes basename(path) to the
 * workspace repo set. Map/list sections are never repos.
 */
export function sectionRepos(config: { sections?: Record<string, unknown> }): Record<string, string> {
  const repos: Record<string, string> = {};
  for (const value of Object.values(config.sections ?? {})) {
    if (typeof value !== "string") continue;
    const p = resolve(value);
    if (existsSync(p)) repos[basename(p)] = p;
  }
  return repos;
}

/** Merge two section maps: plain objects merge shallowly (local wins per
 * key), scalars/lists are taken from local when present. */
function mergeSections(
  global?: Record<string, unknown>,
  local?: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(global ?? {}) };
  const isMap = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  for (const [key, value] of Object.entries(local ?? {})) {
    const existing = out[key];
    out[key] = isMap(existing) && isMap(value) ? { ...existing, ...value } : value;
  }
  return out;
}

const AXN_DEV_CONFIG_DIR = ".axn-dev";
const AXN_DEV_CONFIG_FILE = "config.yaml";

/**
 * Find the git root by walking up from startDir.
 */
function findGitRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  while (dir !== "/") {
    if (existsSync(join(dir, ".git"))) return dir;
    dir = resolve(dir, "..");
  }
  return null;
}

/**
 * Load and merge axn-dev config from local (repo) and global (~) sources.
 * Local values take precedence; lists and maps are merged (local first).
 */
export function loadAxnDevConfig(cwd: string = process.cwd()): AxnDevConfig {
  const globalConfigPath = join(homedir(), AXN_DEV_CONFIG_DIR, AXN_DEV_CONFIG_FILE);
  const gitRoot = findGitRoot(cwd);
  const localConfigPath = gitRoot
    ? join(gitRoot, AXN_DEV_CONFIG_DIR, AXN_DEV_CONFIG_FILE)
    : null;

  const globalCfg = loadAxnDevConfigFile(globalConfigPath);
  const localCfg = localConfigPath ? loadAxnDevConfigFile(localConfigPath) : null;

  // Merge: local overrides global
  const integration = [
    ...(localCfg?.integration ?? []),
    ...(globalCfg?.integration ?? []),
  ];
  // Deduplicate while preserving order
  const seen = new Set<string>();
  const uniqueIntegration = integration.filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });

  const repos: Record<string, string> = {
    ...(globalCfg?.repos ?? {}),
    ...(localCfg?.repos ?? {}),  // local wins
  };

  const repoAliases: Record<string, string> = {
    ...(globalCfg?.repoAliases ?? {}),
    ...(localCfg?.repoAliases ?? {}),
  };

  const autoPort = Boolean(
    localCfg?.autoPort ?? globalCfg?.autoPort ?? false
  );
  const autoPortRange = localCfg?.autoPortRange ?? globalCfg?.autoPortRange ?? null;

  const worktrees = localCfg?.worktrees ?? globalCfg?.worktrees;

  return {
    integration: uniqueIntegration,
    repos,
    repoAliases,
    autoPort,
    autoPortRange,
    worktrees,
    sections: mergeSections(globalCfg?.sections, localCfg?.sections),
  };
}

/**
 * Load a single .axn-dev/config.yaml file.
 */
export function loadAxnDevConfigFile(configPath: string | null): AxnDevConfig | null {
  if (!configPath || !existsSync(configPath)) return null;

  const raw = readFileSync(configPath, "utf-8");
  let parsed: Record<string, unknown>;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new Error(`Invalid YAML in ${configPath}: ${e instanceof Error ? e.message : e}`);
  }

  let integration: string[] = [];
  if (Array.isArray(parsed.integration)) {
    integration = parsed.integration.map((p: unknown) => resolve(String(p)));
  } else if (typeof parsed.integration === "string") {
    integration = [resolve(parsed.integration)];
  }

  const repos: Record<string, string> = {};
  const repoAliases: Record<string, string> = {};
  if (typeof parsed.repos === "object" && parsed.repos !== null && !Array.isArray(parsed.repos)) {
    for (const [name, rawEntry] of Object.entries(parsed.repos as Record<string, unknown>)) {
      const entry = parseRepoEntry(rawEntry);
      if (!entry) continue;
      repos[name] = resolve(entry.path);
      if (entry.env) repoAliases[name] = entry.env;
    }
  }

  const autoPortRaw = parsed["auto-port"];
  const autoPort = typeof autoPortRaw === "boolean"
    ? autoPortRaw
    : (typeof autoPortRaw === "string" ? autoPortRaw.toLowerCase() === "true" : false);

  const autoPortRange = typeof parsed["auto-port-range"] === "string"
    ? parsed["auto-port-range"]
    : null;

  const worktrees = typeof parsed.worktrees === "string"
    ? resolve(parsed.worktrees)
    : undefined;

  const sections: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!CORE_CONFIG_KEYS.has(key)) sections[key] = value;
  }

  return { integration, repos, repoAliases, autoPort, autoPortRange, worktrees, sections };
}

/**
 * Parse one `repos:` entry. Either a plain path string, or the object
 * form `name: {path: /abs/path, env: FOO_SERVER}` (flow or block style) —
 * `env` is the env-var stem used for `<env>_ROOT` instead of the naive
 * uppercased repo name.
 */
function parseRepoEntry(raw: unknown): { path: string; env?: string } | null {
  if (typeof raw === "string") {
    const s = raw.trim();
    return s ? { path: s } : null;
  }
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const e = raw as Record<string, unknown>;
    if (typeof e.path === "string" && e.path) {
      return {
        path: e.path,
        env: typeof e.env === "string" && e.env ? e.env : undefined,
      };
    }
  }
  return null;
}

// --- Workspace config (built from AxnDevConfig) ---

/**
 * Workspace-level config that maps logical repo names to checkout paths
 * and provides computed env vars for docker-compose.
 */
export interface WorkspaceConfig {
  /** Map of repo name → absolute path */
  repos: Record<string, string>;
  /** Computed env vars: <NAME>_ROOT per repo (or the declared env alias) */
  repoEnv: Record<string, string>;
  /** Map of repo name → env-var stem override (from repos: {path, env} entries) */
  repoAliases: Record<string, string>;
}

/**
 * Convert a repo name like "my-server" to an env var name like
 * "MY_SERVER_ROOT". A declared env alias (repos: {path, env} entry)
 * wins — its stem is used as-is, or with `_ROOT` appended when absent.
 */
export function repoNameToEnvVar(name: string, aliases?: Record<string, string>): string {
  const stem = aliases?.[name] ?? name.toUpperCase().replace(/-/g, "_");
  return stem.endsWith("_ROOT") ? stem : stem + "_ROOT";
}

/**
 * Build workspace config from the central AxnDevConfig.
 * Provides repo paths and computed env vars for docker-compose.
 */
export function loadWorkspaceConfig(axnConfig?: AxnDevConfig): WorkspaceConfig {
  const config = axnConfig ?? loadAxnDevConfig();
  const repos: Record<string, string> = { ...config.repos };

  // Path-valued sections (e.g. `infra:` owned by a plugin) contribute
  // their basename as a repo
  for (const [name, path] of Object.entries(sectionRepos(config))) {
    if (!repos[name]) repos[name] = path;
  }

  // Include integration repos if configured
  for (const integrationPath of config.integration) {
    const name = basename(integrationPath);
    if (!repos[name]) {
      repos[name] = integrationPath;
    }
  }

  // Build env var map
  const repoEnv: Record<string, string> = {};
  for (const [name, absPath] of Object.entries(repos)) {
    repoEnv[repoNameToEnvVar(name, config.repoAliases)] = absPath;
  }

  return { repos, repoEnv, repoAliases: { ...config.repoAliases } };
}

/**
 * Apply explicit --repo-root overrides (and any shell env var wins) to the
 * workspace repos and repoEnv maps.
 */
export function applyRepoRootOverrides(
  workspace: WorkspaceConfig,
  repoRootValues: string[],
): void {
  // 1. Shell env vars win over config/worktree for known repos
  for (const [repoName] of Object.entries(workspace.repos)) {
    const envVar = repoNameToEnvVar(repoName, workspace.repoAliases);
    const shellValue = process.env[envVar];
    if (shellValue) {
      workspace.repos[repoName] = shellValue;
      workspace.repoEnv[envVar] = shellValue;
    }
  }

  // 2. --repo-root wins over everything (supports comma-separated and repeated flags)
  for (const raw of repoRootValues) {
    for (const pair of raw.split(",")) {
      const [repoName, ...rest] = pair.trim().split("=");
      if (!repoName || rest.length === 0) {
        throw new Error(`Invalid --repo-root value: "${pair.trim()}". Expected format: repo-name=/path/to/repo`);
      }
      const path = resolve(rest.join("=").trim());
      const normalizedName = repoName.trim();
      workspace.repos[normalizedName] = path;
      workspace.repoEnv[repoNameToEnvVar(normalizedName, workspace.repoAliases)] = path;
    }
  }
}

/** Serialize one plugin-owned config section back to yaml lines. */
function serializeSection(key: string, value: unknown): string[] {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [`${key}: ${value}`];
  }
  if (Array.isArray(value)) {
    return [`${key}:`, ...value.map((v) => `  - ${String(v)}`)];
  }
  if (value && typeof value === "object") {
    const lines = [`${key}:`];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      lines.push(`  ${k}: ${typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}`);
    }
    return lines;
  }
  return [];
}

function generateAxnDevYaml(config: AxnDevConfig): string {
  const lines: string[] = [
    "# axn-dev CLI configuration",
    "",
  ];

  lines.push("# Integration repos — searched in order for global scenarios");

  if (config.integration.length > 0) {
    lines.push("integration:");
    for (const p of config.integration) {
      lines.push(`  - ${p}`);
    }
  } else {
    lines.push("# integration:");
    lines.push("#   - /path/to/integration-repo");
  }
  lines.push("");

  if (config.worktrees) {
    lines.push("# Default parent directory for git worktrees");
    lines.push(`worktrees: ${config.worktrees}`);
    lines.push("");
  }

  lines.push("# Repo checkout paths — injected as env vars for docker-compose");
  lines.push("# Object form sets the env-var stem: name: {path: /x, env: FOO} → FOO_ROOT");
  const repoKeys = Object.keys(config.repos).sort((a, b) => a.localeCompare(b));
  if (repoKeys.length > 0) {
    lines.push("repos:");
    for (const name of repoKeys) {
      const alias = config.repoAliases[name];
      lines.push(alias
        ? `  ${name}: {path: ${config.repos[name]}, env: ${alias}}`
        : `  ${name}: ${config.repos[name]}`);
    }
  } else {
    lines.push("# repos:");
    lines.push("#   my-repo: /path/to/my-repo");
    lines.push("#   other:   {path: /path/to/other, env: OTHER_PREFIX}");
  }
  lines.push("");

  for (const [key, value] of Object.entries(config.sections).sort(([a], [b]) => a.localeCompare(b))) {
    const sectionLines = serializeSection(key, value);
    if (sectionLines.length > 0) {
      lines.push(...sectionLines, "");
    }
  }

  return lines.join("\n");
}

/**
 * Save (or merge) a .axn-dev/config.yaml file.
 * Existing values are preserved unless explicitly overwritten by the update.
 */
export function saveAxnDevConfigFile(
  configPath: string,
  update: Partial<AxnDevConfig>,
  options: { merge?: boolean } = {},
): void {
  const existing = options.merge !== false ? loadAxnDevConfigFile(configPath) : null;

  const config: AxnDevConfig = {
    integration: [
      ...(existing?.integration ?? []),
      ...(update.integration ?? []),
    ],
    repos: { ...(existing?.repos ?? {}), ...(update.repos ?? {}) },
    repoAliases: { ...(existing?.repoAliases ?? {}), ...(update.repoAliases ?? {}) },
    autoPort: update.autoPort ?? existing?.autoPort ?? false,
    autoPortRange: update.autoPortRange ?? existing?.autoPortRange ?? null,
    worktrees: update.worktrees ?? existing?.worktrees,
    sections: mergeSections(existing?.sections, update.sections),
  };

  // Deduplicate integration paths while preserving order
  const seen = new Set<string>();
  config.integration = config.integration.filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, generateAxnDevYaml(config), "utf-8");
}
