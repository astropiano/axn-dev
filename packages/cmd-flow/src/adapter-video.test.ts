import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerFlowAdapter, type FlowAdapter } from "@axn-dev/core";
import { FlowCommand } from "./flow.js";

const TMP = join(tmpdir(), "axn-flow-adapter-video-test-" + process.pid);
const events: string[] = [];

function writeFlow(name: string, inner: string): string {
  const file = join(TMP, name);
  writeFileSync(
    file,
    `<?xml version="1.0"?><flows><flow name="${name.replace(/\.xml$/, "")}"><steps>${inner}</steps></flow></flows>`,
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
    name: "video-rec",
    tags: [],
    load: (): FlowAdapter => {
      let target = "";
      return {
        run: (step) => {
          const what = step.args?.do ?? "?";
          events.push(`run:${what}`);
          if (what === "fail") throw new Error("boom");
          return `DID ${what}`;
        },
        videoStart: (name, dir) => {
          target = join(dir, `${name}.webm`);
          events.push(`start:${name}`);
        },
        videoStop: (name) => {
          writeFileSync(target, "fake video");
          events.push(`stop:${name}`);
          return target;
        },
      };
    },
  });
  registerFlowAdapter({ name: "no-video", tags: [], load: () => ({ run: () => "ok" }) });
});
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
afterEach(() => {
  events.length = 0;
});

describe("<video> in an adapter flow", () => {
  it("records exactly the block's steps through the adapter and reports the file as evidence", async () => {
    const file = writeFlow(
      "video.xml",
      `<step adapter="video-rec" do="before"/>
       <video name="walkthrough"><step adapter="video-rec" do="a"/><step adapter="video-rec" do="b"/></video>
       <step adapter="video-rec" do="after"/>`,
    );
    await new FlowCommand().execute(["-f", file]);
    expect(events).toEqual(["run:before", "start:walkthrough", "run:a", "run:b", "stop:walkthrough", "run:after"]);
    const flow = latestFlow();
    expect(flow.passed).toBe(true);
    expect(flow.evidence).toHaveLength(1);
    expect(flow.evidence[0]).toMatchObject({ kind: "video", name: "walkthrough" });
    expect(flow.evidence[0].path).toContain(join(".reports", "evidence"));
    expect(existsSync(flow.evidence[0].path)).toBe(true);
  });

  it("stops the recording and keeps the evidence when a step inside fails", async () => {
    const file = writeFlow(
      "video-fail.xml",
      `<video name="broken"><step adapter="video-rec" do="fail"/><step adapter="video-rec" do="never"/></video>`,
    );
    await expect(new FlowCommand().execute(["-f", file])).rejects.toThrow();
    expect(events).toEqual(["start:broken", "run:fail", "stop:broken"]);
    const flow = latestFlow();
    expect(flow.passed).toBe(false);
    expect(flow.evidence?.[0]?.name).toBe("broken");
  });

  it("fails with a clear message when the adapter cannot record", async () => {
    const file = writeFlow("video-none.xml", `<video name="v"><step adapter="no-video" do="x"/></video>`);
    await expect(new FlowCommand().execute(["-f", file])).rejects.toThrow();
    expect(latestFlow().error).toMatch(/adapter 'no-video' cannot record video/);
  });
});
