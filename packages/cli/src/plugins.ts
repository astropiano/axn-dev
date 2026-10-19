import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

export const PLUGINS_DIR = join(homedir(), ".axn-dev", "plugins");

/** Extract the package name from an install spec: "@scope/name@1.2.3",
 * "name@^1". Local paths (./foo, ../foo, /abs) read the package.json — npm
 * registers the package under its declared name, not the dir basename. */
function specToPackageName(spec: string): string {
  if (spec.startsWith(".") || spec.startsWith("/")) {
    try {
      const pkg = JSON.parse(readFileSync(join(spec, "package.json"), "utf-8"));
      if (typeof pkg.name === "string") return pkg.name;
    } catch { /* fall through to basename */ }
    const parts = spec.replace(/\/+$/, "").split("/").filter(Boolean);
    return parts[parts.length - 1] ?? spec;
  }
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

function ensurePluginsPackage(): void {
  mkdirSync(PLUGINS_DIR, { recursive: true });
  const pkgPath = join(PLUGINS_DIR, "package.json");
  if (!existsSync(pkgPath)) {
    writeFileSync(
      pkgPath,
      JSON.stringify({ name: "axn-dev-plugins", private: true, dependencies: {} }, null, 2) + "\n",
      "utf-8",
    );
  }
}

/**
 * Plugins must share the CLI's @axn-dev/core instance — a second copy means
 * a second driver registry, and scenario-type plugins silently fail.
 * npm is told to skip peer installs (--legacy-peer-deps); we symlink the
 * CLI's resolved core into the plugins node_modules instead.
 */
function linkCoreInstance(): void {
  const require = createRequire(import.meta.url);
  const corePkgJson = require.resolve("@axn-dev/core/package.json");
  const coreDir = dirname(corePkgJson);

  const scopeDir = join(PLUGINS_DIR, "node_modules", "@axn-dev");
  const link = join(scopeDir, "core");
  mkdirSync(scopeDir, { recursive: true });
  if (existsSync(link)) rmSync(link, { recursive: true, force: true });
  symlinkSync(coreDir, link, "dir");
}

function runNpm(args: string[]): void {
  const res = spawnSync("npm", args, { stdio: "inherit" });
  if (res.error) {
    throw new Error(`npm is not available: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(`npm ${args[0]} failed (exit ${res.status})`);
  }
}

interface InstalledManifest {
  commands?: { name: string; description?: string }[];
  scenarioTypes?: { type: string }[];
  flowAdapters?: { name: string; tags?: string[] }[];
  deviceEnvResolvers?: { name: string }[];
  skills?: string;
}

/** npm install <spec> into the dedicated plugin prefix, validate the
 * axn-dev manifest, and link the shared core instance. */
export function installPlugin(spec: string): void {
  const name = specToPackageName(spec);
  ensurePluginsPackage();

  console.log(`Installing ${spec} into ${PLUGINS_DIR} ...`);
  runNpm(["install", "--prefix", PLUGINS_DIR, "--legacy-peer-deps", spec]);

  const pkgDir = join(PLUGINS_DIR, "node_modules", name);
  const pkgJsonPath = join(pkgDir, "package.json");
  if (!existsSync(pkgJsonPath)) {
    throw new Error(`Package '${name}' not found at ${pkgDir} after install`);
  }

  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as {
    version?: string;
    "axn-dev"?: InstalledManifest;
  };
  const manifest = pkgJson["axn-dev"];
  // Valid contributions: commands, scenario types, flow adapters,
  // device-env resolvers, or a skills dir (explicit "skills" path or the
  // implicit default "skills/").
  const skillsDir = manifest?.skills ?? "skills";
  const hasSkills = !!manifest && existsSync(join(pkgDir, skillsDir));

  if (
    !manifest ||
    (!manifest.commands?.length &&
      !manifest.scenarioTypes?.length &&
      !manifest.flowAdapters?.length &&
      !manifest.deviceEnvResolvers?.length &&
      !hasSkills)
  ) {
    runNpm(["uninstall", "--prefix", PLUGINS_DIR, name]);
    throw new Error(
      `'${name}' is not an axn-dev plugin (no "axn-dev" manifest in package.json). Rolled back.`,
    );
  }

  linkCoreInstance();

  console.log(`\n${name}@${pkgJson.version ?? "?"} installed:`);
  for (const c of manifest.commands ?? []) {
    console.log(`  command       axn-dev ${c.name}`);
  }
  for (const t of manifest.scenarioTypes ?? []) {
    console.log(`  scenario type ${t.type}`);
  }
  for (const a of manifest.flowAdapters ?? []) {
    console.log(`  flow adapter  ${a.name}${a.tags?.length ? ` (tags: ${a.tags.join(", ")})` : ""}`);
  }
  for (const r of manifest.deviceEnvResolvers ?? []) {
    console.log(`  device-env    ${r.name}`);
  }
  if (existsSync(join(pkgDir, manifest.skills ?? "skills"))) {
    console.log(`  skills        ${join(pkgDir, manifest.skills ?? "skills")}`);
    console.log(`                (run 'axn-dev install --skills' to link them for agents)`);
  }
}

/** npm uninstall <name> from the plugin prefix. */
export function uninstallPlugin(name: string): void {
  const pkgDir = join(PLUGINS_DIR, "node_modules", name);
  if (!existsSync(pkgDir)) {
    throw new Error(`Plugin '${name}' is not installed in ${PLUGINS_DIR}`);
  }
  runNpm(["uninstall", "--prefix", PLUGINS_DIR, name]);
  console.log(`Uninstalled ${name}`);
}

/** Names of plugin packages currently installed in the plugin prefix
 * (for completion). */
export function installedPluginNames(): string[] {
  const nmDir = join(PLUGINS_DIR, "node_modules");
  if (!existsSync(nmDir)) return [];
  const names: string[] = [];
  for (const entry of readdirSync(nmDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "@axn-dev") continue; // the linked core
    // npm file: deps are symlinks — isDirectory() is false for those.
    if (entry.name.startsWith("@")) {
      if (!entry.isDirectory()) continue;
      for (const sub of readdirSync(join(nmDir, entry.name), { withFileTypes: true })) {
        if (sub.isDirectory() || sub.isSymbolicLink()) names.push(`${entry.name}/${sub.name}`);
      }
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      names.push(entry.name);
    }
  }
  return names;
}
