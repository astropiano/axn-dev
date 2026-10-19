import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const TMP = join(tmpdir(), "axn-orch-host-test-" + process.pid);
const LOG_FILE = join(TMP, "calls.log");

const require = createRequire(import.meta.url);
const tsxPackagePath = require.resolve("tsx/package.json");
const tsxBin = resolve(dirname(tsxPackagePath), JSON.parse(readFileSync(tsxPackagePath, "utf-8")).bin);
const hostPath = fileURLToPath(new URL("./orchestrator-host.ts", import.meta.url));

interface HostResult {
  id: number;
  ok?: boolean;
  error?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  videos?: { name: string; path?: string }[];
}

/** Spawns orchestrator-host.ts and speaks the __AXN__ JSON-lines protocol. */
class HostClient {
  private child: ChildProcess | undefined;
  private nextId = 1;
  private pending = new Map<number, (v: HostResult) => void>();

  static async start(orchestratorPath: string): Promise<HostClient> {
    const client = new HostClient();
    client.child = spawn(process.execPath, [tsxBin, hostPath], {
      env: {
        ...(process.env as Record<string, string>),
        AXN_FLOW_ORCHESTRATOR: orchestratorPath,
        LOG_FILE,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const rl = createInterface({ input: client.child.stdout! });
    rl.on("line", (line) => {
      if (!line.startsWith("__AXN__")) return;
      let msg: HostResult | undefined;
      try {
        msg = JSON.parse(line.slice("__AXN__".length));
      } catch {
        return;
      }
      if (!msg || typeof msg.id !== "number") return;
      const resolve = client.pending.get(msg.id);
      if (resolve) {
        client.pending.delete(msg.id);
        resolve(msg);
      }
    });
    client.child.stderr?.on("data", () => {});
    const start = await client.send("start", {});
    if (start.error) throw new Error(start.error);
    return client;
  }

  send(method: string, args: Record<string, unknown>): Promise<HostResult> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child!.stdin!.write(JSON.stringify({ id, method, ...args }) + "\n");
    });
  }

  run(steps: unknown[]): Promise<HostResult> {
    return this.send("run", { steps });
  }

  async close(): Promise<void> {
    try {
      await this.send("stop", {});
    } catch {
      /* best effort */
    }
    this.child?.kill();
  }
}

function callLog(): string[] {
  return existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf-8").trim().split("\n") : [];
}

// Fixture orchestrator: logs every call to LOG_FILE; a step named "FAIL"
// makes run() throw; videoStart/videoStop are implemented.
const videoOrchestrator = `
import { appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const log = (s: string) => appendFileSync(process.env.LOG_FILE!, s + "\\n");
let dir = "/tmp";
export default {
  async start() { log("start"); },
  async run(steps: unknown[]) {
    log("run:" + steps.join(","));
    if (steps.some((s) => String(s).includes("FAIL"))) throw new Error("step failed");
    return { exitCode: 0, stdout: "ok:" + steps.length, stderr: "" };
  },
  async videoStart(name: string, d?: string) {
    if (d) { dir = d; mkdirSync(d, { recursive: true }); }
    log("videoStart:" + name + ":" + (d ?? ""));
  },
  async videoStop(name: string) {
    log("videoStop:" + name);
    const p = join(dir, name + ".webm");
    writeFileSync(p, "video");
    return p;
  },
  async stop() { log("stop"); },
};
`;

// Fixture orchestrator without video hooks.
const plainOrchestrator = `
export default {
  async start() {},
  async run(steps: unknown[]) {
    return { exitCode: 0, stdout: "ok:" + steps.length, stderr: "" };
  },
  async stop() {},
};
`;

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
  writeFileSync(join(TMP, "video-orch.ts"), videoOrchestrator);
  writeFileSync(join(TMP, "plain-orch.ts"), plainOrchestrator);
});
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("orchestrator-host protocol", () => {
  it("passes a plain batch through to the orchestrator", async () => {
    const client = await HostClient.start(join(TMP, "plain-orch.ts"));
    try {
      const result = await client.run(["a.ts", "b.ts"]);
      expect(result.error).toBeUndefined();
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("ok:2");
    } finally {
      await client.close();
    }
  }, 15000);

  it("splits the batch at video markers and calls video hooks", async () => {
    writeFileSync(LOG_FILE, "");
    const client = await HostClient.start(join(TMP, "video-orch.ts"));
    try {
      const evidenceDir = join(TMP, "evidence");
      const result = await client.run([
        "a.ts",
        { __axnVideo: "start", name: "seg", dir: evidenceDir },
        "b.ts",
        "c.ts",
        { __axnVideo: "stop", name: "seg" },
        "d.ts",
      ]);

      expect(result.error).toBeUndefined();
      expect(result.videos).toEqual([
        { name: "seg", path: join(evidenceDir, "seg.webm") },
      ]);
      expect(existsSync(join(evidenceDir, "seg.webm"))).toBe(true);

      const log = callLog();
      const runIdx = log.indexOf("run:b.ts,c.ts");
      const startIdx = log.findIndex((l) => l.startsWith("videoStart:seg:"));
      const stopIdx = log.indexOf("videoStop:seg");
      const beforeIdx = log.indexOf("run:a.ts");
      const afterIdx = log.indexOf("run:d.ts");

      expect(startIdx).toBeGreaterThan(-1);
      // Ordering: pre-steps → videoStart → inner steps → videoStop → post-steps
      expect(beforeIdx).toBeLessThan(startIdx);
      expect(startIdx).toBeLessThan(runIdx);
      expect(runIdx).toBeLessThan(stopIdx);
      expect(stopIdx).toBeLessThan(afterIdx);
    } finally {
      await client.close();
    }
  }, 15000);

  it("finalizes an open recording when a step inside the video fails", async () => {
    writeFileSync(LOG_FILE, "");
    const client = await HostClient.start(join(TMP, "video-orch.ts"));
    try {
      const result = await client.run([
        { __axnVideo: "start", name: "seg", dir: TMP },
        "FAIL.ts",
        { __axnVideo: "stop", name: "seg" },
      ]);

      expect(result.error).toContain("step failed");
      const log = callLog();
      expect(log).toContain("videoStop:seg");
    } finally {
      await client.close();
    }
  }, 15000);

  it("returns a clear error when the orchestrator lacks video hooks", async () => {
    const client = await HostClient.start(join(TMP, "plain-orch.ts"));
    try {
      const result = await client.run([
        { __axnVideo: "start", name: "seg" },
        "b.ts",
        { __axnVideo: "stop", name: "seg" },
      ]);
      expect(result.error).toContain("does not support <video>");
    } finally {
      await client.close();
    }
  }, 15000);
});
