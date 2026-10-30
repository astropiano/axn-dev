/**
 * Code navigators — given a place in the code (a search hit, say), answer
 * structural questions about it: who calls it, what it calls, what extends or
 * implements it, where it is referenced.
 *
 * Core only defines the contract; plugins contribute navigators through their
 * `axn-dev` manifest:
 *
 *   "axn-dev": {
 *     "codeNavigators": [{ "name": "ripwire", "extensions": [".java", ".ts"], "entry": "dist/index.js" }]
 *   }
 *
 * The entry module must export `navigator` (or a default export): a
 * `CodeNavigator`. `extensions` are known statically, so picking a navigator
 * for a file never imports one that cannot serve it.
 */
import { existsSync } from "node:fs";
import { extname } from "node:path";
import { pathToFileURL } from "node:url";

export type NavigationQuery = "callers" | "callees" | "implementations" | "references";

export const NAVIGATION_QUERIES: readonly NavigationQuery[] = ["callers", "callees", "implementations", "references"];

/** A symbol at a known place in the code. */
export interface CodeLocation {
  /** Absolute path of the file declaring the symbol. */
  path: string;
  /** 1-based line of the declaration, when known. */
  line?: number;
  /** The type the symbol belongs to, or the type itself (simple name, e.g. `ModuleManagerImpl`). */
  typeName: string;
  /** The member name when the symbol is a method or constructor (e.g. `applyDeltas`); absent for a type. */
  memberName?: string;
}

export interface NavigationHit {
  /** Absolute path of the file the hit is in. */
  path: string;
  /** 1-based line, when the navigator reports one. */
  line?: number;
  /** Name of the enclosing symbol, when the navigator reports one. */
  symbol?: string;
  /** Navigator-specific kind, e.g. `method`, `extends`, `import`. */
  kind?: string;
}

export interface NavigationResult {
  navigator: string;
  hits: NavigationHit[];
  /**
   * What the reader must know to trust the hits — e.g. that counts are lower
   * bounds, or that the symbol was not found. Empty when there is nothing to say.
   */
  caveats: string[];
}

export interface CodeNavigator {
  navigate(query: NavigationQuery, location: CodeLocation): Promise<NavigationResult>;
}

export interface CodeNavigatorSpec {
  /** Navigator name (for output and diagnostics). */
  name: string;
  /** File extensions it serves, lower-case with the dot (e.g. `.java`). Empty: every file. */
  extensions: string[];
  /** Resolved absolute path to the navigator module. */
  entry: string;
}

const specs: CodeNavigatorSpec[] = [];
const loaded = new Map<string, CodeNavigator>();

/** Register a code navigator (spec form — the module loads on first use). */
export function registerCodeNavigator(spec: CodeNavigatorSpec): void {
  specs.push(spec);
}

/** Registered navigators that serve this file, in registration order. */
export function codeNavigatorsFor(path: string): readonly CodeNavigatorSpec[] {
  const ext = extname(path).toLowerCase();
  return specs.filter((s) => s.extensions.length === 0 || s.extensions.includes(ext));
}

/** All registered navigator specs (for listing/debugging). */
export function codeNavigatorSpecs(): readonly CodeNavigatorSpec[] {
  return specs;
}

export async function loadCodeNavigator(spec: CodeNavigatorSpec): Promise<CodeNavigator> {
  const cached = loaded.get(spec.entry);
  if (cached) return cached;
  if (!existsSync(spec.entry)) {
    throw new Error(`Code navigator '${spec.name}' entry not found: ${spec.entry}`);
  }
  const mod = (await import(pathToFileURL(spec.entry).href)) as Record<string, unknown>;
  const navigator = (mod.navigator ?? mod.default) as CodeNavigator | undefined;
  if (typeof navigator?.navigate !== "function") {
    throw new Error(`Code navigator '${spec.name}' at ${spec.entry} must export 'navigator' or a default CodeNavigator`);
  }
  loaded.set(spec.entry, navigator);
  return navigator;
}

/**
 * Answer `query` for `location` with the first registered navigator that
 * serves the file. Returns null when none does.
 */
export async function navigateCode(query: NavigationQuery, location: CodeLocation): Promise<NavigationResult | null> {
  const [spec] = codeNavigatorsFor(location.path);
  if (!spec) return null;
  const result = await (await loadCodeNavigator(spec)).navigate(query, location);
  return { ...result, navigator: result.navigator || spec.name };
}
