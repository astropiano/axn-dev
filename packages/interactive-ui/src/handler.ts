import type { IncomingMessage, ServerResponse } from "node:http";
import type { InteractiveCommand, InteractiveSession } from "./session.js";
import type { ServeThemeSet } from "./theme.js";
import { interactiveHtml } from "./views.js";

/** Themes for each page request; hosts rescan per request, like serve. */
export type InteractiveThemes = () => ServeThemeSet;

const COMMANDS: ReadonlySet<string> = new Set<InteractiveCommand>(["next", "skip", "retry", "abort"]);

/** Bounds a command body; a gate command is a few bytes. */
const MAX_BODY = 4096;

/**
 * Serves one run's pages and API, for whichever host mounts it:
 *
 *   GET  /interactive/<runId>             the stage (product framed)
 *   GET  /interactive/<runId>/driver      the driver: steps, commands, output
 *   GET  /api/interactive/<runId>         snapshot (JSON)
 *   GET  /api/interactive/<runId>/events  event stream (SSE), opening with a snapshot
 *   POST /api/interactive/<runId>/command { "command": "next" | "skip" | "retry" | "abort" }
 *
 * Returns false for any other path, or another run's, so the host answers it.
 */
export function createInteractiveHandler(
  session: InteractiveSession,
  themes: InteractiveThemes,
): (req: IncomingMessage, res: ServerResponse) => boolean {
  const id = encodeURIComponent(session.runId);
  const page = `/interactive/${id}`;
  const api = `/api/interactive/${id}`;

  return (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "");
    const method = req.method ?? "GET";

    if (method === "GET" && path === page) return html(res, interactiveHtml(session.runId, "stage", themes()));
    if (method === "GET" && path === `${page}/driver`) return html(res, interactiveHtml(session.runId, "driver", themes()));
    if (method === "GET" && path === api) return json(res, 200, session.snapshot());
    if (method === "GET" && path === `${api}/events`) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`event: snapshot\ndata: ${JSON.stringify(session.snapshot())}\n\n`);
      if (session.snapshot().finished) {
        res.end();
        return true;
      }
      // The stream ends with the run, after its last event has gone out, so
      // a page never has to tell a finished run from a dropped connection.
      const off = session.events((event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (event.type === "finished") {
          off();
          res.end();
        }
      });
      req.on("close", off);
      return true;
    }
    if (method === "POST" && path === `${api}/command`) {
      readBody(req)
        .then((body) => {
          const command = (JSON.parse(body || "{}") as { command?: unknown }).command;
          if (typeof command !== "string" || !COMMANDS.has(command)) {
            return json(res, 400, { error: `command must be one of ${[...COMMANDS].join(", ")}` });
          }
          if (!session.command(command as InteractiveCommand)) {
            return json(res, 409, { error: `run is not waiting for '${command}'` });
          }
          return json(res, 200, { ok: true });
        })
        .catch((err: Error) => json(res, 400, { error: err.message }));
      return true;
    }
    return false;
  };
}

function html(res: ServerResponse, body: string): true {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
  return true;
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
  return true;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > MAX_BODY) {
        reject(new Error("command body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
