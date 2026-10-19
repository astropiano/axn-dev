import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { ManualFlowRunner } from "./manualFlowRunner.js";
import type { ParsedFlow } from "./flow-util.js";

const TMP = join(tmpdir(), "axn-manual-runner-test-" + process.pid);

beforeAll(() => mkdirSync(TMP, { recursive: true }));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function makeFlow(): ParsedFlow {
  return {
    name: "manual-evidence",
    scenarios: [],
    models: [],
    env: {},
    userMessage: "",
    assertions: [],
    steps: [
      { type: "script", src: "steps/login.ts", description: "Log in" },
      { type: "picture", name: "after-login" },
      {
        type: "video",
        name: "booking",
        children: [
          { type: "script", src: "steps/open.ts" },
          { type: "script", src: "steps/confirm.ts" },
        ],
      },
      { type: "assertions", assertions: [{ that: "contains", value: "welcome", description: "Welcome shown" }] },
    ],
  };
}

describe("ManualFlowRunner.execute — evidence steps", () => {
  it("records picture/video steps as manual step results with their type", () => {
    const runner = new ManualFlowRunner(makeFlow(), "/tmp/flow.xml");
    const result = runner.execute({
      steps: [
        { stepIndex: 0, passed: true, assertions: [] },
        { stepIndex: 1, passed: true, assertions: [] },
        { stepIndex: 2, passed: true, assertions: [] },
        { stepIndex: 3, passed: true, assertions: [{ that: "contains", value: "welcome", passed: true }] },
      ],
    });

    expect(result.manualSteps?.map((s) => s.stepType)).toEqual([
      "script",
      "picture",
      "video",
      "assertions",
    ]);
    expect(result.passed).toBe(true);
    expect(result.assertions).toHaveLength(1);
    expect(result.assertions[0]).toMatchObject({ that: "contains", value: "welcome", passed: true });
  });

  it("copies attached files into the run's evidence dir with stepIndex", () => {
    const proj = join(TMP, "proj");
    mkdirSync(join(proj, "scenarios"), { recursive: true });
    const flowFile = join(proj, "flows", "f.xml");
    const shot = join(TMP, "fail-screenshot.png");
    writeFileSync(shot, "png-bytes");

    const runner = new ManualFlowRunner(makeFlow(), flowFile);
    const result = runner.execute({
      steps: [
        { stepIndex: 0, passed: false, assertions: [], evidence: [{ name: "fail.png", path: shot }] },
      ],
    });

    expect(result.evidence).toHaveLength(1);
    const ev = result.evidence![0];
    expect(ev).toMatchObject({ kind: "picture", name: "fail.png", stepIndex: 0 });
    expect(ev.path.includes(join("flows", ".reports", "evidence") + sep)).toBe(true);
    expect(ev.path.startsWith(join(proj, "flows", ".reports"))).toBe(true);
    expect(existsSync(ev.path)).toBe(true);
  });

  it("keeps paths already inside an evidence dir and infers video kind", () => {
    const proj = join(TMP, "proj2");
    const evDir = join(proj, "flows", ".reports", "evidence", "run-1");
    mkdirSync(evDir, { recursive: true });
    const clip = join(evDir, "seg.webm");
    writeFileSync(clip, "video-bytes");

    const runner = new ManualFlowRunner(makeFlow(), join(proj, "flows", "f.xml"));
    const result = runner.execute({
      steps: [
        { stepIndex: 2, passed: true, assertions: [], evidence: [{ name: "seg.webm", path: clip }] },
      ],
    });

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence![0]).toMatchObject({
      kind: "video",
      name: "seg.webm",
      path: clip,
      stepIndex: 2,
    });
  });

  it("skips evidence entries pointing at missing files", () => {
    const runner = new ManualFlowRunner(makeFlow(), join(TMP, "proj", "flows", "f.xml"));
    const result = runner.execute({
      steps: [
        { stepIndex: 0, passed: true, assertions: [], evidence: [{ name: "gone.png", path: join(TMP, "does-not-exist.png") }] },
      ],
    });

    expect(result.evidence).toBeUndefined();
  });

  it("keeps step notes and observed responses for evidence steps", () => {
    const runner = new ManualFlowRunner(makeFlow(), "/tmp/flow.xml");
    const result = runner.execute({
      steps: [
        { stepIndex: 0, passed: true, response: "logged in", assertions: [] },
        { stepIndex: 1, passed: true, notes: "screenshot taken manually", assertions: [] },
        { stepIndex: 2, passed: false, notes: "video shows a broken layout", assertions: [] },
        { stepIndex: 3, passed: false, assertions: [{ that: "contains", value: "welcome", passed: false, actual: "error page" }] },
      ],
    });

    const picStep = result.manualSteps?.[1];
    expect(picStep).toMatchObject({ stepType: "picture", notes: "screenshot taken manually", passed: true });
    const vidStep = result.manualSteps?.[2];
    expect(vidStep).toMatchObject({ stepType: "video", notes: "video shows a broken layout", passed: false });
    expect(result.passed).toBe(false);
  });
});
