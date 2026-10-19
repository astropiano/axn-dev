import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FlowCommand } from "./flow.js";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let originalCwd: string;
let tempDir: string;
const cmd = new FlowCommand();

describe("flow completion", () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "axn-dev-completion-"));
    process.chdir(tempDir);
    mkdirSync(join(tempDir, "flows"));
    writeFileSync(join(tempDir, "flows", "example.xml"), "<flows/>");
    writeFileSync(join(tempDir, "flows", "other.xml"), "<flows/>");
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("lists flow flags after the command with a trailing space", () => {
    const result = cmd.complete(["axn-dev", "flow", ""]);
    expect(result).toContain("--file");
    expect(result).toContain("-f");
    expect(result).toContain("--filter");
  });

  it("completes flags from a partial flag", () => {
    const result = cmd.complete(["axn-dev", "flow", "--fi"]);
    expect(result).toContain("--file");
    expect(result).toContain("--filter");
  });

  it("does not repeat an exact flag", () => {
    expect(cmd.complete(["axn-dev", "flow", "--file"])).not.toContain("--file");
  });

  it("completes XML files after -f", () => {
    const result = cmd.complete(["axn-dev", "flow", "-f", ""]);
    expect(result).toContain("flows/example.xml");
    expect(result).toContain("flows/other.xml");
  });

  it("completes XML files after --file", () => {
    const result = cmd.complete(["axn-dev", "flow", "--file", ""]);
    expect(result).toContain("flows/example.xml");
  });

  it("completes files from a partial flow directory prefix", () => {
    const result = cmd.complete(["axn-dev", "flow", "--file", "flo"]);
    expect(result).toContain("flows/example.xml");
    expect(result).toContain("flows/other.xml");
  });

  it("completes files inside flows/ from a directory prefix", () => {
    const result = cmd.complete(["axn-dev", "flow", "--file", "flows/"]);
    expect(result).toContain("flows/example.xml");
    expect(result).toContain("flows/other.xml");
  });

  it("completes files inside flows/ from a partial filename", () => {
    const result = cmd.complete(["axn-dev", "flow", "--file", "flows/ex"]);
    expect(result).toEqual(["flows/example.xml"]);
  });
});
