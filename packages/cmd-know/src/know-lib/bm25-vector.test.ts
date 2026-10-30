/**
 * Tests for the vector store, vector indexing, and per-engine search lists.
 * The model is mocked so no download is needed.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DIM = 8;
function mockEmbedSync(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (let i = 0; i < text.length; i++) v[text.charCodeAt(i) % DIM] += 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

/** Texts containing this marker make the mocked model throw. */
const POISON = "@@poison@@";

vi.mock("./vector.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./vector.js")>();
  const embedText = vi.fn(async (text: string) => {
    if (text.includes(POISON)) throw new Error("model rejected input");
    return mockEmbedSync(text);
  });
  return {
    ...original,
    embedText,
    bruteForceCosineSearch: async (store: any, items: any, query: string, topN = 5) =>
      original.vectorSearch(store, items, await embedText(query), topN),
  };
});

import { EMBEDDING_MODEL, embedText, vectorSearch } from "./vector.js";
import { VectorStore } from "./vectorStore.js";
import { syncVectors } from "./vectorIndex.js";
import { buildBM25Index, searchLists } from "./bm25.js";
import type { KnowItem, CorpusConfig } from "./types.js";

const TMP = join(tmpdir(), "axn-know-vec-test-" + process.pid);
const IDX = join(TMP, "index.json");

beforeAll(() => mkdirSync(TMP, { recursive: true }));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function item(path: string, hash: string, texts: string[]): KnowItem {
  return {
    path,
    added: new Date().toISOString(),
    hash,
    chunks: texts.map((text, offset) => ({ offset, text })),
  };
}

const items: KnowItem[] = [
  item("/docs/docker.md", "sha256:1", ["docker compose containerisation", "docker volumes persist data"]),
  item("/docs/raspberry.md", "sha256:2", ["raspberry pi embedded single board computer", "boot pi write image sd card"]),
  item("/docs/keycloak.md", "sha256:3", ["keycloak identity access management", "keycloak oauth2 authentication realm client"]),
];

function storeOf(list: KnowItem[]): VectorStore {
  const store = new VectorStore(EMBEDDING_MODEL, DIM);
  for (const i of list) store.set(i.path, i.hash!, i.chunks.map((c) => c.offset), i.chunks.map((c) => mockEmbedSync(c.text)));
  return store;
}

let base: string;
let n = 0;
beforeEach(() => {
  base = join(TMP, `vectors-${n++}`);
  vi.mocked(embedText).mockClear();
});

describe("VectorStore", () => {
  it("round-trips model, dimension and every row through save and load", () => {
    const store = storeOf(items);
    store.save(base);

    const loaded = VectorStore.load(base)!;
    expect(loaded.model).toBe(EMBEDDING_MODEL);
    expect(loaded.dim).toBe(DIM);
    expect(loaded.size).toBe(6);
    const row = [...loaded.rows()].find((r) => r.path === "/docs/keycloak.md" && r.offset === 1)!;
    const expected = mockEmbedSync("keycloak oauth2 authentication realm client");
    expected.forEach((x, i) => expect(row.vector[i]).toBeCloseTo(x, 6));
  });

  it("is absent until saved", () => {
    expect(VectorStore.load(base)).toBeNull();
  });

  it("knows which content hash a file's vectors belong to", () => {
    const store = storeOf(items);
    expect(store.isCurrent("/docs/docker.md", "sha256:1")).toBe(true);
    expect(store.isCurrent("/docs/docker.md", "sha256:changed")).toBe(false);
  });

  it("rejects a vector of the wrong dimension", () => {
    expect(() => new VectorStore(EMBEDDING_MODEL, DIM).set("/a", "h", [0], [[1, 2]])).toThrow("dimension");
  });
});

describe("vectorSearch", () => {
  const store = storeOf(items);

  it("ranks chunks by similarity, best first, within topN", () => {
    const results = vectorSearch(store, items, mockEmbedSync("keycloak oauth2"), 3);
    expect(results).toHaveLength(3);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].similarity).toBeGreaterThanOrEqual(results[i].similarity);
    }
  });

  it("returns the chunk's own text and metadata", () => {
    const [top] = vectorSearch(store, items, mockEmbedSync("docker compose containerisation"), 1);
    expect(top.path).toBe("/docs/docker.md");
    expect(top.snippet).toBe("docker compose containerisation");
  });

  it("skips vectors whose chunk no longer exists", () => {
    const shrunk = [item("/docs/docker.md", "sha256:1", ["docker compose containerisation"])];
    const results = vectorSearch(store, shrunk, mockEmbedSync("docker volumes persist data"), 10);
    expect(results.map((r) => `${r.path}:${r.chunkOffset}`)).toEqual(["/docs/docker.md:0"]);
  });
});

describe("syncVectors", () => {
  it("embeds every chunk's own text and writes the vectors to disk", async () => {
    const many = [item("/big.md", "h", Array.from({ length: 70 }, (_, i) => `chunk number ${i}`))];
    const result = await syncVectors(many, base);

    expect(result).toMatchObject({ embedded: 70, failed: 0, removed: 0 });
    // The plain chunk text, so vectors moved out of item files stay comparable with new ones.
    expect(vi.mocked(embedText).mock.calls.map(([t]) => t)).toEqual(many[0].chunks.map((c) => c.text));
    expect(VectorStore.load(base)!.size).toBe(70);
  });

  it("embeds nothing on a second run over unchanged files", async () => {
    await syncVectors(items, base);
    vi.mocked(embedText).mockClear();

    expect(await syncVectors(items, base)).toMatchObject({ embedded: 0 });
    expect(embedText).not.toHaveBeenCalled();
  });

  it("re-embeds a changed file and drops the vectors of an untracked one", async () => {
    await syncVectors(items, base);
    const changed = [item("/docs/docker.md", "sha256:new", ["docker swarm"]), items[1]];

    const result = await syncVectors(changed, base);

    expect(result).toMatchObject({ embedded: 1, removed: 1 });
    const stored = VectorStore.load(base)!;
    expect(stored.paths().sort()).toEqual(["/docs/docker.md", "/docs/raspberry.md"]);
    expect(stored.isCurrent("/docs/docker.md", "sha256:new")).toBe(true);
  });

  it("moves inline vectors into the store without calling the model, and strips them", async () => {
    const legacy = item("/legacy.md", "sha256:L", ["old one", "old two"]);
    legacy.chunks.forEach((c) => (c.embedding = mockEmbedSync(c.text)));

    const result = await syncVectors([legacy], base);

    expect(embedText).not.toHaveBeenCalled();
    expect(result.migrated).toEqual([legacy]);
    expect(legacy.chunks.every((c) => c.embedding === undefined)).toBe(true);
    expect(VectorStore.load(base)!.isCurrent("/legacy.md", "sha256:L")).toBe(true);
  });

  it("skips and reports a chunk the model fails on, keeps the rest, and retries the file next run", async () => {
    const mixed = item("/mixed.md", "sha256:M", ["fine text", `bad ${POISON}`, "also fine"]);
    const errors: string[] = [];

    const result = await syncVectors([mixed], base, { onError: (m) => errors.push(m) });

    expect(result).toMatchObject({ embedded: 2, failed: 1 });
    expect(errors.join("\n")).toContain("/mixed.md chunk 1");
    const stored = VectorStore.load(base)!;
    expect([...stored.rows()].map((r) => r.offset)).toEqual([0, 2]);
    expect(stored.isCurrent("/mixed.md", "sha256:M")).toBe(false);
  });

  it("re-embeds everything when the store was written with another model", async () => {
    const old = storeOf(items);
    Object.assign(old, { model: "some/other-model" });
    old.save(base);
    const errors: string[] = [];

    const result = await syncVectors(items, base, { onError: (m) => errors.push(m) });

    expect(result.embedded).toBe(6);
    expect(errors.join("\n")).toContain("some/other-model");
    expect(VectorStore.load(base)!.model).toBe(EMBEDDING_MODEL);
  });

  it("reports progress against a total counted up front", async () => {
    const calls: [number, number][] = [];
    await syncVectors(items, base, { onProgress: (done, total) => calls.push([done, total]) });
    expect(calls[0]).toEqual([0, 6]);
    expect(calls[calls.length - 1]).toEqual([6, 6]);
  });
});

describe("searchLists", () => {
  const store = storeOf(items);
  beforeAll(() => buildBM25Index(items, IDX));
  const config = (indexing: CorpusConfig["indexing"]): CorpusConfig => ({ name: "t", indexing });

  it("returns one BM25 list for a bm25 corpus", async () => {
    const lists = await searchLists(IDX, items, null, config("bm25"), "docker", 5);
    expect(lists).toHaveLength(1);
    expect("score" in lists[0][0]).toBe(true);
  });

  it("returns one vector list for a vector corpus, without a BM25 index", async () => {
    const lists = await searchLists("/nonexistent/index.json", items, store, config("vector"), "keycloak auth", 3);
    expect(lists).toHaveLength(1);
    expect(lists[0].every((r) => "similarity" in r)).toBe(true);
  });

  it("returns the BM25 list, then the vector list, for a hybrid corpus", async () => {
    const lists = await searchLists(IDX, items, store, config("hybrid"), "docker compose", 5);
    expect(lists).toHaveLength(2);
    expect("score" in lists[0][0]).toBe(true);
    expect("similarity" in lists[1][0]).toBe(true);
  });
});

describe("VectorStore — save", () => {
  it("leaves no temp files behind", () => {
    storeOf(items).save(base);
    expect(existsSync(`${base}.bin.tmp`) || existsSync(`${base}.json.tmp`)).toBe(false);
  });
});
