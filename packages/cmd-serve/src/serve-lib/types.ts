import { ScenarioDiscoveryService } from "@axn-dev/core";
import type { ScenarioLink } from "@axn-dev/core";
import type { Worktree } from "@axn-dev/core";
import type { FlowRunManager } from "./flows.js";
import type { ScenarioRunManager } from "./scenarioRuns.js";

export interface ScenarioInstance {
  id: string;
  scenarioName: string;
  description?: string;
  proxies: Record<string, number>;
  /**
   * Full resolved URLs for frontend services, keyed by friendly name.
   * Used by `axn-dev serve` scenario view tabs and dashboard links.
   */
  endpoints?: Record<string, string>;
  /** Name(s) of the frontend service(s) */
  frontend?: string | string[];
  links?: ScenarioLink[];
  registeredAt: Date;
  source: "project" | "global";
  scenarioPath: string;
  worktree?: Worktree & { displayPath: string };
}

export interface ServeContext {
  registry: Map<string, ScenarioInstance>;
  /** Tracks flows started from the dashboard */
  flowRuns: FlowRunManager;
  /** Tracks scenario starts triggered from the dashboard */
  scenarioRuns: ScenarioRunManager;
  discovery: ScenarioDiscoveryService;
  port: number;
  shutdown: () => void;
  resolveProxies: (proxies: Record<string, string>, env: Record<string, string>) => Record<string, number>;
  escapeHtml: (text: string) => string;
}
