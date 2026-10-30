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

/**
 * Words for the title field: each identifier whole — so the exact name
 * `AbstractRepositoryTask` matches — and split at its camelCase humps — so
 * "repository task" matches too.
 */
function prepTitle(text: string): string[] {
  const words = text.replace(/[^A-Za-z0-9]+/g, " ");
  const humps = words.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return [...prepTask(words), ...(humps === words ? [] : prepTask(humps))];
}

/**
 * The names a chunk is known by, without its package: `pkg.Outer.Type.run(String)`
 * becomes `Outer.Type.run(String)`. Package segments are left out so a query
 * word like "module" doesn't lift every class in a `module` package.
 */
export function chunkTitle(chunk: Chunk): string {
  const path = chunk.titlePath ?? chunk.title ?? "";
  const segments = path.split(".");
  const firstName = segments.findIndex((s) => !/^[a-z_][a-z0-9_]*$/.test(s));
  return firstName > 0 ? segments.slice(firstName).join(".") : path;
}

/**
 * Query words that name a symbol rather than describe one: a camelCase or
 * PascalCase identifier (`applyDeltas`, `AbstractRepositoryTask`), or a dotted
 * one (`ModuleManagerImpl.applyDeltas`). A plain word like "module" is not one.
 */
export function identifiersIn(query: string): string[] {
  return query
    .split(/\s+/)
    .filter((w) => /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(w) && /[a-z][A-Z]|\.|_|^[A-Z][a-z0-9]+[A-Z]/.test(w));
}

/** Does the chunk's name end with `identifier`, at a name boundary? `Type.member(…)` matches `member` and `Type.member`. */
function namedBy(chunk: Chunk, identifier: string): boolean {
  const name = chunkTitle(chunk).replace(/\(.*$/, "");
  return name === identifier || name.endsWith(`.${identifier}`);
}

/** Bump when the indexed fields change, so `index` rebuilds older index files. */
export const BM25_INDEX_VERSION = 2;

/** A chunk's names weigh more than its body: they are what a lookup by name is after. */
const FIELD_WEIGHTS = { title: 3, text: 1 };

function newEngine() {
  const engine = bm25();
  engine.defineConfig({ fldWeights: FIELD_WEIGHTS });
  engine.definePrepTasks([prepTask]);
  engine.definePrepTasks([prepTitle], "title");
  return engine;
}

/** Does `indexPath` hold an index in the current format? */
export function isCurrentBM25Index(indexPath: string): boolean {
  if (!existsSync(indexPath)) return false;
  try {
    return JSON.parse(readFileSync(indexPath, "utf-8")).version === BM25_INDEX_VERSION;
  } catch {
    return false;
  }
}

interface ChunkRef {
  path: string;   // absolute file path
  offset: number; // chunk offset within that file
}

interface IndexDoc {
  id: string;   // path:offset
  title: string;
  text: string;
}

/**
 * Build a BM25 engine from the given items and serialize it to indexPath.
 * Each chunk is indexed as its own BM25 document.
 */
export function buildBM25Index(items: KnowItem[], indexPath: string): void {
  const engine = newEngine();

  const refs: ChunkRef[] = [];
  let docIdx = 0;

  for (const item of items) {
    for (const chunk of item.chunks) {
      refs.push({ path: item.path, offset: chunk.offset });
      const doc: IndexDoc = {
        id: `${item.path}:${chunk.offset}`,
        title: chunkTitle(chunk),
        text: chunk.text,
      };
      engine.addDoc(doc, docIdx++);
    }
  }

  // wink-bm25 requires at least 3 documents to consolidate
  const MIN_DOCS = 3;
  for (let pad = refs.length; pad < MIN_DOCS; pad++) {
    engine.addDoc({ id: `__pad_${pad}`, title: "", text: "" }, docIdx++);
    refs.push({ path: `__pad_${pad}`, offset: -1 });
  }

  engine.consolidate();

  // Serialize: store the index data alongside a chunk lookup table
  const serialized = {
    version: BM25_INDEX_VERSION,
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

  const engine = newEngine();
  engine.importJSON(serialized.index);

  const rawResults: [number, number][] = engine.search(query, topN);

  const itemsByPath = new Map<string, KnowItem>(items.map((i) => [i.path, i]));

  // BM25 normalises by the whole chunk's length, so a class whose chunk is its
  // entire body loses to a short note that merely mentions its name. A query
  // naming a symbol is a lookup: the symbols with that exact name come first.
  const exact = exactMatches(items, identifiersIn(query), query, rawResults[0]?.[1] ?? 1);
  const exactKeys = new Set(exact.map((r) => `${r.path}:${r.chunkOffset}`));

  const ranked = rawResults
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
    .filter((r): r is BM25SearchResult => r !== undefined && r.path !== undefined)
    .filter((r) => !exactKeys.has(`${r.path}:${r.chunkOffset}`));
  return [...exact, ...ranked].slice(0, topN);
}

/**
 * The chunks named exactly by one of `identifiers`, types before members —
 * the type is what an exact type name asks for.
 * @param query picks each match's snippet.
 * @param score reported for each match; a match ranks by name, not by score.
 */
export function exactMatches(items: KnowItem[], identifiers: string[], query = identifiers.join(" "), score = 0): BM25SearchResult[] {
  if (identifiers.length === 0) return [];
  const exact: BM25SearchResult[] = [];
  for (const item of items) {
    for (const chunk of item.chunks) {
      if (!identifiers.some((id) => namedBy(chunk, id))) continue;
      exact.push({
        path: item.path,
        score,
        exact: true,
        snippet: bestSnippet(chunk, query),
        chunkOffset: chunk.offset,
        title: chunk.title,
        titlePath: chunk.titlePath,
        startLine: chunk.startLine,
      });
    }
  }
  return exact.sort((a, b) => Number(a.titlePath?.includes("(") ?? false) - Number(b.titlePath?.includes("(") ?? false));
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
