import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadFlowsFromFile } from "./flow-util.js";

let tempDir: string;
let flowsDir: string;

function write(rel: string, content: string): string {
  const path = join(tempDir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function flowFile(stepsInner: string, flowAttrs = "", stepsAttrs = ""): string {
  return write(
    "flows/test.xml",
    `<?xml version="1.0"?>
<flows>
  <flow name="t" orchestrator="orch.ts"${flowAttrs ? " " + flowAttrs : ""}>
    <steps${stepsAttrs ? " " + stepsAttrs : ""}>
${stepsInner}
    </steps>
  </flow>
</flows>`
  );
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "axn-dev-steprefs-"));
  flowsDir = join(tempDir, "flows");
  mkdirSync(join(flowsDir, "steps"), { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("named step files", () => {
  it("binds <step action> to steps/<name>.xml next to the flow", () => {
    write("flows/steps/login.xml", `<step src="ft-login.ts"/>`);
    const [flow] = loadFlowsFromFile(flowFile(`      <step action="login"/>`));
    expect(flow.steps).toHaveLength(1);
    expect(flow.steps[0].type).toBe("script");
    expect(flow.steps[0].src).toBe("steps/ft-login.ts");
    expect(flow.steps[0].args).toBeUndefined();
  });

  it("supports script= as alias for src= inside a step file", () => {
    write("flows/steps/login.xml", `<step script="myScripts/ft-login.ts"/>`);
    const [flow] = loadFlowsFromFile(flowFile(`      <step action="login"/>`));
    expect(flow.steps[0].src).toBe("steps/myScripts/ft-login.ts");
  });

  it("resolves src inside a step file relative to the step file's dir", () => {
    write("flows/lib/deep/login.xml", `<step src="ft-login.ts"/>`);
    const [flow] = loadFlowsFromFile(flowFile(`      <step file="lib/deep/login.xml"/>`));
    expect(flow.steps[0].src).toBe("lib/deep/ft-login.ts");
  });

  it("binds <step file> to an explicit path", () => {
    write("flows/lib/logout.xml", `<step src="um-logout.ts"/>`);
    const [flow] = loadFlowsFromFile(flowFile(`      <step file="lib/logout.xml"/>`));
    expect(flow.steps[0].src).toBe("lib/um-logout.ts");
  });

  it("merges extra attrs on the ref into the bound step's args (caller wins)", () => {
    write("flows/steps/login.xml", `<step src="login.ts" user="default" realm="dev"/>`);
    const [flow] = loadFlowsFromFile(
      flowFile(`      <step action="login" user="mom" extra="1"/>`)
    );
    expect(flow.steps[0].args).toEqual({ user: "mom", realm: "dev", extra: "1" });
  });

  it("keeps adapter steps inside step files", () => {
    write(
      "flows/steps/mkuser.xml",
      `<step adapter="keycloak" action="createUser" username="mom" password="mom"/>`
    );
    const [flow] = loadFlowsFromFile(flowFile(`      <step action="mkuser"/>`));
    expect(flow.steps[0].adapter).toBe("keycloak");
    expect(flow.steps[0].args?.action).toBe("createUser");
    expect(flow.steps[0].args?.username).toBe("mom");
  });

  it("does not treat adapter= steps' action arg as a ref", () => {
    const [flow] = loadFlowsFromFile(
      flowFile(`      <step adapter="keycloak" action="createUser" username="x"/>`)
    );
    expect(flow.steps[0].adapter).toBe("keycloak");
    expect(flow.steps[0].args?.action).toBe("createUser");
  });

  it("accepts a <steps> wrapper with a single child", () => {
    write("flows/steps/login.xml", `<steps><step src="ft-login.ts"/></steps>`);
    const [flow] = loadFlowsFromFile(flowFile(`      <step action="login"/>`));
    expect(flow.steps[0].src).toBe("steps/ft-login.ts");
  });

  it("keeps reusable <assertions> blocks", () => {
    write(
      "flows/steps/check.xml",
      `<assertions><assert that="exitCode" value="0"/></assertions>`
    );
    const [flow] = loadFlowsFromFile(
      flowFile(`      <step src="x.ts"/>
      <step action="check"/>`)
    );
    expect(flow.steps[1].type).toBe("assertions");
    expect(flow.steps[1].assertions?.[0].that).toBe("exitCode");
  });

  it("tolerates action names that already end in .xml", () => {
    write("flows/steps/login.xml", `<step src="ft-login.ts"/>`);
    const [flow] = loadFlowsFromFile(flowFile(`      <step action="login.xml"/>`));
    expect(flow.steps[0].src).toBe("steps/ft-login.ts");
  });
});

describe("steps includes", () => {
  it("finds step files in dirs listed via <steps include>", () => {
    write("shared/lib/logout.xml", `<step src="logout.ts"/>`);
    const [flow] = loadFlowsFromFile(
      flowFile(`      <step action="logout"/>`, "", `include="../shared/lib"`)
    );
    expect(flow.steps[0].src).toBe("../shared/lib/logout.ts");
  });

  it("supports include on <flow> and <flows>", () => {
    write("shared/a/one.xml", `<step src="one.ts"/>`);
    write("shared/b/two.xml", `<step src="two.ts"/>`);
    const file = write(
      "flows/test.xml",
      `<?xml version="1.0"?>
<flows include="../shared/a">
  <flow name="t" include="../shared/b">
    <steps>
      <step action="one"/>
      <step action="two"/>
    </steps>
  </flow>
</flows>`
    );
    const [flow] = loadFlowsFromFile(file);
    expect(flow.steps[0].src).toBe("../shared/a/one.ts");
    expect(flow.steps[1].src).toBe("../shared/b/two.ts");
  });

  it("accepts comma-separated include lists", () => {
    write("shared/a/one.xml", `<step src="one.ts"/>`);
    write("shared/b/two.xml", `<step src="two.ts"/>`);
    const [flow] = loadFlowsFromFile(
      flowFile(
        `      <step action="one"/>
      <step action="two"/>`,
        "",
        `include="../shared/a, ../shared/b"`
      )
    );
    expect(flow.steps[0].src).toBe("../shared/a/one.ts");
    expect(flow.steps[1].src).toBe("../shared/b/two.ts");
  });

  it("errors when an include dir does not exist", () => {
    write("flows/steps/login.xml", `<step src="x.ts"/>`);
    expect(() =>
      loadFlowsFromFile(flowFile(`      <step action="login"/>`, "", `include="nope"`))
    ).toThrow(/include 'nope'.*not.*directory|does not resolve/i);
  });
});

describe("step ref errors", () => {
  it("errors on unknown step names and lists searched dirs", () => {
    expect(() =>
      loadFlowsFromFile(flowFile(`      <step action="nosuch"/>`))
    ).toThrow(/No step file 'nosuch\.xml'.*Searched:/s);
  });

  it("errors on ambiguous step names and suggests file=", () => {
    write("flows/steps/login.xml", `<step src="a.ts"/>`);
    write("shared/login.xml", `<step src="b.ts"/>`);
    expect(() =>
      loadFlowsFromFile(
        flowFile(`      <step action="login"/>`, "", `include="../shared"`)
      )
    ).toThrow(/ambiguous.*file=/s);
  });

  it("errors when file= does not exist", () => {
    expect(() =>
      loadFlowsFromFile(flowFile(`      <step file="missing.xml"/>`))
    ).toThrow(/Step file not found/);
  });

  it("errors when file= is not an .xml", () => {
    expect(() =>
      loadFlowsFromFile(flowFile(`      <step file="steps/login.ts"/>`))
    ).toThrow(/must point to an \.xml step file/);
  });

  it("errors when file= is combined with src", () => {
    expect(() =>
      loadFlowsFromFile(flowFile(`      <step file="x.xml" src="y.ts"/>`))
    ).toThrow(/cannot be combined with src/);
  });

  it("errors on step files with zero elements", () => {
    write("flows/steps/empty.xml", `<!-- nothing here -->`);
    expect(() =>
      loadFlowsFromFile(flowFile(`      <step action="empty"/>`))
    ).toThrow(/exactly one step element \(found 0\)/);
  });

  it("errors on step files with more than one element", () => {
    write("flows/steps/two.xml", `<steps><step src="a.ts"/><step src="b.ts"/></steps>`);
    expect(() =>
      loadFlowsFromFile(flowFile(`      <step action="two"/>`))
    ).toThrow(/exactly one step element \(found 2\)/);
  });

  it("errors on step files that are not valid XML", () => {
    write("flows/steps/bad.xml", `<step src="a.ts"`);
    expect(() =>
      loadFlowsFromFile(flowFile(`      <step action="bad"/>`))
    ).toThrow(/not valid XML/);
  });

  it("detects circular references", () => {
    write("flows/steps/a.xml", `<step action="b"/>`);
    write("flows/steps/b.xml", `<step action="a"/>`);
    expect(() =>
      loadFlowsFromFile(flowFile(`      <step action="a"/>`))
    ).toThrow(/Circular step reference/);
  });

  it("resolves nested refs", () => {
    write("flows/steps/login.xml", `<step action="base-login" user="mom"/>`);
    write("flows/steps/base-login.xml", `<step src="ft-login.ts" realm="dev"/>`);
    const [flow] = loadFlowsFromFile(flowFile(`      <step action="login"/>`));
    expect(flow.steps[0].src).toBe("steps/ft-login.ts");
    expect(flow.steps[0].args).toEqual({ realm: "dev", user: "mom" });
  });
});
