import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { configSection, loadAxnDevConfig, loadAxnDevConfigFile, loadScenarioConfig, scenarioDirNames, type AxnDevConfig, type DevServerSpec } from "./config.js";
import { detectScenarioType } from "../driver.js";
import { getCanonicalRepoName, getWorktreeInfo, getWorktreeInfoAsync, type Worktree, type WorktreeInfo } from "./worktree.js";

export type RepoName = string;

export interface RepoContext {
  /** Which repo the user is currently inside (canonical, from remote origin) */
  repoName: RepoName;
  /** Absolute path to the repo root */
  repoRoot: string;
  /** Absolute path to the parent directory containing all repos */
  reposRoot: string;
  /** Current git branch, if any */
  branch?: string;
  /** Scenario-root the cwd sits inside, when the repo declares nested
   * scenario roots (e.g. a hardware variant dir) — scopes discovery. */
  variant?: string;
  /** Absolute path to that scenario root. */
  variantRoot?: string;
}

/**
 * Scenario type names are open strings resolved through the driver registry
 * (see driver.ts). Built-ins: "compose" (compose.yaml) and "shell"
 * (scenario.sh); plugins add more via the axn-dev.scenarioTypes manifest —
 * e.g. "qemu" (sim.yaml) from a @axn-dev/type-qemu plugin.
 */
export type ScenarioType = string;

export interface ScenarioInfo {
  /** Scenario name (folder name) */
  name: string;
  /** Absolute path to the scenario folder */
  path: string;
  /** Absolute path to docker-compose.yaml inside the scenario (compose scenarios only) */
  composePath?: string;
  /**
   * Scenario type — explicit `type:` from axn-dev.yaml, else probed from
   * registered driver markers; always resolves to a concrete type.
   */
  type?: ScenarioType;
  /** Qualifier of the scenario-root dir the scenario lives under (basename
   * of the dir owning `scenarios/`, when that isn't the repo root — e.g. a
   * variant dir "gen2"). Same-named scenarios across roots are
   * addressable as "gen2/sim" and see ${SCENARIO_VARIANT} in env. */
  variant?: string;
  /** Where this scenario comes from */
  scope: "repo" | "global";
  /** Human-readable description from axn-dev.yaml */
  description?: string;
  /** Default env vars from axn-dev.yaml */
  env?: Record<string, string>;
  /** UI-visible services for axn-dev serve tabs (name → port expression) */
  frontendServices?: Record<string, string>;
  /** Backend-only services (not shown as tabs) (name → port expression) */
  backendServices?: Record<string, string>;
  /** @deprecated Use frontendServices / backendServices instead. */
  proxies?: Record<string, string>;
  /** Name(s) of the frontend service(s) in the scenario */
  frontend?: string | string[];
  /** Auxiliary dev servers started/stopped with the scenario. */
  devServers?: DevServerSpec[];
  /** Interesting links (label + url), auto-associated to a service by port. */
  links?: import("./config.js").ScenarioLink[];
  /** Tags for grouping/filtering in `axn-dev serve`. */
  tags?: string[];
  /** Worktree metadata if this scenario was discovered from a linked checkout. */
  worktree?: Worktree & { displayPath: string };
}

/**
 * Scenario-root patterns a repo declares in its own `.axn-dev/config.yaml`:
 *
 *   scenarios:
 *     roots: variants/*, gen_a/v*         # dirs that own scenarios/
 *
 * `roots` is a comma-separated list of paths relative to the repo root;
 * `*` inside a segment matches any single directory name (so
 * `gen_a/v*` expands to `gen_a/v1`, `gen_a/v2`, …). The
 * basename of an expanded root becomes the scenario `variant` qualifier —
 * `<root>/scenarios/<name>`. Default when undeclared: the repo root itself.
 */
function scenarioRootPatterns(repoRoot: string): string[] {
  const cfg = loadAxnDevConfigFile(join(repoRoot, ".axn-dev", "config.yaml"));
  const roots = cfg
    ? configSection<{ roots?: unknown }>(cfg, "scenarios")?.roots
    : undefined;
  if (roots === undefined) return [""];
  const list = (Array.isArray(roots) ? roots : [roots])
    .flatMap((r) => (typeof r === "string" ? r.split(",") : []))
    .map((r) => r.trim())
    .filter(Boolean);
  return list.length > 0 ? list : [""];
}

/** Expand a root pattern to concrete absolute dirs under `repoRoot`. */
function expandRootPattern(repoRoot: string, pattern: string): string[] {
  let dirs = [repoRoot];
  for (const segment of pattern.split("/").filter(Boolean)) {
    const re = segment.includes("*")
      ? new RegExp(`^${segment.split("*").map(escapeRe).join("[^/]*")}$`)
      : null;
    const next: string[] = [];
    for (const dir of dirs) {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".")) continue;
        if (re ? re.test(e.name) : e.name === segment) next.push(join(dir, e.name));
      }
    }
    dirs = next;
  }
  return dirs;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Concrete dirs that own a `scenarios/` subdir, per the repo's declared
 * layout. Result always includes the repo root unless patterns replace it. */
export function expandScenarioRoots(repoRoot: string): string[] {
  const roots = new Set<string>();
  for (const pattern of scenarioRootPatterns(repoRoot)) {
    for (const dir of expandRootPattern(repoRoot, pattern)) {
      roots.add(resolve(dir));
    }
  }
  return [...roots];
}

/**
 * Walk up from `startDir` to find a known repo root.
 * A repo root is identified by containing a `.git` entry.
 *
 * When the repo declares nested scenario roots (see scenarioRootPatterns),
 * the one containing `startDir` is recorded as the active variant, scoping
 * later scenario discovery to that root.
 */
function buildRepoContext(
  dir: string,
  startDir: string,
  current: Worktree | null | undefined,
): RepoContext {
  const name = current?.repoName ?? getCanonicalRepoName(dir);

  const ctx: RepoContext = {
    repoName: name,
    repoRoot: dir,
    reposRoot: resolve(dir, ".."),
    branch: current?.branch ?? undefined,
  };

  const cwd = resolve(startDir);
  if (cwd !== dir) {
    for (const root of expandScenarioRoots(dir)) {
      if (root !== dir && (cwd === root || cwd.startsWith(root + sep))) {
        ctx.variant = basename(root);
        ctx.variantRoot = root;
        break;
      }
    }
  }
  // Auto-scope when the layout yields exactly one nested root — cwd at the
  // repo root behaves as if inside that single variant.
  if (!ctx.variantRoot) {
    const nested = expandScenarioRoots(dir).filter((r) => r !== dir);
    if (nested.length === 1) {
      ctx.variant = basename(nested[0]);
      ctx.variantRoot = nested[0];
    }
  }

  return ctx;
}

/**
 * Resolve a plugin-owned config section to a directory on disk.
 *
 * Precedence:
 *  1. the current repo's `.axn-dev/config.yaml` section value (resolved
 *     relative to the repo root)
 *  2. a `<repoRoot>/<name>` directory inside the current repo
 *  3. the section value in the global `~/.axn-dev/config.yaml`
 *
 * Returns null when the section is unset or resolves to a missing dir.
 * This is the shared "where does repo X live" plumbing behind plugin-owned
 * sections like `infra:` — the owning package keeps its own layout checks.
 */
export function resolveRepoDir(name: string, startDir: string = process.cwd()): string | null {
  const repo = detectRepo(startDir);

  if (repo) {
    const localConfig = join(repo.repoRoot, ".axn-dev", "config.yaml");
    if (existsSync(localConfig)) {
      try {
        const parsed = loadAxnDevConfigFile(localConfig);
        const value = parsed ? configSection<string>(parsed, name) : undefined;
        if (typeof value === "string") {
          const resolved = resolve(repo.repoRoot, value);
          if (existsSync(resolved)) return resolved;
        }
      } catch {
        /* malformed local config — fall through */
      }
    }

    const inRepo = join(repo.repoRoot, name);
    if (existsSync(inRepo)) return inRepo;
  }

  const globalValue = configSection<string>(loadAxnDevConfig(startDir), name);
  if (typeof globalValue === "string") {
    const resolved = resolve(startDir, globalValue);
    if (existsSync(resolved)) return resolved;
    throw new Error(`Configured '${name}' repo not found: ${globalValue}`);
  }

  return null;
}

export function detectRepo(startDir: string): RepoContext | null {
  let dir = resolve(startDir);

  while (dir !== "/") {
    if (existsSync(join(dir, ".git"))) {
      const wtInfo = getWorktreeInfo(dir);
      const current =
        wtInfo.worktrees.find((w) => w.path === dir) ?? wtInfo.mainWorktree;
      return buildRepoContext(dir, startDir, current);
    }
    dir = resolve(dir, "..");
  }

  return null;
}

/**
 * Async variant of detectRepo — runs `git worktree list` off the event loop.
 * Used by `axn-dev serve` request handlers.
 */
export async function detectRepoAsync(startDir: string): Promise<RepoContext | null> {
  let dir = resolve(startDir);

  while (dir !== "/") {
    if (existsSync(join(dir, ".git"))) {
      const wtInfo = await getWorktreeInfoAsync(dir);
      const current =
        wtInfo.worktrees.find((w) => w.path === dir) ?? wtInfo.mainWorktree;
      return buildRepoContext(dir, startDir, current);
    }
    dir = resolve(dir, "..");
  }

  return null;
}

/**
 * Build a ScenarioInfo for a scenario directory, or null if the directory
 * carries no recognised marker (compose.yaml / docker-compose.yaml /
 * scenario.sh / any marker registered by a scenario-type plugin).
 *
 * `variant` is the qualifier of the scenario-root dir the scenario lives
 * under — it becomes part of the qualified name ("variant/name") and the
 * SCENARIO_VARIANT env var.
 */
function buildScenarioInfo(
  entry: string,
  scenarioPath: string,
  scope: "repo" | "global",
  variant?: string
): ScenarioInfo | null {
  if (!statSync(scenarioPath).isDirectory() || entry === ".env.defaults") {
    return null;
  }

  const composeYaml = join(scenarioPath, "compose.yaml");
  const dockerComposeYaml = join(scenarioPath, "docker-compose.yaml");
  const composePath = existsSync(composeYaml)
    ? composeYaml
    : existsSync(dockerComposeYaml)
      ? dockerComposeYaml
      : null;

  const config = loadScenarioConfig(scenarioPath);

  // Explicit `type:` in axn-dev.yaml wins; otherwise probe registered driver
  // markers. A dir is only a scenario when a type resolves — either probed
  // or declared (a declared type may need no local marker files).
  const detected = detectScenarioType(scenarioPath);
  const type = config.type ?? detected;
  if (!composePath && type === null) return null;

  return {
    name: entry,
    path: scenarioPath,
    composePath: composePath ?? undefined,
    type: type ?? undefined,
    variant,
    scope,
    description: config.description,
    // SCENARIO_VARIANT is injected so compose files / axn-dev.yaml URLs /
    // dev-server env can reference the variant; an explicit env: entry wins.
    env: variant ? { SCENARIO_VARIANT: variant, ...config.env } : config.env,
    frontendServices: config.frontendServices,
    backendServices: config.backendServices,
    proxies: config.proxies,
    frontend: config.frontend,
    links: config.links,
    tags: config.tags,
    devServers: config.devServers,
  };
}

/**
 * Discover all scenarios for a given repo context.
 *
 * Scans `<root>/scenarios/` for each scenario root the repo's layout
 * expands to (`scenarios.roots` in its `.axn-dev/config.yaml`, default: the
 * repo root itself). When `ctx.variantRoot` is set — cwd sits inside one
 * nested root, or the layout has exactly one — scanning is scoped to it.
 * A non-trivial root's basename becomes the scenario `variant`.
 */
export function discoverScenarios(ctx: RepoContext, dirNames?: string[]): ScenarioInfo[] {
  const scenarios: ScenarioInfo[] = [];
  const repoRoot = resolve(ctx.repoRoot);
  const names = dirNames ?? scenarioDirNames(loadAxnDevConfig(repoRoot));
  const seen = new Set<string>();

  const scan = (dir: string, source: "repo" | "global", variant?: string) => {
    const key = resolve(dir);
    if (seen.has(key) || !existsSync(key)) return;
    seen.add(key);
    for (const entry of readdirSync(key)) {
      const info = buildScenarioInfo(entry, join(key, entry), source, variant);
      if (info) scenarios.push(info);
    }
  };

  for (const root of expandScenarioRoots(repoRoot)) {
    if (ctx.variantRoot && root !== resolve(ctx.variantRoot)) continue;
    const variant = root !== repoRoot ? basename(root) : undefined;
    for (const name of names) {
      if (!isAbsolute(name)) scan(join(root, name), "repo", variant);
    }
  }
  // Absolute configured dirs scan once as standalone locations.
  for (const name of names) {
    if (isAbsolute(name)) scan(name, "repo", ctx.variant);
  }

  return scenarios;
}

/** The name a repo checkout is registered under in the workspace config
 * (`repos:` keys), or null when unregistered. Worktree checkouts resolve
 * through their main checkout's registered path. Two checkouts of the same
 * remote (e.g. a public mirror registered as `axn-dev-github`) get distinct
 * names — this is the seed for compose project names. */
export function registeredRepoName(repoRoot: string): string | null {
  const { repos } = loadAxnDevConfig(repoRoot);
  const hit = (p: string) => {
    for (const [name, dir] of Object.entries(repos)) {
      if (resolve(dir) === resolve(p)) return name;
    }
    return null;
  };
  return hit(repoRoot) ?? (() => {
    const main = getWorktreeInfo(repoRoot).mainWorktree?.path;
    return main ? hit(main) : null;
  })();
}

/** Repo-less scenario root: when the cwd is not inside a repo, a directory
 * can still own scenarios — via its own `.axn-dev/config.yaml`
 * `scenarios.roots` or just a `scenarios/` subdir. Returns a synthetic
 * context (name = dir basename) or null when nothing is declared/found. */
export function detectLocalScenarioRoot(dir: string): RepoContext | null {
  const root = resolve(dir);
  const names = scenarioDirNames(loadAxnDevConfig(root));
  const has = expandScenarioRoots(root).some((r) =>
    names.some((n) => existsSync(isAbsolute(n) ? n : join(r, n)))
  );
  if (!has) return null;
  return {
    repoName: basename(root) as RepoName,
    repoRoot: root,
    reposRoot: dirname(root),
  };
}

/**
 * Find a specific scenario by name within the repo context.
 */
/** A scenario matches `ref` by bare name, or by "<variant>/<name>" when it
 * lives under a variant root dir (gen2/sim disambiguates two same-named
 * sim scenarios across different roots). */
export function scenarioMatches(s: ScenarioInfo, ref: string): boolean {
  return s.name === ref || (s.variant !== undefined && `${s.variant}/${s.name}` === ref);
}

export function findScenario(
  ctx: RepoContext,
  scenarioName: string
): ScenarioInfo | null {
  const all = discoverScenarios(ctx);
  return all.find((s) => scenarioMatches(s, scenarioName)) ?? null;
}

/**
 * Discover all project scenarios across all repos in the config.
 * Returns scenarios with repoName metadata for each.
 * Excludes integration repos (those are handled as global scenarios).
 */
export function discoverAllProjectScenarios(config: AxnDevConfig): Array<ScenarioInfo & { repoName: string }> {
  const scenarios: Array<ScenarioInfo & { repoName: string }> = [];
  const integrationPaths = new Set(config.integration.map(p => p.replace(/\/+$/, "")));

  // Group by the REGISTERED repo name (the config key), not the checkout's
  // dir basename — two registered checkouts of one repo (e.g. `axn-term`
  // and `axn-term-github` → ~/github/axn-term) both basename to "axn-term"
  // and would otherwise merge into one indistinguishable section.
  for (const [registeredName, repoPath] of Object.entries(config.repos)) {
    // Skip integration repos - they're handled as global scenarios
    if (integrationPaths.has(repoPath.replace(/\/+$/, ""))) continue;

    const { worktrees, mainWorktree } = getWorktreeInfo(repoPath);
    const basePath = mainWorktree ? dirname(mainWorktree.path) : resolve(repoPath, "..");

    for (const wt of worktrees) {
      for (const s of projectScenariosForWorktree(wt, basePath, integrationPaths)) {
        scenarios.push({ ...s, repoName: registeredName });
      }
    }
  }

  return scenarios;
}

/** True when a worktree should be scanned for project scenarios. */
function isProjectWorktree(wt: Worktree, integrationPaths: Set<string>): boolean {
  if (!existsSync(wt.path) || !existsSync(join(wt.path, ".git"))) return false;

  // Skip worktrees configured as integration repos - they're handled
  // as global scenarios (a worktree path may appear in `integration:`)
  return !integrationPaths.has(resolve(wt.path).replace(/\/+$/, ""));
}

function projectScenariosForCtx(
  wt: Worktree,
  basePath: string,
  ctx: RepoContext,
): Array<ScenarioInfo & { repoName: string }> {
  const wtMeta = { ...wt, displayPath: wt.isMain ? "." : relative(basePath, wt.path) } as Worktree & { displayPath: string };
  return discoverScenarios(ctx).map((s) => ({
    ...s,
    repoName: ctx.repoName,
    worktree: wtMeta,
  }));
}

function projectScenariosForWorktree(
  wt: Worktree,
  basePath: string,
  integrationPaths: Set<string>,
): Array<ScenarioInfo & { repoName: string }> {
  if (!isProjectWorktree(wt, integrationPaths)) return [];
  const ctx = detectRepo(wt.path);
  return ctx ? projectScenariosForCtx(wt, basePath, ctx) : [];
}

/**
 * Async variant of discoverAllProjectScenarios — runs the per-repo
 * `git worktree list` calls in parallel without blocking the event loop.
 * Used by `axn-dev serve` request handlers.
 */
export async function discoverAllProjectScenariosAsync(config: AxnDevConfig): Promise<Array<ScenarioInfo & { repoName: string }>> {
  const integrationPaths = new Set(config.integration.map(p => p.replace(/\/+$/, "")));

  const perRepo = await Promise.all(
    // Same grouping contract as the sync variant: the registered config
    // name, never the checkout basename (identical for second clones).
    Object.entries(config.repos).map(async ([registeredName, repoPath]) => {
      // Skip integration repos - they're handled as global scenarios
      if (integrationPaths.has(repoPath.replace(/\/+$/, ""))) return [];

      const { worktrees, mainWorktree } = await getWorktreeInfoAsync(repoPath);
      const basePath = mainWorktree ? dirname(mainWorktree.path) : resolve(repoPath, "..");

      const perWorktree = await Promise.all(
        worktrees.map(async (wt) => {
          if (!isProjectWorktree(wt, integrationPaths)) return [];
          const ctx = await detectRepoAsync(wt.path);
          return ctx
            ? projectScenariosForCtx(wt, basePath, ctx).map((s) => ({
                ...s,
                repoName: registeredName,
              }))
            : [];
        }),
      );
      return perWorktree.flat();
    }),
  );

  return perRepo.flat();
}

// --- Global (cross-concern) scenarios ---

/**
 * Scan a single integration repo's scenario roots for scenarios — same
 * `scenarios.roots` layout mechanism as project repos.
 */
function scanIntegrationScenarios(integrationRoot: string, dirNames?: string[]): ScenarioInfo[] {
  const root = resolve(integrationRoot);
  const names = dirNames ?? scenarioDirNames(loadAxnDevConfig(root));
  const scenarios: ScenarioInfo[] = [];
  const seen = new Set<string>();

  const scan = (dir: string, variant?: string) => {
    const key = resolve(dir);
    if (seen.has(key) || !existsSync(key)) return;
    seen.add(key);
    for (const entry of readdirSync(key)) {
      const info = buildScenarioInfo(entry, join(key, entry), "global", variant);
      if (info) scenarios.push(info);
    }
  };

  for (const scenarioRoot of expandScenarioRoots(root)) {
    const variant = scenarioRoot !== root ? basename(scenarioRoot) : undefined;
    for (const name of names) {
      if (!isAbsolute(name)) scan(join(scenarioRoot, name), variant);
    }
  }
  for (const name of names) {
    if (isAbsolute(name)) scan(name);
  }

  return scenarios;
}

function createWorktreeMeta(wt: Worktree, basePath: string): Worktree & { displayPath: string } {
  return {
    ...wt,
    displayPath: wt.isMain ? "." : relative(basePath, wt.path),
  };
}

/**
 * Discover global scenarios from all configured integration repos.
 *
 * Without `workbase`, every linked worktree of each integration repo is
 * scanned so that `axn-dev list` and `axn-dev serve` can show global scenarios
 * started from any worktree.
 *
 * With `workbase`, only the checkout or worktree on that branch is scanned,
 * matching the resolution used by `axn-dev start --workbase`.
 *
 * Results are deduplicated by scenario name + path, so the same scenario
 * discovered from the main checkout and a worktree is kept as two distinct
 * entries (distinguished by their worktree metadata).
 */
/** Pick which worktrees of an integration repo to scan for scenarios. */
function integrationWorktreesToScan(
  wtInfo: WorktreeInfo,
  integrationPath: string,
  workbase?: string | null,
): Worktree[] {
  if (!workbase) return wtInfo.worktrees;

  const linked = wtInfo.worktrees.find(
    (w) => w.branch === workbase && !w.isMain,
  );
  const main = wtInfo.mainWorktree?.branch === workbase
    ? wtInfo.mainWorktree
    : null;

  if (linked) return [linked];
  if (main) return [main];

  // Fallback to the configured path (may itself be a worktree when
  // the config/integration list has already been resolved).
  const fallbackWt =
    wtInfo.worktrees.find((w) => w.path === resolve(integrationPath)) ??
    wtInfo.mainWorktree;
  return fallbackWt ? [fallbackWt] : [];
}

function scanWorktreeScenarios(wt: Worktree, basePath: string): ScenarioInfo[] {
  if (!existsSync(wt.path) || !existsSync(join(wt.path, ".git"))) return [];
  const wtMeta = wt.isMain ? undefined : createWorktreeMeta(wt, basePath);
  return scanIntegrationScenarios(wt.path).map((scenario) => ({
    ...scenario,
    worktree: wtMeta,
  }));
}

function dedupeScenarios(lists: ScenarioInfo[][]): ScenarioInfo[] {
  const scenarios: ScenarioInfo[] = [];
  const seen = new Set<string>();
  for (const scenario of lists.flat()) {
    const key = `${scenario.name}|${scenario.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    scenarios.push(scenario);
  }
  return scenarios;
}

export function discoverGlobalScenarios(config: AxnDevConfig, workbase?: string | null): ScenarioInfo[] {
  return dedupeScenarios(
    config.integration.map((integrationPath) => {
      const wtInfo = getWorktreeInfo(integrationPath);
      const basePath = wtInfo.mainWorktree
        ? dirname(wtInfo.mainWorktree.path)
        : resolve(integrationPath, "..");
      return integrationWorktreesToScan(wtInfo, integrationPath, workbase)
        .flatMap((wt) => scanWorktreeScenarios(wt, basePath));
    }),
  );
}

/**
 * Async variant of discoverGlobalScenarios — runs the per-integration
 * `git worktree list` calls in parallel without blocking the event loop.
 * Used by `axn-dev serve` request handlers.
 */
export async function discoverGlobalScenariosAsync(
  config: AxnDevConfig,
  workbase?: string | null,
): Promise<ScenarioInfo[]> {
  const perIntegration = await Promise.all(
    config.integration.map(async (integrationPath) => {
      const wtInfo = await getWorktreeInfoAsync(integrationPath);
      const basePath = wtInfo.mainWorktree
        ? dirname(wtInfo.mainWorktree.path)
        : resolve(integrationPath, "..");
      return integrationWorktreesToScan(wtInfo, integrationPath, workbase)
        .flatMap((wt) => scanWorktreeScenarios(wt, basePath));
    }),
  );
  return dedupeScenarios(perIntegration);
}

/**
 * Find a global scenario by name across all integration repos.
 *
 * `workbase` narrows the search to the checkout or worktree on that branch.
 */
export function findGlobalScenario(
  config: AxnDevConfig,
  scenarioName: string,
  workbase?: string | null,
): ScenarioInfo | null {
  const all = discoverGlobalScenarios(config, workbase);
  return all.find((s) => scenarioMatches(s, scenarioName)) ?? null;
}
