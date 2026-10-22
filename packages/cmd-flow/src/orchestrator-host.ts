import * as readline from "node:readline";
import { pathToFileURL } from "node:url";

const AXN_RESULT_PREFIX = "__AXN__";

interface Orchestrator {
  start(baseUrl: string, env: Record<string, string>): Promise<void>;
  run(steps: unknown[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  stop(): Promise<void>;
  /** Optional: begin recording a video segment — ideally in place (page.screencast), not by swapping contexts. */
  videoStart?(name: string, dir?: string): Promise<void>;
  /** Optional: stop recording and return the artifact path. */
  videoStop?(name: string): Promise<string | void>;
}

interface VideoMarker {
  action: "start" | "stop";
  name: string;
  dir?: string;
}

/** Step items like { __axnVideo: "start"|"stop", name, dir? } mark video segment boundaries. */
function videoMarker(step: unknown): VideoMarker | null {
  if (!step || typeof step !== "object") return null;
  const rec = step as Record<string, unknown>;
  const action = rec.__axnVideo;
  if (action !== "start" && action !== "stop") return null;
  return {
    action,
    name: typeof rec.name === "string" ? rec.name : "video",
    dir: typeof rec.dir === "string" ? rec.dir : undefined,
  };
}

function writeResult(id: number, result: Record<string, unknown>): void {
  process.stdout.write(AXN_RESULT_PREFIX + JSON.stringify({ id, ...result }) + "\n");
}

async function loadOrchestrator(orchestratorPath: string): Promise<Orchestrator> {
  const mod = await import(pathToFileURL(orchestratorPath).href);
  const OrchestratorClass = mod.default ?? mod;
  const instance: Orchestrator =
    typeof OrchestratorClass === "function" ? new OrchestratorClass() : OrchestratorClass;

  if (
    !instance ||
    typeof instance.start !== "function" ||
    typeof instance.run !== "function" ||
    typeof instance.stop !== "function"
  ) {
    throw new Error(
      `Orchestrator at ${orchestratorPath} must export an object with start, run and stop methods`
    );
  }

  return instance;
}

async function main() {
  let stopping = false;
  const shutdown = async (code: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(code), 5_000).unref();
    const instance: Orchestrator | undefined = (process as any).__axnOrchestrator;
    if (instance) {
      try {
        await instance.stop();
      } catch {
        /* best effort */
      }
    }
    process.exit(code);
  };

  const initialPpid = process.ppid;
  process.stdin.on("end", () => void shutdown(0));
  process.stdin.on("close", () => void shutdown(0));
  const watchdog = setInterval(() => {
    if (process.ppid !== initialPpid) void shutdown(0);
  }, 2_000);
  watchdog.unref();

  const rl = readline.createInterface({ input: process.stdin });

  for await (const line of rl) {
    let msg: { id: number; method: string; steps?: string[] } | undefined;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (!msg || typeof msg.id !== "number" || !msg.method) continue;

    if (msg.method === "start") {
      const orchestratorPath = process.env.AXN_FLOW_ORCHESTRATOR;
      if (!orchestratorPath) {
        writeResult(msg.id, { error: "AXN_FLOW_ORCHESTRATOR is not set" });
        continue;
      }

      const baseUrl = process.env.BASE_URL ?? "";
      const env = { ...process.env } as Record<string, string>;

      try {
        const instance = await loadOrchestrator(orchestratorPath);
        (process as any).__axnOrchestrator = instance;
        await instance.start(baseUrl, env);
        writeResult(msg.id, { ok: true });
      } catch (err) {
        writeResult(msg.id, { error: err instanceof Error ? err.message : String(err) });
      }
    } else if (msg.method === "run") {
      const instance: Orchestrator | undefined = (process as any).__axnOrchestrator;
      if (!instance) {
        writeResult(msg.id, { error: "Orchestrator has not been started" });
        continue;
      }

      try {
        const steps = msg.steps ?? [];
        if (!steps.some((s) => videoMarker(s) !== null)) {
          const result = await instance.run(steps);
          writeResult(msg.id, result);
          continue;
        }

        // Video markers split the batch into segments; between segments the
        // orchestrator's videoStart/videoStop hooks drive the recording.
        const videos: { name: string; path?: string }[] = [];
        const openVideos = new Set<string>();
        const out: { exitCode: number; stdout: string; stderr: string; videos: typeof videos } = {
          exitCode: 0,
          stdout: "",
          stderr: "",
          videos,
        };
        let segment: unknown[] = [];
        const flush = async () => {
          if (segment.length === 0) return;
          const r = await instance.run(segment);
          segment = [];
          out.stdout += (out.stdout && r.stdout ? "\n" : "") + (r.stdout ?? "");
          if (r.stderr) out.stderr = r.stderr;
          if (r.exitCode) out.exitCode = r.exitCode;
        };
        const stopVideo = async (name: string) => {
          if (typeof instance.videoStop !== "function") {
            throw new Error(
              "Orchestrator does not support <video> evidence — implement videoStart(name)/videoStop(name)"
            );
          }
          const p = await instance.videoStop(name);
          openVideos.delete(name);
          videos.push({ name, path: typeof p === "string" ? p : undefined });
        };

        try {
          for (const s of steps) {
            const marker = videoMarker(s);
            if (!marker) {
              segment.push(s);
              continue;
            }
            await flush();
            if (marker.action === "start") {
              if (typeof instance.videoStart !== "function") {
                throw new Error(
                  "Orchestrator does not support <video> evidence — implement videoStart(name)/videoStop(name)"
                );
              }
              await instance.videoStart(marker.name, marker.dir);
              openVideos.add(marker.name);
            } else {
              await stopVideo(marker.name);
            }
          }
          await flush();
        } finally {
          // Finalize any recordings still open (e.g. a step inside the video
          // failed) so the evidence captured so far is saved.
          for (const name of [...openVideos]) {
            try {
              await stopVideo(name);
            } catch {
              /* best effort */
            }
          }
        }
        writeResult(msg.id, out);
      } catch (err) {
        writeResult(msg.id, { error: err instanceof Error ? err.message : String(err) });
      }
    } else if (msg.method === "stop") {
      const instance: Orchestrator | undefined = (process as any).__axnOrchestrator;
      if (instance) {
        try {
          await instance.stop();
        } catch {
          /* best effort */
        }
      }
      writeResult(msg.id, { ok: true });
      process.exit(0);
    }
  }

  await shutdown(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
