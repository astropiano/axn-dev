import type { KnowItem } from "./types.js";
import { EMBEDDING_MODEL, embedText } from "./vector.js";
import { VectorStore } from "./vectorStore.js";

/** Save this often, so an interrupted run keeps what it embedded. */
const SAVE_EVERY_CHUNKS = 2000;

export interface VectorSyncResult {
  embedded: number;
  removed: number;
  failed: number;
  /** Items whose legacy inline embeddings were moved into the store; the caller must save them. */
  migrated: KnowItem[];
}

export interface VectorSyncOptions {
  onProgress?: (done: number, total: number) => void;
  onError?: (message: string) => void;
}

/**
 * Bring the corpus's vector store in line with its items: drop vectors of
 * files no longer tracked, and embed every file whose content hash differs
 * from the one its vectors were computed from. A chunk the model fails on is
 * reported and skipped; it does not abort the run.
 */
export async function syncVectors(
  items: KnowItem[],
  base: string,
  { onProgress, onError }: VectorSyncOptions = {},
): Promise<VectorSyncResult> {
  let store = VectorStore.load(base);
  if (store && store.model !== EMBEDDING_MODEL) {
    onError?.(`Vectors were computed with ${store.model}; re-embedding everything with ${EMBEDDING_MODEL}.`);
    store = null;
  }

  const migrated = items.filter((i) => i.chunks.some((c) => c.embedding));
  const dim = store?.dim ?? migrated[0]?.chunks.find((c) => c.embedding)?.embedding?.length;
  let current: VectorStore | null = store ?? (dim ? new VectorStore(EMBEDDING_MODEL, dim) : null);

  for (const item of migrated) {
    // Inline embeddings come from before the store existed, all with the same model.
    if (item.hash && item.chunks.every((c) => c.embedding?.length === current!.dim) && !current!.isCurrent(item.path, item.hash)) {
      current!.set(item.path, item.hash, item.chunks.map((c) => c.offset), item.chunks.map((c) => c.embedding!));
    }
    for (const c of item.chunks) delete c.embedding;
  }

  const tracked = new Set(items.filter((i) => i.chunks.length > 0).map((i) => i.path));
  let removed = 0;
  for (const path of current?.paths() ?? []) {
    if (!tracked.has(path)) removed += current!.delete(path) ? 1 : 0;
  }

  const pending = items.filter((i) => i.chunks.length > 0 && !(current?.isCurrent(i.path, i.hash ?? "") ?? false));
  const total = pending.reduce((n, i) => n + i.chunks.length, 0);
  let done = 0;
  let failed = 0;
  let sinceSave = 0;
  onProgress?.(0, total);

  // One chunk per model call: batching measured no faster on this model,
  // because a batch is padded to its longest text.
  for (const item of pending) {
    const offsets: number[] = [];
    const vectors: number[][] = [];
    for (const chunk of item.chunks) {
      try {
        vectors.push(await embedText(chunk.text));
        offsets.push(chunk.offset);
      } catch (err) {
        failed++;
        onError?.(`embedding ${item.path} chunk ${chunk.offset} failed: ${(err as Error).message}`);
      }
      done++;
      sinceSave++;
      onProgress?.(done, total);
    }

    if (vectors.length > 0 && !current) current = new VectorStore(EMBEDDING_MODEL, vectors[0].length);
    // A file missing some vectors is stored under a hash that never matches, so the next run retries it.
    const hash = vectors.length === item.chunks.length ? item.hash ?? "" : `${item.hash}#partial`;
    current?.set(item.path, hash, offsets, vectors);

    if (sinceSave >= SAVE_EVERY_CHUNKS && current) {
      current.save(base);
      sinceSave = 0;
    }
  }

  if (current && (done > 0 || removed > 0 || migrated.length > 0)) current.save(base);
  return { embedded: done - failed, removed, failed, migrated };
}
