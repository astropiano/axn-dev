import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { NAVIGATION_QUERIES, navigateCode, type Command, type NavigationQuery } from "@axn-dev/core";
import {
  resolveAxnDevRoot,
  ensureCorpus,
  loadItem,
  saveItem,
  loadAllItems,
  loadCorpusConfig,
  indexPath,
  vectorsBase,
  depsPath,
  type Scope,
} from "./know-lib/storage.js";
import { hashFile, gitInfo } from "./know-lib/hash.js";
import { extractChunks, extractCodeFacts, hasCodeFacts } from "./know-lib/chunker.js";
import { buildBM25Index, isCurrentBM25Index, searchLists } from "./know-lib/bm25.js";
import { fuseFiles, isTestPath } from "./know-lib/results.js";
import { codeLocationOf } from "./know-lib/codeLocation.js";
import { typeReferences } from "./know-lib/typeRefs.js";
import { dependencyPath, findArtifacts, mergeGraphs, parseDependencyTree, reach, type DepGraph } from "./know-lib/deps.js";
import { syncVectors } from "./know-lib/vectorIndex.js";
import { VectorStore } from "./know-lib/vectorStore.js";
import type { IndexingTechnique, VectorConfig, SearchResult } from "./know-lib/types.js";
import type { KnowItem } from "./know-lib/types.js";

const KNOW_SUBCOMMANDS = ["add", "index", "find", "add-deps", "deps"];
const KNOW_FLAGS = [
  "--scope", "-s", "--corpus", "-c", "--indexing", "-i",
  "--show-toplevel", "-n", "-q", "-C", "--include-tests", "--then", "--reverse", "--depth", "--path-to", "--help", "-h",
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
  add-deps <path>    Store a Maven dependency graph in a corpus: a project
                     directory (runs mvn dependency:tree) or a file of its
                     output. Repeat to merge several projects.
  deps <artifact>    What an artifact depends on, transitively

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
  --then <callers|callees|implementations|references>
                                 Follow the top code hit with a code navigator
                                 plugin, e.g. @axn-dev/know-nav-ripwire (find only)
  --reverse                      What depends on the artifact instead (deps only)
  --depth <n>                    Stop after n hops (deps only; default: all)
  --path-to <artifact>           Why the artifact depends on another: the
                                 shortest chain (deps only)
  --help, -h                     Show this help

Examples:
  axn-dev know add docs/architecture.md
  axn-dev know add docs/ -s project
  axn-dev know index
  axn-dev know index -s project -c myproject
  axn-dev know find "how to deploy devices"
  axn-dev know find "docker compose" -n 10
  axn-dev know find "auth" -c axn-dev-cli -c my-server
  axn-dev know find "apply module update deltas" --then callers
  axn-dev know add-deps ~/git/dx-core
  axn-dev know deps magnolia-core --reverse --depth 1
  axn-dev know deps magnolia-dx-core-webapp --path-to jackrabbit-core
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
      case "add-deps": return this.addDeps(rest);
      case "deps":  return this.deps(rest);
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
      // A file indexed before its language recorded code facts is re-read once to add them.
      if (item.chunks.length > 0 && item.hash === currentHash && (item.code || !hasCodeFacts(item.path))) {
        skipped++;
        updatedItems.push(item);
        continue;
      }

      const text = readFileSync(item.path, "utf-8");
      const hadChunks = item.chunks.length > 0;
      item.chunks = await extractChunks(item.path, text);
      item.code = await extractCodeFacts(item.path, text);
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
    const withChunks = updatedItems.filter((i) => i.chunks.length > 0);

    // A full BM25 rebuild is most of an unchanged run's time.
    if ((config.indexing === "bm25" || config.indexing === "hybrid") && (contentChanged || !isCurrentBM25Index(idxPath))) {
      buildBM25Index(withChunks, idxPath);
    }

    if (config.indexing === "vector" || config.indexing === "hybrid") {
      const tty = Boolean(process.stderr.isTTY);
      const vectors = await syncVectors(withChunks, vectorsBase(axnRoot, corpus), {
        onProgress: (done, total) => {
          if (total > 0) process.stderr.write(`  embedding ${done}/${total} chunks${tty ? "\r" : "\n"}`);
        },
        onError: (message) => console.warn(`  ${message}`),
      });
      if (tty) process.stderr.write("\n");
      // Their inline vectors now live in the store; rewriting drops them from the YAML.
      for (const item of vectors.migrated) saveItem(axnRoot, corpus, item);
      console.log(
        `Vectors: ${vectors.embedded} embedded, ${vectors.removed} file(s) removed` +
          (vectors.migrated.length > 0 ? `, ${vectors.migrated.length} file(s) moved out of the item YAMLs` : "") +
          (vectors.failed > 0 ? `, ${vectors.failed} failed (retried on the next index)` : "") +
          ".",
      );
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
    let then: NavigationQuery | null = null;

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--scope" || a === "-s") {
        scope = this.parseScope(args[++i]);
      } else if (a === "--corpus" || a === "-c") {
        corpusNames.push(args[++i]);
      } else if (a === "--include-tests") {
        includeTests = true;
      } else if (a === "--then") {
        const q = args[++i];
        if (!NAVIGATION_QUERIES.includes(q as NavigationQuery)) {
          throw new Error(`--then must be one of: ${NAVIGATION_QUERIES.join(", ")}`);
        }
        then = q as NavigationQuery;
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
    const lists: SearchResult[][] = [];
    const itemsByCorpus = new Map<string, KnowItem[]>();
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

      const store = config.indexing === "bm25" ? null : VectorStore.load(vectorsBase(axnRoot, corpus));
      const missing = [
        config.indexing !== "vector" && !existsSync(idxPath) ? "BM25 index" : null,
        config.indexing !== "bm25" && !store ? "vectors" : null,
      ].filter(Boolean);
      if (missing.length > 0) {
        console.warn(`No ${missing.join(" or ")} for corpus '${corpus}' (${scope}); run 'axn-dev know index'. Skipping.`);
        skipped++;
        continue;
      }

      const items = loadAllItems(axnRoot, corpus);
      itemsByCorpus.set(corpus, items);
      for (const list of await searchLists(idxPath, items, store, config, query, fetchN)) {
        for (const r of list) r.corpus = corpus;
        lists.push(list);
      }
      searched++;
    }

    if (lists.every((l) => l.length === 0)) {
      if (searched === 0) {
        console.log(`No searchable corpora found for the query. ${skipped} were skipped.`);
      } else {
        console.log(`No results found for: ${query}`);
      }
      return;
    }

    // Tests leave before fusion, so they take no ranks from production files.
    const shown = lists.map((l) => (includeTests ? l : l.filter((r) => !isTestPath(r.path))));
    const hiddenTests = new Set(
      lists.flat().filter((r) => !includeTests && isTestPath(r.path)).map((r) => `${r.corpus}:${r.path}:${r.chunkOffset}`),
    ).size;
    const top = fuseFiles(shown, topN);
    const testHint = hiddenTests > 0 ? `${hiddenTests} matching test chunk(s) hidden; --include-tests shows them.` : "";

    if (top.length === 0) {
      console.log(`No results found for: ${query}${testHint ? `\n${testHint}` : ""}`);
      return;
    }

    console.log(`\n\x1b[32mTop ${top.length} result(s) for:\x1b[0m "${query}"\n`);

    for (let i = 0; i < top.length; i++) {
      const { result: r, moreInFile, fused } = top[i];
      const [label, value] = fused !== undefined
        ? ["rrf", fused]
        : "score" in r ? ["score", r.score] : ["similarity", r.similarity];
      const score = value.toFixed(3);
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
    if (then) await this.followTopHit(then, top.map((t) => t.result), includeTests, itemsByCorpus);
  }

  /**
   * Hand the first code symbol among the hits to a code navigator and print
   * what it finds — the step from "where is it" to "what touches it".
   */
  private async followTopHit(
    query: NavigationQuery,
    results: SearchResult[],
    includeTests: boolean,
    itemsByCorpus: Map<string, KnowItem[]>,
  ): Promise<void> {
    const hit = results.find((r) => codeLocationOf(r) !== null);
    const location = hit && codeLocationOf(hit);
    if (!hit || !location) {
      console.log(`\n--then ${query}: none of the results is a code symbol.`);
      return;
    }
    // Implementations belong to the type, even when the hit was one of its members.
    const symbol = location.memberName && query !== "implementations" ? `${location.typeName}.${location.memberName}` : location.typeName;
    const navigated = await navigateCode(query, location);
    // For a type, know answers references itself from the uses it recorded at
    // index time — signatures and fields included, which a navigator may miss.
    const own = query === "references" && !location.memberName && location.qualifiedName
      ? typeReferences(itemsByCorpus.get(hit.corpus ?? "") ?? [], location.qualifiedName, location.path)
      : [];
    if (!navigated && own.length === 0) {
      console.log(`\n--then ${query}: no code navigator serves ${location.path}. Install one, e.g. 'axn-dev install --plugin @axn-dev/know-nav-ripwire'.`);
      return;
    }

    const seen = new Set<string>();
    const all = [...(navigated?.hits ?? []), ...own].filter((h) => {
      const key = `${h.path}:${h.line ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const hits = includeTests ? all : all.filter((h) => !isTestPath(h.path));
    const sources = [navigated?.navigator, own.length > 0 ? "know" : null].filter(Boolean).join(" + ");
    console.log(`\n\x1b[32m${query[0].toUpperCase()}${query.slice(1)} of ${symbol}\x1b[0m\x1b[2m (${sources}, ${hits.length} hit(s))\x1b[0m`);
    for (const h of hits) {
      const where = h.line ? `${h.path}:${h.line}` : h.path;
      console.log(`  ${where}${h.symbol ? ` — ${h.symbol}` : ""}${h.kind ? `\x1b[2m (${h.kind})\x1b[0m` : ""}`);
    }
    const hidden = all.length - hits.length;
    if (hidden > 0) console.log(`\x1b[2m  ${hidden} hit(s) in test sources hidden; --include-tests shows them.\x1b[0m`);
    for (const c of navigated?.caveats ?? []) console.log(`\x1b[33m  ⚠ ${c}\x1b[0m`);
  }

  // ---------------------------------------------------------------------------
  // add-deps / deps
  // ---------------------------------------------------------------------------

  private async addDeps(args: string[]): Promise<void> {
    const { scope, corpus, positional } = this.corpusArgs(args);
    if (!positional) throw new Error("Usage: axn-dev know add-deps <project-dir|tree-file> [options]");
    const source = resolve(process.cwd(), positional);
    if (!existsSync(source)) throw new Error(`Path does not exist: ${source}`);

    const text = statSync(source).isDirectory() ? this.runDependencyTree(source) : readFileSync(source, "utf-8");
    const parsed = parseDependencyTree(text);
    if (parsed.artifacts.length === 0) throw new Error(`No dependency tree found in ${source}`);

    const axnRoot = resolveAxnDevRoot(scope);
    ensureCorpus(axnRoot, corpus);
    const path = depsPath(axnRoot, corpus);
    const graph = existsSync(path) ? mergeGraphs(this.readDeps(path), parsed) : parsed;
    writeFileSync(path, JSON.stringify(graph), "utf-8");
    const modules = parsed.artifacts.filter((a) => a.module).length;
    console.log(`Read ${modules} module(s), ${parsed.artifacts.length} artifacts, ${parsed.edges.length} dependencies from ${source}.`);
    console.log(`Corpus '${corpus}' now holds ${graph.artifacts.length} artifacts, ${graph.edges.length} dependencies.`);
  }

  /** `mvn dependency:tree` over a project; every module's tree, appended to one file. */
  private runDependencyTree(dir: string): string {
    const tmp = mkdtempSync(join(tmpdir(), "axn-know-deps-"));
    const out = join(tmp, "tree.txt");
    try {
      console.log(`Running mvn dependency:tree in ${dir} ...`);
      // -Dverbose: without it each artifact appears once per module, and most edges are missing.
      const res = spawnSync("mvn", ["-q", "dependency:tree", "-Dverbose", `-DoutputFile=${out}`, "-DappendOutput=true"], {
        cwd: dir,
        encoding: "utf-8",
      });
      if (res.error) throw new Error(`mvn is not available: ${res.error.message}`);
      if (res.status !== 0) {
        const tail = `${res.stdout}\n${res.stderr}`.trim().split("\n").slice(-5).join("\n");
        throw new Error(`mvn dependency:tree failed (exit ${res.status}):\n${tail}`);
      }
      return readFileSync(out, "utf-8");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  private async deps(args: string[]): Promise<void> {
    let reverse = false;
    let maxDepth = Infinity;
    let pathTo: string | null = null;
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--reverse") reverse = true;
      else if (a === "--depth") {
        maxDepth = parseInt(args[++i], 10);
        if (isNaN(maxDepth) || maxDepth < 1) throw new Error("--depth must be a positive integer");
      } else if (a === "--path-to") pathTo = args[++i];
      else rest.push(a);
    }
    const { scope, corpus, positional } = this.corpusArgs(rest);
    if (!positional) throw new Error("Usage: axn-dev know deps <artifact> [--reverse] [--depth n] [--path-to <artifact>] [options]");

    const path = depsPath(resolveAxnDevRoot(scope), corpus);
    if (!existsSync(path)) throw new Error(`No dependency graph in corpus '${corpus}' (${scope}). Run 'axn-dev know add-deps <project-dir>' first.`);
    const graph = this.readDeps(path);
    const start = this.oneArtifact(graph, positional);
    if (!start) return;

    if (pathTo) {
      const target = this.oneArtifact(graph, pathTo);
      if (!target) return;
      const chain = dependencyPath(graph, start, target);
      console.log(chain
        ? `${chain.join("\n  -> ")}`
        : `${start} does not depend on ${target} in this graph.`);
      return;
    }

    const reached = reach(graph, start, reverse, maxDepth);
    const versions = new Map(graph.artifacts.map((a) => [a.key, a.versions.join(", ")]));
    console.log(`\n\x1b[32m${reverse ? "Depended on by" : "Depends on"} ${start}\x1b[0m\x1b[2m (${reached.length}${Number.isFinite(maxDepth) ? `, up to depth ${maxDepth}` : ", transitive"})\x1b[0m`);
    for (const r of reached) {
      const via = r.depth > 1 ? `\x1b[2m  via ${r.via}\x1b[0m` : "";
      console.log(`  ${r.depth}  ${r.key}\x1b[2m ${versions.get(r.key)} (${r.scope})\x1b[0m${via}`);
    }
  }

  /** The single artifact a query names, or null after listing the candidates. */
  private oneArtifact(graph: DepGraph, query: string): string | null {
    const found = findArtifacts(graph, query);
    if (found.length === 1) return found[0].key;
    if (found.length === 0) {
      console.log(`No artifact matches '${query}'.`);
    } else {
      console.log(`'${query}' matches ${found.length} artifacts; name one:`);
      for (const a of found.slice(0, 20)) console.log(`  ${a.key}`);
    }
    return null;
  }

  private readDeps(path: string): DepGraph {
    return JSON.parse(readFileSync(path, "utf-8")) as DepGraph;
  }

  /** --scope/--corpus and the one positional argument shared by add-deps and deps. */
  private corpusArgs(args: string[]): { scope: Scope; corpus: string; positional: string | null } {
    let scope: Scope = "global";
    let corpusName: string | null = null;
    let positional: string | null = null;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--scope" || a === "-s") scope = this.parseScope(args[++i]);
      else if (a === "--corpus" || a === "-c") corpusName = args[++i];
      else if (!a.startsWith("-")) positional = a;
    }
    return { scope, corpus: corpusName ?? (scope === "global" ? "personal" : "project"), positional };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

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
