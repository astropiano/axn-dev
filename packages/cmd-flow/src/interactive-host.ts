import { createServer, type Server } from "node:http";
import { loadAxnDevConfig } from "@axn-dev/core";
import { createInteractiveHandler, loadServeThemes, type InteractiveSession } from "@axn-dev/interactive-ui";

export interface InteractiveHost {
  stageUrl: string;
  driverUrl: string;
  close(): Promise<void>;
}

/**
 * Port for `--interactive-ui`: the flag, else AXN_DEV_INTERACTIVE_PORT, else
 * `interactive.port` from config, else 0 — a free port, the only case that
 * may pick one, because nothing asked for a specific port.
 */
export function resolveInteractivePort(
  flag: number | null,
  env: NodeJS.ProcessEnv,
  configPort: unknown,
): number {
  if (flag !== null) return flag;
  const fromEnv = env.AXN_DEV_INTERACTIVE_PORT;
  if (fromEnv !== undefined && fromEnv !== "") return parsePort(fromEnv, "AXN_DEV_INTERACTIVE_PORT");
  if (configPort !== undefined && configPort !== null) return parsePort(String(configPort), "interactive.port");
  return 0;
}

export function parsePort(value: string, source: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${source}: '${value}' is not a port (1-65535)`);
  }
  return port;
}

/** Serves the run's stage on 127.0.0.1 for as long as the flow runs. A taken
 * port fails at once, naming it; it never moves to another. */
export async function startInteractiveHost(session: InteractiveSession, port: number): Promise<InteractiveHost> {
  // Same themes and config as `axn-dev serve`, rescanned per page like there.
  const handle = createInteractiveHandler(session, () => loadServeThemes(loadAxnDevConfig()));
  const stagePath = `/interactive/${encodeURIComponent(session.runId)}`;
  const server: Server = createServer((req, res) => {
    if (handle(req, res)) return;
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    // The address to open by hand: stable across runs, lands on the driver.
    if (req.method === "GET" && (path === "/" || path === "/interactive")) {
      res.writeHead(302, { Location: `${stagePath}/driver` });
      res.end();
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) =>
      reject(
        err.code === "EADDRINUSE"
          ? new Error(`--interactive-ui: port ${port} is already in use`)
          : err,
      ));
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  const origin = `http://127.0.0.1:${actual}`;
  return {
    stageUrl: `${origin}${stagePath}`,
    driverUrl: `${origin}${stagePath}/driver`,
    close: () =>
      new Promise<void>((resolve) => {
        // Open event streams would hold close() forever.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
