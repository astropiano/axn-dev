/**
 * Plugin discovery and lazy command loading.
 *
 * A plugin is any package (directory containing a package.json) whose
 * package.json declares an "axn-dev" manifest:
 *
 *   {
 *     "name": "@axn-dev/cmd-know",
 *     "axn-dev": {
 *       "main": "dist/index.js",                 // optional; defaults below
 *       "skills": "skills",                      // optional; default "skills"
 *       "commands": [
 *         { "name": "know", "description": "...", "flags": ["--scope", "-s"] }
 *       ]
 *     }
 *   }
 *
 * The plugin entry module must export the commands either as a named
 * `commands` export (Command[]) or as a default export (Command | Command[]).
 *
 * Plugin directories are discovered by scanning the "plugin roots":
 *   - every directory in $AXN_DEV_PLUGIN_DIRS (path-delimited)
 *   - ~/.axn-dev/plugins/node_modules
 *   - caller-supplied extra roots (e.g. the CLI package's install dir)
 * Each root may itself be a plugin dir, a parent dir of plugin dirs, or a
 * node_modules dir (scoped @org packages are expanded one level deeper).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import type { Command, CommandExecuteOptions } from "./commands/command.js";

export interface PluginCommandSpec {
  name: string;
  description: string;
  /** Static flag list enabling cheap flag completion without loading the module. */
  flags?: string[];
}

/** A scenario type contributed by a plugin package. The driver module (see
 * `entry`, default: the plugin entry) exports `driver` or a default
 * `ScenarioDriver`. `markers` let discovery resolve the type without
 * importing the module. */
export interface PluginScenarioTypeSpec {
  type: string;
  markers?: string[];
  entry?: string;
}

/** A flow adapter contributed by a plugin package. The adapter module (see
 * `entry`, default: the plugin entry) exports `adapter` or a default
 * `FlowAdapter` — or a factory `(base?: FlowAdapter) => FlowAdapter` when
 * `extends` names a base adapter. `tags` are the step tags the adapter
 * serves; they are known statically so dispatch never imports the module
 * just to route a step. */
export interface PluginFlowAdapterSpec {
  name: string;
  tags?: string[];
  extends?: string;
  /** Engine starts + readiness-probes the scenario and passes baseUrl. */
  wantsScenario?: boolean;
  entry?: string;
}

export interface AxnDevManifest {
  /** Entry module relative to the package dir. Default: exports["."], main, dist/index.js, src/index.ts. */
  main?: string;
  /** Skills directory relative to the package dir. Default: "skills". */
  skills?: string;
  commands?: PluginCommandSpec[];
  /** Scenario types (drivers) contributed by this package. */
  scenarioTypes?: PluginScenarioTypeSpec[];
  /** Flow adapters contributed by this package. */
  flowAdapters?: PluginFlowAdapterSpec[];
  /** LLM judges (`that="llm"` evaluators) contributed by this package. */
  judges?: PluginJudgeSpec[];
  /** Device-env resolvers contributed by this package. */
  deviceEnvResolvers?: PluginDeviceEnvSpec[];
}

/** A flow judge contributed by a plugin package. The judge module (see
 * `entry`, default: the plugin entry) exports `judge` or a default
 * `FlowJudge` function. Selected via `judge="name"` or `judge="name/<arg>"`. */
export interface PluginJudgeSpec {
  name: string;
  entry?: string;
}

export interface PluginDeviceEnvSpec {
  name: string;
  /** Resolver module relative to the package dir. Default: plugin entry. */
  entry?: string;
}

export interface PluginPackage {
  dir: string;
  name: string;
  version: string;
  manifest: AxnDevManifest;
  packageJson: Record<string, unknown>;
}

/** Directories scanned for plugin packages. */
export function pluginRoots(): string[] {
  const roots: string[] = [];
  const env = process.env.AXN_DEV_PLUGIN_DIRS;
  if (env) {
    for (const d of env.split(delimiter)) {
      if (d.trim()) roots.push(resolve(d.trim()));
    }
  }
  roots.push(join(homedir(), ".axn-dev", "plugins", "node_modules"));
  return roots;
}

function isPluginDir(dir: string): boolean {
  return existsSync(join(dir, "package.json"));
}

/** Expand a root into candidate package dirs (handles node_modules-style scopes). */
function expandRoot(root: string): string[] {
  if (isPluginDir(root)) return [root];
  const dirs: string[] = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return dirs;
  }
  for (const entry of entries) {
    // Dirent.isDirectory() is false for symlinks — npm file: deps and
    // manually linked plugins are exactly that, so accept both.
    if ((!entry.isDirectory() && !entry.isSymbolicLink()) || entry.name.startsWith(".")) continue;
    const child = join(root, entry.name);
    if (entry.name.startsWith("@")) {
      // Scoped package dir: expand one level deeper
      try {
        for (const sub of readdirSync(child, { withFileTypes: true })) {
          if (sub.isDirectory() || sub.isSymbolicLink()) dirs.push(join(child, sub.name));
        }
      } catch { /* ignore */ }
    } else {
      dirs.push(child);
    }
  }
  return dirs;
}

/** Discover all plugin packages under the plugin roots (deduplicated by package name). */
export function discoverPlugins(extraRoots: string[] = []): PluginPackage[] {
  const found = new Map<string, PluginPackage>();
  for (const root of [...extraRoots, ...pluginRoots()]) {
    for (const dir of expandRoot(root)) {
      let pkg: Record<string, unknown>;
      try {
        pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
      } catch {
        continue;
      }
      const manifest = pkg["axn-dev"] as AxnDevManifest | undefined;
      if (
        !manifest?.commands?.length &&
        !manifest?.scenarioTypes?.length &&
        !manifest?.flowAdapters?.length &&
        !manifest?.judges?.length &&
        !manifest?.deviceEnvResolvers?.length &&
        // skills-only plugins: manifest with an existing skills dir
        !(manifest && existsSync(join(dir, manifest.skills ?? "skills")))
      ) {
        continue;
      }
      const name = String(pkg.name ?? dir);
      if (!found.has(name)) {
        found.set(name, {
          dir,
          name,
          version: String(pkg.version ?? "0.0.0"),
          manifest,
          packageJson: pkg,
        });
      }
    }
  }
  return [...found.values()];
}

/** Resolve a plugin package's entry module (built dist preferred, source fallback for dev). */
export function pluginEntry(pkg: PluginPackage): string {
  const exportsField = pkg.packageJson.exports;
  const exportEntry =
    typeof exportsField === "string"
      ? exportsField
      : exportsField && typeof exportsField === "object" && "." in exportsField
        ? typeof (exportsField as Record<string, unknown>)["."] === "string"
          ? ((exportsField as Record<string, unknown>)["."] as string)
          : ((exportsField as Record<string, Record<string, unknown>>)["."]["default"] as string | undefined)
        : undefined;
  const candidates = [
    pkg.manifest.main,
    exportEntry,
    typeof pkg.packageJson.main === "string" ? pkg.packageJson.main : undefined,
    "dist/index.js",
    "src/index.ts", // dev fallback (works under tsx)
  ];
  for (const c of candidates) {
    if (!c) continue;
    const p = resolve(pkg.dir, c);
    if (existsSync(p)) return p;
  }
  throw new Error(`No entry module found for plugin '${pkg.name}' in ${pkg.dir}`);
}

/** Lazily-loaded plugin command: cheap metadata for --help, module import on dispatch. */
export class LazyCommand implements Command {
  private real: Command | null = null;

  constructor(
    private spec: PluginCommandSpec,
    private pkg: PluginPackage,
  ) {}

  get name(): string {
    return this.spec.name;
  }

  get description(): string {
    return this.spec.description;
  }

  help(): string {
    return `Command '${this.spec.name}' provided by plugin ${this.pkg.name}@${this.pkg.version}.\n` +
      `Run 'axn-dev ${this.spec.name} --help' for command-specific help.`;
  }

  async load(): Promise<Command> {
    if (!this.real) {
      const entry = pluginEntry(this.pkg);
      const mod = await import(pathToFileURL(entry).href);
      const exported: Command[] = Array.isArray(mod.commands)
        ? mod.commands
        : Array.isArray(mod.default)
          ? mod.default
          : mod.default
            ? [mod.default]
            : [];
      const found = exported.find((c) => c.name === this.spec.name);
      if (!found) {
        throw new Error(
          `Plugin '${this.pkg.name}' does not export a command named '${this.spec.name}'`,
        );
      }
      this.real = found;
    }
    return this.real;
  }

  async execute(args: string[], options?: CommandExecuteOptions): Promise<void> {
    return (await this.load()).execute(args, options);
  }

  async complete(words: string[]): Promise<string[]> {
    const cur = words[words.length - 1] ?? "";
    // Cheap path: static flags from the manifest, no module load.
    if (this.spec.flags && cur.startsWith("-")) {
      return this.spec.flags.filter((f) => f.startsWith(cur) && f !== cur);
    }
    return (await this.load()).complete?.(words) ?? [];
  }
}

/** Instantiate lazy Command objects for a discovered plugin package. */
export function pluginCommands(pkg: PluginPackage): Command[] {
  return (pkg.manifest.commands ?? []).map((spec) => new LazyCommand(spec, pkg));
}

/** Scenario-driver specs contributed by a plugin package — markers and type
 * are known statically; the driver module is imported only when a scenario
 * of that type is actually driven. */
export function pluginScenarioDrivers(pkg: PluginPackage): import("./driver.js").ScenarioDriverSpec[] {
  return (pkg.manifest.scenarioTypes ?? []).map((spec) => ({
    type: spec.type,
    markers: spec.markers ?? [],
    load: async () => {
      const entry = spec.entry ? resolve(pkg.dir, spec.entry) : pluginEntry(pkg);
      const mod = await import(pathToFileURL(entry).href);
      const driver = mod.driver ?? mod.default;
      if (!driver || typeof driver.start !== "function") {
        throw new Error(
          `Plugin '${pkg.name}' does not export a ScenarioDriver for type '${spec.type}'`,
        );
      }
      return driver as import("./driver.js").ScenarioDriver;
    },
  }));
}

/** Flow-adapter specs contributed by a plugin package — name/tags/extends are
 * known statically; the adapter module is imported only when a step actually
 * dispatches to it. */
export function pluginFlowAdapters(pkg: PluginPackage): import("./flow-adapter.js").FlowAdapterSpec[] {
  return (pkg.manifest.flowAdapters ?? []).map((spec) => ({
    name: spec.name,
    tags: spec.tags ?? [],
    extends: spec.extends,
    wantsScenario: spec.wantsScenario,
    load: async (base) => {
      const entry = spec.entry ? resolve(pkg.dir, spec.entry) : pluginEntry(pkg);
      const mod = await import(pathToFileURL(entry).href);
      // A module may export a map of adapters (named `adapters`), a single
      // `adapter` (or default) object, or a factory `(base?) => adapter`.
      const exported = mod.adapters?.[spec.name] ?? mod.adapter ?? mod.default;
      const adapter: import("./flow-adapter.js").FlowAdapter =
        typeof exported === "function" ? await exported(base) : exported;
      if (!adapter || typeof adapter.run !== "function") {
        throw new Error(
          `Plugin '${pkg.name}' does not export a FlowAdapter for '${spec.name}'`,
        );
      }
      return adapter;
    },
  }));
}

/** Flow-judge specs contributed by a plugin package — names are known
 * statically; the judge module is imported only when judge="name" is used. */
export function pluginFlowJudges(pkg: PluginPackage): import("./flow-judge.js").FlowJudgeSpec[] {
  return (pkg.manifest.judges ?? []).map((spec) => ({
    name: spec.name,
    load: async () => {
      const entry = spec.entry ? resolve(pkg.dir, spec.entry) : pluginEntry(pkg);
      const mod = await import(pathToFileURL(entry).href);
      const judge = mod.judges?.[spec.name] ?? mod.judge ?? mod.default;
      if (typeof judge !== "function") {
        throw new Error(
          `Plugin '${pkg.name}' does not export a FlowJudge function for '${spec.name}'`,
        );
      }
      return judge as import("./flow-judge.js").FlowJudge;
    },
  }));
}

/** Device-env resolver specs contributed by a plugin package — the resolver
 * module is imported only when a device env is actually requested. */
export function pluginDeviceEnvResolvers(pkg: PluginPackage): import("./device-env.js").DeviceEnvResolverSpec[] {
  return (pkg.manifest.deviceEnvResolvers ?? []).map((spec) => ({
    name: spec.name,
    entry: spec.entry ? resolve(pkg.dir, spec.entry) : pluginEntry(pkg),
  }));
}

/** Skills directories contributed by a plugin package (may be empty). */
export function pluginSkillsDir(pkg: PluginPackage): string | null {
  const dir = join(pkg.dir, pkg.manifest.skills ?? "skills");
  return existsSync(dir) ? dir : null;
}
