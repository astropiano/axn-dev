import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { parseBody } from "./utils.js";
import { discoverAllFlowsAsync, flowRoots, flowRootsAsync, isEvidencePathAllowed, isFlowFileAllowed, flowDirNames } from "../flows.js";
import { evidenceDirFor, loadFlowsFromFileSafe } from "@axn-dev/flow-format";
import { ManualFlowRunner, type ManualFlowInput } from "@axn-dev/flow-format";
import type { ServeContext } from "../types.js";
import { manualFlowViewHtml } from "../manualFlowViews.js";
import { menuCountsAsync } from "./views.js";

/** GET /flow/manual — render the manual execution form for a single flow. */
export async function handleManualFlowView(ctx: ServeContext, url: URL, res: ServerResponse): Promise<void> {
  const file = url.searchParams.get("file") ?? "";
  const name = url.searchParams.get("name") ?? "";
  const config = ctx.discovery.getConfig();
  const [roots, flows] = await Promise.all([
    flowRootsAsync(config),
    discoverAllFlowsAsync(config),
  ]);

  if (!isFlowFileAllowed(file, roots, flowDirNames(ctx.discovery.getConfig()))) {
    res.writeHead(403, { "Content-Type": "text/html" });
    res.end("<h1>Forbidden</h1>");
    return;
  }

  const flow = flows.find((f) => f.file === file && f.name === name);
  const parsed = flow ? loadFlowsFromFileSafe(file).find((f) => f.name === name) : undefined;
  if (!flow || !parsed) {
    res.writeHead(404, { "Content-Type": "text/html" });
    res.end("<h1>Flow not found</h1>");
    return;
  }

  const html = manualFlowViewHtml(flow, parsed, await menuCountsAsync(ctx));
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
}

const evidenceUploadLimit = 50 * 1024 * 1024;

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > evidenceUploadLimit) {
        reject(new Error("File too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * POST /flow/manual/evidence?file=<flow.xml>&flow=<name>&filename=<orig>[&dir=<evidenceDir>]
 * Stores one uploaded evidence file under the flow's evidence dir and returns
 * its path. Pass the returned `dir` on subsequent uploads of the same run so
 * all files land in one directory.
 */
export async function handleManualEvidenceUpload(
  ctx: ServeContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url ?? "", "http://localhost");
  const file = url.searchParams.get("file") ?? "";
  const flowName = url.searchParams.get("flow") ?? "";
  const filename = url.searchParams.get("filename") ?? "evidence.bin";
  const dirParam = url.searchParams.get("dir") ?? "";

  const roots = flowRoots(ctx.discovery.getConfig());
  if (!file || !isFlowFileAllowed(file, roots, flowDirNames(ctx.discovery.getConfig()))) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unknown flow file" }));
    return;
  }

  let dir: string;
  if (dirParam) {
    if (!isEvidencePathAllowed(join(dirParam, "x"), roots, flowDirNames(ctx.discovery.getConfig()))) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Evidence dir is not allowed" }));
      return;
    }
    dir = dirParam;
    mkdirSync(dir, { recursive: true });
  } else {
    dir = evidenceDirFor(file, flowName || "manual");
  }

  let data: Buffer;
  try {
    data = await readRawBody(req);
  } catch (err) {
    res.writeHead(413, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Upload failed" }));
    return;
  }

  const safeName = basename(filename).replace(/[^\w.\- ]/g, "_") || "evidence.bin";
  let target = join(dir, safeName);
  let n = 2;
  while (existsSync(target)) {
    const ext = extname(safeName);
    target = join(dir, `${basename(safeName, ext)}-${n++}${ext}`);
  }
  writeFileSync(target, data);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ success: true, path: target, dir }));
}

/** POST /flow/manual/submit — collect verdicts and write a flow report. */
export async function handleManualFlowSubmit(ctx: ServeContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await parseBody(req);
  const file = typeof body.file === "string" ? body.file : "";
  const name = typeof body.name === "string" ? body.name : "";
  const steps = Array.isArray(body.steps) ? body.steps : [];

  const config = ctx.discovery.getConfig();
  const roots = await flowRootsAsync(config);

  if (!isFlowFileAllowed(file, roots, flowDirNames(ctx.discovery.getConfig()))) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unknown flow file" }));
    return;
  }

  const parsed = loadFlowsFromFileSafe(file).find((f) => f.name === name);
  if (!parsed) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Flow not found" }));
    return;
  }

  const runner = new ManualFlowRunner(parsed, file);
  const input: ManualFlowInput = { steps };
  const result = runner.execute(input);
  const reportPath = runner.writeReport(result);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ success: true, result, reportPath }));
}
