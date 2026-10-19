/**
 * Tests for vector and hybrid search modes.
 * embedText is mocked so no model downloads are needed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// --- Mock the entire vector module so bruteForceCosineSearch uses mock embedText ---
const DIM = 8;
function mockEmbedSync(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (let i = 0; i < text.length; i++) v[text.charCodeAt(i) % DIM] += 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

vi.mock("./vector.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./vector.js")>();
  const mockEmbedText = vi.fn(async (text: string) => mockEmbedSync(text));

  async function mockBruteForceCosineSearch(
    items: import("./types.js").KnowItem[],
    query: string,
    topN = 5
  ): Promise<import("./types.js").VectorSearchResult[]> {
    const queryVec = await mockEmbedText(query);
    const candidates: import("./types.js").VectorSearchResult[] = [];
    for (const item of items) {
      for (const chunk of item.chunks) {
        if (!chunk.embedding) continue;
        const sim = original.cosineSimilarity(queryVec, chunk.embedding);
        if (sim > 0) {
          candidates.push({
            path: item.path,
            similarity: sim,
            snippet: chunk.text,
            chunkOffset: chunk.offset,
          });
        }
      }
    }
    candidates.sort((a, b) => b.similarity - a.similarity);
    return candidates.slice(0, topN);
  }

  return {
    ...original,
    embedText: mockEmbedText,
    bruteForceCosineSearch: mockBruteForceCosineSearch,
  };
});

import { cosineSimilarity, bruteForceCosineSearch } from "./vector.js";
import { buildBM25Index, buildIndex, search } from "./bm25.js";
import type { KnowItem, CorpusConfig } from "./types.js";

const TMP = join(tmpdir(), "axn-know-vec-test-" + process.pid);
const IDX = join(TMP, "index.json");

beforeAll(() => mkdirSync(TMP, { recursive: true }));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

// Pre-embed items using the same logic as the mock (DIM=8)
function makeEmbedded(words: string): number[] {
  return mockEmbedSync(words);
}

const items: KnowItem[] = [
  {
    path: "/docs/docker.md",
    added: new Date().toISOString(),
    hash: "sha256:1",
    chunks: [
      { offset: 0, text: "docker compose containerisation", embedding: makeEmbedded("docker compose containerisation") },
      { offset: 1, text: "docker volumes persist data", embedding: makeEmbedded("docker volumes persist data") },
    ],
  },
  {
    path: "/docs/raspberry.md",
    added: new Date().toISOString(),
    hash: "sha256:2",
    chunks: [
      { offset: 0, text: "raspberry pi embedded single board computer", embedding: makeEmbedded("raspberry pi embedded single board computer") },
      { offset: 1, text: "boot pi write image sd card", embedding: makeEmbedded("boot pi write image sd card") },
    ],
  },
  {
    path: "/docs/keycloak.md",
    added: new Date().toISOString(),
    hash: "sha256:3",
    chunks: [
      { offset: 0, text: "keycloak identity access management", embedding: makeEmbedded("keycloak identity access management") },
      { offset: 1, text: "keycloak oauth2 authentication realm client", embedding: makeEmbedded("keycloak oauth2 authentication realm client") },
    ],
  },
];

// Items without embeddings (for testing that they are skipped)
const itemsNoEmbeddings: KnowItem[] = [
  {
    path: "/docs/noEmbed.md",
    added: new Date().toISOString(),
    hash: "sha256:4",
    chunks: [
      { offset: 0, text: "some text without embedding" },
    ],
  },
];

describe("bruteForceCosineSearch", () => {
  it("returns results for a relevant query", async () => {
    const results = await bruteForceCosineSearch(items, "docker compose", 5);
    expect(results.length).toBeGreaterThan(0);
  });

  it("result similarity values are in [-1, 1]", async () => {
    const results = await bruteForceCosineSearch(items, "keycloak authentication", 5);
    for (const r of results) {
      expect(r.similarity).toBeGreaterThanOrEqual(-1);
      expect(r.similarity).toBeLessThanOrEqual(1);
    }
  });

  it("respects topN limit", async () => {
    const results = await bruteForceCosineSearch(items, "docker", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("returns empty array when no items have embeddings", async () => {
    const results = await bruteForceCosineSearch(itemsNoEmbeddings, "something", 5);
    expect(results).toEqual([]);
  });

  it("results are sorted by similarity descending", async () => {
    const results = await bruteForceCosineSearch(items, "docker", 5);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].similarity).toBeGreaterThanOrEqual(results[i].similarity);
    }
  });

  it("snippet matches the chunk text", async () => {
    const results = await bruteForceCosineSearch(items, "docker", 1);
    expect(results[0].snippet.length).toBeGreaterThan(0);
    // Snippet should be one of the chunk texts
    const allChunkTexts = items.flatMap((i) => i.chunks.map((c) => c.text));
    expect(allChunkTexts).toContain(results[0].snippet);
  });
});

describe("search — vector mode", () => {
  const config: CorpusConfig = { name: "test", indexing: "vector", vector: { model: "mock", dimensions: 8, threshold: 0.5 } };

  it("returns results without a BM25 index file", async () => {
    const results = await search("/nonexistent/index.json", items, config, "keycloak auth", 3);
    expect(results.length).toBeGreaterThan(0);
  });

  it("all results have similarity field", async () => {
    const results = await search("/nonexistent/index.json", items, config, "docker", 5);
    for (const r of results) {
      expect("similarity" in r).toBe(true);
    }
  });
});

describe("search — hybrid mode", () => {
  const config: CorpusConfig = { name: "test", indexing: "hybrid", vector: { model: "mock", dimensions: 8, threshold: 0.5 } };

  beforeAll(() => buildBM25Index(items, IDX));

  it("returns results combining BM25 and vector", async () => {
    const results = await search(IDX, items, config, "docker compose", 5);
    expect(results.length).toBeGreaterThan(0);
  });

  it("respects topN limit", async () => {
    const results = await search(IDX, items, config, "keycloak", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("all results have a snippet", async () => {
    const results = await search(IDX, items, config, "raspberry pi boot", 5);
    for (const r of results) {
      expect(r.snippet.length).toBeGreaterThan(0);
    }
  });
});

describe("buildIndex — vector mode", () => {
  const config: CorpusConfig = { name: "test", indexing: "vector" };

  it("calls embedText and populates chunk embeddings", async () => {
    const { embedText } = await import("./vector.js");
    // Items without embeddings — buildIndex should generate them
    const fresh: KnowItem[] = [
      {
        path: "/docs/fresh.md",
        added: new Date().toISOString(),
        hash: "sha256:99",
        chunks: [
          { offset: 0, text: "hello world" },
          { offset: 1, text: "foo bar baz" },
        ],
      },
    ];
    await buildIndex(fresh, join(TMP, "vec-only.json"), config);
    // embedText should have been called once per chunk
    expect(embedText).toHaveBeenCalledWith("hello world");
    expect(embedText).toHaveBeenCalledWith("foo bar baz");
    // Embeddings should now be set on chunks
    expect(fresh[0].chunks[0].embedding).toBeDefined();
    expect(fresh[0].chunks[0].embedding!.length).toBe(8);
  });
});
