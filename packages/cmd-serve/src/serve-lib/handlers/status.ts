import { createConnection } from "node:net";
import type { ServerResponse } from "node:http";
import type { ServeContext } from "../types.js";

export function handleStatus(ctx: ServeContext, res: ServerResponse): void {
  const instances = Array.from(ctx.registry.values()).map((inst) => ({
    ...inst,
    registeredAt: inst.registeredAt.toISOString(),
  }));

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    running: true,
    port: ctx.port,
    instances,
    count: instances.length,
  }));
}

export function handleStop(ctx: ServeContext, res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ success: true }));
  ctx.shutdown();
}

export async function handleHealthCheck(ctx: ServeContext, url: URL, res: ServerResponse): Promise<void> {
  const portsParam = url.searchParams.get("ports") || "";
  const ports = portsParam.split(",").map(Number).filter((p) => p > 0 && p < 65536);

  const checkPort = (port: number): Promise<"up" | "down"> =>
    new Promise((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(1500);
      socket.on("connect", () => { socket.destroy(); resolve("up"); });
      socket.on("error", () => resolve("down"));
      socket.on("timeout", () => { socket.destroy(); resolve("down"); });
    });

  const results = await Promise.all(ports.map(async (port) => [port, await checkPort(port)] as const));
  const status: Record<number, string> = {};
  for (const [port, state] of results) status[port] = state;

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(status));
}
