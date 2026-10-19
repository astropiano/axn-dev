import { existsSync, readFileSync, writeFileSync } from "node:fs";
// @ts-expect-error - no types for wink-bm25-text-search
import bm25 from "wink-bm25-text-search";
// @ts-ignore - wink-nlp types may not resolve
import winkNLP from "wink-nlp";
// @ts-ignore - wink-eng-lite-web-model types may not resolve
import model from "wink-eng-lite-web-model";
import type { KnowItem, Chunk, BM25SearchResult, VectorSearchResult, SearchResult, CorpusConfig } from "./types.js";
import { embedText } from "./vector.js";

const nlp = winkNLP(model);
const its = nlp.its;

function prepTask(text: string): string[] {
  const tokens: string[] = [];
  nlp
    .readDoc(text)
    .tokens()
    .filter(
      (t: any) => t.out(its.type) === "word" && !t.out(its.stopWordFlag)
    )
    .each((t: any) =>
      tokens.push(
        t.out(its.negationFlag) ? "!" + t.out(its.stem) : t.out(its.stem)
      )
    );
  return tokens;
}

interface ChunkRef {
  path: string;   // absolute file path
  offset: number; // chunk offset within that file
}

interface IndexDoc {
  id: string;   // path:offset
  text: string;
}

/**
 * Build a BM25 engine from the given items and serialize it to indexPath.
 * Each chunk is indexed as its own BM25 document.
 */
export function buildBM25Index(items: KnowItem[], indexPath: string): void {
  const engine = bm25();
  engine.defineConfig({ fldWeights: { text: 1 } });
  engine.definePrepTasks([prepTask]);

  const refs: ChunkRef[] = [];
  let docIdx = 0;

  for (const item of items) {
    for (const chunk of item.chunks) {
      refs.push({ path: item.path, offset: chunk.offset });
      const doc: IndexDoc = {
        id: `${item.path}:${chunk.offset}`,
        text: chunk.text,
      };
      engine.addDoc(doc, docIdx++);
    }
  }

  // wink-bm25 requires at least 3 documents to consolidate
  const MIN_DOCS = 3;
  for (let pad = refs.length; pad < MIN_DOCS; pad++) {
    engine.addDoc({ id: `__pad_${pad}`, text: "" }, docIdx++);
    refs.push({ path: `__pad_${pad}`, offset: -1 });
  }

  engine.consolidate();

  // Serialize: store the index data alongside a chunk lookup table
  const serialized = {
    index: engine.exportJSON(),
    refs,
  };
  writeFileSync(indexPath, JSON.stringify(serialized), "utf-8");
}

/**
 * Search the serialized BM25 index for a query string.
 * Returns top-N results with snippet text fetched from item chunks.
 */
export function searchBM25Index(
  indexPath: string,
  items: KnowItem[],
  query: string,
  topN: number = 5
): BM25SearchResult[] {
  if (!existsSync(indexPath)) return [];

  const serialized = JSON.parse(readFileSync(indexPath, "utf-8"));
  const refs: ChunkRef[] = serialized.refs;

  const engine = bm25();
  engine.defineConfig({ fldWeights: { text: 1 } });
  engine.definePrepTasks([prepTask]);
  engine.importJSON(serialized.index);

  const rawResults: [number, number][] = engine.search(query, topN);

  const itemsByPath = new Map<string, KnowItem>(items.map((i) => [i.path, i]));

  return rawResults
    .slice(0, topN)
    .map(([docIdx, score]) => {
      const ref = refs[docIdx];
      if (!ref || ref.offset === -1) return undefined as any;
      const item = itemsByPath.get(ref.path);
      const chunk = item?.chunks[ref.offset];
      if (!chunk) return undefined as any;
      const snippet = bestSnippet(chunk, query);
      return {
        path: ref.path,
        score,
        snippet,
        chunkOffset: ref.offset,
        title: chunk.title,
        titlePath: chunk.titlePath,
      };
    })
    .filter((r): r is BM25SearchResult => r !== undefined && r.path !== undefined);
}

/**
 * Pick or trim the best text for a search snippet.
 */
function bestSnippet(chunk: Chunk, query: string): string {
  const text = chunk.text ?? "";
  if (text.length <= 300) return text;

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = text.toLowerCase();
  let bestStart = 0;
  let bestScore = 0;

  for (let i = 0; i < text.length - 50; i += 20) {
    const window = lower.slice(i, i + 300);
    const score = terms.filter((t) => window.includes(t)).length;
    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
    }
  }

  const snippet = text.slice(bestStart, bestStart + 300);
  return snippet.length === 300 ? snippet.slice(0, 297) + "..." : snippet;
}

/**
 * Generate embeddings for all chunks in items that lack them.
 */
export async function generateEmbeddings(items: KnowItem[]): Promise<void> {
  for (const item of items) {
    for (const chunk of item.chunks) {
      if (!chunk.embedding) {
        chunk.embedding = await embedText(chunk.text);
      }
    }
  }
}

/**
 * Unified indexing entry point: decides what to build based on corpus config.
 */
export async function buildIndex(items: KnowItem[], indexPath: string, config: CorpusConfig): Promise<void> {
  if (config.indexing === "vector" || config.indexing === "hybrid") {
    await generateEmbeddings(items);
  }
  if (config.indexing === "bm25" || config.indexing === "hybrid") {
    buildBM25Index(items, indexPath);
  }
  // For pure vector mode, we don't write a separate index file; embeddings live in item YAMLs.
}

/**
 * Unified search entry point: delegates to BM25, vector, or hybrid.
 */
export async function search(
  indexPath: string,
  items: KnowItem[],
  config: CorpusConfig,
  query: string,
  topN: number = 5
): Promise<SearchResult[]> {
  if (config.indexing === "bm25") {
    return searchBM25Index(indexPath, items, query, topN);
  }
  if (config.indexing === "vector") {
    const { bruteForceCosineSearch } = await import("./vector.js");
    return bruteForceCosineSearch(items, query, topN);
  }
  // hybrid: BM25 recall + vector re-rank
  const bm25 = searchBM25Index(indexPath, items, query, topN * 2); // fetch more to re-rank
  const { bruteForceCosineSearch } = await import("./vector.js");
  const vec = await bruteForceCosineSearch(items, query, topN * 2);
  // Merge by path+chunk, keep best score (BM25 score or similarity)
  const map = new Map<string, SearchResult>();
  for (const r of bm25) {
    map.set(`${r.path}:${r.chunkOffset}`, r);
  }
  for (const r of vec) {
    const key = `${r.path}:${r.chunkOffset}`;
    const existing = map.get(key);
    if (!existing || ("similarity" in r && r.similarity > (config.vector?.threshold ?? 0.7))) {
      map.set(key, r);
    }
  }
  // Sort by score (BM25) or similarity (vector); prioritize similarity for hybrid
  const results = Array.from(map.values()).sort((a, b) => {
    const aScore = "similarity" in a ? a.similarity : ("score" in a ? a.score : 0);
    const bScore = "similarity" in b ? b.similarity : ("score" in b ? b.score : 0);
    return bScore - aScore;
  });
  return results.slice(0, topN);
}
