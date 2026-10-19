export type IndexingTechnique = "bm25" | "vector" | "hybrid";

export interface VectorConfig {
  model: string;
  dimensions: number;
  threshold?: number; // for hybrid re-ranking
}

export interface CorpusConfig {
  name: string;
  indexing: IndexingTechnique;
  vector?: VectorConfig;
}

export interface Chunk {
  offset: number;
  text: string;
  title?: string;       // human-readable label (class, method, section...)
  titlePath?: string;   // dotted/qualified path, e.g. "MyClass.myMethod"
  embedding?: number[];
}

export interface KnowItem {
  path: string;
  added: string;
  hash?: string;
  git_repo?: string;
  git_commit?: string;
  chunks: Chunk[];
}

export interface BM25SearchResult {
  path: string;
  score: number;
  snippet: string;
  chunkOffset: number;
  title?: string;
  titlePath?: string;
  corpus?: string;
}

export interface VectorSearchResult {
  path: string;
  similarity: number;
  snippet: string;
  chunkOffset: number;
  title?: string;
  titlePath?: string;
  corpus?: string;
}

export type SearchResult = BM25SearchResult | VectorSearchResult;
