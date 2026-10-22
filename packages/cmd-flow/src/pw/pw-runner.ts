// Playwright-based flow runner — steps run as test.step()s in a
// playwright test worker. Enabled via `--runner pw`.
// Serializes a parsed flow to JSON and runs it through `playwright test`
// (the spec engine is pw-spec.ts). Enabled via `axn-dev flow --runner pw`
// or AXN_FLOW_RUNNER=pw.

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import type { ParsedFlow, ParsedStep, FlowResult } from "@axn-dev/flow-format";
import { evidenceDirFor } from "@axn-dev/flow-format";

interface PwUnit {
  type: string;
  description?: string;
  value?: string;
  src?: string;
  args?: Record<string, string>;
  adapter?: string;
  adapterPath?: string;
  name?: string;
  selector?: string;
  fullPage?: boolean;
  assertions?: { that: string; value: string; description?: string; prompt?: string; judge?: string }[];
  children?: PwUnit[];
  num?: number;
  success?: number;
  attr?: string;
  url?: string;
}

function pwCliPath(): string {
  const require = createRequire(import.meta.url);
  const pkg = JSON.parse(
    readFileSync(require.resolve("@playwright/test/package.json"), "utf-8")
  );
  return join(dirname(require.resolve("@playwright/test/package.json")), pkg.bin?.playwright ?? "cli.js");
}

function toUnit(step: ParsedStep, ctx: {
  flowDir: string;
  runDir: string;
  adapterPathFor: (step: ParsedStep) => string | null;
}): PwUnit {
  const u: PwUnit = {
    type: step.type,
    description: step.description,
    value: step.value,
    args: step.args,
    adapter: step.adapter,
    name: step.name,
    selector: step.selector,
    fullPage: step.fullPage,
    assertions: step.assertions,
    children: step.children?.map((c) => toUnit(c, ctx)),
    num: step.num,
    success: step.success,
    attr: step.attr,
    url: step.url,
  };
  if (step.type === "script" && (!step.adapter || step.adapter === "tsAdapter")) {
    if (step.src) {
      u.src = resolve(ctx.flowDir, step.src);
      if (!existsSync(u.src)) throw new Error(`Script not found: ${u.src}`);
    } else if (step.value) {
      const scriptPath = join(ctx.runDir, `inline-${Math.random().toString(36).slice(2)}.ts`);
      writeFileSync(scriptPath, step.value);
      u.src = scriptPath;
      u.value = undefined;
    }
  }
  if (step.adapter && step.adapter !== "tsAdapter") {
    u.adapterPath = ctx.adapterPathFor(step) ?? undefined;
  }
  return u;
}

export async function runFlowWithPlaywright(opts: {
  flow: ParsedFlow;
  filePath: string;
  baseUrl?: string;
  env: Record<string, string>;
  tsxBin: string;
  adapterPathFor: (step: ParsedStep) => string | null;
}): Promise<FlowResult> {
  const { flow, filePath, baseUrl, env, tsxBin, adapterPathFor } = opts;
  const flowDir = dirname(filePath);
  const start = Date.now();

  const runDir = join(flowDir, ".reports", "pw", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(runDir, { recursive: true });

  const payload = {
    name: flow.name,
    baseUrl,
    env,
    flowDir,
    outFile: join(runDir, "out.json"),
    evidenceDir: evidenceDirFor(filePath, flow.name),
    tsxBin,
    scenario: flow.scenarios[0]
      ? { name: flow.scenarios[0].name, service: flow.scenarios[0].service }
      : undefined,
    messageAdapter: flow.scenarios.find((s) => s.adapter)?.adapter,
    model: flow.models[0],
    units: flow.steps.map((s) => toUnit(s, { flowDir, runDir, adapterPathFor })),
  };

  const payloadFile = join(runDir, "payload.json");
  writeFileSync(payloadFile, JSON.stringify(payload, null, 2));

  const enginePath = fileURLToPath(new URL("./pw-spec.js", import.meta.url));
  writeFileSync(join(runDir, "flow.spec.js"), `import ${JSON.stringify(pathToFileURL(enginePath).href)};\n`);
  writeFileSync(
    join(runDir, "playwright.config.mjs"),
    `export default { testDir: '.', timeout: 600000, reporter: [['json', { outputFile: 'result.json' }], ['list']], use: { headless: true, viewport: { width: 1280, height: 720 } } };\n`
  );

  const resultFile = join(runDir, "result.json");
  const child = spawn(process.execPath, [pwCliPath(), "test", "-c", join(runDir, "playwright.config.mjs")], {
    env: { ...env, AXN_FLOW_JSON: payloadFile },
    cwd: runDir,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const exitCode = await new Promise<number>((res) => child.on("close", (c) => res(c ?? 1)));

  const out = existsSync(payload.outFile)
    ? JSON.parse(readFileSync(payload.outFile, "utf-8"))
    : { outputs: [], evidence: [], steps: [], lastExit: 0 };

  let passed = exitCode === 0;
  let error: string | undefined;
  if (!passed && existsSync(resultFile)) {
    try {
      const report = JSON.parse(readFileSync(resultFile, "utf-8"));
      const errors: string[] = [];
      const walk = (s: any) => {
        for (const spec of s.specs ?? []) {
          for (const t of spec.tests ?? []) {
            for (const r of t.results ?? []) {
              for (const e of r.errors ?? []) errors.push(e.message ?? String(e));
            }
          }
        }
        for (const child2 of s.suites ?? []) walk(child2);
      };
      for (const s of report.suites ?? []) walk(s);
      error = errors.join("\n") || `playwright exited ${exitCode}`;
    } catch {
      error = `playwright exited ${exitCode}`;
    }
  }

  return {
    flow: flow.name,
    model: flow.models[0] ?? { provider: "ts", name: "script" },
    passed,
    error,
    assertions: (out.steps ?? [])
      .filter((s: any) => s.that)
      .map((s: any) => ({
        that: s.that,
        value: s.value ?? "",
        passed: s.passed,
        actual: s.actual ?? s.error,
        description: s.description,
      })),
    response: (out.outputs ?? []).join("\n"),
    evidence: out.evidence,
    durationMs: Date.now() - start,
  };
}
