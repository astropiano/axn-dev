import type { SearchResult } from "./types.js";

const TEST_DIR = /(^|\/)(__tests__|tests?)\//;
const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?|(Test|Tests|IT)\.java|_test\.(py|go))$|(^|\/)test_[^/]*\.py$/;

/** Is this a test source, by the directory and file-name conventions of Java, TS/JS, Python and Go? */
export function isTestPath(path: string): boolean {
  return TEST_DIR.test(path) || TEST_FILE.test(path);
}

export interface FileResult {
  /** The file's best chunk: from the list it ranks highest in. */
  result: SearchResult;
  /** Further matching chunks in the same file, across all lists. */
  moreInFile: number;
  /** Reciprocal-rank-fusion score; set only when several lists were fused. */
  fused?: number;
}

const RRF_K = 60;

const fileKey = (r: SearchResult) => `${r.corpus ?? ""}\0${r.path}`;

/**
 * Collapse one ranked chunk list to one entry per file — its best chunk — so a
 * file with many matching methods doesn't take every slot. Keeps rank order.
 */
export function groupByFile(results: SearchResult[]): FileResult[] {
  return fuseFiles([results], Number.MAX_SAFE_INTEGER);
}

/**
 * Merge ranked chunk lists (one per engine and corpus) into one ranked list of
 * files, by reciprocal-rank fusion over each list's file ranking: a file
 * several lists agree on rises.
 *
 * Fusing files rather than chunks matters: at chunk level, a file's other
 * matching methods and any test sources use up ranks and push real hits down.
 * A file only one list ranks highly can still trail files both lists rank
 * moderately — a trade-off of RRF measured on main-1, not a defect: lowering
 * RRF_K lifts the one-list hit and sinks the agreed one by about as much.
 */
export function fuseFiles(lists: SearchResult[][], topN: number): FileResult[] {
  interface Candidate {
    result: SearchResult;
    bestRank: number;
    chunks: Set<string>;
    score: number;
    order: number;
  }
  const byFile = new Map<string, Candidate>();
  let order = 0;

  for (const list of lists) {
    let fileRank = 0;
    const seen = new Set<string>();
    for (const r of list) {
      const key = fileKey(r);
      let c = byFile.get(key);
      if (!c) {
        c = { result: r, bestRank: Infinity, chunks: new Set(), score: 0, order: order++ };
        byFile.set(key, c);
      }
      c.chunks.add(String(r.chunkOffset));
      if (seen.has(key)) continue;
      seen.add(key);
      fileRank++;
      c.score += 1 / (RRF_K + fileRank);
      if (fileRank < c.bestRank) {
        c.bestRank = fileRank;
        c.result = r;
      }
    }
  }

  // Ties keep first-seen order, so a single list comes back in its own order.
  return [...byFile.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, topN)
    .map((c) => ({
      result: c.result,
      moreInFile: c.chunks.size - 1,
      ...(lists.length > 1 ? { fused: c.score } : {}),
    }));
}
