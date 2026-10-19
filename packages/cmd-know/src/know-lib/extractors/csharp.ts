import type { Extractor } from "./types.js";
import { buildChunks, scanUnits } from "./scanner.js";

/**
 * Extract C# classes, structs, interfaces, methods and properties.
 */
export class CSharpExtractor implements Extractor {
  extract(text: string) {
    const typeRe = /(?:^|\n)\s*(?:(?:public|internal|private|protected|sealed|abstract|static|partial)\s+)*(?:class|struct|interface)\s+(\w+)(?:\s*:\s*[^{\n]+)?\s*(?:\{|\n)/g;
    const methodRe = /(?:^|\n)\s*(?:(?:public|private|protected|internal|static|virtual|abstract|override|async|sealed|readonly)\s+)*(?:[\w<>,\[\]?\s]+\s+)?(\w+)\s*\([^)]*\)\s*(?:where\s+\w+\s*:\s*[^\n]+)?\s*(?:\{|\s*=>|\s*;)/g;
    const propertyRe = /(?:^|\n)\s*(?:(?:public|private|protected|internal|static|virtual|abstract|override|readonly)\s+)*(?:[\w<>,\[\]?\s]+\s+)(\w+)\s*(?:\{\s*(?:get|set|init)\s*[;{\}]|\s*=>|\s*;)/g;

    const types = scanUnits(text, [{ kind: "class", re: typeRe }], true);
    const methods = scanUnits(text, [{ kind: "method", re: methodRe }], true);
    const properties = scanUnits(text, [{ kind: "property", re: propertyRe }], true);

    const filteredChildren = [...methods, ...properties].filter((m) =>
      types.some((c) => c.start < m.start && c.end > m.end)
    );

    const all = [...types, ...filteredChildren].sort((a, b) => a.start - b.start);
    return buildChunks(all);
  }
}
