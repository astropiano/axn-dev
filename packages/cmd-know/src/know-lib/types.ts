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
  startLine?: number;   // 1-based, inclusive; set by extractors that parse source
  endLine?: number;
  /** Legacy: vectors stored inline before the corpus vector store. Read once to migrate them, then removed. */
  embedding?: number[];
}

/** What a parsed source file declares and uses, for answering references without another tool. */
export interface CodeFacts {
  /** The file's package, when the language has one. */
  package?: string;
  /** Imported names, wildcards as `pkg.*`. Static imports are left out: they import members, not types. */
  imports: string[];
  /** Each type name the file uses, as written (`Foo`, `Outer.Inner`, `a.b.Foo`), with the lines it is used on. */
  types: Record<string, number[]>;
}

export interface KnowItem {
  path: string;
  added: string;
  hash?: string;
  git_repo?: string;
  git_commit?: string;
  chunks: Chunk[];
  /** Set for languages whose extractor records them (Java). */
  code?: CodeFacts;
}

export interface BM25SearchResult {
  path: string;
  score: number;
  /** The chunk's name is exactly an identifier in the query; ranks first through fusion. */
  exact?: boolean;
  snippet: string;
  chunkOffset: number;
  title?: string;
  titlePath?: string;
  startLine?: number;
  corpus?: string;
}

export interface VectorSearchResult {
  path: string;
  similarity: number;
  snippet: string;
  chunkOffset: number;
  title?: string;
  titlePath?: string;
  startLine?: number;
  corpus?: string;
}

export type SearchResult = BM25SearchResult | VectorSearchResult;
