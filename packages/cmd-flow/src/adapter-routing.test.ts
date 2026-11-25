import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdirSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerFlowAdapter } from "@axn-dev/core";
import { FlowCommand } from "./flow.js";

const TMP = join(tmpdir(), "axn-flow-adapter-routing-test-" + process.pid);
const calls: string[] = [];

function writeFlow(name: string, flowAttrs: string, inner: string): string {
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
    name: "routing-rec",
    tags: [],
    load: () => ({
      run: (step) => {
        calls.push(step.args?.do ?? step.args?.action ?? "?");
        return "ok";
      },
    }),
  });
});
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("adapter flows against a deployment", () => {
  it("runs a scenario-less base-url flow of plugin-adapter steps on the adapter path, with BASE_URL", async () => {
    // A <video> only the adapter path can record: the browser path would
    // reject it for lack of an orchestrator.
    let baseUrl: string | undefined;
    registerFlowAdapter({
      name: "deploy-rec",
      tags: [],
      load: () => ({
        run: (_step, ctx) => {
          baseUrl = ctx.env.BASE_URL;
          return "ok";
        },
        videoStart: () => {},
        videoStop: () => undefined,
      }),
    });
    const file = writeFlow(
      "deploy.xml",
      `base-url="http://127.0.0.1:9"`,
      `<video name="v"><step adapter="deploy-rec" do="x"/></video>`,
    );
    await new FlowCommand().execute(["-f", file]);
    expect(latestFlow().passed).toBe(true);
    expect(baseUrl).toBe("http://127.0.0.1:9");
  });
});

describe("adapter flows — every step runs or the flow fails", () => {
  it("fails, naming the step, when a nested step has no runner", async () => {
    calls.length = 0;
    const file = writeFlow(
      "unroutable.xml",
      "",
      `<step adapter="routing-rec" action="first"/>
       <repeat num="2"><step name="orphan">console.log("never")</step></repeat>`,
    );
    await expect(new FlowCommand().execute(["-f", file])).rejects.toThrow();
    const flow = latestFlow();
    expect(flow.passed).toBe(false);
    const rep = flow.assertions.find((a: any) => a.that === "repeat");
    expect(rep.passed).toBe(false);
    expect(rep.repeat.failures[0]).toMatch(/step 'orphan' has no adapter/);
    expect(calls).toEqual(["first"]);
  });

  it("fails a top-level step with no runner instead of skipping it", async () => {
    calls.length = 0;
    const file = writeFlow(
      "unroutable-top.xml",
      "",
      `<step adapter="routing-rec" action="first"/>
       <step name="orphan">console.log("never")</step>
       <step adapter="routing-rec" action="after"/>`,
    );
    await expect(new FlowCommand().execute(["-f", file])).rejects.toThrow();
    const flow = latestFlow();
    expect(flow.passed).toBe(false);
    expect(flow.error).toMatch(/step 'orphan' has no adapter/);
    expect(calls).toEqual(["first"]);
  });

  it("runs as an adapter flow when the only adapter step is nested two levels deep", async () => {
    calls.length = 0;
    const file = writeFlow(
      "deep.xml",
      "",
      `<repeat num="1"><metric name="m" collect="duration"><step adapter="routing-rec" do="deep"/></metric></repeat>`,
    );
    await new FlowCommand().execute(["-f", file]);
    expect(latestFlow().passed).toBe(true);
    expect(calls).toEqual(["deep"]);
  });

  it("applies <flow adapter> to steps nested in <repeat> and <metric>", async () => {
    calls.length = 0;
    const file = writeFlow(
      "nested-default.xml",
      `adapter="routing-rec"`,
      `<step do="top">x</step>
       <repeat num="2"><step do="in-repeat">x</step></repeat>
       <metric name="m" collect="duration"><step do="in-metric">x</step></metric>`,
    );
    await new FlowCommand().execute(["-f", file]);
    expect(latestFlow().passed).toBe(true);
    expect(calls).toEqual(["top", "in-repeat", "in-repeat", "in-metric"]);
  });
});
