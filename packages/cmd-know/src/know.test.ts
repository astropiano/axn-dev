import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KnowCommand } from "./know.js";

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
