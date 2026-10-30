import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

interface FileVectors {
  /** Content hash of the file the vectors were computed from. */
  hash: string;
  /** Chunk offset of each row, in row order. */
  offsets: number[];
  /** offsets.length × dim values, row-major. */
  data: Float32Array;
}

interface StoreMeta {
  model: string;
  dim: number;
  files: { path: string; hash: string; offsets: number[] }[];
}

export interface VectorRow {
  path: string;
  offset: number;
  vector: Float32Array;
}

/**
 * Chunk embeddings for one corpus, kept apart from the item YAMLs so a search
 * reads one binary blob instead of parsing every vector as YAML text.
 * On disk: `<base>.json` (model, dimension, which rows belong to which file)
 * and `<base>.bin` (all rows as float32, in the order the JSON lists them).
 */
export class VectorStore {
  private readonly files = new Map<string, FileVectors>();

  constructor(readonly model: string, readonly dim: number) {}

  /** The stored vectors, or null when none were written yet. */
  static load(base: string): VectorStore | null {
    if (!existsSync(`${base}.json`) || !existsSync(`${base}.bin`)) return null;
    const meta = JSON.parse(readFileSync(`${base}.json`, "utf-8")) as StoreMeta;
    const bytes = readFileSync(`${base}.bin`);
    const all = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const store = new VectorStore(meta.model, meta.dim);
    let row = 0;
    for (const f of meta.files) {
      const rows = f.offsets.length;
      store.files.set(f.path, {
        hash: f.hash,
        offsets: f.offsets,
        data: all.slice(row * meta.dim, (row + rows) * meta.dim),
      });
      row += rows;
    }
    return store;
  }

  /** Writes both files via a temp name, so an interrupted save leaves the previous pair intact. */
  save(base: string): void {
    const meta: StoreMeta = { model: this.model, dim: this.dim, files: [] };
    const total = [...this.files.values()].reduce((n, f) => n + f.offsets.length, 0);
    const all = new Float32Array(total * this.dim);
    let row = 0;
    for (const [path, f] of this.files) {
      meta.files.push({ path, hash: f.hash, offsets: f.offsets });
      all.set(f.data, row * this.dim);
      row += f.offsets.length;
    }
    writeFileSync(`${base}.bin.tmp`, Buffer.from(all.buffer, all.byteOffset, all.byteLength));
    writeFileSync(`${base}.json.tmp`, JSON.stringify(meta));
    renameSync(`${base}.bin.tmp`, `${base}.bin`);
    renameSync(`${base}.json.tmp`, `${base}.json`);
  }

  /** Are this file's vectors present and computed from content with this hash? */
  isCurrent(path: string, hash: string): boolean {
    return this.files.get(path)?.hash === hash;
  }

  set(path: string, hash: string, offsets: number[], vectors: number[][]): void {
    const data = new Float32Array(offsets.length * this.dim);
    vectors.forEach((v, i) => {
      if (v.length !== this.dim) throw new Error(`Vector of dimension ${v.length}, store expects ${this.dim}`);
      data.set(v, i * this.dim);
    });
    this.files.set(path, { hash, offsets, data });
  }

  delete(path: string): boolean {
    return this.files.delete(path);
  }

  paths(): string[] {
    return [...this.files.keys()];
  }

  get size(): number {
    let n = 0;
    for (const f of this.files.values()) n += f.offsets.length;
    return n;
  }

  *rows(): Generator<VectorRow> {
    for (const [path, f] of this.files) {
      for (let i = 0; i < f.offsets.length; i++) {
        yield { path, offset: f.offsets[i], vector: f.data.subarray(i * this.dim, (i + 1) * this.dim) };
      }
    }
  }
}
