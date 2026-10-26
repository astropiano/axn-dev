import { describe, expect, it } from "vitest";
import { toJUnitXml } from "./junit.js";
import type { FlowResult } from "./flow-util.js";

describe("toJUnitXml", () => {
  it("emits one testsuite per flow result and a testcase per assertion", () => {
    const results: FlowResult[] = [
      {
        flow: "smoke",
        model: { provider: "ts", name: "script" },
        passed: false,
        durationMs: 1500,
        assertions: [
          { that: "contains", value: "hello", passed: true },
          { that: "exitCode", value: "0", passed: false, actual: "1" },
        ],
      },
      {
        flow: "lint",
        model: { provider: "ollama", name: "llama3.1" },
        passed: true,
        durationMs: 200,
        assertions: [{ that: "num_responses", value: "1", passed: true }],
      },
    ];
    const xml = toJUnitXml(results);
    expect(xml).toContain('<testsuites tests="3" failures="1">');
    expect(xml).toContain('<testsuite name="smoke :: ts/script" tests="2" failures="1" time="1.500">');
    expect(xml).toContain('<testcase name="contains=hello" classname="smoke :: ts/script"/>');
    expect(xml).toContain('<testcase name="exitCode=0" classname="smoke :: ts/script">\n      <failure>1</failure>');
    expect(xml).toContain('<testsuite name="lint :: ollama/llama3.1" tests="1" failures="0" time="0.200">');
  });

  it("reports a synthetic run testcase for flows that errored without assertions", () => {
    const xml = toJUnitXml([
      {
        flow: "boom & <busted>",
        model: { provider: "ts", name: "script" },
        passed: false,
        error: "scenario failed to start",
        assertions: [],
      },
    ]);
    expect(xml).toContain('<testsuites tests="1" failures="1">');
    expect(xml).toContain('name="boom &amp; &lt;busted&gt; :: ts/script"');
    expect(xml).toContain('<testcase name="run" classname="boom &amp; &lt;busted&gt; :: ts/script">\n      <failure>scenario failed to start</failure>');
  });
});
