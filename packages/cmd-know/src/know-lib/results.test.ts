import { describe, it, expect } from "vitest";
import { groupByFile, isTestPath } from "./results.js";
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
