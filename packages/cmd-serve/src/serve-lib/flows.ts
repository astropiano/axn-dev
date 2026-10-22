import { basename, dirname } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

// Re-export the shared flow discovery/report logic from util/flow.ts so
// existing serve imports keep working.
export {
  discoverFlows,
  discoverProjectFlows,
  discoverAllFlows,
  discoverProjectFlowsAsync,
  discoverAllFlowsAsync,
  flowRoots,
  flowRootsAsync,
  findFlow,
  listFlowReports,
  loadFlowReport,
  isReportPathAllowed,
  isFlowFileAllowed,
  isEvidencePathAllowed,
} from "@axn-dev/flow-format";
export { flowDirNames } from "@axn-dev/core";
export type {
  FlowInfo,
  FlowReport,
  FlowReportFile,
  FlowResult as FlowReportEntry,
} from "@axn-dev/flow-format";

export type FlowRunStatus = "running" | "passed" | "failed" | "error";

export interface FlowRun {
  id: string;
  /** Flow name filter (undefined = whole file) */
  flowName?: string;
  file: string;
  fileName: string;
  root: string;
  status: FlowRunStatus;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  /** Tail of stdout/stderr for display */
  tail: string;
}

const TAIL_MAX = 16 * 1024; // keep last 16 KiB of output

/**
 * Tracks flow runs started from the dashboard. Each run spawns the CLI's
 * `flow` command as a child process so the dashboard sees real state.
 */
export class FlowRunManager {
  private runs = new Map<string, FlowRun>();
  private procs = new Map<string, ChildProcess>();

  /**
   * Spawn `axn-dev flow -f <file> [-t <name>]`. Returns the run id.
   */
  start(file: string, flowName?: string): FlowRun {
    const run: FlowRun = {
      id: randomUUID(),
      flowName,
      file,
      fileName: basename(file),
      root: dirname(dirname(file)),
      status: "running",
      startedAt: new Date().toISOString(),
      tail: "",
    };
    this.runs.set(run.id, run);

    const args = [process.argv[1], "flow", "-f", file];
    if (flowName) args.push("-t", flowName);

    const child = spawn(process.execPath, args, {
      cwd: dirname(file),
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.procs.set(run.id, child);

    const append = (chunk: unknown) => {
      run.tail = (run.tail + String(chunk)).slice(-TAIL_MAX);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    child.on("exit", (code) => {
      run.finishedAt = new Date().toISOString();
      run.exitCode = code ?? undefined;
      run.status = code === 0 ? "passed" : "failed";
      this.procs.delete(run.id);
    });
    child.on("error", (err) => {
      run.finishedAt = new Date().toISOString();
      run.status = "error";
      run.tail += `\nspawn error: ${err.message}`;
      this.procs.delete(run.id);
    });

    return run;
  }

  list(): FlowRun[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(id: string): FlowRun | undefined {
    return this.runs.get(id);
  }

  /** Latest run for a given flow file + name, if any. */
  latestFor(file: string, flowName?: string): FlowRun | undefined {
    return this.list().find((r) => r.file === file && r.flowName === flowName);
  }

  isRunning(file: string, flowName?: string): boolean {
    return this.list().some((r) => r.file === file && r.flowName === flowName && r.status === "running");
  }
}
