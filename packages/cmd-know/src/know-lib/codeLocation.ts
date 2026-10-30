import type { CodeLocation } from "@axn-dev/core";
import type { SearchResult } from "./types.js";

const REGEX_EXTRACTED = /\.(ts|tsx|js|jsx|cs)$/i;

/**
 * The code symbol a search hit stands for, read back from the chunk's title
 * path, or null for a hit that is not a code symbol (a markdown section, a
 * plain-text paragraph).
 *
 * Title paths come in two shapes:
 *   - parsed Java: `pkg.Outer.Type` for a type, `pkg.Type.member(Params)` for a method
 *   - regex extractors (TS, C#): `Type` for a type, `Type.member` for a member
 */
export function codeLocationOf(result: SearchResult): CodeLocation | null {
  const titlePath = result.titlePath ?? result.title;
  // Parsed sources carry a line; regex-extracted ones are recognised by extension.
  const isCode = result.startLine !== undefined || REGEX_EXTRACTED.test(result.path);
  if (!titlePath || !isCode) return null;

  const base = { path: result.path, ...(result.startLine !== undefined ? { line: result.startLine } : {}) };
  const paren = titlePath.indexOf("(");
  if (paren >= 0) {
    const segments = titlePath.slice(0, paren).split(".");
    const memberName = segments.pop()!;
    return { ...base, typeName: segments.pop() ?? memberName, memberName };
  }

  const segments = titlePath.split(".");
  // Parsed Java names every type by its qualified name; only a member carries parentheses.
  if (/\.java$/i.test(result.path) || segments.length === 1) {
    return { ...base, typeName: segments[segments.length - 1] };
  }
  return { ...base, typeName: segments[segments.length - 2], memberName: segments[segments.length - 1] };
}
