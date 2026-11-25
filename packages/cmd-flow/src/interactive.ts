import { emitKeypressEvents } from "node:readline";
import type { ParsedStep } from "@axn-dev/flow-format";

/** What the controller decided at a gate. */
export type GateCommand = "next" | "skip" | "retry" | "abort";

/** The step a gate holds back — and, after a failed attempt, why it failed. */
export interface GateInfo {
  index: number;
  total: number;
  label: string;
  step: ParsedStep;
  failed?: string;
}

/**
 * Holds an interactive run before each top-level step. The terminal is one
 * controller; a web stage or serve's IPC channel are others behind the same
 * interface.
 */
export interface StepGate {
  /** Resolves with the controller's command. An aborted signal means another
   * controller answered first: stop listening, resolve nothing. */
  wait(info: GateInfo, signal?: AbortSignal): Promise<GateCommand>;
}

/** Status of a top-level step as a controller shows it. */
export type ObservedStatus = "passed" | "failed" | "skipped";

/** Follows an interactive run step by step, for controllers that show more
 * than the gate (the web stage). */
export interface RunObserver {
  begin(flowName: string, steps: { index: number; label: string; args?: Record<string, string>; text?: string; auto?: boolean }[]): void;
  stepStarted(index: number): void;
  stepEnded(index: number, status: ObservedStatus, error?: string): void;
  output(index: number, line: string): void;
  product(url: string): void;
  finished(passed: boolean): void;
}

/** Several controllers on one gate (terminal and web stage): the first
 * command wins and the others stop waiting. */
export function combineGates(gates: StepGate[]): StepGate {
  if (gates.length === 1) return gates[0];
  return {
    async wait(info, signal) {
      const lost = new AbortController();
      signal?.addEventListener("abort", () => lost.abort(), { once: true });
      try {
        return await Promise.race(gates.map((g) => g.wait(info, lost.signal)));
      } finally {
        lost.abort();
      }
    },
  };
}

interface Key {
  name?: string;
  ctrl?: boolean;
  sequence?: string;
}

export function keyToCommand(key: Key, failed: boolean): GateCommand | null {
  if ((key.ctrl && key.name === "c") || key.name === "q") return "abort";
  if (key.name === "s") return "skip";
  const go = key.name === "return" || key.name === "enter" || key.name === "space" ||
    key.name === "right" || key.name === "pagedown";
  if (failed) return key.name === "r" || go ? "retry" : null;
  return go ? "next" : null;
}

function prompt(info: GateInfo): string {
  const head = `\n\x1b[36m▶ step ${info.index + 1}/${info.total}\x1b[0m ${info.label}`;
  const args = Object.entries(info.step.args ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const keys = info.failed
    ? `\x1b[31m✗ ${info.failed}\x1b[0m\n  [Enter/r] retry  [s] skip  [q] abort `
    : `  [Enter] run  [s] skip  [q] abort `;
  return `${head}${args ? `\n  ${args}` : ""}\n${keys}`;
}

/** Terminal controller: one key per gate. Throws at once without a TTY, so a
 * run that nobody can drive fails before its first step instead of hanging. */
export function terminalGate(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): StepGate {
  if (!input.isTTY) {
    throw new Error("--interactive needs a terminal: stdin is not a TTY");
  }
  emitKeypressEvents(input);
  return {
    wait(info, signal) {
      output.write(prompt(info));
      return new Promise((resolve) => {
        const release = () => {
          input.off("keypress", onKey);
          signal?.removeEventListener("abort", onAbort);
          input.setRawMode(false);
          input.pause();
        };
        const onKey = (_s: string, key: Key) => {
          const cmd = keyToCommand(key ?? {}, !!info.failed);
          if (!cmd) return;
          release();
          output.write(`${cmd}\n`);
          resolve(cmd);
        };
        const onAbort = () => {
          release();
          output.write("(answered elsewhere)\n");
        };
        input.setRawMode(true);
        input.resume();
        input.on("keypress", onKey);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}
