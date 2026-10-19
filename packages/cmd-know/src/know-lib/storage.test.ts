import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  pathToSlug,
  ensureCorpus,
  saveItem,
  loadItem,
  loadAllItems,
  removeItem,
  corpusConfigPath,
  itemsDir,
  indexPath,
} from "./storage.js";
import type { KnowItem } from "./types.js";

const TMP = join(tmpdir(), "axn-know-storage-test-" + process.pid);

beforeAll(() => mkdirSync(TMP, { recursive: true }));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const CORPUS = "test-corpus";

const makeItem = (path: string): KnowItem => ({
  path,
  added: new Date().toISOString(),
  hash: "sha256:abc123",
  chunks: [{ offset: 0, text: "some text" }],
});

describe("pathToSlug", () => {
  it("removes leading slash", () => {
    expect(pathToSlug("/foo/bar.md")).not.toMatch(/^\//);
  });

  it("replaces path separators with underscores", () => {
    expect(pathToSlug("/foo/bar/baz.md")).toBe("foo_bar_baz.md");
  });

  it("preserves dots and dashes", () => {
    expect(pathToSlug("/docs/my-file.md")).toBe("docs_my-file.md");
  });
});

describe("ensureCorpus", () => {
  it("creates items directory", () => {
    ensureCorpus(TMP, CORPUS);
    expect(existsSync(itemsDir(TMP, CORPUS))).toBe(true);
  });

  it("creates corpus.yaml", () => {
    ensureCorpus(TMP, CORPUS);
    expect(existsSync(corpusConfigPath(TMP, CORPUS))).toBe(true);
  });

  it("is idempotent", () => {
    expect(() => ensureCorpus(TMP, CORPUS)).not.toThrow();
  });
});

describe("saveItem / loadItem", () => {
  it("roundtrips an item correctly", () => {
    const item = makeItem("/docs/readme.md");
    saveItem(TMP, CORPUS, item);
    const loaded = loadItem(TMP, CORPUS, "/docs/readme.md");
    expect(loaded).not.toBeNull();
    expect(loaded!.path).toBe("/docs/readme.md");
    expect(loaded!.hash).toBe("sha256:abc123");
    expect(loaded!.chunks).toHaveLength(1);
    expect(loaded!.chunks[0].text).toBe("some text");
  });

  it("preserves optional git fields", () => {
    const item: KnowItem = {
      ...makeItem("/repo/file.ts"),
      git_repo: "/repo",
      git_commit: "deadbeef",
    };
    saveItem(TMP, CORPUS, item);
    const loaded = loadItem(TMP, CORPUS, "/repo/file.ts");
    expect(loaded!.git_repo).toBe("/repo");
    expect(loaded!.git_commit).toBe("deadbeef");
  });

  it("returns null for untracked file", () => {
    expect(loadItem(TMP, CORPUS, "/nonexistent/file.md")).toBeNull();
  });
});

describe("loadAllItems", () => {
  it("returns all saved items", () => {
    const root = join(TMP, "multi-corpus");
    saveItem(root, "c1", makeItem("/a.md"));
    saveItem(root, "c1", makeItem("/b.md"));
    saveItem(root, "c1", makeItem("/c.md"));
    const items = loadAllItems(root, "c1");
    expect(items.length).toBeGreaterThanOrEqual(3);
  });

  it("returns empty array when corpus does not exist", () => {
    expect(loadAllItems(TMP, "nonexistent-corpus")).toEqual([]);
  });
});

describe("removeItem", () => {
  it("removes a tracked item and returns true", () => {
    const item = makeItem("/to-remove.md");
    saveItem(TMP, CORPUS, item);
    expect(loadItem(TMP, CORPUS, "/to-remove.md")).not.toBeNull();
    const result = removeItem(TMP, CORPUS, "/to-remove.md");
    expect(result).toBe(true);
    expect(loadItem(TMP, CORPUS, "/to-remove.md")).toBeNull();
  });

  it("returns false for untracked file", () => {
    expect(removeItem(TMP, CORPUS, "/ghost.md")).toBe(false);
  });
});

describe("indexPath", () => {
  it("returns path inside corpus dir", () => {
    const p = indexPath(TMP, CORPUS);
    expect(p).toContain(CORPUS);
    expect(p).toMatch(/index\.json$/);
  });
});
