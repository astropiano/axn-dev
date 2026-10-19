import type { Chunk } from "./types.js";
import {
  AsciidocExtractor,
  CSharpExtractor,
  PlainTextExtractor,
  TypeScriptExtractor,
  type Extractor,
} from "./extractors/index.js";

const tsExtractor = new TypeScriptExtractor();
const csExtractor = new CSharpExtractor();
const adocExtractor = new AsciidocExtractor();
const plainExtractor = new PlainTextExtractor();

function extractorFor(filePath: string): Extractor {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx") || lower.endsWith(".js") || lower.endsWith(".jsx")) {
    return tsExtractor;
  }
  if (lower.endsWith(".cs")) {
    return csExtractor;
  }
  if (lower.endsWith(".adoc") || lower.endsWith(".asciidoc")) {
    return adocExtractor;
  }
  return plainExtractor;
}

/**
 * Extract semantic chunks from a file based on its language.
 */
export function extractChunks(filePath: string, text: string): Chunk[] {
  const raw = extractorFor(filePath).extract(text);
  return raw.map((c, i) => ({ ...c, offset: i } as Chunk));
}

/**
 * Backwards-compatible alias.
 * @deprecated use extractChunks(filePath, text)
 */
export function chunkText(text: string): Chunk[] {
  return plainExtractor.extract(text).map((c, i) => ({ ...c, offset: i } as Chunk));
}

/**
 * Produce a single string of all chunk texts for BM25 document indexing.
 */
export function chunksToDocument(chunks: Chunk[]): string {
  return chunks.map((c) => c.text).join("\n\n");
}
