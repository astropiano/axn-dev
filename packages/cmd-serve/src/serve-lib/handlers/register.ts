import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { parseBody } from "./utils.js";
import type { ServeContext } from "../types.js";

export async function handleRegister(ctx: ServeContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await parseBody(req);
  const { id, scenarioName, description, proxies, links, source, scenarioPath, frontend } = body;

  if (!scenarioName || !proxies || typeof proxies !== "object") {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing required fields: scenarioName, proxies" }));
    return;
  }

  const instanceId = id || randomUUID();
  const instance = {
    id: instanceId,
    scenarioName,
    description,
    proxies,
    frontend,
    links,
    registeredAt: new Date(),
    source: source || "global",
    scenarioPath: scenarioPath || "",
  };
  ctx.registry.set(instanceId, instance);
  console.log(`Registered scenario: ${scenarioName} (${instanceId})`);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ id: instanceId }));
}

export function handleDeregister(ctx: ServeContext, url: URL, res: ServerResponse): void {
  const id = url.pathname.split("/")[2];

  if (!id) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing instance ID" }));
    return;
  }

  const instance = ctx.registry.get(id);
  if (!instance) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Instance not found" }));
    return;
  }

  ctx.registry.delete(id);
  console.log(`Deregistered scenario: ${instance.scenarioName} (${id})`);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ success: true }));
}
