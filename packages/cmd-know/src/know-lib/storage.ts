import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import yaml from "js-yaml";
import type { CorpusConfig, KnowItem, IndexingTechnique, VectorConfig } from "./types.js";

export type Scope = "global" | "project";

/**
 * Resolve the .axn-dev root for the given scope.
 * - global  → ~/.axn-dev
 * - project → <git-root-or-cwd>/.axn-dev
 */
export function resolveAxnDevRoot(scope: Scope, cwd: string = process.cwd()): string {
  if (scope === "global") {
    return join(homedir(), ".axn-dev");
  }

  // Try git root first
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();
    return join(gitRoot, ".axn-dev");
  } catch {
    return join(resolve(cwd), ".axn-dev");
  }
}

export function corpusDir(axnRoot: string, corpusName: string): string {
  return join(axnRoot, "corpora", corpusName);
}

export function itemsDir(axnRoot: string, corpusName: string): string {
  return join(corpusDir(axnRoot, corpusName), "items");
}

export function indexPath(axnRoot: string, corpusName: string): string {
  return join(corpusDir(axnRoot, corpusName), "index.json");
}

export function corpusConfigPath(axnRoot: string, corpusName: string): string {
  return join(corpusDir(axnRoot, corpusName), "corpus.yaml");
}

/**
 * Ensure corpus directory structure exists, creating corpus.yaml if needed.
 */
export function ensureCorpus(axnRoot: string, corpusName: string, indexing?: IndexingTechnique, vector?: VectorConfig): void {
  const dir = corpusDir(axnRoot, corpusName);
  mkdirSync(dir, { recursive: true });
  mkdirSync(itemsDir(axnRoot, corpusName), { recursive: true });
  const configPath = corpusConfigPath(axnRoot, corpusName);
  if (!existsSync(configPath)) {
    const config: CorpusConfig = {
      name: corpusName,
      indexing: indexing ?? "bm25",
      vector: vector,
    };
    writeFileSync(configPath, yaml.dump(config), "utf-8");
  }
}

/**
 * Deterministic slug for an absolute file path (used as item YAML filename).
 */
export function pathToSlug(filePath: string): string {
  return filePath.replace(/^\//, "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function itemPath(axnRoot: string, corpusName: string, filePath: string): string {
  return join(itemsDir(axnRoot, corpusName), pathToSlug(filePath) + ".yaml");
}

export function loadItem(axnRoot: string, corpusName: string, filePath: string): KnowItem | null {
  const p = itemPath(axnRoot, corpusName, filePath);
  if (!existsSync(p)) return null;
  return yaml.load(readFileSync(p, "utf-8")) as KnowItem;
}

export function saveItem(axnRoot: string, corpusName: string, item: KnowItem): void {
  ensureCorpus(axnRoot, corpusName);
  writeFileSync(itemPath(axnRoot, corpusName, item.path), yaml.dump(item), "utf-8");
}

export function loadAllItems(axnRoot: string, corpusName: string): KnowItem[] {
  const dir = itemsDir(axnRoot, corpusName);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => yaml.load(readFileSync(join(dir, f), "utf-8")) as KnowItem);
}

export function removeItem(axnRoot: string, corpusName: string, filePath: string): boolean {
  const p = itemPath(axnRoot, corpusName, filePath);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}

export function loadCorpusConfig(axnRoot: string, corpusName: string): CorpusConfig | null {
  const p = corpusConfigPath(axnRoot, corpusName);
  if (!existsSync(p)) return null;
  return yaml.load(readFileSync(p, "utf-8")) as CorpusConfig;
}
