import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import type { Command } from "@axn-dev/core";
import {
  resolveAxnDevRoot,
  ensureCorpus,
  loadItem,
  saveItem,
  loadAllItems,
  loadCorpusConfig,
  indexPath,
  type Scope,
} from "./know-lib/storage.js";
import { hashFile, gitInfo } from "./know-lib/hash.js";
import { extractChunks } from "./know-lib/chunker.js";
import { buildIndex, search } from "./know-lib/bm25.js";
import { groupByFile, isTestPath } from "./know-lib/results.js";
import type { IndexingTechnique, VectorConfig, SearchResult } from "./know-lib/types.js";
import type { KnowItem } from "./know-lib/types.js";

const KNOW_SUBCOMMANDS = ["add", "index", "find"];
const KNOW_FLAGS = [
  "--scope", "-s", "--corpus", "-c", "--indexing", "-i",
  "--show-toplevel", "-n", "-q", "-C", "--include-tests", "--help", "-h",
];

export class KnowCommand implements Command {
  readonly name = "know";
  readonly description = "Manage the knowledge index (add, index, find)";

  complete(words: string[]): string[] {
    const cur = words[words.length - 1] ?? "";
    if (words.length === 3) {
      return KNOW_SUBCOMMANDS.filter((s) => s.startsWith(cur) && s !== cur);
    }
    return KNOW_FLAGS.filter((f) => f.startsWith(cur) && f !== cur);
  }

  help(): string {
    return `
axn-dev know <subcommand> [options]

Subcommands:
  add <path>         Track a file (or glob/directory) in a corpus
  index              Re-index changed files in a corpus
  find "<query>"     Search the index and show top matching snippets

Options:
  --scope, -s <global|project>   Storage scope (default: global)
  --corpus, -c <name>            Corpus name (default: "personal" for global,
                                 "project" for project scope). For find, -c can
                                 be passed multiple times to search several
                                 corpora at once.
  --indexing, -i <bm25|vector|hybrid>  Indexing technique (default: bm25)
  -n <number>                    Number of files to show (default: 5, find only).
                                 Each file is shown once, at its best match.
  --include-tests                Also show test sources (find only; hidden by default)
  --help, -h                     Show this help

Examples:
  axn-dev know add docs/architecture.md
  axn-dev know add docs/ -s project
  axn-dev know index
  axn-dev know index -s project -c myproject
  axn-dev know find "how to deploy devices"
  axn-dev know find "docker compose" -n 10
  axn-dev know find "auth" -c axn-dev-cli -c my-server
`;
  }

  async execute(args: string[]): Promise<void> {
    const [sub, ...rest] = args;

    if (!sub || sub === "--help" || sub === "-h") {
      console.log(this.help());
      return;
    }

    switch (sub) {
      case "add":   return this.add(rest);
      case "index": return this.index(rest);
      case "find":  return this.find(rest);
      default:
        throw new Error(
          `Unknown know subcommand: '${sub}'\nRun 'axn-dev know --help' for usage.`
        );
    }
  }

  // ---------------------------------------------------------------------------
  // add
  // ---------------------------------------------------------------------------

  private async add(args: string[]): Promise<void> {
    let targetPath: string | null = null;
    let scope: Scope = "global";
    let corpusName: string | null = null;
    let indexing: IndexingTechnique | null = null;

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--scope" || a === "-s") {
        scope = this.parseScope(args[++i]);
      } else if (a === "--corpus" || a === "-c") {
        corpusName = args[++i];
      } else if (a === "--indexing" || a === "-i") {
        indexing = this.parseIndexing(args[++i]);
      } else if (a === "--help" || a === "-h") {
        console.log(this.help()); return;
      } else if (!a.startsWith("-")) {
        targetPath = a;
      }
    }

    if (!targetPath) throw new Error("Usage: axn-dev know add <path> [options]");

    const corpus = corpusName ?? (scope === "global" ? "personal" : "project");
    const axnRoot = resolveAxnDevRoot(scope);
    // Default vector config for vector/hybrid modes
    let vectorConfig: VectorConfig | undefined;
    if (indexing === "vector" || indexing === "hybrid") {
      vectorConfig = { model: "Xenova/all-MiniLM-L6-v2", dimensions: 384, threshold: 0.7 };
    }
    ensureCorpus(axnRoot, corpus, indexing ?? "bm25", vectorConfig);

    const absPath = resolve(process.cwd(), targetPath);

    if (!existsSync(absPath)) {
      throw new Error(`Path does not exist: ${absPath}`);
    }

    const stat = statSync(absPath);
    const paths = stat.isDirectory()
      ? this.collectFilesFromDir(absPath)
      : [absPath];

    let added = 0;
    let skipped = 0;

    for (const filePath of paths) {
      const existing = loadItem(axnRoot, corpus, filePath);
      if (existing) {
        console.log(`  already tracked: ${filePath}`);
        skipped++;
        continue;
      }

      const item: KnowItem = {
        path: filePath,
        added: new Date().toISOString(),
        hash: "",
        chunks: [],
      };

      saveItem(axnRoot, corpus, item);
      console.log(`  added: ${filePath}`);
      added++;
    }

    console.log(`\n${added} file(s) added to corpus '${corpus}' (${scope}), ${skipped} already tracked.`);
    if (added > 0) {
      console.log(`Run 'axn-dev know index' to build the search index.`);
    }
  }

  // ---------------------------------------------------------------------------
  // index
  // ---------------------------------------------------------------------------

  private async index(args: string[]): Promise<void> {
    let scope: Scope = "global";
    let corpusName: string | null = null;

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--scope" || a === "-s") {
        scope = this.parseScope(args[++i]);
      } else if (a === "--corpus" || a === "-c") {
        corpusName = args[++i];
      } else if (a === "--help" || a === "-h") {
        console.log(this.help()); return;
      }
    }

    const corpus = corpusName ?? (scope === "global" ? "personal" : "project");
    const axnRoot = resolveAxnDevRoot(scope);
    const items = loadAllItems(axnRoot, corpus);

    if (items.length === 0) {
      console.log(`No files tracked in corpus '${corpus}' (${scope}). Use 'axn-dev know add' first.`);
      return;
    }

    let indexed = 0;
    let contentChanged = false;
    let skipped = 0;
    let missing = 0;
    const updatedItems: KnowItem[] = [];

    for (const item of items) {
      if (!existsSync(item.path)) {
        console.warn(`  missing (file not found): ${item.path}`);
        missing++;
        updatedItems.push(item);
        continue;
      }

      // Content decides, not the last commit: an uncommitted edit must be re-indexed,
      // and an unchanged file must cost no git process.
      const currentHash = hashFile(item.path);
      if (item.chunks.length > 0 && item.hash === currentHash) {
        skipped++;
        updatedItems.push(item);
        continue;
      }

      const text = readFileSync(item.path, "utf-8");
      const hadChunks = item.chunks.length > 0;
      item.chunks = await extractChunks(item.path, text);
      item.hash = currentHash;
      const git = gitInfo(item.path);
      if (git) {
        item.git_repo = git.repo;
        item.git_commit = git.commit;
      }

      saveItem(axnRoot, corpus, item);
      console.log(`  indexed: ${item.path} (${item.chunks.length} chunks)`);
      indexed++;
      if (hadChunks || item.chunks.length > 0) contentChanged = true;
      updatedItems.push(item);
    }

    const config = loadCorpusConfig(axnRoot, corpus);
    if (!config) throw new Error(`Corpus config not found for '${corpus}'`);
    console.log(`\nBuilding ${config.indexing} index for corpus '${corpus}'...`);
    const idxPath = indexPath(axnRoot, corpus);
    // A full BM25 rebuild is most of an unchanged run's time; other modes still
    // go through buildIndex for any missing embeddings.
    if (config.indexing !== "bm25" || contentChanged || !existsSync(idxPath)) {
      await buildIndex(updatedItems.filter((i) => i.chunks.length > 0), idxPath, config);
    }

    console.log(
      `Done. ${indexed} indexed, ${skipped} up-to-date, ${missing} missing.`
    );
  }

  // ---------------------------------------------------------------------------
  // find
  // ---------------------------------------------------------------------------

  private async find(args: string[]): Promise<void> {
    let query: string | null = null;
    let scope: Scope = "global";
    const corpusNames: string[] = [];
    let topN = 5;
    let includeTests = false;

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--scope" || a === "-s") {
        scope = this.parseScope(args[++i]);
      } else if (a === "--corpus" || a === "-c") {
        corpusNames.push(args[++i]);
      } else if (a === "--include-tests") {
        includeTests = true;
      } else if (a === "-n") {
        topN = parseInt(args[++i], 10);
        if (isNaN(topN) || topN < 1) throw new Error("-n must be a positive integer");
      } else if (a === "--help" || a === "-h") {
        console.log(this.help()); return;
      } else if (!a.startsWith("-")) {
        query = a;
      }
    }

    if (!query) throw new Error('Usage: axn-dev know find "<query>" [options]');

    const targets = corpusNames.length > 0
      ? corpusNames
      : [scope === "global" ? "personal" : "project"];
    const axnRoot = resolveAxnDevRoot(scope);

    // Chunks, not files, are ranked: fetch deep enough that grouping by file and
    // hiding tests still leave topN files.
    const fetchN = Math.max(topN * 20, 100);
    let allResults: SearchResult[] = [];
    let searched = 0;
    let skipped = 0;

    for (const corpus of targets) {
      const config = loadCorpusConfig(axnRoot, corpus);
      if (!config) {
        console.warn(`Corpus config not found for '${corpus}' (${scope}), skipping.`);
        skipped++;
        continue;
      }

      const idxPath = indexPath(axnRoot, corpus);

      if (config.indexing === "vector") {
        const items = loadAllItems(axnRoot, corpus);
        const hasEmbeddings = items.some((i) => i.chunks.some((c) => c.embedding));
        if (!hasEmbeddings) {
          console.warn(`No embeddings found for corpus '${corpus}' (${scope}), skipping.`);
          skipped++;
          continue;
        }
      } else {
        if (!existsSync(idxPath)) {
          console.warn(`No index found for corpus '${corpus}' (${scope}), skipping.`);
          skipped++;
          continue;
        }
      }

      const items = loadAllItems(axnRoot, corpus);
      const results = await search(idxPath, items, config, query, fetchN);
      for (const r of results) {
        r.corpus = corpus;
      }
      allResults = allResults.concat(results);
      searched++;
    }

    if (allResults.length === 0) {
      if (searched === 0) {
        console.log(`No searchable corpora found for the query. ${skipped} were skipped.`);
      } else {
        console.log(`No results found for: ${query}`);
      }
      return;
    }

    allResults.sort((a, b) => this.resultScore(b) - this.resultScore(a));
    const shown = includeTests ? allResults : allResults.filter((r) => !isTestPath(r.path));
    const hiddenTests = allResults.length - shown.length;
    const top = groupByFile(shown).slice(0, topN);
    const testHint = hiddenTests > 0 ? `${hiddenTests} matching test chunk(s) hidden; --include-tests shows them.` : "";

    if (top.length === 0) {
      console.log(`No results found for: ${query}${testHint ? `\n${testHint}` : ""}`);
      return;
    }

    console.log(`\n\x1b[32mTop ${top.length} result(s) for:\x1b[0m "${query}"\n`);

    for (let i = 0; i < top.length; i++) {
      const { result: r, moreInFile } = top[i];
      const score = "score" in r ? r.score.toFixed(3) : ("similarity" in r ? r.similarity.toFixed(3) : "0");
      const label = "score" in r ? "score" : ("similarity" in r ? "similarity" : "score");
      const title = r.titlePath ?? r.title;
      const corpusTag = r.corpus ? ` [${r.corpus}]` : "";
      const location = r.startLine ? `${r.path}:${r.startLine}` : r.path;
      const header = title ? `${location} — ${title}` : location;
      const more = moreInFile > 0 ? `, +${moreInFile} more in this file` : "";
      console.log(`\x1b[1m${i + 1}. ${header}\x1b[0m\x1b[2m${corpusTag} (${label}: ${score}${more})\x1b[0m`);
      console.log(`   ${r.snippet.replace(/\n/g, "\n   ")}`);
      console.log("");
    }
    if (testHint) console.log(`\x1b[2m${testHint}\x1b[0m`);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private resultScore(r: SearchResult): number {
    return "similarity" in r ? r.similarity : ("score" in r ? r.score : 0);
  }

  private parseScope(val: string): Scope {
    if (val === "global" || val === "project") return val;
    throw new Error(`--scope must be 'global' or 'project', got: '${val}'`);
  }

  private parseIndexing(val: string): IndexingTechnique {
    if (val === "bm25" || val === "vector" || val === "hybrid") return val;
    throw new Error(`--indexing must be 'bm25', 'vector', or 'hybrid', got: '${val}'`);
  }

  private collectFilesFromDir(dirPath: string, repoRoot: string | null = null, relPath: string = ""): string[] {
    if (repoRoot === null) {
      repoRoot = this.resolveRepoRoot(dirPath);
    }
    const results: string[] = [];
    const entries = readdirSync(dirPath);
    for (const entry of entries) {
      const full = `${dirPath}/${entry}`;
      const rel = relPath ? `${relPath}/${entry}` : entry;
      if (repoRoot && this.isGitIgnored(repoRoot, rel)) continue;
      const s = statSync(full);
      if (s.isDirectory()) {
        results.push(...this.collectFilesFromDir(full, repoRoot, rel));
      } else if (this.isTextFile(entry)) {
        results.push(full);
      }
    }
    return results;
  }

  private resolveRepoRoot(dirPath: string): string | null {
    try {
      return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dirPath, encoding: "utf-8", stdio: "pipe" }).trim();
    } catch {
      return null;
    }
  }

  private isGitIgnored(repoRoot: string, rel: string): boolean {
    try {
      execFileSync("git", ["-C", repoRoot, "check-ignore", "-q", "--", rel], { stdio: "pipe" });
      return true;
    } catch (e: any) {
      return false;
    }
  }

  private isTextFile(name: string): boolean {
    return /\.(md|txt|ts|js|py|java|yaml|yml|json|sh|adoc|rst|toml|env|conf|cfg)$/.test(name);
  }
}
