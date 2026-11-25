import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerFlowAdapter } from "@axn-dev/core";
import { FlowCommand } from "./flow.js";
import { resolveInteractivePort } from "./interactive-host.js";

const TMP = join(tmpdir(), "axn-flow-interactive-ui-test-" + process.pid);
const calls: string[] = [];
let failuresLeft = 0;

function writeFlow(name: string, inner: string, env: Record<string, string> = {}): string {
  const file = join(TMP, name);
  const vars = Object.entries(env).map(([k, v]) => `<var name="${k}" value="${v}"/>`).join("");
  writeFileSync(
    file,
    `<?xml version="1.0"?><flows><flow name="${name.replace(/\.xml$/, "")}" adapter="ui-rec">` +
      `${vars ? `<env>${vars}</env>` : ""}<steps>${inner}</steps></flow></flows>`,
  );
  return file;
}

const noTerminal = () => {
  throw new Error("--interactive needs a terminal: stdin is not a TTY");
};

/** Starts a web-only interactive run and returns its stage URL. */
async function startRun(file: string, extra: string[] = []) {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.join(" "));
  });
  const run = new FlowCommand(noTerminal).execute(["-f", file, "--interactive-ui", ...extra]);
  const settled = run.then(() => "ok", (e: Error) => e.message);
  let stage: string | undefined;
  for (let i = 0; i < 200 && !stage; i++) {
    stage = logs.join("\n").match(/Interactive stage:\s+(\S+)/)?.[1];
    if (!stage) await new Promise((r) => setTimeout(r, 10));
  }
  spy.mockRestore();
  if (!stage) throw new Error("no stage URL printed");
  const api = stage.replace("/interactive/", "/api/interactive/");
  return { stage, api, settled };
}

async function snapshot(api: string) {
  return (await fetch(api)).json();
}

async function waitFor<T>(probe: () => Promise<T | undefined>, what: string): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const v = await probe();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const atGate = (api: string, index: number, failed = false) =>
  waitFor(async () => {
    const s = await snapshot(api);
    return s.gate?.index === index && !!s.gate.failed === failed ? s : undefined;
  }, `gate ${index}`);

function command(api: string, cmd: string) {
  return fetch(`${api}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: cmd }),
  });
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
  registerFlowAdapter({
    name: "ui-rec",
    tags: [],
    load: () => ({
      run: async (step, ctx) => {
        const what = step.args?.do ?? "?";
        calls.push(what === "mode" ? `mode:${ctx.env.AXN_DEV_INTERACTIVE ?? "-"}` : what);
        if (what === "flaky" && failuresLeft-- > 0) throw new Error("flaky failed");
        ctx.log(`working on ${what}`);
        return `DONE ${what}`;
      },
    }),
  });
});
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
afterEach(() => {
  calls.length = 0;
  failuresLeft = 0;
  vi.restoreAllMocks();
});

describe("--interactive-ui", () => {
  it("holds each step until Next arrives over HTTP, then stops serving with the flow", async () => {
    const file = writeFlow("web.xml", `<step do="one"/><step do="two"/>`);
    const { stage, api, settled } = await startRun(file);

    const page = await fetch(stage);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('data-cmd="next"');
    expect(html).not.toContain("side-menu");

    const first = await atGate(api, 0);
    expect(first.steps).toHaveLength(2);
    expect(first.steps[0].args).toEqual({ do: "one" });
    expect(calls).toEqual([]);

    expect((await command(api, "retry")).status).toBe(409);
    expect((await command(api, "next")).status).toBe(200);
    const second = await atGate(api, 1);
    expect(calls).toEqual(["one"]);
    expect(second.steps[0].status).toBe("passed");
    const out = second.output.filter((o: { index: number }) => o.index === 0).map((o: { line: string }) => o.line);
    expect(out).toContain("working on one");
    expect(out).toContain("DONE one");

    expect((await command(api, "next")).status).toBe(200);
    expect(await settled).toBe("ok");
    expect(calls).toEqual(["one", "two"]);
    await expect(fetch(stage)).rejects.toThrow();
  });

  it("offers retry after a failed step and reports skip", async () => {
    failuresLeft = 1;
    const file = writeFlow("retry.xml", `<step do="flaky"/><step do="later"/>`);
    const { api, settled } = await startRun(file);

    await atGate(api, 0);
    await command(api, "next");
    const failed = await atGate(api, 0, true);
    expect(failed.gate.failed).toMatch(/flaky failed/);
    expect(failed.steps[0].status).toBe("failed");
    expect((await command(api, "retry")).status).toBe(200);

    await atGate(api, 1);
    expect((await command(api, "skip")).status).toBe(200);
    expect(await settled).toBe("ok");
    expect(calls).toEqual(["flaky", "flaky"]);
  });

  it("streams events tied to the step, opening with a snapshot", async () => {
    const file = writeFlow("events.xml", `<step do="one"/>`);
    const { api, settled } = await startRun(file);
    await atGate(api, 0);

    const res = await fetch(`${api}/events`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const read = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
        if (text.includes('"type":"finished"')) break;
      }
    })();
    await command(api, "next");
    await read;
    await settled;

    expect(text.startsWith("event: snapshot\n")).toBe(true);
    const events = text
      .split("\n\n")
      .filter((b) => b.startsWith("data: "))
      .map((b) => JSON.parse(b.slice(6)));
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["step", "output", "finished"]),
    );
    const outputs = events.filter((e) => e.type === "output");
    expect(outputs.every((e) => e.index === 0)).toBe(true);
    const ended = events.findIndex((e) => e.type === "step" && e.status === "passed");
    expect(events.findIndex((e) => e.type === "output")).toBeLessThan(ended);
  });

  it("fails at once, naming the port, when the port is taken", async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
    const port = (blocker.address() as { port: number }).port;
    try {
      const file = writeFlow("taken.xml", `<step do="one"/>`);
      await expect(
        new FlowCommand(noTerminal).execute(["-f", file, "--interactive-ui", String(port)]),
      ).rejects.toThrow(`port ${port} is already in use`);
      expect(calls).toEqual([]);
    } finally {
      blocker.close();
    }
  });
});

describe("product window", () => {
  it("frames the product only when the browser is neither visible nor attached", async () => {
    const cases: [Record<string, string>, boolean][] = [
      [{}, true], // interactive: headed=auto shows a window
      [{ AXN_DEV_BROWSER_HEADED: "false" }, false],
      [{ AXN_DEV_BROWSER_HEADED: "false", AXN_DEV_BROWSER_ATTACH: "http://127.0.0.1:9222" }, true],
    ];
    for (const [env, window] of cases) {
      const file = writeFlow("window.xml", `<step do="one"/>`, env);
      const { api, settled } = await startRun(file);
      const s = await atGate(api, 0);
      expect(s.productWindow, JSON.stringify(env)).toBe(window);
      await command(api, "next");
      expect(await settled).toBe("ok");
    }
  });

  it("sends / to the driver", async () => {
    const file = writeFlow("root.xml", `<step do="one"/>`);
    const { stage, api, settled } = await startRun(file);
    await atGate(api, 0);
    const res = await fetch(new URL("/", stage), { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(new URL(stage).pathname + "/driver");
    await command(api, "next");
    await settled;
  });
});

describe("AXN_DEV_INTERACTIVE", () => {
  it("is 1 in the step env of an interactive run only, and gone afterwards", async () => {
    const file = writeFlow("mode.xml", `<step do="mode"/>`);
    await new FlowCommand(noTerminal).execute(["-f", file]);
    const { api, settled } = await startRun(file);
    await atGate(api, 0);
    await command(api, "next");
    expect(await settled).toBe("ok");
    expect(calls).toEqual(["mode:-", "mode:1"]);
    expect(process.env.AXN_DEV_INTERACTIVE).toBeUndefined();
  });
});

describe("resolveInteractivePort", () => {
  it("prefers the flag, then the environment, then config, then a free port", () => {
    const env = { AXN_DEV_INTERACTIVE_PORT: "7500" };
    expect(resolveInteractivePort(7400, env, 7600)).toBe(7400);
    expect(resolveInteractivePort(null, env, 7600)).toBe(7500);
    expect(resolveInteractivePort(null, {}, 7600)).toBe(7600);
    expect(resolveInteractivePort(null, {}, undefined)).toBe(0);
  });

  it("rejects a value that is not a port, naming its source", () => {
    expect(() => resolveInteractivePort(null, { AXN_DEV_INTERACTIVE_PORT: "x" }, undefined))
      .toThrow(/AXN_DEV_INTERACTIVE_PORT/);
    expect(() => resolveInteractivePort(null, {}, 70000)).toThrow(/interactive.port/);
  });
});
