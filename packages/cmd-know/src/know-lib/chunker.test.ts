import { describe, it, expect } from "vitest";
import { chunkText, chunksToDocument } from "./chunker.js";

describe("chunkText", () => {
  it("returns empty array for empty string", () => {
    expect(chunkText("")).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(chunkText("   \n\n   ")).toEqual([]);
  });

  it("splits on blank lines into paragraphs", () => {
    const text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].text).toBe("First paragraph.");
    expect(chunks[1].text).toBe("Second paragraph.");
    expect(chunks[2].text).toBe("Third paragraph.");
  });

  it("assigns sequential offsets", () => {
    const text = "A\n\nB\n\nC";
    const chunks = chunkText(text);
    expect(chunks.map((c) => c.offset)).toEqual([0, 1, 2]);
  });

  it("splits markdown headings as new chunks within a block", () => {
    const text = "# Heading One\nSome content.\n## Heading Two\nMore content.";
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].text).toContain("Heading One");
    expect(chunks.some((c) => c.text.includes("Heading Two"))).toBe(true);
  });

  it("handles single paragraph with no blank lines", () => {
    const text = "Just one paragraph\nwith multiple lines.";
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain("Just one paragraph");
  });

  it("handles multiple blank lines between paragraphs", () => {
    const text = "Para one.\n\n\n\nPara two.";
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(2);
  });
});

describe("chunksToDocument", () => {
  it("joins chunks with double newline", () => {
    const chunks = [
      { offset: 0, text: "First" },
      { offset: 1, text: "Second" },
    ];
    expect(chunksToDocument(chunks)).toBe("First\n\nSecond");
  });

  it("returns empty string for empty array", () => {
    expect(chunksToDocument([])).toBe("");
  });
});
