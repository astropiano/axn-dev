import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdirSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { registerFlowJudge } from "@axn-dev/core";
import { FlowCommand } from "./flow.js";

const TMP = join(tmpdir(), "axn-flow-repeat-test-" + process.pid);
const COUNTER = join(TMP, "counter.txt");

/** Script adapter: alternates PASS/FAIL via a counter file (P,F,P,F,…). */
const FLAKY_TS = `
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const f = ${JSON.stringify(COUNTER)};
const n = existsSync(f) ? parseInt(readFileSync(f, "utf-8"), 10) + 1 : 1;
writeFileSync(f, String(n));
console.log(n % 2 === 1 ? "PASS" : "FAIL");
`;

function writeFlow(name: string, inner: string): string {
  const file = join(TMP, name);
  writeFileSync(
    file,
    `<?xml version="1.0"?><flows><flow name="${name.replace(/\.xml$/, "")}"><steps>${inner}</steps></flow></flows>`,
  );
  return file;
}

function latestReport(): any {
  const dir = join(TMP, ".reports");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  return JSON.parse(readFileSync(join(dir, files[files.length - 1]), "utf-8"));
}

function resetCounter() {
  rmSync(COUNTER, { force: true });
  rmSync(join(TMP, ".reports"), { recursive: true, force: true });
}

let judge: Server;
let judgeHits: { prompt: string; response: string }[] = [];
let judgeReply: any = { pass: true };

beforeAll(async () => {
  mkdirSync(TMP, { recursive: true });
  writeFileSync(join(TMP, "flaky.ts"), FLAKY_TS);
  judge = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      judgeHits.push(JSON.parse(body));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(judgeReply));
    });
  });
  await new Promise<void>((r) => judge.listen(0, "127.0.0.1", r));
});
afterAll(async () => {
  await new Promise((r) => judge.close(r));
  rmSync(TMP, { recursive: true, force: true });
});

function judgeUrl() {
  const addr = judge.address();
  return `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/eval`;
}

describe("<repeat> execution", () => {
  it("passes when the success rate is met (P,F,P,F,P → 3/5)", { timeout: 120_000 }, async () => {
    resetCounter();
    const file = writeFlow(
      "repeat-pass.xml",
      `<repeat num="5" success="0.6">
        <step adapter="flaky" src="flaky.ts"/>
        <assertions><assert that="contains" value="PASS"/></assertions>
      </repeat>`
    );
    await new FlowCommand().execute(["-f", file]);
    const flow = latestReport().flows[0];
    expect(flow.passed).toBe(true);
    const rep = flow.assertions.find((a: any) => a.that === "repeat");
    expect(rep).toMatchObject({ passed: true, actual: "3/5" });
    expect(rep.repeat).toMatchObject({ runs: 5, succeeded: 3, needed: 3 });
    expect(rep.repeat.failures).toHaveLength(2);
  });

  it("fails when the rate cannot be reached", { timeout: 120_000 }, async () => {
    resetCounter();
    const file = writeFlow(
      "repeat-fail.xml",
      `<repeat num="4" success="1">
        <step adapter="flaky" src="flaky.ts"/>
        <assertions><assert that="contains" value="PASS"/></assertions>
      </repeat>`
    );
    await expect(new FlowCommand().execute(["-f", file])).rejects.toThrow(/assertions failed/);
    const flow = latestReport().flows[0];
    expect(flow.passed).toBe(false);
    const rep = flow.assertions.find((a: any) => a.that === "repeat");
    expect(rep.passed).toBe(false);
  });
});

describe('that="llm" via a binary judge endpoint', () => {
  it("passes on {pass:true} and posts rubric+response", { timeout: 60_000 }, async () => {
    resetCounter();
    judgeReply = { pass: true };
    judgeHits = [];
    const file = writeFlow(
      "llm-pass.xml",
      `<step adapter="flaky" src="flaky.ts"/>
       <assertions><assert that="llm" prompt="output must say PASS" judge="${"$"}{JUDGE_URL}"/></assertions>`
    );
    process.env.JUDGE_URL = judgeUrl();
    await new FlowCommand().execute(["-f", file]);
    const flow = latestReport().flows[0];
    expect(flow.passed).toBe(true);
    const a = flow.assertions.find((x: any) => x.that === "llm");
    expect(a.passed).toBe(true);
    expect(judgeHits).toHaveLength(1);
    expect(judgeHits[0].prompt).toBe("output must say PASS");
    expect(judgeHits[0].response).toContain("PASS");
  });

  it("fails on {pass:false}", { timeout: 60_000 }, async () => {
    resetCounter();
    judgeReply = { pass: false };
    const file = writeFlow(
      "llm-fail.xml",
      `<step adapter="flaky" src="flaky.ts"/>
       <assertions><assert that="llm" value="any rubric" judge="${judgeUrl()}"/></assertions>`
    );
    await expect(new FlowCommand().execute(["-f", file])).rejects.toThrow(/assertions failed/);
    const flow = latestReport().flows[0];
    const a = flow.assertions.find((x: any) => x.that === "llm");
    expect(a.passed).toBe(false);
  });
});

describe('that="llm" via a plugin-registered judge', () => {
  registerFlowJudge({
    name: "test-judge",
    load: () => async ({ rubric, response, arg }) => ({
      passed: response.includes("PASS"),
      actual: `test-judge${arg ? `/${arg}` : ""} rubric="${rubric}"`,
    }),
  });

  it("routes judge=<name>/<arg> to the registry and records its verdict", { timeout: 60_000 }, async () => {
    resetCounter();
    const file = writeFlow(
      "llm-plugin.xml",
      `<step adapter="flaky" src="flaky.ts"/>
       <assertions><assert that="llm" prompt="says PASS" judge="test-judge/strict"/></assertions>`
    );
    await new FlowCommand().execute(["-f", file]);
    const a = latestReport().flows[0].assertions.find((x: any) => x.that === "llm");
    expect(a.passed).toBe(true);
    expect(a.actual).toContain("test-judge/strict");
  });

  it("unknown judge names surface a helpful error", { timeout: 60_000 }, async () => {
    resetCounter();
    const file = writeFlow(
      "llm-unknown.xml",
      `<step adapter="flaky" src="flaky.ts"/>
       <assertions><assert that="llm" value="x" judge="nonexistent-provider/m"/></assertions>`
    );
    await expect(new FlowCommand().execute(["-f", file])).rejects.toThrow(/Unknown judge provider|assertions failed/);
  });
});
