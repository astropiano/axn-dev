import { describe, it, expect } from "vitest";
import { fuseFiles, groupByFile, isTestPath } from "./results.js";
import type { SearchResult } from "./types.js";

describe("isTestPath", () => {
  it.each([
    "/repo/magnolia-core/src/test/java/info/magnolia/FooTest.java",
    "/repo/src/test/resources/fixture.yaml",
    "/repo/src/__tests__/chunker.ts",
    "/repo/tests/integration/run.py",
    "/repo/src/chunker.test.ts",
    "/repo/src/view.spec.tsx",
    "/repo/src/main/java/FooIT.java",
    "/repo/src/main/java/FooTests.java",
    "/repo/pkg/server_test.go",
    "/repo/app/test_models.py",
  ])("treats %s as a test", (path) => {
    expect(isTestPath(path)).toBe(true);
  });

  it.each([
    "/repo/magnolia-core/src/main/java/info/magnolia/module/delta/AbstractRepositoryTask.java",
    "/repo/src/main/java/info/magnolia/testing/TestUtil.java",
    "/repo/src/main/java/ContestEntry.java",
    "/repo/src/latest.ts",
    "/repo/docs/testing-guide.md",
  ])("treats %s as production", (path) => {
    expect(isTestPath(path)).toBe(false);
  });
});

describe("groupByFile", () => {
  const hit = (path: string, chunkOffset: number, score: number, corpus = "c"): SearchResult =>
    ({ path, chunkOffset, score, snippet: "", corpus });

  it("keeps each file's best chunk, in rank order, and counts the rest", () => {
    const grouped = groupByFile([hit("/a.java", 3, 9), hit("/b.java", 0, 8), hit("/a.java", 1, 7), hit("/a.java", 5, 2)]);

    expect(grouped.map((g) => [g.result.path, g.result.chunkOffset, g.moreInFile])).toEqual([
      ["/a.java", 3, 2],
      ["/b.java", 0, 0],
    ]);
  });

  it("keeps the same path in two corpora apart", () => {
    const grouped = groupByFile([hit("/a.java", 0, 9, "one"), hit("/a.java", 0, 8, "two")]);
    expect(grouped).toHaveLength(2);
  });
});

describe("fuseFiles", () => {
  const bm = (path: string, chunkOffset = 0): SearchResult => ({ path, chunkOffset, score: 1, snippet: `bm25 ${path}` });
  const vec = (path: string, chunkOffset = 0): SearchResult => ({ path, chunkOffset, similarity: 0.5, snippet: `vec ${path}` });
  const paths = (r: { result: SearchResult }[]) => r.map((x) => x.result.path);

  it("ranks a file both lists agree on first", () => {
    const fused = fuseFiles([[bm("/a"), bm("/b")], [vec("/a"), vec("/c")]], 3);
    expect(paths(fused)[0]).toBe("/a");
  });

  it("scores a file by its file rank, so another file's extra chunks take no ranks from it", () => {
    // /b is the third chunk but the second file of the BM25 list.
    const fused = fuseFiles([[bm("/a", 0), bm("/a", 1), bm("/b")], [vec("/b")]], 2);
    expect(fused.find((f) => f.result.path === "/b")!.fused).toBeCloseTo(1 / 62 + 1 / 61, 10);
  });

  it("counts distinct chunks of a file across both lists", () => {
    const fused = fuseFiles([[bm("/a", 0), bm("/a", 1)], [vec("/a", 1), vec("/a", 2)]], 5);
    expect(fused).toEqual([expect.objectContaining({ moreInFile: 2 })]);
  });

  it("shows the chunk from the list that ranks the file highest", () => {
    const fused = fuseFiles([[bm("/x"), bm("/a")], [vec("/a")]], 5);
    expect(fused.find((f) => f.result.path === "/a")!.result.snippet).toBe("vec /a");
  });

  it("sets a fused score only when several lists were fused", () => {
    expect(fuseFiles([[bm("/a")]], 5)[0].fused).toBeUndefined();
    expect(fuseFiles([[bm("/a")], [vec("/a")]], 5)[0].fused).toBeCloseTo(2 / 61, 6);
  });

  it("returns a single list in its own order", () => {
    expect(paths(fuseFiles([[bm("/c"), bm("/a"), bm("/c", 1), bm("/b")]], 10))).toEqual(["/c", "/a", "/b"]);
  });
});
