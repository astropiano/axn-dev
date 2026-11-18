import { describe, it, expect, afterAll, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KnowCommand } from "./know.js";
import { loadAllItems, saveItem, vectorsBase } from "./know-lib/storage.js";
import { VectorStore } from "./know-lib/vectorStore.js";

const TMP = join(tmpdir(), "axn-know-vector-test-" + process.pid);
const AXN_ROOT = join(TMP, ".axn-dev");

vi.mock("./know-lib/storage.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./know-lib/storage.js")>();
  return { ...original, resolveAxnDevRoot: (_scope: string) => AXN_ROOT };
});

// No model download: a fixed-size vector is all persistence needs.
vi.mock("./know-lib/vector.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./know-lib/vector.js")>();
  return { ...original, embedText: vi.fn(async (text: string) => [text.length, 1, 0]) };
});

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("know index — vector corpus", () => {
  it("writes the embeddings it generates to the corpus vector store, not the item files", async () => {
    const docs = join(TMP, "docs");
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, "a.md"), "# A\n\nfirst paragraph\n\nsecond paragraph");

    const cmd = new KnowCommand();
    await cmd.execute(["add", docs, "-c", "vec", "-i", "vector"]);
    await cmd.execute(["index", "-c", "vec"]);

    // Read back from disk: embeddings held only in memory are lost when the process exits.
    const chunks = loadAllItems(AXN_ROOT, "vec").flatMap((i) => i.chunks);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.some((c) => c.embedding)).toBe(false);
    const store = VectorStore.load(vectorsBase(AXN_ROOT, "vec"))!;
    expect(store.size).toBe(chunks.length);
    expect(store.dim).toBe(3);
  });
});

describe("know index — corpus with vectors inside its item files", () => {
  it("moves them into the vector store and drops them from the item files", async () => {
    const docs = join(TMP, "legacy");
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, "b.md"), "# B\n\nonly paragraph");
    const cmd = new KnowCommand();
    await cmd.execute(["add", docs, "-c", "legacy", "-i", "vector"]);
    await cmd.execute(["index", "-c", "legacy"]);

    // Recreate the old layout: vectors inline, no store.
    const [item] = loadAllItems(AXN_ROOT, "legacy");
    item.chunks.forEach((c) => (c.embedding = [9, 9, 9]));
    saveItem(AXN_ROOT, "legacy", item);
    rmSync(`${vectorsBase(AXN_ROOT, "legacy")}.json`);
    rmSync(`${vectorsBase(AXN_ROOT, "legacy")}.bin`);

    await cmd.execute(["index", "-c", "legacy"]);

    expect(loadAllItems(AXN_ROOT, "legacy").flatMap((i) => i.chunks).some((c) => c.embedding)).toBe(false);
    const rows = [...VectorStore.load(vectorsBase(AXN_ROOT, "legacy"))!.rows()];
    expect(rows.map((r) => Array.from(r.vector))).toEqual(item.chunks.map(() => [9, 9, 9]));
  });
});
