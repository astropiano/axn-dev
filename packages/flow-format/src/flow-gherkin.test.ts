import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadFlowsFromFile } from "./flow-util.js";

let tempDir: string;

function featureFile(body: string, fm = ""): string {
  const path = join(tempDir, "flows", "test.feature");
  mkdirSync(join(tempDir, "flows"), { recursive: true });
  writeFileSync(path, (fm ? `---\n${fm}---\n\n` : "") + body);
  return path;
}

function stepFile(name: string, inner: string): void {
  const dir = join(tempDir, "flows", "steps");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.xml`), inner);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "axn-dev-gherkin-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("feature structure", () => {
  it("maps Scenario name/description to the flow", () => {
    const [f] = loadFlowsFromFile(
      featureFile(`Feature: RSVP
  A description line.

  Scenario: invitee accepts
    scenario desc text
    When the user says "hi"
    Then the output contains "ok"
`)
    );
    expect(f.name).toBe("invitee accepts");
    expect(f.description).toContain("A description line.");
    expect(f.description).toContain("scenario desc text");
  });

  it("maps frontmatter to flow config", () => {
    const [f] = loadFlowsFromFile(
      featureFile(
        `Feature: x
  Scenario: s
    When the user says "hi"
`,
        `orchestrator: orchestrators/pw.ts
runner: pw
adapter: tsAdapter
baseUrl: http://example.test
toolMode: all
useDocker: true
tags: [smoke]
env:
  FOO: bar
  NUM: 42
models:
  - { provider: ollama, name: llama3.1 }
scenarios:
  - name: demo
    service: web
    adapter: tsAdapter
    readiness:
      - { service: web, path: /, expected: "200" }
`
      )
    );
    expect(f.orchestrator).toBe("orchestrators/pw.ts");
    expect(f.runner).toBe("pw");
    expect(f.adapter).toBe("tsAdapter");
    expect(f.baseUrl).toBe("http://example.test");
    expect(f.toolMode).toBe("all");
    expect(f.useDocker).toBe(true);
    expect(f.env).toEqual({ FOO: "bar", NUM: "42" });
    expect(f.models).toEqual([{ provider: "ollama", name: "llama3.1" }]);
    expect(f.tags).toEqual(["smoke"]);
    expect(f.scenarios[0].name).toBe("demo");
    expect(f.scenarios[0].readiness[0].expected).toBe("200");
  });

  it("collects @tags onto the flow", () => {
    const [f] = loadFlowsFromFile(
      featureFile(`Feature: x
  @smoke @rsvp
  Scenario: s
    When the user says "hi"
`)
    );
    expect(f.tags).toEqual(["smoke", "rsvp"]);
  });

  it("prepends Background steps to every scenario", () => {
    const flows = loadFlowsFromFile(
      featureFile(`Feature: x
  Background:
    Given script "setup.ts"

  Scenario: a
    When the user says "one"

  Scenario: b
    When the user says "two"
`)
    );
    expect(flows).toHaveLength(2);
    expect(flows[0].steps[0].src).toBe("setup.ts");
    expect(flows[1].steps[0].src).toBe("setup.ts");
  });
});

describe("producing steps", () => {
  it("resolves step name refs to step files with arg merging", () => {
    stepFile("do-login", `<step src="ft-login.ts"/>`);
    const [f] = loadFlowsFromFile(
      featureFile(`Feature: x
  Scenario: s
    Given step "do-login" user="mom"
`)
    );
    expect(f.steps[0].type).toBe("script");
    expect(f.steps[0].src).toContain("ft-login.ts");
    expect(f.steps[0].args?.user).toBe("mom");
  });

  it("maps script, message, picture, extract", () => {
    const [f] = loadFlowsFromFile(
      featureFile(`Feature: x
  Scenario: s
    Given script "a.ts" lang="ts" foo=bar
    When the user says "hello there"
    And picture "after-login" of "#app" fullPage
    And extract attr "value" "#field" as "field-val"
`)
    );
    expect(f.steps[0]).toMatchObject({ type: "script", src: "a.ts", lang: "ts" });
    expect(f.steps[0].args).toEqual({ foo: "bar" });
    expect(f.steps[1]).toMatchObject({ type: "message", value: "hello there" });
    expect(f.steps[2]).toMatchObject({ type: "picture", name: "after-login", selector: "#app", fullPage: true });
    expect(f.steps[3]).toMatchObject({ type: "extract", attr: "value", selector: "#field", name: "field-val" });
  });

  it("routes unknown idents to custom adapter tags", () => {
    const [f] = loadFlowsFromFile(
      featureFile(`Feature: x
  Scenario: s
    Given keycloak-login user="mom" realm="dev"
`)
    );
    expect(f.steps[0].type).toBe("keycloak-login");
    expect(f.steps[0].args).toEqual({ user: "mom", realm: "dev" });
  });

  it("rejects reserved words with a helpful error", () => {
    expect(() =>
      loadFlowsFromFile(
        featureFile(`Feature: x
  Scenario: s
    Given video "x"
`)
      )
    ).toThrow(/reserved|unrecognized/);
  });

  it("merges data tables into step args", () => {
    const [f] = loadFlowsFromFile(
      featureFile(`Feature: x
  Scenario: s
    Given keycloak-create-user
      | username  | rsvp_mom        |
      | email     | mom@rsvp.family |
`)
    );
    expect(f.steps[0].args).toEqual({ username: "rsvp_mom", email: "mom@rsvp.family" });
  });

  it("feeds docstrings into message and inline-script values", () => {
    const [f] = loadFlowsFromFile(
      featureFile(`Feature: x
  Scenario: s
    When the user says
      """
      line one
      line two
      """
    And script
      """
      console.log("hi")
      """
`)
    );
    expect(f.steps[0].value).toBe("line one\nline two");
    expect(f.steps[1].value).toBe('console.log("hi")');
  });
});

describe("assertions", () => {
  it("groups a Then/And run into one assertions step", () => {
    const [f] = loadFlowsFromFile(
      featureFile(`Feature: x
  Scenario: s
    When the user says "hi"
    Then the output contains "time"
    And there is 1 response
    And the exit code is 0
`)
    );
    const a = f.steps[1];
    expect(a.type).toBe("assertions");
    expect(a.assertions).toHaveLength(3);
    expect(a.assertions![0]).toMatchObject({ that: "contains", value: "time" });
    expect(a.assertions![1]).toMatchObject({ that: "num_responses", value: "1" });
    expect(a.assertions![2]).toMatchObject({ that: "exitCode", value: "0" });
  });

  it("maps sugar patterns to assertion types", () => {
    const [f] = loadFlowsFromFile(
      featureFile(`Feature: x
  Scenario: s
    When the user says "hi"
    Then the new output contains "x"
    And it took less than 2000 ms
    And the page matches "ref.png"
    And "#app" matches "ref2.png"
    And an llm judges "looks right" using "ollama/judge"
    And script "verify.ts" passes
`)
    );
    const a = f.steps[1].assertions!;
    expect(a[0]).toMatchObject({ that: "contains", value: "x", fresh: true });
    expect(a[1]).toMatchObject({ that: "duration", max: 2000 });
    expect(a[2]).toMatchObject({ that: "screenshot", value: "ref.png" });
    expect(a[3]).toMatchObject({ that: "screenshot", selector: "#app", value: "ref2.png" });
    expect(a[4]).toMatchObject({ that: "llm", prompt: "looks right", judge: "ollama/judge" });
    expect(a[5]).toMatchObject({ that: "script", src: "verify.ts" });
  });

  it("generic assert escape hatch: value, k=v attrs, boolean flags", () => {
    const [f] = loadFlowsFromFile(
      featureFile(`Feature: x
  Scenario: s
    When the user says "hi"
    Then assert screenshot refs/app.png fullPage maxDiff=0.02 viewport=1280x800
`)
    );
    expect(f.steps[1].assertions![0]).toMatchObject({
      that: "screenshot",
      value: "refs/app.png",
      fullPage: true,
      maxDiff: 0.02,
      viewport: "1280x800",
    });
  });

  it("merges a table under a Then line into the assert", () => {
    const [f] = loadFlowsFromFile(
      featureFile(`Feature: x
  Scenario: s
    When the user says "hi"
    Then assert screenshot
      | value    | refs/app.png |
      | selector | #app         |
`)
    );
    expect(f.steps[1].assertions![0]).toMatchObject({ that: "screenshot", value: "refs/app.png", selector: "#app" });
  });

  it("binds deeper-indented Then lines to the step", () => {
    const [f] = loadFlowsFromFile(
      featureFile(`Feature: x
  Scenario: s
    When script "a.ts"
        Then the output contains "ok"
    Then the output contains "done"
`)
    );
    expect(f.steps[0].assertions![0]).toMatchObject({ that: "contains", value: "ok" });
    expect(f.steps[1].type).toBe("assertions");
  });
});

describe("blocks", () => {
  it("nests children under video/repeat/stopwatch headers", () => {
    const [f] = loadFlowsFromFile(
      featureFile(`Feature: x
  Scenario: s
    * video "login":
        When script "a.ts"
        And script "b.ts"
    * repeat 3 times at 80%:
        When script "flaky.ts"
    * stopwatch "cold-start":
        When script "c.ts"
    When the user says "done"
`)
    );
    const [video, repeat, sw] = f.steps;
    expect(video).toMatchObject({ type: "video", name: "login" });
    expect(video.children).toHaveLength(2);
    expect(repeat).toMatchObject({ type: "repeat", num: 3, success: 0.8 });
    expect(repeat.children).toHaveLength(1);
    expect(sw).toMatchObject({ type: "stopwatch", name: "cold-start" });
    expect(f.steps[3].type).toBe("message");
  });

  it("supports bare block headers too", () => {
    const [f] = loadFlowsFromFile(
      featureFile(`Feature: x
  Scenario: s
    video "v":
        When script "a.ts"
`)
    );
    expect(f.steps[0].type).toBe("video");
    expect(f.steps[0].children).toHaveLength(1);
  });

  it("rejects empty blocks", () => {
    expect(() =>
      loadFlowsFromFile(
        featureFile(`Feature: x
  Scenario: s
    * video "v":
    When the user says "hi"
`)
      )
    ).toThrow(/no children/);
  });
});

describe("scenario outlines", () => {
  it("expands Examples rows into flows with env + substitution", () => {
    const flows = loadFlowsFromFile(
      featureFile(`Feature: x
  Scenario Outline: greet <user>
    When the user says "hi <user>"
    Then the output contains "ok"
    Examples:
      | user |
      | mom  |
      | dad  |
`)
    );
    expect(flows).toHaveLength(2);
    expect(flows[0].name).toBe("greet mom");
    expect(flows[1].name).toBe("greet dad");
    expect(flows[0].steps[0].value).toBe("hi mom");
    expect(flows[1].steps[0].value).toBe("hi dad");
    expect(flows[0].env).toEqual({ user: "mom" });
  });
});

describe("errors", () => {
  it("rejects Rule:", () => {
    expect(() =>
      loadFlowsFromFile(featureFile(`Feature: x\n  Rule: y\n`))
    ).toThrow(/Rule: is not supported/);
  });

  it("rejects unknown assertion text with the generic hint", () => {
    expect(() =>
      loadFlowsFromFile(
        featureFile(`Feature: x
  Scenario: s
    When the user says "hi"
    Then frobnicate the widget
`)
      )
    ).toThrow(/unrecognized assertion.*assert <that>/s);
  });

  it("rejects dangling tables and duplicate flow names", () => {
    expect(() =>
      loadFlowsFromFile(
        featureFile(`Feature: x
  Scenario: s
    | a | b |
`)
      )
    ).toThrow(/dangling table|expected a step/);

    expect(() =>
      loadFlowsFromFile(
        featureFile(`Feature: x
  Scenario: same
    When the user says "a"
  Scenario: same
    When the user says "b"
`)
      )
    ).toThrow(/duplicate flow name/);
  });
});
