import { spawn, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { load as loadYaml } from "js-yaml";
import { basename, join } from "node:path";
import { getCanonicalRepoName, getWorktreeInfo, getWorktreeInfoAsync } from "./worktree.js";
import { registeredRepoName } from "./repo.js";

const execFileAsync = promisify(execFile);

export interface ComposeCommand {
  /** Binary to spawn or exec, e.g. "docker" or "docker-compose" */
  binary: string;
  /** Arguments that must appear before the compose sub-command, e.g. ["compose"] */
  prefixArgs: string[];
  /** Human-readable command, e.g. "docker compose" or "docker-compose" */
  command: string;
}

let composeCommandCache: ComposeCommand | null = null;

function probe(binary: string, args: string[]): string | null {
  try {
    const output = execFileSync(binary, args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return output.trim();
  } catch {
    return null;
  }
}

async function probeAsync(binary: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(binary, args, { encoding: "utf-8" });
    return stdout.trim();
  } catch {
    return null;
  }
}

function looksLikeDockerComposeVersion(output: string): boolean {
  // The real `docker compose version` prints something like:
  //   Docker Compose version v2.27.0
  // Some Docker CLI versions treat `docker compose --version` as a global
  // `--version` flag and print `Docker version ...` instead, so we guard
  // against that by requiring both "Compose" and "version".
  return /compose/i.test(output) && /version/i.test(output);
}

/**
 * Detect the available Docker Compose command.
 *
 * Prefers `docker compose` (the v2 plugin shipped with Docker CLI). If the
 * plugin is not present, falls back to a standalone `docker-compose` binary
 * (v1 Python or v2 standalone). The result is cached for the process lifetime.
 */
export function getComposeCommand(): ComposeCommand {
  if (composeCommandCache) {
    return composeCommandCache;
  }

  // Try the v2 plugin form first: `docker compose version`.
  const dockerComposeOut = probe("docker", ["compose", "version"]);
  if (dockerComposeOut && looksLikeDockerComposeVersion(dockerComposeOut)) {
    composeCommandCache = {
      binary: "docker",
      prefixArgs: ["compose"],
      command: "docker compose",
    };
    return composeCommandCache;
  }

  // Fall back to the standalone binary.
  for (const args of [["version"], ["--version"]] as string[][]) {
    if (probe("docker-compose", args) !== null) {
      composeCommandCache = {
        binary: "docker-compose",
        prefixArgs: [],
        command: "docker-compose",
      };
      return composeCommandCache;
    }
  }

  throw new Error(
    "Neither 'docker compose' (v2 plugin) nor 'docker-compose' is available. " +
      "Please install Docker Compose."
  );
}

/**
 * Async variant of {@link getComposeCommand} — same detection order and the
 * same process-lifetime cache, but the probe subprocesses run off the event
 * loop so `axn-dev serve` stays responsive.
 */
export async function resolveComposeCommand(): Promise<ComposeCommand> {
  if (composeCommandCache) {
    return composeCommandCache;
  }

  const dockerComposeOut = await probeAsync("docker", ["compose", "version"]);
  if (dockerComposeOut && looksLikeDockerComposeVersion(dockerComposeOut)) {
    composeCommandCache = {
      binary: "docker",
      prefixArgs: ["compose"],
      command: "docker compose",
    };
    return composeCommandCache;
  }

  for (const args of [["version"], ["--version"]] as string[][]) {
    if ((await probeAsync("docker-compose", args)) !== null) {
      composeCommandCache = {
        binary: "docker-compose",
        prefixArgs: [],
        command: "docker-compose",
      };
      return composeCommandCache;
    }
  }

  throw new Error(
    "Neither 'docker compose' (v2 plugin) nor 'docker-compose' is available. " +
      "Please install Docker Compose."
  );
}

/**
 * Return the full local compose invocation as a single string.
 */
export function composeCommand(...subcommand: string[]): string {
  const cmd = getComposeCommand();
  return [cmd.binary, ...cmd.prefixArgs, ...subcommand].join(" ");
}

/**
 * A shell snippet that detects the available compose command on the machine
 * where it runs and stores it in the `COMPOSE_CMD` variable.
 *
 * This is useful for commands executed on remote hosts via SSH, where the
 * remote machine may have `docker compose` or `docker-compose` (v1/v2
 * standalone) but not both.
 */
export function composeDetectShell(): string {
  return (
    `COMPOSE_CMD=""; ` +
    `if docker compose version >/dev/null 2>&1; then ` +
    `  COMPOSE_CMD="docker compose"; ` +
    `elif docker-compose version >/dev/null 2>&1 || docker-compose --version >/dev/null 2>&1; then ` +
    `  COMPOSE_CMD="docker-compose"; ` +
    `else ` +
    `  echo "Docker Compose not found" >&2; exit 1; ` +
    `fi`
  );
}

/**
 * Check if Docker daemon is running and accessible.
 * Throws an error if Docker is not available.
 */
async function checkDocker(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["info"], {
      stdio: "pipe",
    });

    let errorOutput = "";

    child.stderr?.on("data", (data) => {
      errorOutput += data.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `Docker daemon is not running or not accessible.\n${errorOutput || "Please start Docker (e.g., 'colima start' or 'docker desktop')"}`
          )
        );
      }
    });

    child.on("error", (err) => {
      reject(
        new Error(
          `Docker command not found or daemon not running: ${err.message}\nPlease ensure Docker is installed and running.`
        )
      );
    });
  });
}

export interface ComposeRunOptions {
  /** Absolute path to the scenario folder (contains docker-compose.yaml) */
  scenarioPath: string;
  /** Absolute path to the repos root (parent of all repo checkouts) */
  reposRoot: string;
  /** docker-compose subcommand args, e.g. ["up", "--build", "-d"] */
  args: string[];
  /** Per-repo env vars from workspace config (e.g. MY_SERVER_ROOT) */
  repoEnv?: Record<string, string>;
  /** Extra environment variables from scenario axn-dev.yaml */
  env?: Record<string, string>;
  /**
   * Explicit compose project name (e.g. recovered from running containers via
   * getRunningComposeProjects). When unset, the name is derived from repo /
   * scenario / branch / SCENARIO_PORT.
   */
  projectName?: string;
  /**
   * Optional callback receiving compose stdout/stderr chunks.
   * Output is still forwarded to this process's terminal.
   */
  onOutput?: (chunk: string) => void;
}

function slugify(text: string | null): string {
  return (text ?? "detached")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}


/**
 * Optional repo-local override for the derived compose project name:
 * `<repoRoot>/.axn-dev/config.yaml` with a `project-name:` key. Lets two
 * checkouts of the same repo (or mirrored public/internal clones, which
 * share the repo directory name) run stacks side by side without
 * colliding on compose project, network and per-user container names.
 */
function getProjectNameOverride(repoRoot: string): string | null {
  const cfg = join(repoRoot, ".axn-dev", "config.yaml");
  if (!existsSync(cfg)) return null;
  try {
    const parsed = loadYaml(readFileSync(cfg, "utf-8")) as Record<string, unknown> | null;
    const name = parsed?.["project-name"];
    return typeof name === "string" && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

export function getComposeProjectName(scenarioPath: string, env?: Record<string, string>): string | null {
  let repoRoot: string;
  try {
    repoRoot = execFileSync(
      "git",
      ["-C", scenarioPath, "rev-parse", "--show-toplevel"],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
  } catch {
    return null;
  }

  const repoName = registeredRepoName(repoRoot) ?? getCanonicalRepoName(repoRoot);
  const scenario = basename(scenarioPath);

  const { worktrees } = getWorktreeInfo(repoRoot);
  const current = worktrees.find((w) => w.path === repoRoot);

  let branchSlug: string | null = null;
  if (current && !current.isMain) {
    branchSlug = slugify(current.branch);
  } else if (env?.SCENARIO_PORT) {
    // Main checkout: still need a unique project name when a single port is requested.
    try {
      const branch = execFileSync(
        "git",
        ["-C", scenarioPath, "rev-parse", "--abbrev-ref", "HEAD"],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      ).trim();
      branchSlug = slugify(branch);
    } catch {
      branchSlug = "main";
    }
  }

  if (!branchSlug) return null;

  const portSuffix = env?.SCENARIO_PORT ? `-${env.SCENARIO_PORT}` : "";
  const override = getProjectNameOverride(repoRoot);
  return `${override ?? `axn-${repoName}-${scenario}-${branchSlug}`}${portSuffix}`;
}

/** Async variant of getComposeProjectName — used by runCompose so serve
 * request handlers never block the event loop on git subprocesses. */
export async function getComposeProjectNameAsync(scenarioPath: string, env?: Record<string, string>): Promise<string | null> {
  let repoRoot: string;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", scenarioPath, "rev-parse", "--show-toplevel"],
      { encoding: "utf-8" },
    );
    repoRoot = stdout.trim();
  } catch {
    return null;
  }

  const repoName = registeredRepoName(repoRoot) ?? getCanonicalRepoName(repoRoot);
  const scenario = basename(scenarioPath);

  const { worktrees } = await getWorktreeInfoAsync(repoRoot);
  const current = worktrees.find((w) => w.path === repoRoot);

  let branchSlug: string | null = null;
  if (current && !current.isMain) {
    branchSlug = slugify(current.branch);
  } else if (env?.SCENARIO_PORT) {
    // Main checkout: still need a unique project name when a single port is requested.
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", scenarioPath, "rev-parse", "--abbrev-ref", "HEAD"],
        { encoding: "utf-8" },
      );
      branchSlug = slugify(stdout.trim());
    } catch {
      branchSlug = "main";
    }
  }

  if (!branchSlug) return null;

  const portSuffix = env?.SCENARIO_PORT ? `-${env.SCENARIO_PORT}` : "";
  const override = getProjectNameOverride(repoRoot);
  return `${override ?? `axn-${repoName}-${scenario}-${branchSlug}`}${portSuffix}`;
}

/**
 * Run docker compose in the scenario folder.
 * Loads .env file from the scenario folder if present.
 * Returns the exit code.
 */
export async function runCompose(options: ComposeRunOptions): Promise<number> {
  await checkDocker();

  const cmd = await resolveComposeCommand();
  const { scenarioPath, args, env: extraEnv } = options;

  const envFile = join(scenarioPath, ".env");
  const composeArgs: string[] = [];

  if (existsSync(envFile)) {
    composeArgs.push("--env-file", envFile);
  }

  composeArgs.push(...args);

  const childEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    ...options.repoEnv,
    ...extraEnv,
  };

  const projectName = options.projectName ?? (await getComposeProjectNameAsync(scenarioPath, childEnv));
  if (projectName) {
    childEnv.COMPOSE_PROJECT_NAME = projectName;
  }

  return new Promise((resolve) => {
    const capture = typeof options.onOutput === "function";
    const child = spawn(cmd.binary, [...cmd.prefixArgs, ...composeArgs], {
      cwd: scenarioPath,
      env: childEnv,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });

    if (capture) {
      const forward = (data: Buffer, stream: NodeJS.WriteStream) => {
        stream.write(data);
        options.onOutput?.(data.toString());
      };
      child.stdout?.on("data", (d: Buffer) => forward(d, process.stdout));
      child.stderr?.on("data", (d: Buffer) => forward(d, process.stderr));
    }

    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", (err) => {
      console.error(`Failed to run ${cmd.command}: ${err.message}`);
      resolve(1);
    });
  });
}
