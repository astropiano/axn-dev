import type { KnowItem, VectorSearchResult } from "./types.js";
import type { VectorStore } from "./vectorStore.js";

/** The model every vector is computed with; a store written with another model is re-embedded. */
export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

let embedder: any | null = null;

/**
 * Lazy-load the embedding pipeline (all-MiniLM-L6-v2).
 */
async function getEmbedder() {
  if (!embedder) {
    // @ts-ignore - Transformers.js has no types
    const { pipeline } = await import("@xenova/transformers");
    embedder = await pipeline("feature-extraction", EMBEDDING_MODEL);
  }
  return embedder;
}

/**
 * Embed a single text string as a number array.
 */
export async function embedText(text: string): Promise<number[]> {
  const pipe = await getEmbedder();
  // @ts-ignore - Transformers.js types are incomplete
  const output = await pipe(text, { pooling: "mean", normalize: true });
  // output is a Tensor with .data property
  // @ts-ignore - access .data on Tensor
  return Array.from(output.data);
}

/**
 * Compute cosine similarity between two vectors.
 */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new Error("Vector dimensions must match");
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Brute-force cosine search: embed the query, then rank every stored vector.
 */
export async function bruteForceCosineSearch(
  store: VectorStore,
  items: KnowItem[],
  query: string,
  topN: number = 5
): Promise<VectorSearchResult[]> {
  return vectorSearch(store, items, await embedText(query), topN);
}

/**
 * Rank every stored chunk vector against `queryVec` and return the top-N with
 * similarity scores. Rows whose chunk no longer exists in `items` are skipped.
 */
export function vectorSearch(
  store: VectorStore,
  items: KnowItem[],
  queryVec: ArrayLike<number>,
  topN: number = 5
): VectorSearchResult[] {
  const itemsByPath = new Map(items.map((i) => [i.path, i]));

  const scored: { path: string; offset: number; similarity: number }[] = [];
  for (const row of store.rows()) {
    const similarity = cosineSimilarity(queryVec, row.vector);
    if (similarity > 0) scored.push({ path: row.path, offset: row.offset, similarity });
  }
  scored.sort((a, b) => b.similarity - a.similarity);

  const results: VectorSearchResult[] = [];
  for (const s of scored) {
    if (results.length >= topN) break;
    const chunk = itemsByPath.get(s.path)?.chunks[s.offset];
    if (!chunk) continue;
    results.push({
      path: s.path,
      similarity: s.similarity,
      snippet: chunk.text,
      chunkOffset: chunk.offset,
      title: chunk.title,
      titlePath: chunk.titlePath,
      startLine: chunk.startLine,
    });
  }
  return results;
}
