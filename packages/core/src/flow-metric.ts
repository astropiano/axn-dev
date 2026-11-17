/**
 * Flow metrics — the fifth flow plugin axis.
 *
 * Where flow adapters own how a step executes and judges own how output is
 * evaluated, flow metrics own how a <metric> block's execution is
 * *measured*. A plugin package declares collectors in its manifest:
 *
 *   "axn-dev": {
 *     "flowMetrics": [{ "name": "cpu_s", "entry": "dist/metrics.js" }]
 *   }
 *
 * and flows select them via `collect=`:
 *
 *   <metric id="task" collect="duration,cpu_s">
 *     <step src="task.ts"/>
 *   </metric>
 *
 * A collector brackets the wrapped steps: `begin()` runs before the
 * children, `collect()` after (also on failure). `collect` returns the
 * measured value, or `null` when the metric is unavailable in this
 * context — the engine then skips or errors per
 * --fail-on-unavailable-metric.
 *
 * The `duration` collector is built in (engine wall clock). Everything
 * else — cpu, memory, container stats — is adapter/plugin-defined, since
 * what is measurable depends on the adapter's runtime.
 *
 * Modules load lazily on first use; the registry is process-local state —
 * plugins must resolve @axn-dev/core to the CLI's copy (peer dependency)
 * or their registrations land in a second, invisible registry.
 */

export interface FlowMetricContext {
  /** Fully merged environment: process + repo env + scenario env + flow env. */
  env: Record<string, string>;
  /** Directory containing the flow XML file. */
  flowDir: string;
  cwd: string;
  flowName?: string;
  /** The scenario the enclosing flow runs against, if declared. */
  scenario?: { name: string; service?: string; [key: string]: unknown };
  /** Base URL of the scenario's service / deployment target, when set. */
  baseUrl?: string;
}

export interface FlowMetricCollector {
  /** Metric name as used in `collect="..."` — e.g. "cpu_s". */
  name: string;
  /** Unit label shown in reports ("ms", "s", "mb", …) — informational only. */
  unit?: string;
  /** Called before the block's steps run. The returned state is passed to
   *  collect(). May be omitted for stateless collectors. */
  begin?(ctx: FlowMetricContext): Promise<unknown> | unknown;
  /** Called after the block's steps finished — also when a child failed.
   *  Return the measured value, or null when the metric is unavailable
   *  in this context. */
  collect(ctx: FlowMetricContext, state: unknown): Promise<number | null> | number | null;
}

/** A registered flow metric: name known statically, module loads lazily. */
export interface FlowMetricSpec {
  name: string;
  load(): Promise<FlowMetricCollector> | FlowMetricCollector;
}

const specs = new Map<string, FlowMetricSpec>();
const instances = new Map<string, Promise<FlowMetricCollector>>();

/** Register a flow metric collector. Later registrations lose name
 * conflicts. The built-in `duration` metric can be shadowed by a plugin. */
export function registerFlowMetric(spec: FlowMetricSpec): void {
  if (specs.has(spec.name)) return;
  specs.set(spec.name, spec);
}

export function hasFlowMetric(name: string): boolean {
  return specs.has(name);
}

/** All registered metric specs, in registration order. */
export function flowMetricSpecs(): FlowMetricSpec[] {
  return [...specs.values()];
}

/** Resolved collector instance — loads the module on first use. */
export async function flowMetric(name: string): Promise<FlowMetricCollector> {
  let instance = instances.get(name);
  if (!instance) {
    const spec = specs.get(name);
    if (!spec) {
      throw new Error(
        `Unknown flow metric '${name}'. ` +
          `Registered metrics: ${[...specs.keys()].join(", ")}. ` +
          `Install a plugin package declaring it via axn-dev.flowMetrics.`,
      );
    }
    instance = (async () => spec.load())();
    instances.set(name, instance);
  }
  return instance;
}

// Built-in `duration` — engine wall clock over the wrapped block. This is
// what <stopwatch id="..."> collects.
registerFlowMetric({
  name: "duration",
  load: () => ({
    name: "duration",
    unit: "ms",
    begin: () => Date.now(),
    collect: (_ctx, t0) => Date.now() - (t0 as number),
  }),
});
