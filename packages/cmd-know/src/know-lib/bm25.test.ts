import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildBM25Index, chunkTitle, identifiersIn, isCurrentBM25Index, searchBM25Index } from "./bm25.js";
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

describe("searchBM25Index", () => {
  beforeAll(() => buildBM25Index(items, IDX));

  it("returns results for a matching query", async () => {
    const results = searchBM25Index(IDX, items, "docker compose", 5);
    expect(results.length).toBeGreaterThan(0);
    if ("score" in results[0]) {
      expect(results[0].path).toBe("/docs/docker.md");
    }
  });

  it("top result for raspberry query is raspberry doc", async () => {
    const results = searchBM25Index(IDX, items, "raspberry pi boot", 5);
    expect(results.length).toBeGreaterThan(0);
    if ("score" in results[0]) {
      expect(results[0].path).toBe("/docs/raspberry.md");
    }
  });

  it("returns snippet text", async () => {
    const results = searchBM25Index(IDX, items, "keycloak authentication", 5);
    expect(results[0].snippet.length).toBeGreaterThan(0);
  });

  it("respects topN limit", async () => {
    const results = searchBM25Index(IDX, items, "the", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("returns empty array when index does not exist", async () => {
    const results = searchBM25Index(join(TMP, "nonexistent.json"), items, "query", 5);
    expect(results).toEqual([]);
  });

  it("snippet is max 300 chars", async () => {
    const results = searchBM25Index(IDX, items, "docker", 5);
    for (const r of results) {
      expect(r.snippet.length).toBeLessThanOrEqual(300);
    }
  });
});

describe("BM25 title field", () => {
  // A long class body that names itself once, against a short note that names it too.
  const body = "public abstract class AbstractRepositoryTask extends AbstractTask {\n" +
    Array.from({ length: 40 }, (_, i) => `  void step${i}(Session s) { s.getNode("/x${i}").setProperty("p", ${i}); }`).join("\n") + "\n}";
  const named: KnowItem[] = [
    { path: "/notes.md", added: "", hash: "1", chunks: [{ offset: 0, text: "Mentions AbstractRepositoryTask once." }] },
    { path: "/a/AbstractRepositoryTask.java", added: "", hash: "2", chunks: [{ offset: 0, text: body, title: "AbstractRepositoryTask", titlePath: "info.magnolia.module.delta.AbstractRepositoryTask" }] },
    { path: "/a/Other.java", added: "", hash: "3", chunks: [{ offset: 0, text: "class Other {}", title: "Other", titlePath: "info.magnolia.Other" }] },
  ];
  const idx = join(TMP, "titled.json");
  beforeAll(() => buildBM25Index(named, idx));

  it("ranks the symbol named exactly by the query above a short text that mentions it", () => {
    expect(searchBM25Index(idx, named, "AbstractRepositoryTask", 3)[0].path).toBe("/a/AbstractRepositoryTask.java");
  });

  it("matches the camelCase parts of a name", () => {
    expect(searchBM25Index(idx, named, "repository task", 3)[0].path).toBe("/a/AbstractRepositoryTask.java");
  });

  it("finds a member by its name, and by its type-qualified name", () => {
    const withMember: KnowItem[] = [
      ...named,
      { path: "/a/Mgr.java", added: "", hash: "4", chunks: [{ offset: 0, text: "void applyDeltas() {}", title: "applyDeltas()", titlePath: "info.magnolia.Mgr.applyDeltas()" }] },
    ];
    expect(searchBM25Index(idx, withMember, "applyDeltas", 3)[0].path).toBe("/a/Mgr.java");
    expect(searchBM25Index(idx, withMember, "Mgr.applyDeltas", 3)[0].path).toBe("/a/Mgr.java");
  });

  it("does not match package names in the title", () => {
    // "delta" appears only in the package of AbstractRepositoryTask.
    expect(searchBM25Index(idx, named, "delta", 3)).toEqual([]);
  });
});

describe("chunkTitle", () => {
  it("drops the package from a Java title path", () => {
    expect(chunkTitle({ offset: 0, text: "", titlePath: "info.magnolia.module.ModuleManagerImpl.applyDeltas(ModuleDefinition)" }))
      .toBe("ModuleManagerImpl.applyDeltas(ModuleDefinition)");
    expect(chunkTitle({ offset: 0, text: "", titlePath: "a.Outer.Inner" })).toBe("Outer.Inner");
  });

  it("keeps titles that have no package", () => {
    expect(chunkTitle({ offset: 0, text: "", titlePath: "KnowCommand.find" })).toBe("KnowCommand.find");
    expect(chunkTitle({ offset: 0, text: "", title: "Setup" })).toBe("Setup");
    expect(chunkTitle({ offset: 0, text: "" })).toBe("");
  });
});

describe("isCurrentBM25Index", () => {
  it("is false for a missing file or an index from before titles were indexed, true after a build", () => {
    const old = join(TMP, "old-format.json");
    expect(isCurrentBM25Index(old)).toBe(false);
    writeFileSync(old, JSON.stringify({ index: {}, refs: [] }));
    expect(isCurrentBM25Index(old)).toBe(false);
    buildBM25Index(items, old);
    expect(isCurrentBM25Index(old)).toBe(true);
  });
});

describe("identifiersIn", () => {
  it("picks out words that name a symbol", () => {
    expect(identifiersIn("who extends AbstractRepositoryTask")).toEqual(["AbstractRepositoryTask"]);
    expect(identifiersIn("callers of applyDeltas")).toEqual(["applyDeltas"]);
    expect(identifiersIn("ModuleManagerImpl.applyDeltas")).toEqual(["ModuleManagerImpl.applyDeltas"]);
    expect(identifiersIn("MAX_RETRIES")).toEqual(["MAX_RETRIES"]);
  });

  it("leaves plain words alone, capitalised or not", () => {
    expect(identifiersIn("decide which module update tasks run")).toEqual([]);
    expect(identifiersIn("Module Update")).toEqual([]);
    expect(identifiersIn("JCR")).toEqual([]);
  });
});
