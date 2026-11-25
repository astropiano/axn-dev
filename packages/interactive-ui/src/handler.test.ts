import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { createInteractiveHandler } from "./handler.js";
import { pageHead } from "./head.js";
import { interactiveHtml } from "./views.js";
import type { InteractiveCommand, InteractiveSession } from "./session.js";

function fakeSession(accept: boolean): InteractiveSession & { got: InteractiveCommand[] } {
  const got: InteractiveCommand[] = [];
  return {
    runId: "r1",
    got,
    snapshot: () => ({ runId: "r1", flowName: "f", steps: [], gate: null, output: [] }),
    events: () => () => {},
    command(c) {
      got.push(c);
      return accept;
    },
  };
}

async function serve(session: InteractiveSession): Promise<{ origin: string; server: Server }> {
  const handle = createInteractiveHandler(session);
  const server = createServer((req, res) => {
    if (!handle(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { origin: `http://127.0.0.1:${port}`, server };
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("createInteractiveHandler", () => {
  it("answers 400 to an unknown command, 409 when the run is not waiting, 200 otherwise", async () => {
    const waiting = fakeSession(true);
    const idle = fakeSession(false);
    const a = await serve(waiting);
    const b = await serve(idle);
    try {
      expect((await post(`${a.origin}/api/interactive/r1/command`, { command: "jump" })).status).toBe(400);
      expect((await post(`${a.origin}/api/interactive/r1/command`, { command: "next" })).status).toBe(200);
      expect(waiting.got).toEqual(["next"]);
      expect((await post(`${b.origin}/api/interactive/r1/command`, { command: "next" })).status).toBe(409);
    } finally {
      a.server.close();
      b.server.close();
    }
  });

  it("leaves other runs' paths to the host", async () => {
    const { origin, server } = await serve(fakeSession(true));
    try {
      expect((await fetch(`${origin}/interactive/other`)).status).toBe(404);
      expect((await fetch(`${origin}/interactive/r1/driver`)).status).toBe(200);
    } finally {
      server.close();
    }
  });
});

describe("interactive pages", () => {
  it("render the shared page head and no colour of their own", () => {
    for (const view of ["stage", "driver"] as const) {
      const html = interactiveHtml("r1", view);
      expect(html).toContain(pageHead(view === "stage" ? "axn-dev · interactive stage" : "axn-dev · interactive"));
      const own = html.slice(html.indexOf("</script>", html.indexOf("data-theme")));
      expect(own).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    }
  });
});
