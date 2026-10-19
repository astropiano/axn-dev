import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildBM25Index, buildIndex, search } from "./bm25.js";
import type { CorpusConfig } from "./types.js";
import type { KnowItem } from "./types.js";

const TMP = join(tmpdir(), "axn-know-bm25-test-" + process.pid);
const IDX = join(TMP, "index.json");

beforeAll(() => mkdirSync(TMP, { recursive: true }));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const items: KnowItem[] = [
  {
    path: "/docs/docker.md",
    added: new Date().toISOString(),
    hash: "sha256:1",
    chunks: [
      { offset: 0, text: "Docker is a platform for containerization. Use docker-compose to manage multi-container applications." },
      { offset: 1, text: "Docker volumes persist data between container restarts." },
    ],
  },
  {
    path: "/docs/raspberry.md",
    added: new Date().toISOString(),
    hash: "sha256:2",
    chunks: [
      { offset: 0, text: "The Raspberry Pi is a small single-board computer used for embedded projects." },
      { offset: 1, text: "Boot the Raspberry Pi by writing an OS image to an SD card." },
    ],
  },
  {
    path: "/docs/keycloak.md",
    added: new Date().toISOString(),
    hash: "sha256:3",
    chunks: [
      { offset: 0, text: "Keycloak is an open-source identity and access management solution." },
      { offset: 1, text: "Configure Keycloak realms and clients for OAuth2 authentication flows." },
    ],
  },
];

describe("buildBM25Index", () => {
  it("writes index.json without throwing", async () => {
    expect(() => buildBM25Index(items, IDX)).not.toThrow();
    expect(existsSync(IDX)).toBe(true);
  });

  it("handles fewer than 3 items by padding", () => {
    const idxSmall = join(TMP, "small.json");
    expect(() => buildBM25Index(items.slice(0, 1), idxSmall)).not.toThrow();
  });

  it("handles empty items array", () => {
    const idxEmpty = join(TMP, "empty.json");
    expect(() => buildBM25Index([], idxEmpty)).not.toThrow();
  });
});

describe("search (BM25 mode)", () => {
  const config: CorpusConfig = { name: "test", indexing: "bm25" };
  beforeAll(() => buildBM25Index(items, IDX));

  it("returns results for a matching query", async () => {
    const results = await search(IDX, items, config, "docker compose", 5);
    expect(results.length).toBeGreaterThan(0);
    if ("score" in results[0]) {
      expect(results[0].path).toBe("/docs/docker.md");
    }
  });

  it("top result for raspberry query is raspberry doc", async () => {
    const results = await search(IDX, items, config, "raspberry pi boot", 5);
    expect(results.length).toBeGreaterThan(0);
    if ("score" in results[0]) {
      expect(results[0].path).toBe("/docs/raspberry.md");
    }
  });

  it("returns snippet text", async () => {
    const results = await search(IDX, items, config, "keycloak authentication", 5);
    expect(results[0].snippet.length).toBeGreaterThan(0);
  });

  it("respects topN limit", async () => {
    const results = await search(IDX, items, config, "the", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("returns empty array when index does not exist", async () => {
    const results = await search(join(TMP, "nonexistent.json"), items, config, "query", 5);
    expect(results).toEqual([]);
  });

  it("snippet is max 300 chars", async () => {
    const results = await search(IDX, items, config, "docker", 5);
    for (const r of results) {
      expect(r.snippet.length).toBeLessThanOrEqual(300);
    }
  });
});
