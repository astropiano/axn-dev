import { spawn } from "node:child_process";

/** Run a git command and return trimmed stdout. Rejects on non-zero exit. */
export function gitAsync(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: env ? { ...process.env, ...env } : undefined });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => stdout += d.toString());
    child.stderr?.on("data", (d) => stderr += d.toString());
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `git exited ${code}`));
    });
  });
}
