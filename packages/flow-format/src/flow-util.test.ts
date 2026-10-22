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

describe("<repeat> blocks", () => {
  it("parses num/success and ordered children", () => {
    const file = writeFlow(
      "repeat.xml",
      `<flows><flow name="flaky">
        <steps>
          <repeat num="10" success="0.8">
            <step src="flaky.ts">flaky bit</step>
            <usermessage>hi</usermessage>
            <assertions><assert that="contains" value="ok"/></assertions>
          </repeat>
          <assertions><assert that="exitCode" value="0"/></assertions>
        </steps>
      </flow></flows>`
    );
    const [flow] = loadFlowsFromFile(file);
    expect(flow.steps.map((s) => s.type)).toEqual(["repeat", "assertions"]);
    const rep = flow.steps[0];
    expect(rep.num).toBe(10);
    expect(rep.success).toBeCloseTo(0.8);
    expect(rep.children?.map((c) => c.type)).toEqual(["script", "message", "assertions"]);
  });

  it("accepts percent success and defaults success to 1", () => {
    const file = writeFlow(
      "repeat-pct.xml",
      `<flows><flow name="f">
        <steps>
          <repeat num="4" success="80%"><assertions/></repeat>
          <repeat num="3"><assertions/></repeat>
        </steps>
      </flow></flows>`
    );
    const [flow] = loadFlowsFromFile(file);
    expect(flow.steps[0].success).toBeCloseTo(0.8);
    expect(flow.steps[1].success).toBe(1);
  });

  it("rejects a missing/invalid num and out-of-range success", () => {
    for (const [name, attrs, re] of [
      ["r-nonum", "", /positive integer 'num'/],
      ["r-zeronum", 'num="0"', /positive integer 'num'/],
      ["r-badsucc", 'num="3" success="abc"', /must be a rate/],
      ["r-succ0", 'num="3" success="0"', /out of range/],
      ["r-succ200", 'num="3" success="200"', /out of range/],
    ] as const) {
      const file = writeFlow(
        `${name}.xml`,
        `<flows><flow name="f"><steps><repeat ${attrs}><assertions/></repeat></steps></flow></flows>`
      );
      expect(() => loadFlowsFromFile(file), name).toThrow(re);
    }
  });

  it("expands step-file refs inside <repeat>", () => {
    mkdirSync(join(TMP, "steps"), { recursive: true });
    writeFileSync(join(TMP, "steps", "login.xml"), `<step src="ft-login.ts"/>`);
    const file = writeFlow(
      "repeat-ref.xml",
      `<flows><flow name="f"><steps>
        <repeat num="2"><step action="login"/></repeat>
      </steps></flow></flows>`
    );
    const [flow] = loadFlowsFromFile(file);
    expect(flow.steps[0].children?.[0].src).toBe("steps/ft-login.ts");
  });
});

describe('that="llm" assertion attrs', () => {
  it("parses prompt and judge attributes", () => {
    const file = writeFlow(
      "llm.xml",
      `<flows><flow name="f"><steps>
        <assertions>
          <assert that="llm" prompt="states a concrete time" judge="ollama/llama3.1"/>
          <assert that="llm" value="mentions Berlin" judge="https://jev.example/eval"/>
        </assertions>
      </steps></flow></flows>`
    );
    const [flow] = loadFlowsFromFile(file);
    const [a1, a2] = flow.steps[0].assertions ?? [];
    expect(a1).toMatchObject({ that: "llm", prompt: "states a concrete time", judge: "ollama/llama3.1" });
    expect(a2).toMatchObject({ that: "llm", value: "mentions Berlin", judge: "https://jev.example/eval" });
  });
});

describe("<extract> DOM step", () => {
  it("parses selector/attr/url and keeps order", () => {
    const file = writeFlow(
      "extract.xml",
      `<flows><flow name="f">
        <steps>
          <step src="open.ts"/>
          <extract selector=".chat .bubble:last-child"/>
          <extract selector="#count" attr="value" url="\${BASE_URL}/app"/>
          <assertions><assert that="contains" value="hi"/></assertions>
        </steps>
      </flow></flows>`
    );
    const [flow] = loadFlowsFromFile(file);
    expect(flow.steps.map((s) => s.type)).toEqual(["script", "extract", "extract", "assertions"]);
    expect(flow.steps[1]).toMatchObject({ selector: ".chat .bubble:last-child" });
    expect(flow.steps[2]).toMatchObject({ selector: "#count", attr: "value", url: "${BASE_URL}/app" });
  });

  it("requires selector", () => {
    const file = writeFlow(
      "extract-nosel.xml",
      `<flows><flow name="f"><steps><extract attr="text"/></steps></flow></flows>`
    );
    expect(() => loadFlowsFromFile(file)).toThrow(/requires a 'selector'/);
  });
});

describe("nested + bare asserts", () => {
  it("collects <assert>/<assertions> children on producing steps", () => {
    const file = writeFlow(
      "nested.xml",
      `<flows><flow name="f">
        <steps>
          <usermessage>hi<assert that="contains" value="ok"/></usermessage>
          <extract selector=".msg">
            <assert that="llm" judge="ollama/x">rubric text</assert>
          </extract>
          <step src="s.ts">
            <assertions fresh="true"><assert that="duration" max="2000"/></assertions>
          </step>
        </steps>
      </flow></flows>`
    );
    const [flow] = loadFlowsFromFile(file);
    expect(flow.steps[0].assertions).toHaveLength(1);
    expect(flow.steps[1].assertions?.[0]).toMatchObject({ that: "llm", judge: "ollama/x", description: "rubric text" });
    expect(flow.steps[2].assertions?.[0]).toMatchObject({ that: "duration", max: 2000, fresh: true });
  });

  it("parses a bare <assert> as a one-assertion block", () => {
    const file = writeFlow(
      "bare.xml",
      `<flows><flow name="f">
        <steps>
          <step src="a.ts"/>
          <assert that="contains" value="done" fresh="true"/>
        </steps>
      </flow></flows>`
    );
    const [flow] = loadFlowsFromFile(file);
    expect(flow.steps[1]).toMatchObject({
      type: "assertions",
      assertions: [{ that: "contains", value: "done", fresh: true }],
    });
  });
});

describe("<flow adapter> — default step adapter", () => {
  it("applies to adapter-less script steps, leaves others untouched", () => {
    const file = writeFlow(
      "flow-adapter.xml",
      `<?xml version="1.0"?>
      <flows>
        <flow name="f" adapter="my-adapter">
          <steps>
            <step adapter="axn-term" action="a"/>
            <step>console.log("b")</step>
            <script src="x.ts"/>
            <usermessage>hi</usermessage>
            <my-tag action="c"/>
          </steps>
        </flow>
      </flows>`,
    );
    const flow = loadFlowsFromFile(file)[0];
    expect(flow.adapter).toBe("my-adapter");
    const steps = flow.steps;
    // explicit adapter kept
    expect(steps[0].adapter).toBe("axn-term");
    // adapter-less script step inherits
    expect(steps[1].adapter).toBe("my-adapter");
    expect(steps[2].adapter).toBe("my-adapter");
    // usermessage + custom tags unaffected
    expect(steps[3].adapter).toBeUndefined();
    expect(steps[4].adapter).toBeUndefined();
  });
});
