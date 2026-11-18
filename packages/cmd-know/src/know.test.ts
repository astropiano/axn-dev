import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerCodeNavigator } from "@axn-dev/core";
import { KnowCommand } from "./know.js";
import { loadAllItems, saveItem } from "./know-lib/storage.js";

/**
 * We override resolveAxnDevRoot so the command writes into our tmp dir
 * rather than ~/.axn-dev or a real git root.
 */
vi.mock("./know-lib/storage.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./know-lib/storage.js")>();
  return {
    ...original,
    resolveAxnDevRoot: (_scope: string) => AXN_ROOT,
  };
});

const TMP = join(tmpdir(), "axn-know-test-" + process.pid);
const AXN_ROOT = join(TMP, ".axn-dev");
const DOCS = join(TMP, "docs");

beforeAll(() => {
  mkdirSync(DOCS, { recursive: true });
  writeFileSync(join(DOCS, "intro.md"), "# Intro\n\nThis is the introduction.\n\nIt covers the basics of Docker Compose.");
  writeFileSync(join(DOCS, "setup.md"), "# Setup\n\nRun docker-compose up to start the stack.\n\nRequires Docker installed.");
  writeFileSync(join(DOCS, "raspberry.md"), "# Raspberry Pi\n\nBoot the Pi by writing an image to an SD card.\n\nUse Raspberry Pi Imager.");
});

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const cmd = new KnowCommand();

async function run(...args: string[]) {
  await cmd.execute(args);
}

async function output(...args: string[]): Promise<string> {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
  try {
    await run(...args);
  } finally {
    spy.mockRestore();
  }
  return logs.join("\n");
}

describe("know add", () => {
  it("tracks a single file", async () => {
    await run("add", join(DOCS, "intro.md"));
    // item YAML should exist under AXN_ROOT
    const itemsDir = join(AXN_ROOT, "corpora", "personal", "items");
    expect(existsSync(itemsDir)).toBe(true);
    const files = readdirSync(itemsDir);
    expect(files.some((f) => f.includes("intro.md"))).toBe(true);
  });

  it("tracks a directory of files", async () => {
    // intro.md already tracked — add remaining
    await run("add", DOCS);
    const itemsDir = join(AXN_ROOT, "corpora", "personal", "items");
    const files = readdirSync(itemsDir);
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it("does not duplicate already-tracked files", async () => {
    const itemsDir = join(AXN_ROOT, "corpora", "personal", "items");
    const before = readdirSync(itemsDir).length;
    await run("add", join(DOCS, "intro.md"));
    const after = readdirSync(itemsDir).length;
    expect(after).toBe(before);
  });

  it("throws for non-existent path", async () => {
    await expect(run("add", join(DOCS, "missing.md"))).rejects.toThrow("does not exist");
  });

  it("throws when no path provided", async () => {
    await expect(run("add")).rejects.toThrow("Usage");
  });
});

describe("know index", () => {
  it("indexes all tracked files and creates index.json", async () => {
    await run("index");
    const idxPath = join(AXN_ROOT, "corpora", "personal", "index.json");
    expect(existsSync(idxPath)).toBe(true);
  });

  it("runs again without errors (up-to-date files are skipped)", async () => {
    await expect(run("index")).resolves.not.toThrow();
  });

  it("leaves the BM25 index untouched when no content changed", async () => {
    const idxPath = join(AXN_ROOT, "corpora", "personal", "index.json");
    const before = statSync(idxPath).mtimeMs;
    await run("index");
    expect(statSync(idxPath).mtimeMs).toBe(before);
  });
});

describe("know find", () => {
  it("returns results for a relevant query", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
    await run("find", "docker compose");
    spy.mockRestore();
    const output = logs.join("\n");
    expect(output).toContain("result");
    expect(output).toContain(DOCS);
  });

  it("reports no results for garbage query", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
    await run("find", "xyzzy_zorkblat_quux");
    spy.mockRestore();
    expect(logs.join("\n")).toContain("No results");
  });

  it("throws when no query provided", async () => {
    await expect(run("find")).rejects.toThrow("Usage");
  });
});

describe("know --help", () => {
  it("prints help without throwing", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
    await run("--help");
    spy.mockRestore();
    expect(logs.join("\n")).toContain("add");
    expect(logs.join("\n")).toContain("index");
    expect(logs.join("\n")).toContain("find");
  });

  it("throws for unknown subcommand", async () => {
    await expect(run("notasubcommand")).rejects.toThrow("Unknown know subcommand");
  });
});

describe("know index — what triggers a re-index", () => {
  const REPO = join(TMP, "repo");
  const FILE = join(REPO, "notes.md");
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: REPO, stdio: "pipe" });

  beforeAll(() => {
    mkdirSync(REPO, { recursive: true });
    git("init", "-q");
    writeFileSync(FILE, "# Notes\n\nThe original paragraph.");
    git("add", ".");
    git("commit", "-q", "-m", "init");
  });

  it("re-indexes a file edited but not committed", async () => {
    await run("add", FILE, "-c", "gitrepo");
    await run("index", "-c", "gitrepo");

    // Same last commit, new content: the commit alone must not mark it up to date.
    writeFileSync(FILE, "# Notes\n\nA quokka appeared in the working tree.");
    await run("index", "-c", "gitrepo");

    expect(await output("find", "quokka", "-c", "gitrepo")).toContain(FILE);
  });
});

describe("know find — one line per file, tests hidden", () => {
  const SRC = join(TMP, "proj", "src");
  const TESTS = join(TMP, "proj", "src", "__tests__");

  beforeAll(async () => {
    mkdirSync(TESTS, { recursive: true });
    writeFileSync(join(SRC, "many.md"), "# One\n\nwombat alpha\n\n# Two\n\nwombat beta\n\n# Three\n\nwombat gamma");
    writeFileSync(join(SRC, "single.md"), "# Only\n\nwombat delta");
    writeFileSync(join(TESTS, "spec.md"), "# Spec\n\nwombat wombat wombat");
    await run("add", join(TMP, "proj"), "-c", "grouping");
    await run("index", "-c", "grouping");
  });

  it("shows a file with several matching chunks once, with a count of the rest", async () => {
    const out = await output("find", "wombat", "-c", "grouping", "--include-tests");

    expect(out.split("\n").filter((l) => l.includes("many.md"))).toHaveLength(1);
    expect(out).toContain("+2 more in this file");
  });

  it("hides test sources by default and says so", async () => {
    const out = await output("find", "wombat", "-c", "grouping");

    expect(out).not.toContain("__tests__");
    expect(out).toContain("single.md");
    expect(out).toContain("1 matching test chunk(s) hidden");
  });

  it("fills the requested count with production files when a test ranks first", async () => {
    // spec.md is the best match; hidden after ranking, it would leave -n 1 empty.
    const out = await output("find", "wombat", "-c", "grouping", "-n", "1");
    expect(out).toContain("Top 1 result(s)");
  });

  it("shows test sources with --include-tests", async () => {
    expect(await output("find", "wombat", "-c", "grouping", "--include-tests")).toContain("__tests__");
  });
});

describe("know find --then", () => {
  const PROJ = join(TMP, "navproj");
  const NAV = join(TMP, "fake-nav.mjs");

  beforeAll(async () => {
    mkdirSync(join(PROJ, "src"), { recursive: true });
    writeFileSync(
      join(PROJ, "src", "Pouch.java"),
      "package zoo;\n\npublic class Pouch {\n    void carry(String joey) {\n        kangaroo(joey);\n    }\n}\n",
    );
    writeFileSync(join(PROJ, "src", "notes.md"), "# Notes\n\nplatypus facts");
    // Uses Pouch in a field type — a use only the indexed type uses can report.
    writeFileSync(join(PROJ, "src", "Keeper.java"), "package zoo;\n\nclass Keeper {\n    private Pouch pouch;\n}\n");
    // A same-named type in another package: not a use of zoo.Pouch.
    writeFileSync(join(PROJ, "src", "Stranger.java"), "package elsewhere;\n\nclass Stranger {\n    Pouch pouch;\n}\n");
    writeFileSync(join(PROJ, "src", "util.ts"), "export class Wallaby {\n  hop() { return 'numbat'; }\n}\n");
    // Echoes what it was asked, plus one hit in a test source.
    writeFileSync(
      NAV,
      `export const navigator = {
        async navigate(query, location, target) {
          return {
            navigator: "fake",
            hits: [
              { path: "/elsewhere/Zoo.java", line: 7, symbol: query + " of " + location.typeName + "." + location.memberName + "@" + location.line + (target ? " to " + target.typeName : "") },
              { path: "/elsewhere/src/test/ZooTest.java", line: 3, symbol: "inTest" },
            ],
            caveats: ["a lower bound"],
          };
        },
      };`,
    );
    registerCodeNavigator({ name: "fake", extensions: [".java"], entry: NAV });
    await run("add", PROJ, "-c", "nav");
    await run("index", "-c", "nav");
  });

  it("hands the top code hit's type, member and line to the navigator and prints its hits and caveats", async () => {
    // "carry" is in the method's title, so the method outranks its class.
    const out = await output("find", "carry kangaroo", "-c", "nav", "--then", "callers");

    expect(out).toContain("Callers of Pouch.carry");
    expect(out).toContain("/elsewhere/Zoo.java:7 — callers of Pouch.carry@4");
    expect(out).toContain("⚠ a lower bound");
  });

  it("hides navigator hits in test sources unless --include-tests", async () => {
    expect(await output("find", "carry kangaroo", "-c", "nav", "--then", "callers")).toContain("1 hit(s) in test sources hidden");
    expect(await output("find", "kangaroo", "-c", "nav", "--then", "callers", "--include-tests")).toContain("ZooTest.java");
  });

  it("says so when no result is a code symbol", async () => {
    expect(await output("find", "platypus", "-c", "nav", "--then", "callers")).toContain("none of the results is a code symbol");
  });

  it("says so when no navigator serves the file", async () => {
    expect(await output("find", "numbat", "-c", "nav", "--then", "callers")).toContain("no code navigator serves");
  });

  it("adds know's own uses of a Java type to the navigator's references, resolved by package", async () => {
    const out = await output("find", "Pouch", "-c", "nav", "--then", "references");

    const references = out.slice(out.indexOf("References of"));
    expect(references).toMatch(/^References of Pouch\S* \(fake \+ know/);
    expect(references).toMatch(/Keeper\.java:4 — Keeper.*\(type\)/);
    // Stranger uses its own package's Pouch; it may match the search, but it is no reference.
    expect(references).not.toContain("Stranger.java");
  });

  it("re-reads a Java file indexed before code facts were recorded", async () => {
    const [keeper] = loadAllItems(AXN_ROOT, "nav").filter((i) => i.path.endsWith("Keeper.java"));
    delete keeper.code;
    saveItem(AXN_ROOT, "nav", keeper);

    await run("index", "-c", "nav");

    const [again] = loadAllItems(AXN_ROOT, "nav").filter((i) => i.path.endsWith("Keeper.java"));
    expect(again.code?.types.Pouch).toEqual([4]);
  });

  it("resolves --to by exact name and hands both symbols to the navigator for a path", async () => {
    const out = await output("find", "carry kangaroo", "-c", "nav", "--then", "path", "--to", "Keeper");

    expect(out).toContain("Path from Pouch.carry to Keeper");
    expect(out).toContain("path of Pouch.carry@4 to Keeper");
    // A path keeps every step, test sources included.
    expect(out).toContain("ZooTest.java");
  });

  it("needs --to for a path, and says so when the name matches nothing", async () => {
    await expect(run("find", "carry kangaroo", "-c", "nav", "--then", "path")).rejects.toThrow("--then path needs --to");
    expect(await output("find", "carry kangaroo", "-c", "nav", "--then", "path", "--to", "Nobody")).toContain("no symbol named 'Nobody'");
  });

  it("rejects an unknown navigation", async () => {
    await expect(run("find", "kangaroo", "-c", "nav", "--then", "siblings")).rejects.toThrow("--then must be one of");
  });
});

describe("know add-deps / deps", () => {
  const TREE = join(TMP, "tree.txt");

  beforeAll(async () => {
    writeFileSync(
      TREE,
      "[INFO] info.magnolia:webapp:war:6.4\n" +
        "[INFO] +- info.magnolia:magnolia-core:jar:6.4:compile\n" +
        "[INFO] |  \\- org.apache.jackrabbit:jackrabbit-core:jar:2.20.0:compile\n" +
        "[INFO] \\- info.magnolia:magnolia-rendering:jar:6.4:compile\n",
    );
    await run("add-deps", TREE, "-c", "deps");
  });

  it("lists what depends on an artifact", async () => {
    const out = await output("deps", "jackrabbit-core", "--reverse", "-c", "deps");
    expect(out).toContain("Depended on by org.apache.jackrabbit:jackrabbit-core");
    expect(out).toMatch(/1  info\.magnolia:magnolia-core/);
    expect(out).toMatch(/2  info\.magnolia:webapp.*via info\.magnolia:magnolia-core/);
  });

  it("shows the chain from one artifact to another", async () => {
    expect(await output("deps", "webapp", "--path-to", "jackrabbit-core", "-c", "deps")).toBe(
      "info.magnolia:webapp\n  -> info.magnolia:magnolia-core\n  -> org.apache.jackrabbit:jackrabbit-core",
    );
  });

  it("asks for one artifact when a query matches several", async () => {
    const out = await output("deps", "magnolia", "-c", "deps");
    expect(out).toContain("'magnolia' matches 3 artifacts");
  });

  it("says how to load a graph when the corpus has none", async () => {
    await expect(run("deps", "x", "-c", "nodeps")).rejects.toThrow("know add-deps");
  });
});
