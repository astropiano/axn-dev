/**
 * Flow adapters — the third plugin axis.
 *
 * Where scenarioTypes own a scenario's lifecycle, flow adapters own how a
 * flow step is executed. A plugin package declares adapters in its
 * package.json manifest:
 *
 *   "axn-dev": {
 *     "flowAdapters": [
 *       {
 *         "name": "my-adapter",
 *         "entry": "dist/adapter.js",          // optional; default: plugin entry
 *         "tags": ["usermessage"],              // step tags this adapter serves
 *         "extends": "script",                  // optional base adapter name
 *         "wantsScenario": true                 // engine prepares+starts the scenario
 *       }
 *     ]
 *   }
 *
 * Step dispatch in the flow engine:
 *   - <script>/<step> without adapter=  → built-in script runner (tsx subprocess)
 *   - <script adapter="x">              → registered adapter "x", else the
 *                                       file-path adapter fallback
 *                                       (config 'adapters:', src attr,
 *                                       adapters/<name>.ts|.js next to the flow)
 *   - <usermessage adapter="x">         → registered adapter "x" serving the tag
 *   - <custom-tag .../>                 → the adapter declaring that tag
 *
 * The adapter module exports `adapter` (or a default export) that is either a
 * FlowAdapter object or a factory `(base?: FlowAdapter) => FlowAdapter`.
 * The factory receives the resolved base instance when the spec declares
 * `extends` — composition, not subclassing.
 *
 * Modules load lazily on first use; the registry is process-local state —
 * plugins must resolve @axn-dev/core to the CLI's copy (peer dependency)
 * or their registrations land in a second, invisible registry.
 */

export interface FlowAdapterStep {
  /** XML tag that produced this step ("script", "usermessage", or a custom tag). */
  type: string;
  /** Text content or value= attribute. */
  value?: string;
  /** src= attribute — script/file path relative to the flow dir. */
  src?: string;
  description?: string;
  /** adapter= attribute — explicit adapter selection. */
  adapter?: string;
  /** Remaining attributes, passed through as arguments. */
  args?: Record<string, string>;
}

/** Minimal scenario view handed to adapters. Engine-side fields pass
 * through (service, project, workingDirectory, branch, orchestrator ...). */
export interface FlowAdapterScenario {
  name: string;
  service?: string;
  [key: string]: unknown;
}

export interface FlowAdapterContext {
  /** Fully merged environment: process + repo env + scenario env + flow env. */
  env: Record<string, string>;
  /** Directory containing the flow XML file. */
  flowDir: string;
  cwd: string;
  flowName: string;
  /** The parsed flow record (opaque to core — adapters may read
   * adapter-specific flow attributes off it). */
  flow: { name: string } & Record<string, unknown>;
  /** The parsed scenario this step targets, if the flow declares scenarios. */
  scenario?: FlowAdapterScenario;
  /** Model selected for this run (provider/name) when the flow declares <models>. */
  model?: { provider: string; name: string };
  /** Base URL of the prepared scenario's service — populated when the
   * adapter spec sets wantsScenario and the engine started it. */
  baseUrl?: string;
  /** Run a TS/JS file with the built-in script engine (tsx subprocess). */
  runScript(
    path: string,
    env?: Record<string, string>,
    cwd?: string,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  log(message: string): void;
}

export interface FlowAdapter {
  run(step: FlowAdapterStep, ctx: FlowAdapterContext): Promise<string | void> | string | void;
}

export type FlowAdapterFactory = (base?: FlowAdapter) => FlowAdapter | Promise<FlowAdapter>;

/** A registered flow adapter: metadata known statically, module loads lazily. */
export interface FlowAdapterSpec {
  name: string;
  /** Step tags this adapter can serve (e.g. "usermessage"). Adapters without
   * tags are reachable only by explicit adapter="<name>" on script steps. */
  tags: string[];
  /** Base adapter name — its instance is passed to the module's factory. */
  extends?: string;
  /** Engine prepares (starts + readiness + baseUrl) the scenario before run(). */
  wantsScenario?: boolean;
  /** Lazily produces the adapter instance (cached per name). */
  load(base?: FlowAdapter): Promise<FlowAdapter> | FlowAdapter;
}

// ── Reserved flow vocabulary ──────────────────────────────────────────────
//
// Custom step tags and step-file action names are self-declared: adapters
// declare tags in their manifest, step files declare action names via their
// file name. Neither may reuse a name the engine owns — the engine
// interprets it before adapter dispatch or step-file binding ever sees it.

/** Step elements the engine interprets inside <steps> — they can never
 * serve as custom step tags or step-file names. `usermessage` is included:
 * as an element it is always a message step, and adapters serve it in
 * their manifests by design. */
export const FLOW_ENGINE_STEP_TAGS: ReadonlySet<string> = new Set([
  "usermessage", "step", "script", "assert", "assertions",
  "picture", "video", "repeat", "extract",
]);

/** Structural elements — meaningful only in their own positions
 * (<flow>, <scenarios>, <env>, …), never as a step tag or step-file name. */
export const FLOW_STRUCTURAL_TAGS: ReadonlySet<string> = new Set([
  "flows", "flow", "steps", "scenarios", "scenario", "setup", "models",
  "model", "env", "var", "readiness", "tags", "tag", "description",
  "tool-mode", "use-docker",
]);

/** Keywords of the reusable-step vocabulary (`file=`, `action=`, `include=`
 * on <step>/<flows>/<flow>/<steps>) plus `src` for script paths. */
export const FLOW_STEP_REF_KEYWORDS: ReadonlySet<string> = new Set([
  "file", "action", "include", "src",
]);

/** All names a flow must not self-declare: custom <steps> tags and <step
 * action="name"> / step-file basenames. */
export const FLOW_RESERVED_STEP_NAMES: ReadonlySet<string> = new Set([
  ...FLOW_ENGINE_STEP_TAGS,
  ...FLOW_STRUCTURAL_TAGS,
  ...FLOW_STEP_REF_KEYWORDS,
]);

/** Manifest tags a plugin adapter must not declare — the engine interprets
 * them before tag dispatch could route a step. `usermessage` is exempt:
 * serving it is how message adapters work. */
export const FLOW_ADAPTER_TAG_BLOCKLIST: ReadonlySet<string> = new Set(
  [...FLOW_RESERVED_STEP_NAMES].filter((t) => t !== "usermessage")
);

const specs = new Map<string, FlowAdapterSpec>();
const instances = new Map<string, Promise<FlowAdapter>>();

/** Register a flow adapter. Later registrations lose name conflicts.
 * Reserved tags (engine elements / step-ref keywords) are dropped with a
 * warning — they could never be dispatched anyway. */
export function registerFlowAdapter(spec: FlowAdapterSpec): void {
  if (specs.has(spec.name)) return;
  const tags = spec.tags.filter((t) => {
    if (FLOW_ADAPTER_TAG_BLOCKLIST.has(t)) {
      console.warn(
        `Warning: flow adapter '${spec.name}' declares reserved flow tag '${t}' — ` +
          `the engine owns that element, so the tag is ignored`
      );
      return false;
    }
    return true;
  });
  specs.set(spec.name, { ...spec, tags });
}

export function hasFlowAdapter(name: string): boolean {
  return specs.has(name);
}

/** All registered adapters, in registration order. */
export function flowAdapterSpecs(): FlowAdapterSpec[] {
  return [...specs.values()];
}

/** Adapters serving a step tag, in registration order. */
export function flowAdaptersForTag(tag: string): FlowAdapterSpec[] {
  return [...specs.values()].filter((s) => s.tags.includes(tag));
}

/** Resolved adapter instance — loads the module and resolves the `extends`
 * chain (base instance is created first and passed to the factory). */
export async function flowAdapter(name: string): Promise<FlowAdapter> {
  let instance = instances.get(name);
  if (!instance) {
    const spec = specs.get(name);
    if (!spec) {
      throw new Error(
        `Unknown flow adapter '${name}'. ` +
          `Registered adapters: ${[...specs.keys()].join(", ") || "(none)"}. ` +
          `Install a plugin package declaring it via axn-dev.flowAdapters, ` +
          `or map a script file via 'adapters:' in .axn-dev/config.yaml.`,
      );
    }
    instance = (async () => {
      const base = spec.extends ? await flowAdapter(spec.extends) : undefined;
      return spec.load(base);
    })();
    instances.set(name, instance);
  }
  return instance;
}
