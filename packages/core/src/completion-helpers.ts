/**
 * Shared value-completers for command `complete()` implementations.
 * Each returns candidate strings already filtered by prefix where cheap.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadAxnDevConfig } from "./util/config.js";
import {
  detectRepo,
  discoverScenarios,
  discoverGlobalScenarios,
  discoverAllProjectScenarios,
} from "./util/repo.js";

export function listScenarios(global: boolean): string[] {
  try {
    const config = loadAxnDevConfig();
    if (global) {
      return discoverGlobalScenarios(config).map((s) => s.name);
    }
    const repo = detectRepo(process.cwd());
    const project = repo ? discoverScenarios(repo).map((s) => s.name) : [];
    const globalScenarios = discoverGlobalScenarios(config).map((s) => s.name);
    return [...new Set([...project, ...globalScenarios])];
  } catch {
    return [];
  }
}

export function listTags(): string[] {
  try {
    const config = loadAxnDevConfig();
    const tags = new Set<string>();
    for (const s of [...discoverGlobalScenarios(config), ...discoverAllProjectScenarios(config)]) {
      for (const t of s.tags ?? []) tags.add(t);
    }
    return [...tags];
  } catch {
    return [];
  }
}

/** Complete the current word with .json files (and directories) from the fs. */
export function listJsonFiles(partial: string): string[] {
  try {
    const lastSlash = partial.lastIndexOf("/");
    const dir = lastSlash >= 0
      ? (partial.startsWith("/")
          ? partial.slice(0, lastSlash + 1)
          : join(process.cwd(), partial.slice(0, lastSlash + 1)))
      : process.cwd();
    const base = lastSlash >= 0 ? partial.slice(lastSlash + 1) : partial;
    const prefix = lastSlash >= 0 ? partial.slice(0, lastSlash + 1) : "";
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.name.startsWith(base) &&
                     ((e.isFile() && e.name.endsWith(".json")) || e.isDirectory()))
      .map((e) => prefix + e.name + (e.isDirectory() ? "/" : ""));
  } catch {
    return [];
  }
}

/** Completer factory: scenario names after -s/--scenario, static flags otherwise. */
export function scenarioCompleter(flags: string[]) {
  return (words: string[]): string[] => {
    const prev = words[words.length - 2] ?? "";
    const cur = words[words.length - 1] ?? "";
    if (prev === "-s" || prev === "--scenario") {
      const useGlobal = words.includes("--global") || words.includes("-g");
      return listScenarios(useGlobal).filter((s) => s.startsWith(cur));
    }
    return flags.filter((f) => f.startsWith(cur) && f !== cur);
  };
}
