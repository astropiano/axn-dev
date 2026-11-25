/** What a controller may send at a gate. `retry` is valid only after a failure. */
export type InteractiveCommand = "next" | "skip" | "retry" | "abort";

export type StepStatus = "waiting" | "running" | "passed" | "failed" | "skipped";

export interface InteractiveStep {
  /** Index among the flow's top-level steps. */
  index: number;
  label: string;
  status: StepStatus;
  /** Step attributes, shown before release (the "what comes next"). */
  args?: Record<string, string>;
  /** Text the step will send (a message step's prompt, a script's body). */
  text?: string;
  /** interactive="auto": runs without a gate. */
  auto?: boolean;
  error?: string;
}

/** The gate the run waits at; null while a step runs. */
export interface InteractiveGate {
  index: number;
  /** Why the previous attempt failed — the gate then offers retry/skip. */
  failed?: string;
}

export interface InteractiveSnapshot {
  runId: string;
  flowName: string;
  /** The system under demo, framed on the stage once the scenario is up. */
  productUrl?: string;
  /** The product runs in a browser window of its own (a visible or attached
   * browser): the stage shows the driver layout instead of a frame. */
  productWindow?: boolean;
  steps: InteractiveStep[];
  gate: InteractiveGate | null;
  /** Output so far, oldest first, each line tied to its step. */
  output: { index: number; line: string }[];
  /** Set once the flow ended. */
  finished?: { passed: boolean };
}

export type InteractiveEvent =
  | { type: "flow"; flowName: string; steps: InteractiveStep[]; productWindow?: boolean }
  | { type: "gate"; gate: InteractiveGate }
  | { type: "step"; index: number; status: StepStatus; error?: string }
  | { type: "output"; index: number; line: string }
  | { type: "product"; url: string }
  | { type: "finished"; passed: boolean };

/**
 * One interactive run, as the pages see it. The flow host implements it
 * in-process over the engine's gate; serve relays it to its flow child.
 * The pages cannot tell the two apart.
 */
export interface InteractiveSession {
  readonly runId: string;
  snapshot(): InteractiveSnapshot;
  /** Subscribes to events after the snapshot; returns the unsubscribe. */
  events(listener: (event: InteractiveEvent) => void): () => void;
  /** False when the run is not waiting for this command (the API answers 409). */
  command(command: InteractiveCommand): boolean;
}
