/**
 * JUnit XML serialization of flow results — lets CI systems (GitLab
 * artifacts:reports:junit, GitHub, Jenkins, …) render per-assertion test
 * results. Each flow×model result becomes a testsuite, each assertion a
 * testcase. A flow that errored before producing assertions reports a
 * single "run" testcase carrying the error.
 */

import type { AssertionResult, FlowResult } from "./flow-util.js";

const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

function testcaseXml(a: AssertionResult, classname: string): string {
  const name = `${a.that}${a.value ? `=${a.value}` : ""}`;
  const open = `    <testcase name="${esc(name)}" classname="${esc(classname)}"`;
  if (a.passed) return `${open}/>`;
  const detail =
    a.actual ??
    (a.repeat ? a.repeat.failures.join("\n") : undefined) ??
    "assertion failed";
  return `${open}>\n      <failure>${esc(detail)}</failure>\n    </testcase>`;
}

/** Serialize flow results as a JUnit <testsuites> document. */
export function toJUnitXml(results: FlowResult[]): string {
  let totalTests = 0;
  let totalFailures = 0;
  const suites = results.map((r) => {
    const suiteName = `${r.flow} :: ${r.model.provider}/${r.model.name}`;
    const cases: AssertionResult[] =
      r.assertions.length > 0
        ? r.assertions
        : [{ that: "run", value: "", passed: r.passed, actual: r.error }];
    const failures = cases.filter((a) => !a.passed).length;
    totalTests += cases.length;
    totalFailures += failures;
    const time = ((r.durationMs ?? 0) / 1000).toFixed(3);
    const body = cases.map((a) => testcaseXml(a, suiteName)).join("\n");
    return `  <testsuite name="${esc(suiteName)}" tests="${cases.length}" failures="${failures}" time="${time}">\n${body}\n  </testsuite>`;
  });
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites tests="${totalTests}" failures="${totalFailures}">\n` +
    `${suites.join("\n")}\n</testsuites>\n`
  );
}
