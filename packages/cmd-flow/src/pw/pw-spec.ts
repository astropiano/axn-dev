// Playwright spec engine — executed by `playwright test` (never imported by
// the CLI). Reads the serialized flow from AXN_FLOW_JSON (path to a JSON
// payload written by pw-runner.ts) and runs each step as a test.step.

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import {
  discoverPlugins,
  pluginFlowAdapters,
  pluginFlowJudges,
  registerFlowAdapter,
  registerFlowJudge,
  flowAdapter,
  hasFlowAdapter,
  type FlowAdapterContext,
} from "@axn-dev/core";
import { evaluateScreenshotAssertion } from "../screenshot.js";
import { evaluateLlmAssertion } from "../llm-judge.js";

interface PwAssertion {
  that: string;
  value: string;
  description?: string;
  prompt?: string;
  judge?: string;
  fresh?: boolean;
  src?: string;
  min?: number;
  max?: number;
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
  children?: PwUnit[]; // video segments / repeat children
  num?: number;
  success?: number;
  attr?: string;
  url?: string;
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
  value?: string;
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
  for (const spec of pluginFlowJudges(pkg)) registerFlowJudge(spec);
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

  // Assertion input boundaries — outputBase: a repeat iteration only sees its
  // own output; assertMark: `fresh` asserts see output since the last assert.
  let outputBase = 0;
  let assertMark = 0;
  const windowText = (a: PwAssertion) => outputs.slice(a.fresh ? assertMark : outputBase).join("\n");
  const evalAssertion = (a: PwAssertion, text?: string, ms?: number): void => {
    const all = text ?? windowText(a);
    switch (a.that) {
      case "contains":
        expect(all, `expected output to contain ${JSON.stringify(a.value)}`).toContain(a.value);
        break;
      case "num_responses": {
        const count = text !== undefined
          ? (text.trim() ? 1 : 0)
          : outputs.length - (a.fresh ? assertMark : outputBase);
        expect(count).toBe(Number(a.value));
        break;
      }
      case "exitCode":
        expect(lastExit).toBe(Number(a.value));
        break;
      case "duration": {
        if (ms === undefined) throw new Error("duration assert needs a step context");
        const max = a.max ?? (a.value.trim() !== "" && !isNaN(Number(a.value)) ? Number(a.value) : undefined);
        const min = a.min;
        const ok = (min === undefined || ms >= min) && (max === undefined || ms <= max);
        expect(ok, `duration ${ms}ms not within min=${min ?? "-"} max=${max ?? "-"}`).toBe(true);
        break;
      }
      default:
        throw new Error(`Unknown assertion '${a.that}' in pw runner`);
    }
  };

  /** Evaluate one assertion — `text` scopes it to a step's own output
   * (nested asserts), `ms` is that step's duration for that="duration". */
  const runAssert = async (a: PwAssertion, text?: string, ms?: number): Promise<void> => {
    const input = text ?? windowText(a);
    if (a.that === "screenshot") {
      const r = await evaluateScreenshotAssertion(a, { flowDir: payload.flowDir, env: payload.env, flowName: payload.name });
      steps.push({ description: a.description, that: a.that, value: a.value, passed: r.passed, actual: r.detail });
      expect(r.passed, r.detail ?? "screenshot assertion failed").toBe(true);
      return;
    }
    if (a.that === "llm") {
      const r = await evaluateLlmAssertion(a, input, payload.env);
      steps.push({ description: a.description, that: a.that, value: a.value, passed: r.passed, actual: r.actual });
      expect(r.passed, r.actual ?? "llm judge failed").toBe(true);
      return;
    }
    if (a.that === "script") {
      const r = await runTsScript(resolve(payload.flowDir, a.src ?? a.value), {
        ...payload.env, AXN_OUTPUT: input, AXN_ASSERT: JSON.stringify(a),
      }, payload.flowDir);
      steps.push({ description: a.description, that: a.that, value: a.value, passed: r.exitCode === 0, actual: r.stdout.trim() || r.stderr.trim() });
      expect(r.exitCode, r.stderr || r.stdout).toBe(0);
      return;
    }
    try {
      evalAssertion(a, text, ms);
      steps.push({ description: a.description, that: a.that, value: a.value, passed: true, actual: a.that === "duration" ? `${ms}ms` : undefined });
    } catch (err) {
      steps.push({
        description: a.description, that: a.that, value: a.value, passed: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };

  const runUnit = async (u: PwUnit, i: number, pg: Page): Promise<void> => {
    if (u.type === "assertions") {
      for (const a of u.assertions ?? []) {
        await test.step(`assert ${a.description ?? `${a.that}=${a.value}`}`, async () => {
          await runAssert(a);
        });
      }
      assertMark = outputs.length;
      return;
    }

    await test.step(describeUnit(u, i), async () => {
      const t0 = Date.now();
      let produced: string | undefined;
      switch (u.type) {
        case "script": {
          if (u.adapter && u.adapter !== "tsAdapter") {
            if (hasFlowAdapter(u.adapter)) {
              const out = await (await flowAdapter(u.adapter)).run(u, adapterCtx(u));
              if (out) { outputs.push(String(out)); produced = String(out); }
              break;
            }
            if (u.adapterPath) {
              const r = await runScriptAdapter(u.adapterPath, u);
              lastExit = r.exitCode;
              if (r.stdout) { outputs.push(r.stdout.trimEnd()); produced = r.stdout.trimEnd(); }
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
          if (out) { outputs.push(String(out)); produced = String(out); }
          break;
        }
        case "message": {
          const adapterName = u.adapter ?? payload.messageAdapter ?? "restAdapter";
          const out = await (await flowAdapter(adapterName)).run(u, adapterCtx(u));
          if (out) { outputs.push(String(out)); produced = String(out); }
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
        case "extract": {
          const attr = u.attr ?? "text";
          const loc = pg.locator(u.selector!);
          const v =
            attr === "text" ? await loc.innerText() :
            attr === "html" ? await loc.innerHTML() :
            attr === "value" ? await loc.inputValue() :
            await loc.getAttribute(attr);
          outputs.push(v ?? "");
          produced = v ?? "";
          break;
        }
        case "repeat": {
          const num = u.num ?? 1;
          const rate = u.success ?? 1;
          const needed = Math.ceil(num * rate);
          let ok = 0;
          const failures: string[] = [];
          for (let i = 0; i < num; i++) {
            if (ok + (num - i) < needed) break;
            const savedBase = outputBase;
            outputBase = outputs.length;
            try {
              await test.step(`repeat run ${i + 1}/${num}`, async () => {
                for (const c of u.children ?? []) await runUnit(c, i, pg);
              });
              ok++;
            } catch (err) {
              failures.push(`run ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
            } finally {
              outputBase = savedBase;
            }
          }
          const passed = ok >= needed;
          steps.push({
            description: u.description, that: "repeat", passed,
            actual: `${ok}/${num}${failures.length ? ` — ${failures.join(" | ")}` : ""}`,
          });
          expect(passed, `repeat needed ${needed}/${num} ok, got ${ok}`).toBe(true);
          break;
        }
        case "video": {
          // Record the live page in place: no second browser context, so page state (an open
          // dialog, a logged-in session) carries into and out of the segment, and steps or
          // pictures after </video> see the page exactly as the recording left it.
          const target = join(payload.evidenceDir, `${slug(u.name ?? "video")}.webm`);
          await pg.screencast.start({ path: target });
          try {
            for (const inner of u.children ?? []) {
              await runUnit(inner, i, pg);
            }
          } finally {
            await pg.screencast.stop();
            await testInfo.attach(u.name ?? "video", { path: target, contentType: "video/webm" });
            evidence.push({ kind: "video", name: u.name ?? "video", path: target, stepIndex: i });
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
          if (out) { outputs.push(String(out)); produced = String(out); }
        }
      }
      // Nested <assert> children — this step is the subject under test.
      for (const a of u.assertions ?? []) {
        await runAssert(a, produced ?? "", Date.now() - t0);
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
