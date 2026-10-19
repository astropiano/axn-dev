import type { Extractor } from "./types.js";
import { buildChunks, scanUnits } from "./scanner.js";

/**
 * Extract TypeScript / JavaScript classes, interfaces and their methods.
 */
export class TypeScriptExtractor implements Extractor {
  extract(text: string) {
    const classRe = /(?:^|\n)\s*(?:export\s+|default\s+|abstract\s+)*(?:class|interface)\s+(\w+)(?:\s*<[^>]+>)?\s*(?:extends\s+\w+)?(?:\s+implements\s+[^{]+)?\s*(?:\{|\n)/g;
    const methodRe = /(?:^|\n)\s*(?:(?:public|private|protected|readonly|static|async|abstract|get|set)\s+)*(\w+|\[string\])\s*\([^)]*\)\s*(?::\s*[^{;=]+)?(?:\s*=>\s*\{|\s*\{|\s*;)/g;
    const functionRe = /(?:^|\n)\s*(?:export\s+|default\s+)?(?:async\s+)?function\s+(\w+)\s*[\(<]/g;

    const classLike = scanUnits(text, [
      { kind: "class", re: classRe },
      { kind: "function", re: functionRe },
    ], true);
    const methods = scanUnits(text, [{ kind: "method", re: methodRe }], true);

    // Keep only methods that sit inside a class/interface and are not themselves a top-level function
    const filteredMethods = methods.filter((m) =>
      classLike.some((c) => c.start < m.start && c.end > m.end)
    );

    const all = [...classLike, ...filteredMethods].sort((a, b) => a.start - b.start);
    return buildChunks(all);
  }
}
