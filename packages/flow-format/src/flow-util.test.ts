import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { loadFlowsFromFile, parseFlow, isEvidencePathAllowed, evidenceDirFor } from "./flow-util.js";

const TMP = join(tmpdir(), "axn-flow-parse-test-" + process.pid);

beforeAll(() => mkdirSync(TMP, { recursive: true }));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function writeFlow(name: string, xml: string): string {
  const file = join(TMP, name);
  writeFileSync(file, xml);
  return file;
}

describe("loadFlowsFromFile — evidence steps", () => {
  it("parses <picture> with name, selector and fullPage", () => {
    const file = writeFlow(
      "picture.xml",
      `<?xml version="1.0"?>
      <flows>
        <flow name="pic" orchestrator="orchestrators/pw.ts">
          <scenarios>
            <scenario name="s" service="web" adapter="tsAdapter"/>
          </scenarios>
          <steps>
            <step src="steps/login.ts">Log in</step>
            <picture name="after-login" />
            <picture name="grid" selector=".data-grid" />
            <picture name="full" fullPage="true" />
            <assertions><assert that="exitCode" value="0"/></assertions>
          </steps>
        </flow>
      </flows>`
    );

    const [flow] = loadFlowsFromFile(file);
    expect(flow.steps.map((s) => s.type)).toEqual([
      "script",
      "picture",
      "picture",
      "picture",
      "assertions",
    ]);

    const [plain, el, full] = flow.steps.slice(1, 4);
    expect(plain).toMatchObject({ type: "picture", name: "after-login" });
    expect(plain.selector).toBeUndefined();
    expect(el).toMatchObject({ type: "picture", name: "grid", selector: ".data-grid" });
    expect(full).toMatchObject({ type: "picture", name: "full", fullPage: true });
  });

  it("parses <video> with nested steps in order", () => {
    const file = writeFlow(
      "video.xml",
      `<?xml version="1.0"?>
      <flows>
        <flow name="vid" orchestrator="orchestrators/pw.ts">
          <scenarios>
            <scenario name="s" service="web" adapter="tsAdapter"/>
          </scenarios>
          <steps>
            <step src="steps/login.ts"/>
            <video name="booking">
              <step src="steps/open.ts">Open booking</step>
              <picture name="mid-video" />
              <step src="steps/confirm.ts"/>
            </video>
            <assertions><assert that="exitCode" value="0"/></assertions>
          </steps>
        </flow>
      </flows>`
    );

    const [flow] = loadFlowsFromFile(file);
    expect(flow.steps.map((s) => s.type)).toEqual(["script", "video", "assertions"]);

    const video = flow.steps[1];
    expect(video.name).toBe("booking");
    expect(video.children?.map((c) => c.type)).toEqual(["script", "picture", "script"]);
    expect(video.children?.[0]).toMatchObject({ src: "steps/open.ts", description: "Open booking" });
    expect(video.children?.[1]).toMatchObject({ name: "mid-video" });
  });

  it("uses the tag body as description for <picture>", () => {
    const file = writeFlow(
      "pic-desc.xml",
      `<?xml version="1.0"?>
      <flows>
        <flow name="d" orchestrator="o.ts">
          <scenarios><scenario name="s" service="web" adapter="tsAdapter"/></scenarios>
          <steps>
            <picture name="shot">Screenshot of the landing page</picture>
          </steps>
        </flow>
      </flows>`
    );

    const [flow] = loadFlowsFromFile(file);
    expect(flow.steps[0]).toMatchObject({
      type: "picture",
      name: "shot",
      description: "Screenshot of the landing page",
    });
  });

  it("allows non-script step types inside <video>", () => {
    const file = writeFlow(
      "video-mixed.xml",
      `<?xml version="1.0"?>
      <flows>
        <flow name="vm" orchestrator="o.ts">
          <scenarios><scenario name="s" service="web" adapter="tsAdapter"/></scenarios>
          <steps>
            <video name="seg">
              <usermessage value="hello">Say hi</usermessage>
              <assertions><assert that="contains" value="hi"/></assertions>
            </video>
          </steps>
        </flow>
      </flows>`
    );

    const [flow] = loadFlowsFromFile(file);
    const video = flow.steps[0];
    expect(video.type).toBe("video");
    expect(video.children?.map((c) => c.type)).toEqual(["message", "assertions"]);
    expect(video.children?.[0]).toMatchObject({ value: "hello", description: "Say hi" });
  });

  it("keeps document order for evidence mixed with steps and assertions", () => {
    const file = writeFlow(
      "order.xml",
      `<?xml version="1.0"?>
      <flows>
        <flow name="ord" orchestrator="o.ts">
          <scenarios><scenario name="s" service="web" adapter="tsAdapter"/></scenarios>
          <steps>
            <picture name="first" />
            <step src="a.ts"/>
            <assertions><assert that="exitCode" value="0"/></assertions>
            <video name="seg"><step src="b.ts"/></video>
            <picture name="last" />
          </steps>
        </flow>
      </flows>`
    );

    const [flow] = loadFlowsFromFile(file);
    expect(flow.steps.map((s) => s.type)).toEqual([
      "picture",
      "script",
      "assertions",
      "video",
      "picture",
    ]);
  });
});

describe("parseFlow — flat-parse fallback for evidence", () => {
  it("converts flat picture/video items into evidence steps", () => {
    // Mirrors the shape the flat XMLParser produces for <steps> children.
    const raw = {
      name: "flat",
      steps: {
        step: [{ src: "a.ts" }],
        picture: [{ name: "p1", selector: ".x" }],
        video: [
          {
            name: "v",
            step: [{ src: "b.ts" }],
            picture: [{ name: "inner" }],
          },
        ],
      },
    };

    const flow = parseFlow(raw);
    expect(flow.steps.map((s) => s.type)).toEqual(["script", "picture", "video"]);
    expect(flow.steps[1]).toMatchObject({ name: "p1", selector: ".x" });

    const video = flow.steps[2];
    expect(video.name).toBe("v");
    expect(video.children?.map((c) => c.type)).toEqual(["script", "picture"]);
    expect(video.children?.[0]).toMatchObject({ src: "b.ts" });
    expect(video.children?.[1]).toMatchObject({ name: "inner" });
  });
});

describe("evidenceDirFor", () => {
  it("creates <root>/flows/.reports/evidence/<slug>-<ts>/", () => {
    const proj = join(TMP, "proj");
    mkdirSync(join(proj, "scenarios"), { recursive: true });
    const flowFile = join(proj, "flows", "f.xml");

    const dir = evidenceDirFor(flowFile, "My Flow!");
    expect(dir.startsWith(join(proj, "flows", ".reports", "evidence") + sep)).toBe(true);
    expect(dir).toMatch(/my-flow-/);
    expect(existsSync(dir)).toBe(true);
  });
});

describe("isEvidencePathAllowed", () => {
  const roots = ["/repos/integration"];

  it("accepts files under <root>/flows/.reports/evidence/", () => {
    expect(
      isEvidencePathAllowed("/repos/integration/flows/.reports/evidence/run-1/a.png", roots)
    ).toBe(true);
    expect(
      isEvidencePathAllowed("/repos/integration/flows/.reports/evidence/run-1/nested/v.webm", roots)
    ).toBe(true);
  });

  it("rejects paths outside evidence dirs or unknown roots", () => {
    expect(isEvidencePathAllowed("/repos/integration/flows/.reports/flow-report-1.json", roots)).toBe(false);
    expect(isEvidencePathAllowed("/repos/integration/flows/evil.png", roots)).toBe(false);
    expect(isEvidencePathAllowed("/other/flows/.reports/evidence/run/a.png", roots)).toBe(false);
    expect(isEvidencePathAllowed("/repos/integration/../integration/flows/.reports/evidence/x/a.png", roots)).toBe(true);
  });
});

describe("runner attribute", () => {
  it("parses <flow runner=\"pw\"> and the <flows> file-level default", () => {
    const file = writeFlow(
      "runner.xml",
      `<?xml version="1.0"?>
      <flows runner="pw">
        <flow name="uses-default">
          <steps><step src="a.ts"/></steps>
        </flow>
        <flow name="overrides" runner="axn">
          <steps><step src="a.ts"/></steps>
        </flow>
      </flows>`
    );
    const [a, b] = loadFlowsFromFile(file);
    expect(a.runner).toBe("pw");
    expect(b.runner).toBe("axn");
  });

  it("normalizes legacy → axn and rejects unknown runners", () => {
    const legacy = writeFlow(
      "runner-legacy.xml",
      `<flows><flow name="f" runner="legacy"><steps><step src="a.ts"/></steps></flow></flows>`
    );
    expect(loadFlowsFromFile(legacy)[0].runner).toBe("axn");

    const bad = writeFlow(
      "runner-bad.xml",
      `<flows><flow name="f" runner="vitest"><steps><step src="a.ts"/></steps></flow></flows>`
    );
    expect(() => loadFlowsFromFile(bad)).toThrow(/Unknown flow runner 'vitest'/);
  });
});
