import type { Command } from "./command.js";
import { execSync } from "node:child_process";
import { discoverGlobalScenarios, discoverAllProjectScenarios } from "../util/repo.js";
import { loadAxnDevConfig, loadWorkspaceConfig } from "../util/config.js";
import { getRunningComposeProjectDirs, getComposePorts, getRunningPortOverrides, getRunningScenarioPort, resolveEndpoints } from "../util/ports.js";
import { driverFor, getRunningDriverDirs } from "../driver.js";
import { devServerUrlEnv } from "../util/dev-servers.js";
import { listTags } from "../completion-helpers.js";
import type { ScenarioInfo } from "../util/repo.js";

const STATUS_WIDTH = "● running".length;

function matchesTags(s: ScenarioInfo, filters: string[]): boolean {
  if (filters.length === 0) return true;
  return (s.tags ?? []).some((tag) => {
    const t = tag.toLowerCase();
    return filters.some((f) => t === f || t.startsWith(`${f}/`));
  });
}

function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

async function printScenario(
  s: ScenarioInfo,
  runningDirs: Set<string>,
  env: Record<string, string>,
  nameWidth: number,
  indent: string = "  ",
): Promise<void> {
  const isRunning = runningDirs.has(s.path.replace(/\/+$/, ""));
  const status = isRunning ? "\x1b[32m● running\x1b[0m" : "\x1b[90m○ stopped\x1b[0m";
  const worktreeLabel = s.worktree && !s.worktree.isMain
    ? ` [worktree: ${s.worktree.branch} @ ${s.worktree.displayPath}]`
    : "";
  const sep = s.description ? " — " : " ";
  const text = s.description ? `${s.description}${worktreeLabel}` : worktreeLabel.trimStart();
  const textCol = indent.length + nameWidth + 1 + STATUS_WIDTH + sep.length;
  const termWidth = process.stdout.columns ?? 0;
  const lines = text && termWidth > textCol + 10 ? wrapText(text, termWidth - textCol) : [text];

  console.log(`${indent}${s.name.padEnd(nameWidth)} ${status}${text ? sep + lines[0] : ""}`);
  const pad = " ".repeat(textCol);
  for (const extra of lines.slice(1)) {
    console.log(pad + extra);
  }

  if (isRunning) {
    const padTo = " ".repeat(indent.length + 2);
    for (const { label, url } of await runningEndpoints(s, env)) {
      console.log(`${padTo}\x1b[90m${label.padEnd(20)} ${url}\x1b[0m`);
    }
  }
}

/**
 * Endpoints of a running scenario — resolved service URLs for compose
 * scenarios (running port overrides + SCENARIO_PORT applied), driver-exposed
 * endpoints for other types. Returns [] when port info is unavailable.
 */
async function runningEndpoints(
  s: ScenarioInfo,
  env: Record<string, string>,
): Promise<{ label: string; url: string }[]> {
  try {
    const runningEnv = { ...process.env as Record<string, string>, ...env };
    if (s.type && s.type !== "compose") {
      // Non-compose types expose their endpoints through the driver —
      // e.g. resolved ports a running instance actually bound.
      const driver = await driverFor(s);
      const seen = new Set<string>();
      const out: { label: string; url: string }[] = [];
      for (const { label, url } of driver.endpoints?.(s) ?? []) {
        if (seen.has(url)) continue;
        seen.add(url);
        out.push({ label, url });
      }
      return out;
    }
    // Overlay the ports the running containers actually published — env
    // vars reassigned by --auto-port only exist on the docker side.
    Object.assign(runningEnv, getRunningPortOverrides(s.path, runningEnv));
    const runningPort = getRunningScenarioPort(s.path);
    if (runningPort !== null) {
      runningEnv.SCENARIO_PORT = String(runningPort);
    }

    const frontendMap = s.frontendServices ?? s.proxies;
    if (frontendMap && Object.keys(frontendMap).length > 0) {
      const friendly = resolveEndpoints(frontendMap, runningEnv);
      return Object.entries(friendly)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, ep]) => ({ label: name, url: ep.url }));
    }
    const ports = getComposePorts(s.path, runningEnv);
    const out: { label: string; url: string }[] = [];
    for (const [port, service] of ports) {
      out.push({ label: service, url: `http://localhost:${port}` });
    }
    return out;
  } catch {
    // port info unavailable
    return [];
  }
}

const MEM_UNITS: Record<string, number> = {
  B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12,
  KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4,
};

function memToBytes(text: string): number {
  const m = /^([\d.]+)\s*([A-Za-z]+)/.exec(text.trim());
  return m ? parseFloat(m[1]) * (MEM_UNITS[m[2]] ?? 1) : 0;
}

function formatMem(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GiB`
    : `${Math.round(bytes / 1024 ** 2)} MiB`;
}

/**
 * CPU% + memory used per running compose project working dir — one
 * `docker ps` + one batched `docker stats --no-stream`, grouped by the
 * com.docker.compose.project.working_dir label. Empty map when Docker or
 * stats are unavailable.
 */
function runningResources(): Map<string, { cpuPercent: number; mem: string }> {
  const out = new Map<string, { cpuPercent: number; mem: string }>();
  try {
    const ps = execSync(
      'docker ps --format \'{{.Names}}|{{.Label "com.docker.compose.project.working_dir"}}\'',
      { encoding: "utf8" },
    ).trim();
    if (!ps) return out;
    const names: string[] = [];
    const dirOf = new Map<string, string>();
    for (const line of ps.split("\n")) {
      const [name, dir] = line.split("|");
      if (!name || !dir) continue;
      names.push(name);
      dirOf.set(name, dir.replace(/\/+$/, ""));
    }
    if (!names.length) return out;
    const stats = execSync(
      `docker stats --no-stream --format '{{.CPUPerc}}|{{.MemUsage}}' ${names.map((n) => `'${n}'`).join(" ")}`,
      { encoding: "utf8" },
    ).trim().split("\n");
    const acc = new Map<string, { cpu: number; bytes: number }>();
    stats.forEach((line, i) => {
      const dir = dirOf.get(names[i]);
      if (!dir) return;
      const [cpu, mem] = line.split("|");
      const cur = acc.get(dir) ?? { cpu: 0, bytes: 0 };
      cur.cpu += parseFloat(cpu) || 0;
      cur.bytes += memToBytes((mem ?? "").split("/")[0]);
      acc.set(dir, cur);
    });
    for (const [dir, r] of acc) {
      out.set(dir, { cpuPercent: Math.round(r.cpu * 10) / 10, mem: formatMem(r.bytes) });
    }
  } catch {
    // docker unavailable
  }
  return out;
}

export class ListCommand implements Command {
  readonly name = "list";
  readonly description = "List available scenarios and their running status";

  complete(words: string[]): string[] {
    const prev = words[words.length - 2] ?? "";
    const cur = words[words.length - 1] ?? "";
    if (prev === "-t" || prev === "--tags") {
      const prefix = cur.includes(",") ? cur.slice(0, cur.lastIndexOf(",") + 1) : "";
      const seg = cur.slice(prefix.length);
      return listTags().filter((t) => t.startsWith(seg)).map((t) => prefix + t);
    }
    return ["--tags", "-t", "--json", "--help", "-h"].filter((f) => f.startsWith(cur) && f !== cur);
  }

  help(): string {
    return `
axn-dev list [options]

Lists all available scenarios with running status and ports:
- Global scenarios from configured integration repos
- Project scenarios from all repos in ~/.axn-dev/config.yaml

Options:
  -t, --tags <tags>   Only show scenarios carrying any of the given
                      comma-separated tags (a tag also matches its
                      subtrees, e.g. "mygroup" matches "mygroup/e2e")
      --json          Machine-readable output: {sections:[{label, scope,
                      scenarios:[{name, path, running, description, tags,
                      worktree?, endpoints[]}]}]} — used by UI clients
                      (e.g. the axn-term plugin) that need tags and paths
  -h, --help          Show this help
`;
  }

  async execute(args: string[]): Promise<void> {
    let json = false;
    const tagFilters: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-h" || arg === "--help") {
        console.log(this.help());
        return;
      } else if (arg === "-t" || arg === "--tags") {
        const value = args[++i];
        if (!value) throw new Error("--tags requires a value");
        tagFilters.push(...value.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean));
      } else if (arg === "--json") {
        json = true;
      }
    }

    const axnConfig = loadAxnDevConfig();
    const repoEnv = loadWorkspaceConfig(axnConfig).repoEnv;

    const globalScenarios = (axnConfig.integration.length > 0
      ? discoverGlobalScenarios(axnConfig)
      : []).filter((s) => matchesTags(s, tagFilters));
    const allProjectScenarios = discoverAllProjectScenarios(axnConfig)
      .filter((s) => matchesTags(s, tagFilters));

    // Compose scenarios surface via docker project labels; other types are
    // probed through their registered drivers.
    const runningDirs = getRunningComposeProjectDirs();
    for (const dir of await getRunningDriverDirs([...globalScenarios, ...allProjectScenarios])) {
      runningDirs.add(dir);
    }
    const isRunningDir = (p: string) => runningDirs.has(p.replace(/\/+$/, ""));

    if (json) {
      const resources = runningResources();
      const toJson = async (s: ScenarioInfo) => ({
        name: s.name,
        path: s.path,
        running: isRunningDir(s.path),
        description: s.description ?? "",
        tags: s.tags ?? [],
        ...(s.worktree && !s.worktree.isMain
          ? { worktree: { branch: s.worktree.branch, path: s.worktree.path } }
          : {}),
        endpoints: isRunningDir(s.path)
          ? await runningEndpoints(s, { ...repoEnv, ...(s.env ?? {}) })
          : [],
        ...(isRunningDir(s.path) && resources.get(s.path.replace(/\/+$/, ""))
          ? { resources: resources.get(s.path.replace(/\/+$/, "")) }
          : {}),
      });
      const sections = [];
      if (globalScenarios.length > 0) {
        sections.push({
          label: "global",
          scope: "global",
          scenarios: await Promise.all(globalScenarios.map(toJson)),
        });
      }
      const groupedByRepo = new Map<string, typeof allProjectScenarios>();
      for (const s of allProjectScenarios) {
        const l = groupedByRepo.get(s.repoName) ?? [];
        l.push(s);
        groupedByRepo.set(s.repoName, l);
      }
      for (const [repoName, scenarios] of groupedByRepo) {
        sections.push({
          label: repoName,
          scope: "project",
          scenarios: await Promise.all(scenarios.map(toJson)),
        });
      }
      console.log(JSON.stringify({ sections }));
      return;
    }

    const nameWidth = Math.max(1, ...globalScenarios.map(s => s.name.length), ...allProjectScenarios.map(s => s.name.length));

    // Global scenarios first
    if (globalScenarios.length > 0) {
      console.log("Global scenarios:");
      for (const s of globalScenarios) {
        await printScenario(s, runningDirs, { ...repoEnv, ...(s.env ?? {}) }, nameWidth);
      }
    }

    // Project scenarios grouped by repo
    if (allProjectScenarios.length > 0) {
      console.log("");
      console.log("Project scenarios:");
      const groupedByRepo = new Map<string, typeof allProjectScenarios>();
      for (const s of allProjectScenarios) {
        if (!groupedByRepo.has(s.repoName)) groupedByRepo.set(s.repoName, []);
        groupedByRepo.get(s.repoName)!.push(s);
      }
      for (const [repoName, scenarios] of groupedByRepo) {
        console.log(`  ${repoName}:`);
        for (const s of scenarios) {
          await printScenario(s, runningDirs, { ...repoEnv, ...(s.env ?? {}) }, nameWidth, "    ");
        }
      }
    }

    if (!globalScenarios.length && !allProjectScenarios.length) {
      console.log(tagFilters.length > 0
        ? `No scenarios matched tag(s): ${tagFilters.join(", ")}`
        : "No scenarios found. Configure repos in ~/.axn-dev/config.yaml");
    }
  }
}
