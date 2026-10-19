import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import yaml from "js-yaml";
import { discoverInfraDotenvFiles, expandHome } from "./dotenv-backup.js";
import { gitAsync as git } from "@axn-dev/core";
import { resolveInfraRoot } from "./infra.js";
import { loadAxnDevConfig, loadWorkspaceConfig, configSection } from "@axn-dev/core";
import { detectRepo, type RepoContext, type ScenarioInfo } from "@axn-dev/core";
import { ScenarioDiscoveryService } from "@axn-dev/core";

export interface DotenvBitwardenBackupOptions {
  infra?: string;
  scenario?: string;
  force?: boolean;
}

export interface DotenvBitwardenRestoreOptions {
  infra?: string;
  scenario?: string;
  force?: boolean;
}

interface BitwardenFolder {
  id: string;
  name: string;
}

interface BitwardenItem {
  id: string;
  name: string;
  type: number;
  folderId: string | null;
  notes?: string;
}

const INFRA_FOLDER = "axn-dev-infra";
const SCENARIO_FOLDER = "axn-dev-scenarios";

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function runBw(args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("bw", args, {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    if (stdin !== undefined) {
      child.stdin?.write(stdin);
    }
    child.stdin?.end();

    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err: any) => {
      if (err.code === "ENOENT") {
        reject(new Error("Bitwarden CLI (bw) not found. Install with: npm install -g @bitwarden/cli"));
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`bw ${args.join(" ")} failed: ${stderr.trim() || code}`));
    });
  });
}

async function ensureBitwardenUnlocked(): Promise<void> {
  try {
    const status = JSON.parse(await runBw(["status"]));
    if (status.status !== "unlocked") {
      throw new Error(`Bitwarden is ${status.status}. Run 'bw unlock --raw' and export BW_SESSION=<token> before using --bitwarden.`);
    }
  } catch (err: any) {
    if (err.message?.includes("bw status failed")) {
      throw new Error("Bitwarden CLI (bw) not found or not in PATH. Install with: npm install -g @bitwarden/cli");
    }
    throw err;
  }
}

const folderCache = new Map<string, string>();

async function getFolderId(name: string): Promise<string> {
  if (folderCache.has(name)) return folderCache.get(name)!;

  const folders: BitwardenFolder[] = JSON.parse(await runBw(["list", "folders"]));
  const existing = folders.find((f) => f.name === name);
  if (existing) {
    folderCache.set(name, existing.id);
    return existing.id;
  }

  const encoded = (await runBw(["encode"], JSON.stringify({ name }))).trim();
  const created: BitwardenFolder = JSON.parse(await runBw(["create", "folder", encoded]));
  folderCache.set(name, created.id);
  return created.id;
}

interface DotenvMeta {
  type: "infra" | "scenario";
  scope: "global" | "project";
  repo: string | null;
  relpath: string;
}

async function getRepoRemote(repoRoot: string): Promise<string | null> {
  try {
    return (await git(repoRoot, ["remote", "get-url", "origin"])).trim();
  } catch {
    return null;
  }
}

async function getRepoInfo(cwd: string): Promise<{ repoRoot: string; repoName: string; repo: string | null } | null> {
  const ctx: RepoContext | null = detectRepo(cwd);
  if (!ctx) return null;
  const remote = await getRepoRemote(ctx.repoRoot);
  return { repoRoot: ctx.repoRoot, repoName: ctx.repoName, repo: remote };
}

function getGlobalInfraRoot(): string {
  const config = loadAxnDevConfig(process.cwd());
  const infra = configSection<string>(config, "infra");
  if (!infra) throw new Error("No global infra repo configured. Set 'infra' in ~/.axn-dev/config.yaml");
  return realpathSync(resolve(expandHome(infra)));
}

const repoPathCache = new Map<string, string | null>();

async function findRepoByRemote(remote: string): Promise<string | null> {
  if (repoPathCache.has(remote)) return repoPathCache.get(remote)!;

  const workspace = loadWorkspaceConfig(loadAxnDevConfig(process.cwd()));
  for (const path of Object.values(workspace.repos)) {
    if (!existsSync(path)) continue;
    const repoRemote = await getRepoRemote(path);
    if (repoRemote === remote) {
      const found = realpathSync(path);
      repoPathCache.set(remote, found);
      return found;
    }
  }

  repoPathCache.set(remote, null);
  return null;
}

interface ScenarioWithScope {
  name: string;
  path: string;
  source: "project" | "global";
}

function getScenariosToProcess(scenarioName: string): ScenarioWithScope[] {
  const discovery = new ScenarioDiscoveryService(process.cwd());
  const project = discovery.getProjectScenarios();
  const global = discovery.getGlobalScenarios();
  const all: ScenarioInfo[] = [...project, ...global];

  if (scenarioName === "*") {
    const seen = new Set<string>();
    const out: ScenarioWithScope[] = [];
    for (const s of all) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      const source = project.some((p) => p.name === s.name) ? "project" : "global";
      out.push({ name: s.name, path: s.path, source });
    }
    return out;
  }

  const resolution = discovery.resolveScenario(scenarioName);
  return [{ name: resolution.scenario.name, path: resolution.scenario.path, source: resolution.source }];
}

function repoNameFromRemote(remote: string | null): string {
  if (!remote) return "unknown";
  return remote.replace(/.*[/:]/, "").replace(/\.git$/, "");
}

function buildNoteName(meta: DotenvMeta): string {
  return meta.scope === "global"
    ? `global - ${meta.relpath}`
    : `project - ${repoNameFromRemote(meta.repo)} - ${meta.relpath}`;
}

function buildNoteYaml(meta: DotenvMeta, dotenv: string): string {
  return yaml.dump(
    { axn: meta, dotenv },
    { lineWidth: -1, noRefs: true }
  );
}

function parseNoteYaml(raw: string): { axn: DotenvMeta; dotenv: string } {
  let parsed: any;
  try {
    parsed = yaml.load(raw);
  } catch (err: any) {
    throw new Error(`Invalid note YAML: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Note is not a YAML object");
  }
  if (typeof parsed.dotenv !== "string") {
    throw new Error("Note is missing the 'dotenv' string");
  }
  return { axn: parsed.axn as DotenvMeta, dotenv: parsed.dotenv };
}

function buildSecureNote(name: string, content: string, folderId: string): object {
  return {
    organizationId: null,
    collectionIds: null,
    folderId,
    type: 2,
    name,
    notes: content,
    favorite: false,
    fields: [],
    login: null,
    secureNote: { type: 0 },
    card: null,
    identity: null,
    reprompt: 0,
  };
}

async function getInfraBase(meta: DotenvMeta): Promise<string> {
  let path: string | null = meta.repo ? await findRepoByRemote(meta.repo) : null;
  if (path) return realpathSync(path);

  if (meta.scope === "global") {
    const config = loadAxnDevConfig(process.cwd());
    const infra = configSection<string>(config, "infra");
    if (infra) return realpathSync(resolve(expandHome(infra)));
  }

  const repo = detectRepo(process.cwd());
  if (repo) {
    const remote = await getRepoRemote(repo.repoRoot);
    if (remote === meta.repo || !meta.repo) return realpathSync(resolveInfraRoot());
  }

  throw new Error(`Cannot find repo with remote '${meta.repo}'`);
}

async function findScenario(meta: DotenvMeta): Promise<{ path: string }> {
  let repoPath: string | null = meta.repo ? await findRepoByRemote(meta.repo) : null;
  if (!repoPath) {
    const repo = detectRepo(process.cwd());
    const remote = repo ? await getRepoRemote(repo.repoRoot) : null;
    if (repo && (remote === meta.repo || !meta.repo)) repoPath = repo.repoRoot;
  }
  if (!repoPath) throw new Error(`Cannot find repo with remote '${meta.repo}'`);

  const discovery = new ScenarioDiscoveryService(repoPath);
  const resolution = discovery.resolveScenario(meta.relpath);
  return resolution.scenario;
}

export async function backupDotenvToBitwarden(opts: DotenvBitwardenBackupOptions): Promise<{ folder: string; name: string }[]> {
  await ensureBitwardenUnlocked();
  const backedUp: { folder: string; name: string }[] = [];
  let found = 0;

  await runBw(["sync"]);
  const allItems: BitwardenItem[] = JSON.parse(await runBw(["list", "items"]));
  const byName = new Map<string, { id: string; folderId: string | null }>();
  for (const i of allItems) {
    if (i.type === 2) byName.set(i.name, { id: i.id, folderId: i.folderId });
  }

  const infraFolderId = opts.infra ? await getFolderId(INFRA_FOLDER) : null;
  const scenarioFolderId = opts.scenario ? await getFolderId(SCENARIO_FOLDER) : null;

  if (opts.infra) {
    const infraRoot = realpathSync(resolveInfraRoot());
    const globalRoot = getGlobalInfraRoot();
    const isGlobal = infraRoot === globalRoot;
    const info = await getRepoInfo(infraRoot);
    const files = discoverInfraDotenvFiles(opts.infra);
    found += files.length;

    for (const f of files) {
      const relpath = relative(infraRoot, f);
      const dotenv = readFileSync(f, "utf-8");
      const meta: DotenvMeta = {
        type: "infra",
        scope: isGlobal ? "global" : "project",
        repo: info?.repo ?? null,
        relpath,
      };
      const name = buildNoteName(meta);
      const content = buildNoteYaml(meta, dotenv);
      const encoded = (await runBw(["encode"], JSON.stringify(buildSecureNote(name, content, infraFolderId!)))).trim();

      const existing = byName.get(name);
      if (existing) {
        if (existing.folderId === infraFolderId && !opts.force) {
          console.log(`  skipped (exists in Bitwarden): ${INFRA_FOLDER}/${name}`);
          continue;
        }
        await runBw(["edit", "item", existing.id, encoded]);
      } else {
        await runBw(["create", "item", encoded]);
      }
      backedUp.push({ folder: INFRA_FOLDER, name });
    }
  }

  if (opts.scenario) {
    const scenarios = getScenariosToProcess(opts.scenario);

    for (const s of scenarios) {
      const envPath = join(s.path, ".env");
      if (!existsSync(envPath)) continue;
      found++;

      const info = await getRepoInfo(s.path);
      const dotenv = readFileSync(envPath, "utf-8");
      const meta: DotenvMeta = {
        type: "scenario",
        scope: s.source,
        repo: info?.repo ?? null,
        relpath: s.name,
      };
      const name = buildNoteName(meta);
      const content = buildNoteYaml(meta, dotenv);
      const encoded = (await runBw(["encode"], JSON.stringify(buildSecureNote(name, content, scenarioFolderId!)))).trim();

      const existing = byName.get(name);
      if (existing) {
        if (existing.folderId === scenarioFolderId && !opts.force) {
          console.log(`  skipped (exists in Bitwarden): ${SCENARIO_FOLDER}/${name}`);
          continue;
        }
        await runBw(["edit", "item", existing.id, encoded]);
      } else {
        await runBw(["create", "item", encoded]);
      }
      backedUp.push({ folder: SCENARIO_FOLDER, name });
    }
  }

  await runBw(["sync"]);
  if (found === 0) throw new Error("No .env files found to back up.");
  return backedUp;
}

export async function restoreDotenvFromBitwarden(opts: DotenvBitwardenRestoreOptions): Promise<string[]> {
  await ensureBitwardenUnlocked();
  const restored: string[] = [];
  const failed: { name: string; error: string }[] = [];

  if (opts.infra) {
    const folderId = await getFolderId(INFRA_FOLDER);
    const items: BitwardenItem[] = JSON.parse(await runBw(["list", "items", "--folderid", folderId]));
    const pattern = opts.infra === "*" ? "" : opts.infra;

    for (const item of items) {
      try {
        const full: BitwardenItem = JSON.parse(await runBw(["get", "item", item.id]));
        if (!full.notes) continue;
        const { axn, dotenv } = parseNoteYaml(full.notes);

        if (pattern && !axn.relpath.includes(pattern)) continue;

        const base = await getInfraBase(axn);
        const target = join(base, axn.relpath);
        if (existsSync(target) && !opts.force) {
          console.log(`  skipped (exists): ${target}`);
          continue;
        }

        ensureDir(dirname(target));
        writeFileSync(target, dotenv);
        restored.push(target);
      } catch (err: any) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  error, skipping: ${item.name}: ${message}`);
        failed.push({ name: item.name, error: message });
      }
    }
  }

  if (opts.scenario) {
    const folderId = await getFolderId(SCENARIO_FOLDER);
    const items: BitwardenItem[] = JSON.parse(await runBw(["list", "items", "--folderid", folderId]));
    const pattern = opts.scenario === "*" ? "" : opts.scenario;

    for (const item of items) {
      try {
        const full: BitwardenItem = JSON.parse(await runBw(["get", "item", item.id]));
        if (!full.notes) continue;
        const { axn, dotenv } = parseNoteYaml(full.notes);

        if (pattern && !axn.relpath.includes(pattern)) continue;

        const scenario = await findScenario(axn);
        const target = join(scenario.path, ".env");
        if (existsSync(target) && !opts.force) {
          console.log(`  skipped (exists): ${target}`);
          continue;
        }

        ensureDir(dirname(target));
        writeFileSync(target, dotenv);
        restored.push(target);
      } catch (err: any) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  error, skipping: ${item.name}: ${message}`);
        failed.push({ name: item.name, error: message });
      }
    }
  }

  if (failed.length > 0) {
    console.error(`\nFailed to restore ${failed.length} .env note(s):`);
    for (const { name, error } of failed) {
      console.error(`  ${name}: ${error}`);
    }
    if (restored.length === 0) {
      throw new Error("No .env files were restored.");
    }
  }

  return restored;
}
