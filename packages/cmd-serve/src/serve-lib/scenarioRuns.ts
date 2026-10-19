import { randomUUID } from "node:crypto";

export type ScenarioRunStatus = "running" | "succeeded" | "failed";

export interface ScenarioRun {
  id: string;
  scenarioName: string;
  source: "project" | "global";
  repoName?: string;
  status: ScenarioRunStatus;
  /** Human-readable progress shown on the dashboard button. */
  phase: string;
  error?: string;
  port?: number;
  /** Tail of docker compose output for diagnostics */
  tail: string;
  startedAt: string;
  finishedAt?: string;
}

const TAIL_MAX = 16 * 1024; // keep last 16 KiB of output

/**
 * Tracks scenario start operations triggered from the dashboard.
 * `docker compose up --build` can take far longer than Node's default
 * HTTP requestTimeout (5 min), so starts run in the background and the
 * dashboard polls GET /api/scenario-runs for progress.
 */
export class ScenarioRunManager {
  private runs = new Map<string, ScenarioRun>();

  begin(scenarioName: string, source: "project" | "global", repoName?: string): ScenarioRun {
    const run: ScenarioRun = {
      id: randomUUID(),
      scenarioName,
      source,
      repoName,
      status: "running",
      phase: "Starting...",
      tail: "",
      startedAt: new Date().toISOString(),
    };
    this.runs.set(run.id, run);
    return run;
  }

  update(id: string, patch: Partial<ScenarioRun>): void {
    const run = this.runs.get(id);
    if (run) Object.assign(run, patch);
  }

  appendTail(id: string, chunk: string): void {
    const run = this.runs.get(id);
    if (run) run.tail = (run.tail + chunk).slice(-TAIL_MAX);
  }

  succeed(id: string, port?: number): void {
    this.update(id, {
      status: "succeeded",
      phase: "Up",
      port,
      finishedAt: new Date().toISOString(),
    });
  }

  fail(id: string, error: string): void {
    this.update(id, { status: "failed", error, finishedAt: new Date().toISOString() });
  }

  get(id: string): ScenarioRun | undefined {
    return this.runs.get(id);
  }

  list(): ScenarioRun[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** A start is currently in flight for this scenario. */
  isStarting(scenarioName: string): boolean {
    return [...this.runs.values()].some(
      (r) => r.scenarioName === scenarioName && r.status === "running",
    );
  }
}
