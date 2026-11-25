import { randomUUID } from "node:crypto";
import type {
  InteractiveCommand,
  InteractiveEvent,
  InteractiveGate,
  InteractiveSession,
  InteractiveSnapshot,
  InteractiveStep,
} from "@axn-dev/interactive-ui";
import type { GateCommand, GateInfo, ObservedStatus, RunObserver, StepGate } from "./interactive.js";

/** Output kept for a reload; older lines drop off. */
const MAX_OUTPUT = 2000;

/**
 * The run as the web stage sees it, in the flow's own process: a gate the
 * pages answer through createInteractiveHandler, and the observer that keeps
 * the snapshot and fans events out to every open page.
 */
export class LiveSession implements InteractiveSession, StepGate, RunObserver {
  readonly runId = randomUUID().slice(0, 8);
  private flowName = "";
  private steps: InteractiveStep[] = [];
  private gate: InteractiveGate | null = null;
  private lines: { index: number; line: string }[] = [];
  private productUrl?: string;
  private productWindow = false;
  private done?: { passed: boolean };
  private pending: ((cmd: GateCommand) => void) | null = null;
  private readonly listeners = new Set<(event: InteractiveEvent) => void>();

  snapshot(): InteractiveSnapshot {
    return structuredClone({
      runId: this.runId,
      flowName: this.flowName,
      productUrl: this.productUrl,
      productWindow: this.productWindow,
      steps: this.steps,
      gate: this.gate,
      output: this.lines,
      finished: this.done,
    });
  }

  events(listener: (event: InteractiveEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  command(command: InteractiveCommand): boolean {
    const answer = this.pending;
    if (!answer || !this.gate) return false;
    const failed = !!this.gate.failed;
    if (command === "retry" && !failed) return false;
    // After a failure "next" means run it again, as Enter does in the terminal.
    answer(command === "next" && failed ? "retry" : command);
    return true;
  }

  wait(info: GateInfo, signal?: AbortSignal): Promise<GateCommand> {
    this.gate = { index: info.index, ...(info.failed ? { failed: info.failed } : {}) };
    this.emit({ type: "gate", gate: this.gate });
    return new Promise((resolve) => {
      const onAbort = () => {
        this.pending = null;
      };
      this.pending = (cmd) => {
        this.pending = null;
        signal?.removeEventListener("abort", onAbort);
        resolve(cmd);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  begin(flowName: string, steps: Omit<InteractiveStep, "status">[], productWindow: boolean): void {
    this.flowName = flowName;
    this.productWindow = productWindow;
    this.productUrl = undefined;
    this.steps = steps.map((s) => ({ ...s, status: "waiting" }));
    this.gate = null;
    this.lines = [];
    this.done = undefined;
    this.emit({ type: "flow", flowName, steps: structuredClone(this.steps), productWindow });
  }

  stepStarted(index: number): void {
    this.setStatus(index, "running");
  }

  stepEnded(index: number, status: ObservedStatus, error?: string): void {
    this.setStatus(index, status, error);
  }

  output(index: number, line: string): void {
    this.lines.push({ index, line });
    if (this.lines.length > MAX_OUTPUT) this.lines.splice(0, this.lines.length - MAX_OUTPUT);
    this.emit({ type: "output", index, line });
  }

  product(url: string): void {
    if (url === this.productUrl) return;
    this.productUrl = url;
    this.emit({ type: "product", url });
  }

  finished(passed: boolean): void {
    this.done = { passed };
    this.gate = null;
    this.pending = null;
    this.emit({ type: "finished", passed });
  }

  private setStatus(index: number, status: InteractiveStep["status"], error?: string): void {
    // The gate is answered (from here or the terminal) once the step moves on.
    this.gate = null;
    this.pending = null;
    const step = this.steps.find((s) => s.index === index);
    if (step) {
      step.status = status;
      if (error) step.error = error;
      else delete step.error;
    }
    this.emit({ type: "step", index, status, ...(error ? { error } : {}) });
  }

  private emit(event: InteractiveEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
