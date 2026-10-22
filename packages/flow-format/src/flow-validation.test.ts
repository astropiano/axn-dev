import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadFlowsFromFile } from "./flow-util.js";

let tempDir: string;

function flowFile(stepsInner: string, flowAttrs = ""): string {
  const path = join(tempDir, "flows", "test.xml");
  mkdirSync(join(tempDir, "flows"), { recursive: true });
  writeFileSync(
    path,
    `<?xml version="1.0"?>
<flows>
  <flow name="t"${flowAttrs ? " " + flowAttrs : ""}>
    <steps>
${stepsInner}
    </steps>
  </flow>
</flows>`
  );
  return path;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "axn-dev-flowval-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("reserved step tags", () => {
  it("rejects reserved keywords used as custom tags", () => {
    for (const tag of ["file", "action", "env", "var", "include", "tool-mode", "steps", "models"]) {
      expect(
        () => loadFlowsFromFile(flowFile(`      <${tag}/>`)),
        `<${tag}>`
      ).toThrow(/reserved flow element/);
    }
  });

  it("rejects reserved tags nested in <video> and <repeat>", () => {
    expect(() =>
      loadFlowsFromFile(flowFile(`      <video name="v"><file/></video>`))
    ).toThrow(/reserved flow element/);
    expect(() =>
      loadFlowsFromFile(flowFile(`      <repeat num="2"><env/></repeat>`))
    ).toThrow(/reserved flow element/);
  });

  it("still allows real custom adapter tags", () => {
    const [flow] = loadFlowsFromFile(flowFile(`      <keycloak action="createUser" username="x"/>`));
    expect(flow.steps[0].type).toBe("keycloak");
    expect(flow.steps[0].args?.action).toBe("createUser");
  });
});

describe("reserved action names", () => {
  it("rejects <step action> names that are reserved keywords", () => {
    for (const name of ["file", "step", "usermessage", "assertions", "env"]) {
      expect(
        () => loadFlowsFromFile(flowFile(`      <step action="${name}"/>`)),
        `action="${name}"`
      ).toThrow(/reserved flow keyword/);
    }
  });

  it("rejects reserved names ending in .xml", () => {
    expect(() =>
      loadFlowsFromFile(flowFile(`      <step action="file.xml"/>`))
    ).toThrow(/reserved flow keyword/);
  });

  it("rejects file= combined with action=", () => {
    expect(() =>
      loadFlowsFromFile(flowFile(`      <step file="steps/x.xml" action="login"/>`))
    ).toThrow(/cannot be combined with action/);
  });

  it("keeps action= as a normal adapter argument on adapter steps", () => {
    const [flow] = loadFlowsFromFile(
      flowFile(`      <step adapter="keycloak" action="createUser" username="x"/>`)
    );
    expect(flow.steps[0].args?.action).toBe("createUser");
  });
});

describe("assertion validation", () => {
  const assertFlow = (attrs: string, body = "") =>
    flowFile(`      <step src="a.ts"/>
      <assertions><assert ${attrs}>${body}</assert></assertions>`);

  it("rejects an assert without 'that'", () => {
    expect(() => loadFlowsFromFile(assertFlow(`value="x"`))).toThrow(/requires a 'that'/);
  });

  it("rejects unknown assertion types", () => {
    expect(() => loadFlowsFromFile(assertFlow(`that="contain" value="x"`))).toThrow(
      /unknown assertion type 'contain'/
    );
  });

  it("rejects contains/num_responses/exitCode without value", () => {
    for (const that of ["contains", "num_responses", "exitCode"]) {
      expect(() => loadFlowsFromFile(assertFlow(`that="${that}"`)), that).toThrow(/requires 'value'/);
    }
  });

  it("rejects non-integer num_responses/exitCode values", () => {
    for (const that of ["num_responses", "exitCode"]) {
      expect(() => loadFlowsFromFile(assertFlow(`that="${that}" value="abc"`)), that).toThrow(
        /must be an integer/
      );
    }
  });

  it("rejects that=\"screenshot\" without a reference path", () => {
    expect(() => loadFlowsFromFile(assertFlow(`that="screenshot"`))).toThrow(/reference PNG/);
  });

  it("rejects that=\"llm\" without a rubric", () => {
    expect(() => loadFlowsFromFile(assertFlow(`that="llm" judge="ollama/x"`))).toThrow(/rubric/);
  });

  it("accepts the llm rubric from prompt, value or body", () => {
    expect(() => loadFlowsFromFile(assertFlow(`that="llm" prompt="p"`))).not.toThrow();
    expect(() => loadFlowsFromFile(assertFlow(`that="llm" value="v"`))).not.toThrow();
    expect(() => loadFlowsFromFile(assertFlow(`that="llm"`, "rubric body"))).not.toThrow();
  });

  it("rejects that=\"duration\" without a bound", () => {
    expect(() => loadFlowsFromFile(assertFlow(`that="duration"`))).toThrow(/needs a bound/);
    expect(() => loadFlowsFromFile(assertFlow(`that="duration" value="abc"`))).toThrow(/needs a bound/);
    expect(() => loadFlowsFromFile(assertFlow(`that="duration" max="xyz"`))).toThrow(/max= must be numeric/);
  });

  it("rejects that=\"script\" without a script", () => {
    expect(() => loadFlowsFromFile(assertFlow(`that="script"`))).toThrow(/script path/);
  });
});

describe("step validation", () => {
  it("rejects an empty <usermessage>", () => {
    expect(() => loadFlowsFromFile(flowFile(`      <usermessage/>`))).toThrow(/requires a message/);
  });

  it("rejects a <step> with no content", () => {
    expect(() => loadFlowsFromFile(flowFile(`      <step description="nothing"/>`))).toThrow(
      /needs a 'src' script, inline text/
    );
  });

  it("rejects <picture>/<video> without a name", () => {
    expect(() => loadFlowsFromFile(flowFile(`      <step src="a.ts"/><picture/>`))).toThrow(
      /<picture>.*requires 'name'/
    );
    expect(() =>
      loadFlowsFromFile(flowFile(`      <video><step src="a.ts"/></video>`))
    ).toThrow(/<video>.*requires 'name'/);
  });

  it("rejects an empty <video> and an empty <repeat>", () => {
    expect(() => loadFlowsFromFile(flowFile(`      <video name="v"/>`))).toThrow(/wraps no steps/);
    expect(() => loadFlowsFromFile(flowFile(`      <repeat num="2"/>`))).toThrow(/no child steps/);
  });
});

describe("flow-level validation", () => {
  const writeRaw = (body: string) => {
    const path = join(tempDir, "flows", "raw.xml");
    mkdirSync(join(tempDir, "flows"), { recursive: true });
    writeFileSync(path, `<?xml version="1.0"?><flows>${body}</flows>`);
    return path;
  };

  it("rejects a flow with no steps", () => {
    const file = writeRaw(`<flow name="empty"/>`);
    expect(() => loadFlowsFromFile(file)).toThrow(/has no steps/);
  });

  it("rejects duplicate flow names", () => {
    const file = writeRaw(
      `<flow name="dup"><steps><step src="a.ts"/></steps></flow>` +
        `<flow name="dup"><steps><step src="b.ts"/></steps></flow>`
    );
    expect(() => loadFlowsFromFile(file)).toThrow(/Duplicate <flow> name 'dup'/);
  });

  it("rejects a scenario without name or adapter", () => {
    expect(() =>
      loadFlowsFromFile(
        writeRaw(
          `<flow name="f"><scenarios><scenario adapter="x"/></scenarios><steps><step src="a.ts"/></steps></flow>`
        )
      )
    ).toThrow(/<scenario> requires a 'name'/);
    expect(() =>
      loadFlowsFromFile(
        writeRaw(
          `<flow name="f"><scenarios><scenario name="s"/></scenarios><steps><step src="a.ts"/></steps></flow>`
        )
      )
    ).toThrow(/requires an 'adapter'/);
  });

  it("rejects a model without provider or name", () => {
    const file = writeRaw(
      `<flow name="f"><setup><models><model name="m"/></models></setup><steps><step src="a.ts"/></steps></flow>`
    );
    expect(() => loadFlowsFromFile(file)).toThrow(/<model> requires 'provider' and 'name'/);
  });

  it("rejects an env <var> without a name", () => {
    const file = writeRaw(
      `<flow name="f"><setup><env><var value="x"/></env></setup><steps><step src="a.ts"/></steps></flow>`
    );
    expect(() => loadFlowsFromFile(file)).toThrow(/<var> requires a 'name'/);
  });

  it("rejects non-numeric readiness port/timeout", () => {
    const file = writeRaw(
      `<flow name="f"><scenarios><scenario name="s" adapter="tsAdapter"><readiness port="abc"/></scenario></scenarios><steps><step src="a.ts"/></steps></flow>`
    );
    expect(() => loadFlowsFromFile(file)).toThrow(/port must be a number/);
  });
});
