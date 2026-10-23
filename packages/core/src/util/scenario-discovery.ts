import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  detectRepo,
  detectLocalScenarioRoot,
  discoverScenarios,
  discoverGlobalScenarios,
  discoverGlobalScenariosAsync,
  findScenario,
  findGlobalScenario,
  type RepoContext,
  type ScenarioInfo,
} from "./repo.js";
import {
  loadAxnDevConfig,
  loadWorkspaceConfig,
  repoNameToEnvVar,
  scenarioDirNames,
  type AxnDevConfig,
  type WorkspaceConfig,
} from "./config.js";
import { getWorktreeInfo, resolveCheckoutForBranch } from "./worktree.js";

export interface ScenarioResolution {
  /** The resolved scenario */
  scenario: ScenarioInfo;
  /** Where the scenario was found */
  source: "project" | "global";
  /** Human-readable message about the resolution */
  message: string;
}

/**
 * Service for discovering and resolving scenarios with smart fallback logic.
 *
 * Global scenarios (from integration repos) are checked first; a scenario
 * in the current repo's `scenarios/` directory is the fallback.
 */
export class ScenarioDiscoveryService {
  private readonly cwd: string;
  private config: AxnDevConfig;
  private repoContext: RepoContext | null;
  /** Synthetic context when cwd is not in a repo but owns scenarios
   * (a `scenarios/` dir, or roots declared in `./.axn-dev/config.yaml`). */
  private readonly localContext: RepoContext | null;
  private readonly workbase: string | null;

  constructor(cwd: string = process.cwd(), workbase?: string) {
    this.cwd = cwd;
    this.workbase = workbase ?? null;
    this.config = this.applyWorkbase(loadAxnDevConfig(cwd));
    this.repoContext = this.resolveRepoContextWorkbase(detectRepo(cwd));
    this.localContext = this.repoContext ? null : detectLocalScenarioRoot(cwd);
  }

  /**
   * If a --workbase branch was supplied and the current directory is inside a
   * repo that has a linked worktree on that branch, switch the repo context
   * to that worktree so project-scenario resolution and the current repo's
   * *_ROOT env var use the feature checkout.
   */
  private resolveRepoContextWorkbase(ctx: RepoContext | null): RepoContext | null {
    if (!ctx || !this.workbase) return ctx;

    const wtInfo = getWorktreeInfo(ctx.repoRoot);
    const linked = wtInfo.worktrees.find(
      (w) => w.branch === this.workbase && !w.isMain,
    );
    const main =
      wtInfo.mainWorktree?.branch === this.workbase ? wtInfo.mainWorktree : null;
    const chosen = linked ?? main;
    if (!chosen) return ctx;

    return {
      ...ctx,
      repoRoot: chosen.path,
      branch: chosen.branch ?? undefined,
      reposRoot: dirname(chosen.path),
    };
  }

  private applyWorkbase(config: AxnDevConfig): AxnDevConfig {
    if (this.workbase) {
      config.integration = config.integration.map((p) =>
        resolveCheckoutForBranch(p, this.workbase!)
      );
    }
    return config;
  }

  /**
   * If the current working directory is inside an integration repo checkout
   * (a repo whose name ends with -integration and has a scenarios/ dir), treat
   * that checkout as the primary global scenario source. This means running
   * axn-dev from an integration repo automatically uses the current branch,
   * without needing --workbase or a config change.
   */
  private applyCurrentIntegrationRepo(config: AxnDevConfig): AxnDevConfig {
    if (this.workbase || !this.repoContext) return config;
    const { repoRoot, repoName } = this.repoContext;
    if (!repoName.endsWith("-integration")) return config;
    const hasScenarioDir = scenarioDirNames(loadAxnDevConfig(repoRoot)).some(
      (n) => existsSync(isAbsolute(n) ? n : join(repoRoot, n))
    );
    if (!hasScenarioDir) return config;

    const currentPath = repoRoot.replace(/\/+$/, "");
    const seen = new Set<string>();
    config.integration = [currentPath, ...config.integration.map((p) => p.replace(/\/+$/, ""))]
      .filter((p) => {
        if (seen.has(p)) return false;
        seen.add(p);
        return true;
      });
    return config;
  }

  /**
   * Get the loaded AxnDevConfig.
   * Reloads .axn-dev/config.yaml on every call so long-running processes
   * (e.g. `axn-dev serve`) pick up config changes without a restart.
   */
  getConfig(): AxnDevConfig {
    this.config = this.applyCurrentIntegrationRepo(
      this.applyWorkbase(loadAxnDevConfig(this.cwd))
    );
    return this.config;
  }

  /**
   * Get workspace config (repo env vars for docker-compose).
   * If inside a worktree, the current repo's *_ROOT env var is overridden
   * to point at the active checkout.
   */
  getWorkspaceConfig(): WorkspaceConfig {
    const workspace = loadWorkspaceConfig(this.getConfig());
    if (this.repoContext) {
      const envVar = repoNameToEnvVar(this.repoContext.repoName, this.getConfig().repoAliases);
      workspace.repoEnv[envVar] = this.repoContext.repoRoot;
      workspace.repos[this.repoContext.repoName] = this.repoContext.repoRoot;
    }
    return workspace;
  }

  /**
   * Get the repo context (if inside a known repo).
   */
  getRepoContext(): RepoContext | null {
    return this.repoContext;
  }

  /**
   * Get all available project scenarios (if in a repo).
   */
  getProjectScenarios(): ScenarioInfo[] {
    const ctx = this.repoContext ?? this.localContext;
    if (!ctx) {
      return [];
    }
    return discoverScenarios(ctx);
  }

  /**
   * Get all available global scenarios, including any linked worktrees of
   * the configured integration repos. This is used by `axn-dev list` and the
   * `axn-dev serve` dashboard, so it intentionally returns all variants.
   */
  getGlobalScenarios(): ScenarioInfo[] {
    return discoverGlobalScenarios(this.getConfig());
  }

  /**
   * Async variant of getGlobalScenarios — `git worktree list` runs off the
   * event loop so `axn-dev serve` stays responsive while resolving.
   */
  async getGlobalScenariosAsync(): Promise<ScenarioInfo[]> {
    return discoverGlobalScenariosAsync(this.getConfig());
  }

  /**
   * Resolve a scenario by name: global scenarios first, with the current
   * repo's project scenario as fallback.
   */
  resolveScenario(scenarioName: string | null): ScenarioResolution {
    return this.resolveGlobalScenario(scenarioName);
  }

  /**
   * Resolve a project scenario (for when explicitly working with project scenarios).
   * Throws if not in a repo.
   */
  resolveProjectScenario(scenarioName: string | null): ScenarioResolution {
    const ctx = this.repoContext ?? this.localContext;
    if (!ctx) {
      throw new Error("Not inside a known repo or a directory with scenarios. Cannot resolve project scenarios.");
    }

    const scenarios = discoverScenarios(ctx);

    if (!scenarioName) {
      if (scenarios.length === 0) {
        throw new Error(`No scenarios found in ${ctx.repoRoot}`);
      }
      if (scenarios.length === 1) {
        return {
          scenario: scenarios[0],
          source: "project",
          message: `Auto-selected project scenario: ${scenarios[0].name}`,
        };
      }
      console.log("\nAvailable project scenarios:");
      for (const s of scenarios) {
        console.log(`  - ${s.name}`);
      }
      throw new Error("Multiple scenarios available. Use --scenario <name> to pick one.");
    }

    const scenario = findScenario(ctx, scenarioName);
    if (!scenario) {
      throw new Error(
        `Scenario '${scenarioName}' not found in project.\n` +
          `Available: ${scenarios.map((s) => s.name).join(", ") || "(none)"}`
      );
    }

    return {
      scenario,
      source: "project",
      message: `Project scenario '${scenario.name}'`,
    };
  }

  /**
   * Resolve a global scenario, narrowed by --workbase when supplied.
   */
  private resolveGlobalScenario(scenarioName: string | null): ScenarioResolution {
    const scenarios = discoverGlobalScenarios(this.getConfig(), this.workbase);

    if (!scenarioName) {
      if (scenarios.length === 0) {
        const paths = this.config.integration.length > 0
          ? this.config.integration.join(", ")
          : "(none configured)";
        throw new Error(
          `No global scenarios found.\n` +
          `Integration repos searched: ${paths}\n` +
          `Configure integration repos in ~/.axn-dev/config.yaml`
        );
      }
      if (scenarios.length === 1) {
        return {
          scenario: scenarios[0],
          source: "global",
          message: `Auto-selected global scenario: ${scenarios[0].name}`,
        };
      }
      console.log("\nAvailable global scenarios:");
      for (const s of scenarios) {
        const desc = s.description ? ` — ${s.description}` : "";
        const branch = s.worktree?.branch ? ` (${s.worktree.branch})` : "";
        console.log(`  - ${s.name}${branch}${desc}`);
      }
      throw new Error("Multiple global scenarios available. Use --scenario <name> to pick one.");
    }

    const scenario = findGlobalScenario(this.getConfig(), scenarioName, this.workbase);
    if (!scenario) {
      // Fall back to local project scenario if available
      const ctx = this.repoContext ?? this.localContext;
      if (ctx) {
        const localScenario = findScenario(ctx, scenarioName);
        if (localScenario) {
          return {
            scenario: localScenario,
            source: "project",
            message: `Project scenario '${localScenario.name}' (global '${scenarioName}' not found, using local)`,
          };
        }
      }
      throw new Error(
        `Global scenario '${scenarioName}' not found.\n` +
          `Available: ${scenarios.map((s) => s.name).join(", ") || "(none)"}`
      );
    }

    return {
      scenario,
      source: "global",
      message: `Global scenario '${scenario.name}'`,
    };
  }

  /**
   * Print detection info to console.
   */
  printDetectionInfo(): void {
    if (this.repoContext) {
      console.log(`Detected repo: ${this.repoContext.repoName} (${this.repoContext.repoRoot})`);
      if (this.repoContext.variant) {
        console.log(`Variant: ${this.repoContext.variant}`);
      }
    } else if (this.localContext) {
      console.log(`Detected local scenario dir: ${this.localContext.repoRoot}`);
    }
  }
}
