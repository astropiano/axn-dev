import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerFlowAdapter } from "@axn-dev/core";
import { FlowCommand } from "./flow.js";
import { keyToCommand, terminalGate, type GateCommand, type GateInfo, type StepGate } from "./interactive.js";

const TMP = join(tmpdir(), "axn-flow-interactive-test-" + process.pid);
/** Ordered log of gate waits and adapter runs. */
let log: string[] = [];
/** Per-action queue of results: a string is returned, an Error is thrown. */
let behaviour: Record<string, (string | Error)[]> = {};

function scripted(...commands: GateCommand[]): { gate: StepGate; seen: GateInfo[] } {
  const seen: GateInfo[] = [];
  return {
    seen,
    gate: {
      async wait(info) {
        seen.push(info);
        const cmd = commands.shift();
        if (!cmd) throw new Error(`scripted gate ran out of commands at step ${info.index + 1}`);
        log.push(`gate:${info.index + 1}:${cmd}`);
        return cmd;
      },
    },
  };
}

function writeFlow(name: string, inner: string, flowAttrs = `adapter="gate-rec"`): string {
  const file = join(TMP, name);
  writeFileSync(
    file,
    `<?xml version="1.0"?><flows><flow name="${name.replace(/\.xml$/, "")}" ${flowAttrs}><steps>${inner}</steps></flow></flows>`,
  );
  return file;
}

function latestFlow(): any {
  const dir = join(TMP, ".reports");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  return JSON.parse(readFileSync(join(dir, files[files.length - 1]), "utf-8")).flows[0];
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
  registerFlowAdapter({
    name: "gate-rec",
    tags: [],
    load: () => ({
      run: (step) => {
        const action = step.args?.do ?? "?";
        log.push(`run:${action}`);
        const next = behaviour[action]?.shift();
        if (next instanceof Error) throw next;
        return next ?? `did ${action}`;
      },
    }),
  });
});
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
beforeEach(() => {
  log = [];
  behaviour = {};
  rmSync(join(TMP, ".reports"), { recursive: true, force: true });
});

describe("keyToCommand", () => {
  it("maps run keys to next, or to retry after a failure", () => {
    for (const name of ["return", "enter", "space", "right", "pagedown"]) {
      expect(keyToCommand({ name }, false)).toBe("next");
      expect(keyToCommand({ name }, true)).toBe("retry");
    }
    expect(keyToCommand({ name: "r" }, true)).toBe("retry");
    expect(keyToCommand({ name: "r" }, false)).toBeNull();
  });

  it("maps s to skip and q / Ctrl-C to abort, ignores other keys", () => {
    expect(keyToCommand({ name: "s" }, false)).toBe("skip");
    expect(keyToCommand({ name: "q" }, true)).toBe("abort");
    expect(keyToCommand({ name: "c", ctrl: true }, false)).toBe("abort");
    expect(keyToCommand({ name: "c" }, false)).toBeNull();
    expect(keyToCommand({ name: "x" }, false)).toBeNull();
  });
});

describe("terminalGate", () => {
  it("refuses to start without a TTY", () => {
    expect(() => terminalGate({ isTTY: false } as NodeJS.ReadStream)).toThrow(/not a TTY/);
  });
});

describe("axn-dev flow --interactive (adapter flows)", () => {
  it("runs each step only after its gate releases it, once", async () => {
    const { gate, seen } = scripted("next", "next");
    const file = writeFlow("order.xml", `<step do="one"/><step do="two" who="x"/>`);
    await new FlowCommand(() => gate).execute(["-f", file, "--interactive"]);
    expect(log).toEqual(["gate:1:next", "run:one", "gate:2:next", "run:two"]);
    expect(seen[1]).toMatchObject({ index: 1, total: 2, step: { args: { do: "two", who: "x" } } });
    const flow = latestFlow();
    expect(flow.passed).toBe(true);
    expect(flow.interactive).toEqual([
      { index: 0, label: "<script>", outcome: "ran", failedAttempts: [] },
      { index: 1, label: "<script>", outcome: "ran", failedAttempts: [] },
    ]);
  });

  it("skip does not run the step and records it as skipped", async () => {
    const { gate } = scripted("skip", "next");
    const file = writeFlow("skip.xml", `<step do="one"/><step do="two"/>`);
    await new FlowCommand(() => gate).execute(["-f", file, "--interactive"]);
    expect(log).toEqual(["gate:1:skip", "gate:2:next", "run:two"]);
    expect(latestFlow().interactive[0].outcome).toBe("skipped");
  });

  it("a throwing step stops at the gate; retry runs it again and the flow passes", async () => {
    behaviour = { one: [new Error("boom")] };
    const { gate, seen } = scripted("next", "retry", "next");
    const file = writeFlow("retry.xml", `<step do="one"/><step do="two"/>`);
    await new FlowCommand(() => gate).execute(["-f", file, "--interactive"]);
    expect(log).toEqual(["gate:1:next", "run:one", "gate:1:retry", "run:one", "gate:2:next", "run:two"]);
    expect(seen[1].failed).toBe("boom");
    const flow = latestFlow();
    expect(flow.passed).toBe(true);
    expect(flow.interactive[0]).toMatchObject({ outcome: "ran", failedAttempts: ["boom"] });
  });

  it("a failed assertion is rolled back on retry, so the retry is judged alone", async () => {
    behaviour = { one: ["bad output", "good output"] };
    const { gate } = scripted("next", "retry");
    const file = writeFlow(
      "assert-retry.xml",
      `<step do="one"><assert that="contains" value="good"/></step>`,
    );
    await new FlowCommand(() => gate).execute(["-f", file, "--interactive"]);
    const flow = latestFlow();
    expect(flow.passed).toBe(true);
    expect(flow.assertions.every((a: any) => a.passed)).toBe(true);
    expect(flow.response).not.toContain("bad output");
    expect(flow.interactive[0].failedAttempts).toHaveLength(1);
  });

  it("abort ends the run and names the step", async () => {
    const { gate } = scripted("next", "abort");
    const file = writeFlow("abort.xml", `<step do="one"/><step do="two" description="second"/>`);
    await expect(new FlowCommand(() => gate).execute(["-f", file, "--interactive"])).rejects.toThrow();
    expect(log).toEqual(["gate:1:next", "run:one", "gate:2:abort"]);
    expect(latestFlow().error).toMatch(/aborted at step 2 \(second\)/);
  });

  it('interactive="auto" runs a step without a gate', async () => {
    const { gate } = scripted("next");
    const file = writeFlow("auto.xml", `<step do="setup" interactive="auto"/><step do="show"/>`);
    await new FlowCommand(() => gate).execute(["-f", file, "--interactive"]);
    expect(log).toEqual(["run:setup", "gate:2:next", "run:show"]);
  });

  it("without --interactive no gate is created and failures end the run as before", async () => {
    behaviour = { one: [new Error("boom")] };
    let created = 0;
    const file = writeFlow("auto-run.xml", `<step do="one"/><step do="two"/>`);
    await expect(
      new FlowCommand(() => { created++; return scripted().gate; }).execute(["-f", file]),
    ).rejects.toThrow();
    expect(created).toBe(0);
    expect(log).toEqual(["run:one"]);
    expect(latestFlow().interactive).toBeUndefined();
  });

  it("fails before the first step when no controller can be created", async () => {
    const file = writeFlow("no-tty.xml", `<step do="one"/>`);
    await expect(
      new FlowCommand(() => { throw new Error("--interactive needs a terminal: stdin is not a TTY"); })
        .execute(["-f", file, "--interactive"]),
    ).rejects.toThrow(/not a TTY/);
    expect(log).toEqual([]);
  });

  it("rejects flows that are not adapter flows yet", async () => {
    const { gate } = scripted("next");
    const file = writeFlow("script.xml", `<step>console.log("hi")</step>`, "");
    await expect(new FlowCommand(() => gate).execute(["-f", file, "--interactive"])).rejects.toThrow(
      /adapter flows only/,
    );
  });
});
