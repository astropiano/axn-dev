// Playwright spec engine — executed by `playwright test` (never imported by
// the CLI). Reads the serialized flow from AXN_FLOW_JSON (path to a JSON
// payload written by pw-runner.ts) and runs each step as a test.step.

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import {
  discoverPlugins,
  pluginFlowAdapters,
  registerFlowAdapter,
  flowAdapter,
  hasFlowAdapter,
  type FlowAdapterContext,
} from "@axn-dev/core";
import { evaluateScreenshotAssertion } from "../screenshot.js";

interface PwAssertion {
  that: string;
  value: string;
  description?: string;
}

interface PwUnit {
  type: string;
  description?: string;
  value?: string;
  src?: string; // absolute path for script steps
  args?: Record<string, string>;
  adapter?: string;
  adapterPath?: string; // resolved script-file adapter path
  name?: string;
  selector?: string;
  fullPage?: boolean;
  assertions?: PwAssertion[];
  children?: PwUnit[]; // video segments
}

interface PwPayload {
  name: string;
  baseUrl?: string;
  env: Record<string, string>;
  flowDir: string;
  outFile: string;
  evidenceDir: string;
  tsxBin?: string;
  scenario?: { name: string; service?: string };
  messageAdapter?: string;
  model?: { provider: string; name: string };
  units: PwUnit[];
}

interface StepOutcome {
  description?: string;
  that?: string;
  passed: boolean;
  actual?: string;
  error?: string;
}

const payloadPath = process.env.AXN_FLOW_JSON;
if (!payloadPath) throw new Error("AXN_FLOW_JSON env var is required");
const payload = JSON.parse(readFileSync(payloadPath, "utf-8")) as PwPayload;

// Register plugin flow adapters in the worker — spec objects carry load()
// closures, so discovery must run in-process (same roots as the CLI).
const pkgDir = join(fileURLToPath(import.meta.url), "..", "..", "..");
for (const pkg of discoverPlugins([join(pkgDir, "..")])) {
  for (const spec of pluginFlowAdapters(pkg)) registerFlowAdapter(spec);
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "artifact";

function describeUnit(u: PwUnit, i: number): string {
  const label = u.type === "message" ? "usermessage" : u.type;
  return u.description
    ? `[${label}] ${u.description}`
    : `[${label}] ${u.name ?? u.src ?? u.value?.slice(0, 60) ?? `step ${i + 1}`}`;
}

test(payload.name, async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  const outputs: string[] = [];
  const evidence: { kind: string; name: string; path: string; stepIndex?: number }[] = [];
  const steps: StepOutcome[] = [];
  let lastExit = 0;
  let evidenceCounter = 0;
  mkdirSync(payload.evidenceDir, { recursive: true });

  const adapterCtx = (unit: PwUnit): FlowAdapterContext => ({
    env: payload.env,
    flowDir: payload.flowDir,
    cwd: process.cwd(),
    flowName: payload.name,
    flow: payload as unknown as FlowAdapterContext["flow"],
    scenario: payload.scenario as FlowAdapterContext["scenario"],
    model: payload.model,
    baseUrl: payload.baseUrl,
    runScript: (path, scriptEnv, cwd) => runTsScript(path, scriptEnv ?? payload.env, cwd ?? payload.flowDir),
    log: (m) => console.log(`    ${m}`),
  });

  const runTsScript = (
    scriptPath: string,
    env: Record<string, string>,
    cwd: string
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> =>
    new Promise((resolveRun, reject) => {
      const child = spawn(process.execPath, [payload.tsxBin!, scriptPath], {
        env, cwd, stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) =>
        resolveRun({ exitCode: code ?? 1, stdout, stderr }));
    });

  const evalAssertion = (a: PwAssertion): void => {
    const all = outputs.join("\n");
    switch (a.that) {
      case "contains":
        expect(all, `expected output to contain ${JSON.stringify(a.value)}`).toContain(a.value);
        break;
      case "num_responses":
        expect(outputs.length).toBe(Number(a.value));
        break;
      case "exitCode":
        expect(lastExit).toBe(Number(a.value));
        break;
      default:
        throw new Error(`Unknown assertion '${a.that}' in pw runner`);
    }
  };

  const runUnit = async (u: PwUnit, i: number, pg: Page): Promise<void> => {
    if (u.type === "assertions") {
      for (const a of u.assertions ?? []) {
        await test.step(`assert ${a.description ?? `${a.that}=${a.value}`}`, async () => {
          if (a.that === "screenshot") {
            const r = await evaluateScreenshotAssertion(a, { flowDir: payload.flowDir, env: payload.env, flowName: payload.name });
            steps.push({ description: a.description, that: a.that, passed: r.passed, actual: r.detail });
            expect(r.passed, r.detail ?? "screenshot assertion failed").toBe(true);
            return;
          }
          try {
            evalAssertion(a);
            steps.push({ description: a.description, that: a.that, passed: true });
          } catch (err) {
            steps.push({
              description: a.description, that: a.that, passed: false,
              error: err instanceof Error ? err.message : String(err),
            });
            throw err;
          }
        });
      }
      return;
    }

    await test.step(describeUnit(u, i), async () => {
      switch (u.type) {
        case "script": {
          if (u.adapter && u.adapter !== "tsAdapter") {
            if (hasFlowAdapter(u.adapter)) {
              const out = await (await flowAdapter(u.adapter)).run(u, adapterCtx(u));
              if (out) outputs.push(String(out));
              break;
            }
            if (u.adapterPath) {
              const r = await runScriptAdapter(u.adapterPath, u);
              lastExit = r.exitCode;
              if (r.stdout) outputs.push(r.stdout.trimEnd());
              expect(r.exitCode, r.stderr || r.stdout).toBe(0);
              break;
            }
            throw new Error(`Adapter '${u.adapter}' is neither a plugin adapter nor resolvable to a script file`);
          }
          const mod = await import(pathToFileURL(u.src!).href);
          if (typeof mod.default !== "function") {
            throw new Error(`Step at ${u.src} does not export a default function`);
          }
          const out = await mod.default(pg, payload.baseUrl, u.args ?? {});
          if (out) outputs.push(String(out));
          break;
        }
        case "message": {
          const adapterName = u.adapter ?? payload.messageAdapter ?? "restAdapter";
          const out = await (await flowAdapter(adapterName)).run(u, adapterCtx(u));
          if (out) outputs.push(String(out));
          break;
        }
        case "picture": {
          const fileName = `${String(evidenceCounter++).padStart(3, "0")}-${slug(u.name ?? "picture")}.png`;
          const artifactPath = join(payload.evidenceDir, fileName);
          if (u.selector) {
            await pg.locator(u.selector).screenshot({ path: artifactPath });
          } else {
            await pg.screenshot({ path: artifactPath, fullPage: u.fullPage });
          }
          await testInfo.attach(u.name ?? fileName, { path: artifactPath, contentType: "image/png" });
          evidence.push({ kind: "picture", name: u.name ?? fileName, path: artifactPath, stepIndex: i });
          break;
        }
        case "video": {
          const browser = pg.context().browser();
          if (!browser) throw new Error("<video> needs a browser page");
          const ctx2 = await browser.newContext({
            recordVideo: { dir: payload.evidenceDir },
            storageState: await pg.context().storageState(),
          });
          const vpage = await ctx2.newPage();
          const currentUrl = pg.url();
          if (currentUrl && currentUrl !== "about:blank") {
            await vpage.goto(currentUrl).catch(() => {});
          }
          try {
            for (const inner of u.children ?? []) {
              await runUnit(inner, i, vpage);
            }
          } finally {
            const video = vpage.video();
            await ctx2.close();
            if (video) {
              const target = join(payload.evidenceDir, `${slug(u.name ?? "video")}.webm`);
              await video.saveAs(target);
              await testInfo.attach(u.name ?? "video", { path: target, contentType: "video/webm" });
              evidence.push({ kind: "video", name: u.name ?? "video", path: target, stepIndex: i });
            }
          }
          break;
        }
        default: {
          // Custom step tag — dispatched to the adapter declaring the tag.
          const adapterName = u.adapter ?? u.type;
          if (!hasFlowAdapter(adapterName)) {
            throw new Error(`No adapter found for <${u.type}> — install a plugin adapter declaring the tag`);
          }
          const out = await (await flowAdapter(adapterName)).run(u, adapterCtx(u));
          if (out) outputs.push(String(out));
        }
      }
    });
  };

  const runScriptAdapter = (
    adapterPath: string,
    u: PwUnit
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> =>
    new Promise((resolveRun, reject) => {
      const child = spawn(process.execPath, [payload.tsxBin!, adapterPath], {
        env: { ...payload.env, AXN_STEP: JSON.stringify(u), AXN_FLOW_DIR: payload.flowDir },
        cwd: payload.flowDir,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => resolveRun({ exitCode: code ?? 1, stdout, stderr }));
    });

  try {
    if (payload.baseUrl) {
      await page.goto(payload.baseUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    }
    for (const [i, u] of payload.units.entries()) {
      await runUnit(u, i, page);
    }
  } finally {
    writeFileSync(
      payload.outFile,
      JSON.stringify({ outputs, evidence, steps, lastExit }, null, 2)
    );
  }
});
