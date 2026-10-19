import type { IncomingMessage, ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname } from "node:path";
import { parseBody } from "./utils.js";
import { isEvidencePathAllowed, isFlowFileAllowed, isReportPathAllowed, flowRoots, flowRootsAsync } from "../flows.js";
import type { ServeContext } from "../types.js";

/**
 * POST /flows/start — body: { file: string, name?: string }
 * Spawns `axn-dev flow -f <file> [-t <name>]` as a tracked background run.
 */
export async function handleStartFlow(ctx: ServeContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await parseBody(req);
  const file = typeof body.file === "string" ? body.file : "";
  const name = typeof body.name === "string" && body.name ? body.name : undefined;

  const roots = await flowRootsAsync(ctx.discovery.getConfig());
  if (!file || !isFlowFileAllowed(file, roots)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unknown flow file" }));
    return;
  }

  if (ctx.flowRuns.isRunning(file, name)) {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Flow is already running" }));
    return;
  }

  const run = ctx.flowRuns.start(file, name);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ success: true, run }));
}

/** GET /api/flow-runs — JSON list of all tracked runs (for polling). */
export function handleFlowRuns(ctx: ServeContext, res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(ctx.flowRuns.list()));
}

const evidenceMimeTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
};

/**
 * GET /flow-evidence?path=<abs> — stream an evidence artifact (screenshot or
 * video) captured during a flow run. The path must live under
 * <root>/flows/.reports/evidence/ of a known flow root.
 */
export function handleFlowEvidence(ctx: ServeContext, url: URL, res: ServerResponse): void {
  const file = url.searchParams.get("path") ?? "";
  const roots = flowRoots(ctx.discovery.getConfig());
  if (!file || !isEvidencePathAllowed(file, roots)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Evidence path is not allowed" }));
    return;
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Evidence file not found" }));
    return;
  }

  const mime = evidenceMimeTypes[extname(file).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": mime });
  createReadStream(file).pipe(res);
}

/** POST /flow-report/open — body: { file: string }. Opens the report file with the OS default app. */
export async function handleOpenReportFile(ctx: ServeContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await parseBody(req);
  const file = typeof body.file === "string" ? body.file : "";

  const roots = await flowRootsAsync(ctx.discovery.getConfig());
  if (!file || !isReportPathAllowed(file, roots)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Report path is not allowed" }));
    return;
  }

  const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
  const child = spawn(cmd, [file], { stdio: "ignore", detached: true });
  child.unref();

  child.on("error", (err) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  });

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ success: true }));
}
