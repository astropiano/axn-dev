import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerFlowAdapter } from "@axn-dev/core";
import { FlowCommand } from "./flow.js";

const TMP = join(tmpdir(), "axn-flow-adapter-dispose-test-" + process.pid);
let loads = 0;
const disposed: number[] = [];
let releaseSlow: (() => void) | undefined;
let slowStarted: (() => void) | undefined;

function writeFlow(name: string, inner: string): string {
  const file = join(TMP, name);
  writeFileSync(
    file,
    `<?xml version="1.0"?><flows><flow name="${name.replace(/\.xml$/, "")}" adapter="dispose-rec"><steps>${inner}</steps></flow></flows>`,
  );
  return file;
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
  registerFlowAdapter({
    name: "dispose-rec",
    tags: [],
    load: () => {
      const instance = ++loads;
      return {
        run: async (step) => {
          if (step.args?.do === "fail") throw new Error("boom");
          if (step.args?.do === "slow") {
            slowStarted?.();
            await new Promise<void>((r) => (releaseSlow = r));
          }
          return "ok";
        },
        dispose: () => {
          disposed.push(instance);
        },
      };
    },
  });
});
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
afterEach(() => {
  loads = 0;
  disposed.length = 0;
  vi.restoreAllMocks();
});

describe("adapter start", () => {
  it("runs once per flow, before the first step, and pairs with dispose", async () => {
    const events: string[] = [];
    registerFlowAdapter({
      name: "lifecycle-rec",
      tags: [],
      load: () => ({
        start: (ctx) => {
          events.push(`start:${ctx.baseUrl ?? "-"}`);
        },
        run: (step) => {
          events.push(`run:${step.args?.do}`);
          return "ok";
        },
        dispose: () => {
          events.push("dispose");
        },
      }),
    });
    const file = join(TMP, "lifecycle.xml");
    writeFileSync(
      file,
      `<?xml version="1.0"?><flows><flow name="lifecycle" adapter="lifecycle-rec"><steps>` +
        `<step do="a"/><repeat num="2"><step do="b"/></repeat></steps></flow></flows>`,
    );
    await new FlowCommand().execute(["-f", file]);
    expect(events).toEqual(["start:-", "run:a", "run:b", "run:b", "dispose"]);
  });
});

describe("adapter teardown", () => {
  it("disposes the adapter exactly once when a step fails", async () => {
    const file = writeFlow("fails.xml", `<step do="ok"/><step do="fail"/><step do="ok"/>`);
    await expect(new FlowCommand().execute(["-f", file])).rejects.toThrow();
    expect(disposed).toEqual([1]);
  });

  it("gives the next flow a fresh adapter instance", async () => {
    const file = writeFlow("ok.xml", `<step do="ok"/>`);
    await new FlowCommand().execute(["-f", file]);
    await new FlowCommand().execute(["-f", file]);
    expect(loads).toBe(2);
    expect(disposed).toEqual([1, 2]);
  });

  it("tears down and exits 130 on SIGINT during a slow step", async () => {
    const exited = new Promise<number | undefined>((resolve) => {
      vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        resolve(code);
      }) as never);
    });
    const started = new Promise<void>((r) => (slowStarted = r));
    const file = writeFlow("slow.xml", `<step do="slow"/>`);
    const run = new FlowCommand().execute(["-f", file]).catch(() => undefined);

    await started;
    process.emit("SIGINT", "SIGINT");
    expect(await exited).toBe(130);
    expect(disposed).toEqual([1]);

    releaseSlow?.();
    await run;
    // the per-flow finally found nothing left to dispose
    expect(disposed).toEqual([1]);
  });
});
