import type { Chunk, CodeFacts } from "./types.js";
import {
  AsciidocExtractor,
  CSharpExtractor,
  JavaExtractor,
  extractJavaFacts,
  PlainTextExtractor,
  TypeScriptExtractor,
  type Extractor,
} from "./extractors/index.js";

const tsExtractor = new TypeScriptExtractor();
const csExtractor = new CSharpExtractor();
const javaExtractor = new JavaExtractor();
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
  if (lower.endsWith(".java")) {
    return javaExtractor;
  }
  if (lower.endsWith(".adoc") || lower.endsWith(".asciidoc")) {
    return adocExtractor;
  }
  return plainExtractor;
}

/**
 * Extract semantic chunks from a file based on its language.
 */
export async function extractChunks(filePath: string, text: string): Promise<Chunk[]> {
  const raw = await extractorFor(filePath).extract(text);
  return raw.map((c, i) => ({ ...c, offset: i } as Chunk));
}

/**
 * The declarations and uses a parsed source file records, or undefined for a
 * language that records none.
 */
export async function extractCodeFacts(filePath: string, text: string): Promise<CodeFacts | undefined> {
  return hasCodeFacts(filePath) ? extractJavaFacts(text) : undefined;
}

/** Will `extractCodeFacts` record anything for this file? */
export function hasCodeFacts(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".java");
}

/**
 * Backwards-compatible alias.
 * @deprecated use extractChunks(filePath, text)
 */
export async function chunkText(text: string): Promise<Chunk[]> {
  return (await plainExtractor.extract(text)).map((c, i) => ({ ...c, offset: i } as Chunk));
}

/**
 * Produce a single string of all chunk texts for BM25 document indexing.
 */
export function chunksToDocument(chunks: Chunk[]): string {
  return chunks.map((c) => c.text).join("\n\n");
}
