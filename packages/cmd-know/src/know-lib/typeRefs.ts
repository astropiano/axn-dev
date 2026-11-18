import type { NavigationHit } from "@axn-dev/core";
import type { CodeFacts, KnowItem } from "./types.js";

/** `info.magnolia.module.Outer.Inner` → package `info.magnolia.module`: leading lower-case segments. */
function packageOf(qualifiedName: string): string {
  const segments = qualifiedName.split(".");
  const firstType = segments.findIndex((s) => !/^[a-z_][a-z0-9_]*$/.test(s));
  return segments.slice(0, Math.max(firstType, 0)).join(".");
}

/**
 * Does `written` — a type name as it appears in a file — denote `target` in
 * that file? Java's rules, without a compiler: a name imported explicitly wins
 * over a wildcard; otherwise the file's own package and its wildcard imports
 * are candidates. A qualified name resolves its first segment the same way.
 */
export function denotes(written: string, target: string, facts: CodeFacts): boolean {
  if (written === target) return true;
  const head = written.split(".")[0];
  const rest = written.slice(head.length);
  const explicit = facts.imports.find((i) => i === head || i.endsWith(`.${head}`));
  if (explicit) return explicit + rest === target;
  const packages = [facts.package ?? "", ...facts.imports.filter((i) => i.endsWith(".*")).map((i) => i.slice(0, -2))];
  return packages.some((p) => (p ? `${p}.${written}` : written) === target);
}

/**
 * Every use of the type `qualifiedName` in the items' recorded type uses,
 * resolved per file, outside the file that declares it. Each hit names the
 * innermost indexed symbol enclosing the use.
 */
export function typeReferences(items: KnowItem[], qualifiedName: string, declaringPath: string): NavigationHit[] {
  const simple = qualifiedName.slice(packageOf(qualifiedName).length).replace(/^\./, "").split(".").pop()!;
  const hits: NavigationHit[] = [];
  for (const item of items) {
    if (!item.code || item.path === declaringPath) continue;
    for (const [written, lines] of Object.entries(item.code.types)) {
      if (!(written === simple || written.endsWith(`.${simple}`)) || !denotes(written, qualifiedName, item.code)) continue;
      for (const line of lines) {
        hits.push({ path: item.path, line, symbol: enclosingSymbol(item, line), kind: "type" });
      }
    }
  }
  return hits.sort((a, b) => a.path.localeCompare(b.path) || a.line! - b.line!);
}

function enclosingSymbol(item: KnowItem, line: number): string | undefined {
  let best: { title?: string; span: number } | undefined;
  for (const c of item.chunks) {
    if (c.startLine === undefined || c.endLine === undefined || line < c.startLine || line > c.endLine) continue;
    const span = c.endLine - c.startLine;
    if (!best || span < best.span) best = { title: c.title, span };
  }
  return best?.title;
}
