let embedder: any | null = null;

/**
 * Lazy-load the embedding pipeline (all-MiniLM-L6-v2).
 */
async function getEmbedder() {
  if (!embedder) {
    // @ts-ignore - Transformers.js has no types
    const { pipeline } = await import("@xenova/transformers");
    embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
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
export function cosineSimilarity(a: number[], b: number[]): number {
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
 * Brute-force cosine search: embed query, compare to all chunk vectors,
 * return top-N results with similarity scores.
 */
export async function bruteForceCosineSearch(
  items: import("./types.js").KnowItem[],
  query: string,
  topN: number = 5
): Promise<import("./types.js").VectorSearchResult[]> {
  const queryVec = await embedText(query);

  const candidates: import("./types.js").VectorSearchResult[] = [];

  for (const item of items) {
    for (const chunk of item.chunks) {
      if (!chunk.embedding) continue;
      const sim = cosineSimilarity(queryVec, chunk.embedding);
      if (sim > 0) {
        candidates.push({
          path: item.path,
          similarity: sim,
          snippet: chunk.text,
          chunkOffset: chunk.offset,
          title: chunk.title,
          titlePath: chunk.titlePath,
        });
      }
    }
  }

  // Sort by similarity descending
  candidates.sort((a, b) => b.similarity - a.similarity);
  return candidates.slice(0, topN);
}
