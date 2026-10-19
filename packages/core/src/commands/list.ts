import type { Command } from "./command.js";
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
    try {
      const runningEnv = { ...process.env as Record<string, string>, ...env };
      if (s.type && s.type !== "compose") {
        // Non-compose types expose their endpoints through the driver —
        // e.g. resolved ports a running instance actually bound.
        const driver = await driverFor(s);
        const padTo = " ".repeat(indent.length + 2);
        const seen = new Set<string>();
        for (const { label, url } of driver.endpoints?.(s) ?? []) {
          if (seen.has(url)) continue;
          seen.add(url);
          console.log(`${padTo}\x1b[90m${label.padEnd(20)} ${url}\x1b[0m`);
        }
        return;
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
        for (const [name, ep] of Object.entries(friendly).sort(([a], [b]) => a.localeCompare(b))) {
          console.log(`${indent}  \x1b[90m${name.padEnd(20)} ${ep.url}\x1b[0m`);
        }
      } else {
        const ports = getComposePorts(s.path, runningEnv);
        for (const [port, service] of ports) {
          console.log(`${indent}  \x1b[90m${service.padEnd(20)} http://localhost:${port}\x1b[0m`);
        }
      }
    } catch {
      // port info unavailable
    }
  }
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
    return ["--tags", "-t", "--help", "-h"].filter((f) => f.startsWith(cur) && f !== cur);
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
  -h, --help          Show this help
`;
  }

  async execute(args: string[]): Promise<void> {
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
