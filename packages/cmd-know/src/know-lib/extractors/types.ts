import type { Chunk } from "../types.js";

export interface Extractor {
  extract(text: string): Omit<Chunk, "offset">[];
}

export interface RawUnit {
  start: number;
  end: number;
  name: string;
  text: string;
  kind: "class" | "method" | "property" | "function" | "section";
  parentName?: string;
}
