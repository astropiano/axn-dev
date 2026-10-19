import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  backupDotenvFiles,
  collectDotenvFiles,
  discoverInfraDotenvFiles,
  discoverScenarioDotenvFiles,
  expandHome,
  restoreDotenvFiles,
} from "./dotenv-backup.js";

let originalCwd: string;
let tmpDir: string;
let otherBaseDir: string;

beforeAll(() => {
  originalCwd = process.cwd();
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "axn-dotenv-")));
  otherBaseDir = realpathSync(mkdtempSync(join(tmpdir(), "other-")));
  process.chdir(tmpDir);

  // repo marker
  mkdirSync(".git");

  // infra dotenvs
  mkdirSync(join("infra", "devices", "test"), { recursive: true });
  writeFileSync(join("infra", "devices", "test", ".env"), "DEVICE=1");
  mkdirSync(join("infra", "hosting", "h1"), { recursive: true });
  writeFileSync(join("infra", "hosting", "h1", ".env"), "HOSTING=1");

  // example envs that must not be collected
  writeFileSync(join("infra", "hosting", "h1", ".env.example"), "EXAMPLE=1");

  // scenario dotenv
  mkdirSync(join("scenarios", "dev"), { recursive: true });
  writeFileSync(join("scenarios", "dev", "compose.yaml"), "services:\n  web:\n    image: nginx\n");
  writeFileSync(join("scenarios", "dev", ".env"), "SCENARIO=1");
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("dotenv-backup discovery", () => {
  it("discovers all .env files under the resolved infra root", () => {
    const files = discoverInfraDotenvFiles("*");
    expect(files.map((f) => f.replace(tmpDir, "<TMP>"))).toEqual([
      "<TMP>/infra/devices/test/.env",
      "<TMP>/infra/hosting/h1/.env",
    ]);
  });

  it("filters infra .env files by pattern", () => {
    const files = discoverInfraDotenvFiles("h1");
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("hosting/h1/.env");
  });

  it("discovers a scenario .env", () => {
    const files = discoverScenarioDotenvFiles("dev");
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("scenarios/dev/.env");
  });

  it("rejects files outside the backup base", () => {
    expect(() =>
      collectDotenvFiles({ infra: "*", base: otherBaseDir })
    ).toThrow("Files outside backup base");
  });
});

describe("dotenv-backup directory roundtrip", () => {
  it("backs up .env files to a directory tree and restores them", async () => {
    const backupDir = join(tmpDir, "backup-dir");
    const out = await backupDotenvFiles({
      infra: "*",
      base: tmpDir,
      to: backupDir,
    });
    expect(out).toBe(backupDir);
    expect(existsSync(join(backupDir, "infra/devices/test/.env"))).toBe(true);
    expect(existsSync(join(backupDir, "infra/hosting/h1/.env"))).toBe(true);
    expect(readFileSync(join(backupDir, "infra/devices/test/.env"), "utf-8")).toBe("DEVICE=1");

    const restoreBase = join(tmpDir, "restore-dir");
    const restored = await restoreDotenvFiles({
      from: backupDir,
      base: restoreBase,
    });
    expect(restored).toHaveLength(2);
    expect(
      readFileSync(join(restoreBase, "infra/devices/test/.env"), "utf-8")
    ).toBe("DEVICE=1");
  });

  it("skips existing .env files by default on restore", async () => {
    const backupDir = join(tmpDir, "backup-skip");
    await backupDotenvFiles({ infra: "*", base: tmpDir, to: backupDir });

    const restoreBase = join(tmpDir, "restore-skip");
    await restoreDotenvFiles({ from: backupDir, base: restoreBase });

    // pre-existing file with different content
    writeFileSync(join(restoreBase, "infra/devices/test/.env"), "CHANGED");

    const again = await restoreDotenvFiles({ from: backupDir, base: restoreBase });
    expect(again).toHaveLength(0);
    expect(
      readFileSync(join(restoreBase, "infra/devices/test/.env"), "utf-8")
    ).toBe("CHANGED");
  });

  it("overwrites when force is true", async () => {
    const backupDir = join(tmpDir, "backup-force");
    await backupDotenvFiles({ infra: "*", base: tmpDir, to: backupDir });

    const restoreBase = join(tmpDir, "restore-force");
    await restoreDotenvFiles({ from: backupDir, base: restoreBase });
    writeFileSync(join(restoreBase, "infra/devices/test/.env"), "CHANGED");

    await restoreDotenvFiles({ from: backupDir, base: restoreBase, force: true });
    expect(
      readFileSync(join(restoreBase, "infra/devices/test/.env"), "utf-8")
    ).toBe("DEVICE=1");
  });
});

describe("dotenv-backup tar roundtrip", () => {
  it("backs up and restores via a tar archive", async () => {
    const archive = join(tmpDir, "backup.tar");
    const out = await backupDotenvFiles({
      infra: "*",
      base: tmpDir,
      to: archive,
      tar: true,
    });
    expect(out).toBe(archive);
    expect(existsSync(archive)).toBe(true);

    const restoreBase = join(tmpDir, "restore-tar");
    const restored = await restoreDotenvFiles({
      from: archive,
      base: restoreBase,
    });
    expect(restored).toHaveLength(2);
    expect(
      readFileSync(join(restoreBase, "infra/devices/test/.env"), "utf-8")
    ).toBe("DEVICE=1");
    expect(
      readFileSync(join(restoreBase, "infra/hosting/h1/.env"), "utf-8")
    ).toBe("HOSTING=1");
  });
});

describe("expandHome", () => {
  it("expands ~ to the home directory", () => {
    expect(expandHome("~")).toBe(realpathSync(process.env.HOME ?? tmpdir()));
    expect(expandHome("~/foo").startsWith(process.env.HOME ?? "")).toBe(true);
  });
});
