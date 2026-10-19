import type { Command } from "@axn-dev/core";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { ScenarioDiscoveryService } from "@axn-dev/core";
import { ServeHandlers } from "./serve-lib/handlers.js";
import { FlowRunManager } from "./serve-lib/flows.js";
import { ScenarioRunManager } from "./serve-lib/scenarioRuns.js";
import type { ServeContext } from "./serve-lib/types.js";
import { resolveProxies, flagCompleter } from "@axn-dev/core";

export class ServeCommand implements Command {
  readonly name = "serve";
  readonly description = "Start the axn-dev proxy server (dashboard + Caddy management)";

  complete = flagCompleter(["--stop", "--workbase", "--help", "-h"]);

  private registry = new Map<string, import("./serve-lib/types.js").ScenarioInstance>();
  private server?: ReturnType<typeof createServer>;
  private readonly port = 7079;
  private discovery!: ScenarioDiscoveryService;
  private handlers!: ServeHandlers;

  help(): string {
    return `
axn-dev serve

Start the axn-dev proxy server. This is a persistent HTTP server that:
- Maintains a registry of running scenario instances
- Serves a live dashboard at http://localhost:7079
- Exposes a management API for CLI commands to register/deregister scenarios
- Lists flows, lets you start them, and shows flow reports
- Manages Caddy and /etc/hosts entries (future phases)

The server runs until stopped with Ctrl+C, via this CLI's --stop flag, or via POST /stop.

Options:
  -h, --help           Show this help message
  --stop               Stop the running axn-dev serve server
  --workbase <branch>  Use the checkout or worktree on <branch> for all configured repos (including integration)

Pages (localhost:7079):
  GET    /               Scenario dashboard
  GET    /flows          Flow list
  GET    /flow           Flow detail (query: file, name)
  GET    /flow/manual    Manual flow execution (query: file, name)
  GET    /flow-report    Report detail (query: file, flow)
  GET    /flow-evidence  Stream a captured evidence artifact (query: path)
  GET    /scenario/<n>   Scenario iframe view

API (localhost:7079):
  POST   /register      Register a scenario instance
  DELETE /register/:id  Deregister a scenario instance
  GET    /status        Return current registry and server state
  GET    /scenarios     List scenarios (JSON)
  POST   /scenarios/start  Start a scenario (body: scenarioName, source, repoName, port?)
                           Runs the same preflight as 'axn-dev start' in the
                           background; returns 202 + runId immediately
  POST   /scenarios/stop   Stop a scenario
  POST   /flows/start   Start a flow run
  POST   /flow/manual/submit  Submit manual flow verdicts and write a report
  POST   /flow/manual/evidence  Upload an evidence file for a manual run
  POST   /flow-report/open    Open a flow report file with the OS default app
  GET    /api/flow-runs List tracked flow runs (JSON)
  GET    /api/scenario-runs  List tracked scenario starts (JSON, for polling)
  GET    /health        Health check
  POST   /stop          Graceful shutdown
`;
  }

  async execute(args: string[]): Promise<void> {
    let workbase: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--workbase") {
        workbase = args[++i];
      }
    }

    if (args.includes("--help") || args.includes("-h")) {
      console.log(this.help());
      return;
    }

    if (args.includes("--stop")) {
      await this.stopServer();
      return;
    }

    this.discovery = new ScenarioDiscoveryService(process.cwd(), workbase);

    const ctx: ServeContext = {
      registry: this.registry,
      flowRuns: new FlowRunManager(),
      scenarioRuns: new ScenarioRunManager(),
      discovery: this.discovery,
      port: this.port,
      shutdown: () => this.shutdown(),
      resolveProxies,
      escapeHtml: (text) => text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;"),
    };
    this.handlers = new ServeHandlers(ctx);

    console.log(`Starting axn-dev proxy server on http://localhost:${this.port}...`);

    this.server = createServer((req, res) => this.handleRequest(req, res));

    this.server.listen(this.port, "127.0.0.1", () => {
      console.log(`\x1b[32m✓ axn-dev proxy server running\x1b[0m`);
      console.log(`  Dashboard: http://localhost:${this.port}`);
      console.log(`  API:       http://localhost:${this.port}/status`);
      console.log(`\nPress Ctrl+C to stop.\n`);
    });

    this.server.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        console.error(`\x1b[31mPort ${this.port} is already in use.\x1b[0m`);
        console.error("Is axn-dev serve already running?");
        process.exit(1);
      } else {
        console.error(`Server error: ${err.message}`);
        process.exit(1);
      }
    });

    // Handle graceful shutdown
    process.on("SIGINT", () => this.shutdown());
    process.on("SIGTERM", () => this.shutdown());
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://localhost:${this.port}`);
    const method = req.method || "GET";

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (method === "POST" && url.pathname === "/register") {
        await this.handlers.register(req, res);
      } else if (method === "DELETE" && url.pathname.startsWith("/register/")) {
        this.handlers.deregister(url, res);
      } else if (method === "GET" && url.pathname === "/status") {
        this.handlers.status(res);
      } else if (method === "POST" && url.pathname === "/stop") {
        this.handlers.stop(res);
      } else if (method === "GET" && url.pathname === "/health") {
        await this.handlers.healthCheck(url, res);
      } else if (method === "GET" && url.pathname === "/scenarios") {
        await this.handlers.listScenarios(res);
      } else if (method === "POST" && url.pathname === "/scenarios/start") {
        await this.handlers.startScenario(req, res);
      } else if (method === "POST" && url.pathname === "/scenarios/stop") {
        await this.handlers.stopScenario(req, res);
      } else if (method === "GET" && url.pathname === "/api/scenario-runs") {
        this.handlers.scenarioRuns(res);
      } else if (method === "GET" && url.pathname === "/") {
        await this.handlers.dashboard(res);
      } else if (method === "GET" && url.pathname === "/flows") {
        await this.handlers.flows(res);
      } else if (method === "POST" && url.pathname === "/flows/start") {
        await this.handlers.startFlow(req, res);
      } else if (method === "GET" && url.pathname === "/api/flow-runs") {
        this.handlers.flowRuns(res);
      } else if (method === "GET" && url.pathname === "/flow") {
        await this.handlers.flowView(url, res);
      } else if (method === "GET" && url.pathname === "/flow/manual") {
        await this.handlers.manualFlowView(url, res);
      } else if (method === "POST" && url.pathname === "/flow/manual/submit") {
        await this.handlers.manualFlowSubmit(req, res);
      } else if (method === "POST" && url.pathname === "/flow/manual/evidence") {
        await this.handlers.manualEvidenceUpload(req, res);
      } else if (method === "POST" && url.pathname === "/flow-report/open") {
        await this.handlers.openReportFile(req, res);
      } else if (method === "GET" && url.pathname === "/flow-report") {
        await this.handlers.flowReportView(url, res);
      } else if (method === "GET" && url.pathname === "/flow-evidence") {
        await this.handlers.flowEvidence(url, res);
      } else if (method === "GET" && url.pathname.startsWith("/scenario/")) {
        await this.handlers.scenarioView(url, res);
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      }
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Internal error" }));
    }
  }


  private async stopServer(): Promise<void> {
    const url = `http://127.0.0.1:${this.port}/stop`;
    try {
      const res = await fetch(url, { method: "POST" });
      if (!res.ok) {
        const body = await res.text();
        console.error(`Failed to stop server: ${res.status} ${body}`);
        process.exit(1);
      }
      console.log("axn-dev serve stopped.");
    } catch (err) {
      console.error(`Failed to stop server: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  private shutdown(): void {
    console.log("\nShutting down axn-dev proxy server...");
    this.server?.close(() => {
      console.log("Server stopped.");
    });
    // Force exit after a short delay if close callback doesn't fire
    setTimeout(() => process.exit(0), 100);
  }
}
