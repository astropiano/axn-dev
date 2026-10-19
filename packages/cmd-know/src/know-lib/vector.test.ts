import { describe, it, expect } from "vitest";
import { cosineSimilarity } from "./vector.js";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = [0.5, 0.3, 0.8, 0.1];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 5);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1, 5);
  });

  it("is commutative", () => {
    const a = [0.2, 0.4, 0.6];
    const b = [0.1, 0.9, 0.3];
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 10);
  });

  it("returns 0 for zero vector", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it("throws when dimensions differ", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow("dimensions must match");
  });

  it("normalised vectors give same result as unnormalised", () => {
    const a = [3, 4];
    const b = [4, 3];
    // Cosine should be dot(a,b) / (|a| * |b|) = (12+12)/(5*5) = 24/25
    expect(cosineSimilarity(a, b)).toBeCloseTo(24 / 25, 5);
  });
});
