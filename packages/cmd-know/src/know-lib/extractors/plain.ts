import type { Chunk } from "../types.js";
import type { Extractor } from "./types.js";

/**
 * Fallback extractor for plain text / markdown — split by paragraphs and headings.
 */
export class PlainTextExtractor implements Extractor {
  extract(text: string): Omit<Chunk, "offset">[] {
    const chunks: Omit<Chunk, "offset">[] = [];
    const blocks = text.split(/\n{2,}/);

    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed) continue;
      const headingParts = trimmed.split(/(?=^#{1,6} )/m);
      for (const part of headingParts) {
        const t = part.trim();
        if (!t) continue;
        const heading = t.match(/^#{1,6}\s+(.+)$/m);
        chunks.push({
          text: t,
          title: heading ? heading[1].trim() : undefined,
          titlePath: heading ? heading[1].trim() : undefined,
        });
      }
    }

    return chunks;
  }
}
