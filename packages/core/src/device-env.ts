/**
 * Device-env resolvers — how `axn-dev flow -i <device>` (or any consumer)
 * turns a device name into environment variables.
 *
 * The layout of device definitions (`devices/<name>/device.yaml`, `.env`
 * files, etc.) is a product/infra convention, so core only defines the
 * contract: plugins register resolvers via their `axn-dev` manifest:
 *
 *   "axn-dev": {
 *     "deviceEnvResolvers": [{ "name": "infra", "entry": "dist/device-env.js" }]
 *   }
 *
 * The entry module must export `resolver` (or a default export): a function
 * `(device: string) => Record<string, string> | null | Promise<...>` that
 * returns additional env vars for the device, or null when it can't resolve
 * the name. Resolvers are tried in registration order; the first non-null
 * result wins.
 */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export interface DeviceEnvResolverSpec {
  /** Resolver name (for diagnostics). */
  name: string;
  /** Resolved absolute path to the resolver module. */
  entry: string;
}

export type DeviceEnvResolverFn = (
  device: string,
) => Promise<Record<string, string> | null> | Record<string, string> | null;

const specs: DeviceEnvResolverSpec[] = [];
const loaded = new Map<string, DeviceEnvResolverFn>();

/** Register a device-env resolver (spec form — module loads lazily on first use). */
export function registerDeviceEnvResolver(spec: DeviceEnvResolverSpec): void {
  specs.push(spec);
}

/** Registered resolver specs (for listing/debugging). */
export function deviceEnvResolverSpecs(): readonly DeviceEnvResolverSpec[] {
  return specs;
}

async function loadResolver(spec: DeviceEnvResolverSpec): Promise<DeviceEnvResolverFn> {
  const cached = loaded.get(spec.entry);
  if (cached) return cached;
  if (!existsSync(spec.entry)) {
    throw new Error(`Device-env resolver '${spec.name}' entry not found: ${spec.entry}`);
  }
  const mod = (await import(pathToFileURL(spec.entry).href)) as Record<string, unknown>;
  const fn = (mod.resolver ?? mod.default) as DeviceEnvResolverFn | undefined;
  if (typeof fn !== "function") {
    throw new Error(
      `Device-env resolver '${spec.name}' at ${spec.entry} must export 'resolver' or a default function`,
    );
  }
  loaded.set(spec.entry, fn);
  return fn;
}

/**
 * Resolve a device name to additional environment variables by trying each
 * registered resolver in order. Returns null when no resolver handles it.
 */
export async function resolveDeviceEnv(device: string): Promise<Record<string, string> | null> {
  for (const spec of specs) {
    const fn = await loadResolver(spec);
    const env = await fn(device);
    if (env) return env;
  }
  return null;
}
