import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Maps adapter names to script paths, from .axn-dev/config.yaml 'adapters:'
 * and --adapter <name=path> overrides.
 */
export class AdapterRegistry {
  constructor(
    private adapters: Record<string, string>,
    private overrides: Record<string, string> = {}
  ) {}

  resolve(name: string): { path: string; via: string } | null {
    const rawPath = this.overrides[name] ?? this.adapters[name];
    if (!rawPath) return null;
    const adapterPath = resolve(rawPath);
    if (!existsSync(adapterPath)) {
      throw new Error(`Adapter '${name}' path does not exist: ${adapterPath}`);
    }
    return { path: adapterPath, via: name in this.overrides ? "--adapter" : "config.yaml 'adapters:'" };
  }
}
