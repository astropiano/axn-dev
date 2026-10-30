import type { SearchResult } from "./types.js";

const TEST_DIR = /(^|\/)(__tests__|tests?)\//;
const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?|(Test|Tests|IT)\.java|_test\.(py|go))$|(^|\/)test_[^/]*\.py$/;

/** Is this a test source, by the directory and file-name conventions of Java, TS/JS, Python and Go? */
export function isTestPath(path: string): boolean {
  return TEST_DIR.test(path) || TEST_FILE.test(path);
}

export interface FileResult {
  result: SearchResult;
  /** Further matching chunks in the same file, ranked below `result`. */
  moreInFile: number;
}

/**
 * Collapse ranked chunk results to one per file — its best chunk — so a file
 * with many matching methods doesn't take every slot. Expects `results`
 * sorted best-first; keeps that order.
 */
export function groupByFile(results: SearchResult[]): FileResult[] {
  const byFile = new Map<string, FileResult>();
  for (const result of results) {
    const key = `${result.corpus ?? ""}\0${result.path}`;
    const existing = byFile.get(key);
    if (existing) existing.moreInFile++;
    else byFile.set(key, { result, moreInFile: 0 });
  }
  return [...byFile.values()];
}
