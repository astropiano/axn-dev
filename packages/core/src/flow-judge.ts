/**
 * Flow judges — the fourth flow plugin axis.
 *
 * Where flow adapters own how a step executes, flow judges own how
 * that="llm" output is *evaluated*. A plugin package declares judges in
 * its package.json manifest:
 *
 *   "axn-dev": {
 *     "judges": [{ "name": "my-judge", "entry": "dist/judge.js" }]
 *   }
 *
 * and flows select them via `judge="my-judge"` (or `judge="my-judge/<arg>"` —
 * the suffix is passed as `arg`):
 *
 *   <assert that="llm" judge="my-judge" prompt="..."/>
 *
 * The judge module exports `judge` (or a default export) — a function
 * receiving the rubric, the captured output, the optional spec suffix and
 * the merged env, returning {passed, actual?}.
 *
 * Built-in judge forms (evaluated before the registry): `ollama/<model>`,
 * `openai/<model>`, local agent CLIs (`claude`, `gemini`, `codex`), and
 * `http(s)://` binary-judge endpoints.
 *
 * Modules load lazily on first use; the registry is process-local state —
 * plugins must resolve @axn-dev/core to the CLI's copy (peer dependency)
 * or their registrations land in a second, invisible registry.
 */

export interface FlowJudgeInput {
  /** The assertion rubric (prompt= / value= / tag body). */
  rubric: string;
  /** The captured output under evaluation. */
  response: string;
  /** Spec suffix: judge="name/<arg>". */
  arg?: string;
  /** Fully merged flow environment. */
  env: Record<string, string>;
}

export interface FlowJudgeResult {
  passed: boolean;
  /** Short verdict detail shown in reports (e.g. "my-judge → PASS"). */
  actual?: string;
}

export type FlowJudge = (
  input: FlowJudgeInput,
) => Promise<FlowJudgeResult> | FlowJudgeResult;

/** A registered flow judge: name known statically, module loads lazily. */
export interface FlowJudgeSpec {
  name: string;
  load(): Promise<FlowJudge> | FlowJudge;
}

const specs = new Map<string, FlowJudgeSpec>();
const instances = new Map<string, Promise<FlowJudge>>();

/** Register a flow judge. Later registrations lose name conflicts. */
export function registerFlowJudge(spec: FlowJudgeSpec): void {
  if (specs.has(spec.name)) return;
  specs.set(spec.name, spec);
}

export function hasFlowJudge(name: string): boolean {
  return specs.has(name);
}

/** All registered judges, in registration order. */
export function flowJudgeSpecs(): FlowJudgeSpec[] {
  return [...specs.values()];
}

/** Resolved judge instance — loads the module on first use. */
export async function flowJudge(name: string): Promise<FlowJudge> {
  let instance = instances.get(name);
  if (!instance) {
    const spec = specs.get(name);
    if (!spec) {
      throw new Error(
        `Unknown flow judge '${name}'. ` +
          `Registered judges: ${[...specs.keys()].join(", ") || "(none)"}. ` +
          `Install a plugin package declaring it via axn-dev.judges, ` +
          `or use a built-in form (ollama/<model>, openai/<model>, ` +
          `claude, gemini, codex, devin, http(s)://<endpoint>).`,
      );
    }
    instance = (async () => spec.load())();
    instances.set(name, instance);
  }
  return instance;
}
