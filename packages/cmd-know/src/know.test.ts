import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
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
