import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { resolveInfraRoot } from "./infra.js";
import { ScenarioDiscoveryService } from "@axn-dev/core";

export interface DotenvBackupOptions {
  infra?: string;
  scenario?: string;
  base?: string;
  to?: string;
  tar?: boolean;
}

export interface DotenvRestoreOptions {
  from?: string;
  base?: string;
  force?: boolean;
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function defaultDotenvBackupRoot(): string {
  return join(expandHome("~/.axn-dev"), "dotenv-backups");
}

export function defaultDotenvBackupPath(tar = false): string {
  const root = defaultDotenvBackupRoot();
  return tar ? join(root, "dotenv-backup.tar") : join(root, "dotenv-backup");
}

function resolveBackupFrom(from?: string): string {
  if (from) return expandHome(from);
  const tarPath = defaultDotenvBackupPath(true);
  if (existsSync(tarPath)) return tarPath;
  const dirPath = defaultDotenvBackupPath(false);
  if (existsSync(dirPath)) return dirPath;
  throw new Error(`No default backup found at ${dirname(tarPath)}`);
}

function isDotenvFile(p: string): boolean {
  return basename(p) === ".env";
}

function findDotenvFiles(root: string): string[] {
  const files: string[] = [];
  if (!existsSync(root)) return files;

  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        stack.push(p);
      } else if (entry.isFile() && isDotenvFile(p)) {
        files.push(p);
      }
    }
  }
  return files.sort();
}

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function runTar(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("tar", args, { stdio: "ignore" });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

export function discoverInfraDotenvFiles(pattern?: string): string[] {
  const files = findDotenvFiles(resolveInfraRoot());
  if (!pattern || pattern === "*") return files;
  return files.filter((f) => f.includes(pattern));
}

export function discoverScenarioDotenvFiles(scenarioName: string): string[] {
  const discovery = new ScenarioDiscoveryService(process.cwd());

  if (scenarioName === "*") {
    const project = discovery.getProjectScenarios();
    const global = discovery.getGlobalScenarios();
    const seen = new Set<string>();
    const files: string[] = [];
    for (const s of [...project, ...global]) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      const envPath = join(s.path, ".env");
      if (existsSync(envPath)) files.push(envPath);
    }
    return files;
  }

  const resolution = discovery.resolveScenario(scenarioName);
  const envPath = join(resolution.scenario.path, ".env");
  return existsSync(envPath) ? [envPath] : [];
}

export function collectDotenvFiles(opts: DotenvBackupOptions): { files: string[]; base: string } {
  const base = realpathSync(resolve(expandHome(opts.base ?? "~")));
  const files: string[] = [];

  if (opts.infra) files.push(...discoverInfraDotenvFiles(opts.infra));
  if (opts.scenario) files.push(...discoverScenarioDotenvFiles(opts.scenario));

  const unique = [...new Set(files.map((f) => realpathSync(f)))];
  const outside = unique.filter((f) => relative(base, f).startsWith(".."));
  if (outside.length > 0) {
    throw new Error(
      `Files outside backup base (${base}):\n  ${outside.join("\n  ")}`
    );
  }

  return { files: unique, base };
}

export async function backupDotenvFiles(opts: DotenvBackupOptions): Promise<string> {
  const { files, base } = collectDotenvFiles(opts);
  if (files.length === 0) throw new Error("No .env files found to back up.");

  const to = opts.to ? expandHome(opts.to) : defaultDotenvBackupPath(opts.tar ?? false);
  ensureDir(dirname(to));

  const rels = files.map((f) => relative(base, f));

  if (opts.tar) {
    const gz = to.endsWith(".gz") || to.endsWith(".tgz");
    const exitCode = await runTar([gz ? "-czf" : "-cf", to, "-C", base, ...rels]);
    if (exitCode !== 0) throw new Error(`tar failed with exit code ${exitCode}`);
    return to;
  }

  ensureDir(to);
  for (const f of files) {
    const dest = join(to, relative(base, f));
    ensureDir(dirname(dest));
    writeFileSync(dest, readFileSync(f));
  }
  return to;
}

export async function restoreDotenvFiles(opts: DotenvRestoreOptions): Promise<string[]> {
  const basePath = expandHome(opts.base ?? "~");
  ensureDir(basePath);
  const base = realpathSync(resolve(basePath));
  const from = resolveBackupFrom(opts.from);

  let source: string;
  let tempDir: string | undefined;

  if (from.endsWith(".tar") || from.endsWith(".tar.gz") || from.endsWith(".tgz")) {
    if (!existsSync(from)) throw new Error(`Backup archive not found: ${from}`);
    tempDir = join(tmpdir(), `axn-dev-restore-${Date.now()}`);
    ensureDir(tempDir);
    const gz = from.endsWith(".tar.gz") || from.endsWith(".tgz");
    const exitCode = await runTar([gz ? "-xzf" : "-xf", from, "-C", tempDir]);
    if (exitCode !== 0) throw new Error(`tar failed with exit code ${exitCode}`);
    source = tempDir;
  } else {
    if (!existsSync(from)) throw new Error(`Backup directory not found: ${from}`);
    source = from;
  }

  const files = findDotenvFiles(source);
  const restored: string[] = [];

  for (const f of files) {
    const rel = relative(source, f);
    if (rel.startsWith("..") || rel.split(/[\\/]/).includes("..")) {
      console.log(`  skipped (unsafe path): ${rel}`);
      continue;
    }
    const target = join(base, rel);
    if (existsSync(target) && !opts.force) {
      console.log(`  skipped (exists): ${target}`);
      continue;
    }
    ensureDir(dirname(target));
    writeFileSync(target, readFileSync(f));
    restored.push(target);
  }

  if (tempDir) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  return restored;
}
