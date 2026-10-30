import { existsSync, readFileSync, writeFileSync } from "node:fs";
// @ts-expect-error - no types for wink-bm25-text-search
import bm25 from "wink-bm25-text-search";
// @ts-ignore - wink-nlp types may not resolve
import winkNLP from "wink-nlp";
// @ts-ignore - wink-eng-lite-web-model types may not resolve
import model from "wink-eng-lite-web-model";
import type { KnowItem, Chunk, BM25SearchResult, SearchResult, CorpusConfig } from "./types.js";
import type { VectorStore } from "./vectorStore.js";

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
        startLine: chunk.startLine,
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
 * Ranked chunk lists for a query, one per engine the corpus uses: BM25 and/or
 * vector. They stay separate because their scores are not comparable; the
 * caller fuses them by rank.
 * @param store the corpus's vectors; required for vector and hybrid corpora.
 */
export async function searchLists(
  indexPath: string,
  items: KnowItem[],
  store: VectorStore | null,
  config: CorpusConfig,
  query: string,
  topN: number = 5
): Promise<SearchResult[][]> {
  const lists: SearchResult[][] = [];
  if (config.indexing === "bm25" || config.indexing === "hybrid") {
    lists.push(searchBM25Index(indexPath, items, query, topN));
  }
  if ((config.indexing === "vector" || config.indexing === "hybrid") && store) {
    const { bruteForceCosineSearch } = await import("./vector.js");
    lists.push(await bruteForceCosineSearch(store, items, query, topN));
  }
  return lists;
}
