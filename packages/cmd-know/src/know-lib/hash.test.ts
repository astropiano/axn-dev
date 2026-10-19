import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashFile, needsReindex } from "./hash.js";

const TMP = join(tmpdir(), "axn-know-hash-test-" + process.pid);

beforeAll(() => mkdirSync(TMP, { recursive: true }));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("hashFile", () => {
  it("returns a sha256: prefixed string", () => {
    const f = join(TMP, "a.txt");
    writeFileSync(f, "hello world");
    const h = hashFile(f);
    expect(h).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("is stable for the same content", () => {
    const f = join(TMP, "stable.txt");
    writeFileSync(f, "same content");
    expect(hashFile(f)).toBe(hashFile(f));
  });

  it("differs for different content", () => {
    const f1 = join(TMP, "c1.txt");
    const f2 = join(TMP, "c2.txt");
    writeFileSync(f1, "content one");
    writeFileSync(f2, "content two");
    expect(hashFile(f1)).not.toBe(hashFile(f2));
  });
});

describe("needsReindex", () => {
  it("returns false when hashes match and no git commits", () => {
    expect(needsReindex("sha256:abc", undefined, "sha256:abc", undefined)).toBe(false);
  });

  it("returns true when hashes differ and no git commits", () => {
    expect(needsReindex("sha256:new", undefined, "sha256:old", undefined)).toBe(true);
  });

  it("uses git commit when both present — returns false if same", () => {
    expect(needsReindex("sha256:any", "commit1", "sha256:other", "commit1")).toBe(false);
  });

  it("uses git commit when both present — returns true if different", () => {
    expect(needsReindex("sha256:any", "commit2", "sha256:any", "commit1")).toBe(true);
  });

  it("falls back to hash when stored has no git commit", () => {
    expect(needsReindex("sha256:new", "commit1", "sha256:old", undefined)).toBe(true);
  });
});
