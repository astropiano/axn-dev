import type { RawUnit } from "./types.js";
import type { Extractor } from "./types.js";
import { buildChunks } from "./scanner.js";

/**
 * Extract AsciiDoc sections and subsections.
 */
export class AsciidocExtractor implements Extractor {
  extract(text: string) {
    const lines = text.split("\n");
    const headings: RawUnit[] = [];
    const startRe = /^(=+)\s+(.+)$/;

    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(startRe);
      if (!m) continue;
      const level = m[1].length;
      const name = m[2].trim();
      const start = lines.slice(0, i).join("\n").length + (i > 0 ? 1 : 0);
      let end = text.length;

      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].match(startRe);
        if (next && next[1].length <= level) {
          end = lines.slice(0, j).join("\n").length + (j > 0 ? 1 : 0);
          break;
        }
      }

      headings.push({
        start,
        end,
        name,
        text: text.slice(start, end).trim(),
        kind: "section",
      });
    }

    return buildChunks(headings);
  }
}
