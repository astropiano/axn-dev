// Lifecycle for a scenario's `dev-servers:` entries (axn-dev.yaml) —
// auxiliary dev servers in other repos (e.g. a vite dev server or a sim
// dashboard in a sibling repo) that should live as long as the
// scenario does.
//
// Semantics:
//  - start: a listener already answering HTTP on the port is *reused*
//    (dashboards are device-agnostic thanks to ?control=); anything else
//    occupying the port fails the start — the declared server cannot run.
//    A free port spawns the command detached, pid + log under
//    ~/.axn-dev/dev-servers/<hash>.{pid,log}. Any failure (foreign port,
//    missing repo, early exit, readiness timeout) propagates as an error
//    so the caller's exit code reflects the dev-servers' health.
//  - stop: only pids we spawned are killed (process group, SIGTERM).
//    Reused servers are left running — someone else may be using them.

import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ScenarioInfo } from "./repo.js";
import type { AxnDevConfig, DevServerSpec } from "./config.js";
import { isPortFree, substituteEnvVars } from "./ports.js";

const READY_TIMEOUT_MS = 20_000;
const READY_POLL_MS = 400;

function stateDir(): string {
  const dir = join(homedir(), ".axn-dev", "dev-servers");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function stateKey(scenarioPath: string, label: string): string {
  return createHash("md5").update(`${scenarioPath}:${label}`).digest("hex").slice(0, 12);
}

function pidFile(scenarioPath: string, label: string): string {
  return join(stateDir(), `${stateKey(scenarioPath, label)}.pid`);
}

function logFile(scenarioPath: string, label: string): string {
  return join(stateDir(), `${stateKey(scenarioPath, label)}.log`);
}

/** Env-var prefix derived from a label: "sim-dashboard" → "SIM_DASHBOARD". */
export function devServerEnvPrefix(label: string): string {
  return label.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/** ${<LABEL>_URL} / ${<LABEL>_PORT} for each dev-server with a port —
 * merge into the env used to resolve frontend-services and links. */
export function devServerUrlEnv(specs: DevServerSpec[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const s of specs) {
    if (s.port === undefined) continue;
    const prefix = devServerEnvPrefix(s.label);
    env[`${prefix}_PORT`] = String(s.port);
    // URL only makes sense for socket servers; the scheme matches the probe.
    if (s.probe !== "none") {
      env[`${prefix}_URL`] = `${s.probe === "tcp" ? "tcp" : "http"}://localhost:${s.port}`;
    }
  }
  return env;
}

async function answersHttp(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.status > 0;
  } catch {
    return false;
  }
}

function answersTcp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(2000, () => done(false));
  });
}

function portAnswers(port: number, probe?: "http" | "tcp" | "none"): Promise<boolean> {
  if (probe === "tcp") return answersTcp(port);
  if (probe === "none") return Promise.resolve(false); // foreign until proven ours
  return answersHttp(port);
}

function repoPathFor(
  spec: DevServerSpec,
  scenario: ScenarioInfo & { repoName?: string },
  config: AxnDevConfig,
): string | null {
  // The scenario's own repo honours its linked worktree; other repos run
  // from their registered main checkout.
  if (!spec.repo && scenario.worktree?.path) return scenario.worktree.path;
  const name = spec.repo ?? scenario.repoName;
  return (name && config.repos[name]) || null;
}

/** Start every dev-server the scenario declares. Safe to call when some are
 * already running — those are reused, never double-spawned. Throws when any
 * declared server fails to start so callers can reflect it in their exit
 * code; servers that did come up stay running. */
export async function startDevServers(
  scenario: ScenarioInfo,
  env: Record<string, string>,
  config: AxnDevConfig,
): Promise<void> {
  const failures: string[] = [];
  for (const spec of scenario.devServers ?? []) {
    const failure = await startOne(spec, scenario, env, config);
    if (failure !== null) failures.push(`dev-server ${spec.label}: ${failure}`);
  }
  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Returns null on success (spawned or reused) or a failure reason. */
async function startOne(
  spec: DevServerSpec,
  scenario: ScenarioInfo & { repoName?: string },
  env: Record<string, string>,
  config: AxnDevConfig,
): Promise<string | null> {
  const label = spec.label;

  // A live pidfile means we spawned it earlier (restart reuses — aux servers
  // stay warm across scenario restarts; only `stop` kills them).
  const file = pidFile(scenario.path, label);
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, "utf8").trim());
    if (pidAlive(pid)) {
      console.log(`  dev-server ${label}: already running (pid ${pid})`);
      return null;
    }
    rmSync(file, { force: true });
  }

  if (spec.port !== undefined) {
    if (!(await isPortFree(spec.port))) {
      if (await portAnswers(spec.port, spec.probe)) {
        console.log(`  dev-server ${label}: localhost:${spec.port} already running — reusing`);
        return null;
      }
      return `port ${spec.port} in use by a foreign process`;
    }
  }

  const cwd = repoPathFor(spec, scenario, config);
  if (!cwd || !existsSync(cwd)) {
    return `repo '${spec.repo ?? scenario.repoName}' not found`;
  }

  const childEnv: Record<string, string> = { ...process.env as Record<string, string> };
  if (spec.port !== undefined) childEnv.PORT = String(spec.port);
  for (const entry of spec.env ?? []) {
    const eq = entry.indexOf("=");
    if (eq === -1) continue;
    childEnv[entry.slice(0, eq)] = substituteEnvVars(entry.slice(eq + 1), env);
  }

  const logFd = openSync(logFile(scenario.path, label), "a");
  const child = spawn("bash", ["-c", spec.command], {
    cwd,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: childEnv,
  });
  child.unref();
  writeFileSync(pidFile(scenario.path, label), String(child.pid));

  console.log(`  dev-server ${label}: spawning '${spec.command}' (log: ${logFile(scenario.path, label)})`);

  if (spec.port !== undefined && spec.probe !== "none") {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await portAnswers(spec.port, spec.probe)) {
        console.log(`  dev-server ${label}: localhost:${spec.port} up`);
        return null;
      }
      if (child.exitCode !== null) {
        rmSync(pidFile(scenario.path, label), { force: true });
        return `exited early (code ${child.exitCode}) — see ${logFile(scenario.path, label)}`;
      }
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
    return `port ${spec.port} not answering after ${READY_TIMEOUT_MS / 1000}s (log: ${logFile(scenario.path, label)})`;
  }
  return null;
}

/** Kill the dev-servers this scenario spawned (pidfiles we wrote). Servers
 * that were already running when the scenario started are left alone. */
export function stopDevServers(scenario: ScenarioInfo): void {
  for (const spec of scenario.devServers ?? []) {
    const file = pidFile(scenario.path, spec.label);
    if (!existsSync(file)) continue;
    try {
      const pid = Number(readFileSync(file, "utf8").trim());
      // Negative pid kills the whole process group (vite forks children).
      process.kill(-pid, "SIGTERM");
      console.log(`  dev-server ${spec.label}: stopped (pid ${pid})`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
        console.log(`\x1b[33m  dev-server ${spec.label}: stop failed: ${err}\x1b[0m`);
      }
    }
    rmSync(file, { force: true });
  }
}
