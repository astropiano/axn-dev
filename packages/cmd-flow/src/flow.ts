import type { Command } from "@axn-dev/core";
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

import { StartCommand } from "@axn-dev/core";
import { StopCommand } from "@axn-dev/core";
import { CleanCommand } from "@axn-dev/core";
import { ScenarioDiscoveryService, resolveDeviceEnv } from "@axn-dev/core";
import { getServiceEndpoints, getRunningScenarioPort, isScenarioRunning, resolveEndpoints, type ServiceEndpoint } from "@axn-dev/core";
import { loadWorkspaceConfig, parseYaml } from "@axn-dev/core";
import {
  flowAdapter,
  flowAdaptersForTag,
  flowAdapterSpecs,
  hasFlowAdapter,
  type FlowAdapterContext,
  type FlowAdapterStep,
} from "@axn-dev/core";
import { loadFlowsFromFile, discoverAllFlows, writeFlowReport, evidenceDirFor, normalizeRunnerName, type FlowInfo } from "@axn-dev/flow-format";
import type {
  ParsedFlow,
  ParsedScenario,
  ParsedModel,
  ParsedAssertion,
  ParsedReadiness,
  ParsedStep,
  FlowResult,
  AssertionResult,
  EvidenceArtifact,
} from "@axn-dev/flow-format";
import { ManualFlowRunner } from "@axn-dev/flow-format";
import { evaluateScreenshotAssertion } from "./screenshot.js";
import { AdapterRegistry } from "./adapters/adapterRegistry.js";
import { loadAxnDevConfig, configSection } from "@axn-dev/core";
import { listFlowFiles } from "@axn-dev/flow-format";
import { runFlowWithPlaywright } from "./pw/pw-runner.js";

const FLOW_FLAGS = [
  "--file", "-f", "--model", "-m", "--filter", "-t", "--suite",
  "--no-stop", "--no-build", "--clean-start", "--manual", "--adapter",
  "--report", "--report-format", "--scenario", "-s", "--project", "-p",
  "--infra", "-i", "--global", "-g", "--workbase", "--auto-port",
  "--port", "--pwd", "-c", "--yes", "-y", "-B", "--runner", "--help", "-h",
];

export class FlowCommand implements Command {
  readonly name = "flow";
  readonly description = "Run XML-defined agentic flow tests against scenarios";

  complete(words: string[]): string[] {
    const prev = words[words.length - 2] ?? "";
    const cur = words[words.length - 1] ?? "";
    const valueFlag = cur === "-f" || cur === "--file";
    if (prev === "-f" || prev === "--file" || valueFlag) {
      return listFlowFiles(valueFlag ? "" : cur);
    }
    return FLOW_FLAGS.filter((f) => f.startsWith(cur) && f !== cur);
  }

  private _resolvedFilePath: string | null = null;
  private runnerMode: string | null = process.env.AXN_FLOW_RUNNER ?? null;
  private adapterRegistry: AdapterRegistry | null = null;
  private orchestratorProcesses = new Map<string, OrchestratorProcess>();

  help(): string {
    return `
axn-dev flow [list] -f <file> [-m <model>] [-t <flow-name>]

Run XML flow tests against Docker Compose scenarios.

Subcommands:
  list                    List all discovered flows (global + project repos)
  list-adapters           List registered flow adapters (plugin-contributed)

Options:
  -f, --file <path>       Path to the XML flow file (required)
  -m, --model <model>     Run only the specified model (e.g. llama3.1:latest)
  -t, --filter <name>     Run only flows whose name contains the given string
  -i, --infra <device>    Run the flow against a deployed device (tsAdapter only)
  -p, --port <port>       Single-port scenario: override the SCENARIO_PORT
  --auto-port             Resolve port conflicts by picking a free port from the configured range
  --adapter <name=path>   Register a custom adapter for this run (overrides config)
  --manual                Run the flow manually: show each step/assertion and
                          prompt for pass/fail verdicts, then write a report
  --clean-start           Stop and remove volumes before starting the flow
  -y, --yes               Skip confirmation prompts (for --clean-start)
  --no-stop               Do not stop scenarios after the run
  --runner <axn|pw>       Execution engine override: 'axn' (default) runs steps
                          through the orchestrator/script engine; 'pw' runs the
                          flow as a Playwright spec (test.step()s, traces,
                          standard reporters). Overrides the flow's runner=
                          attribute; AXN_FLOW_RUNNER does the same.
  -h, --help              Show this help

Flow XML:
  <flow runner="axn|pw">  selects the execution engine for that flow;
                          <flows runner="pw"> sets the file-level default.
                          Note: runner= on a <step> is display metadata only
                          (serve UI) — it does not select an engine per step.

Reusable step files:
  A .xml file containing exactly one step element (e.g. steps/login.xml
  holding <step src="ft-login.ts"/>) can be bound from any flow:
  <step action="login"/>          finds login.xml in the flow dir, steps/,
                                  and dirs listed via include="a,b" on
                                  <flows>, <flow> or <steps>
  <step file="steps/login.xml"/>  explicit path relative to the flow file
  Ambiguous names fail with a hint to use file=. Extra attributes on the
  referencing step merge into the bound step's args (caller wins).

Adapters decide how steps run:
  tsAdapter               Built-in: execute a TypeScript/Playwright script
                          against a service (default for <step>/<script>)
  <name>                  Plugin adapters registered via axn-dev.flowAdapters
                          in a plugin package's manifest (e.g. 'axn-dev flow
                          list-adapters'). Custom step tags like <my-tag> are
                          dispatched to the adapter declaring that tag.
  <name>=<path>           Script-file adapters: run via tsx with the step
                          passed as AXN_STEP JSON in process.env. Resolved in
                          order: --adapter <name=path>, 'adapters:' in
                          .axn-dev/config.yaml, the step's src attribute,
                          then adapters/<name>.ts|.js next to the flow file.

Assertions:
  <assert that="contains|num_responses|exitCode|screenshot" .../>
  that="screenshot"         Capture the page (or the 'selector' element) at 'url'
                          (default: BASE_URL) with headless Chromium and compare
                          it against the reference PNG at 'value' (relative to
                          the flow file). Antialiasing is tolerated; layout and
                          shape changes fail. An element capture is cropped to
                          the element — select a container element (or omit
                          'selector') to also catch position changes. Extra
                          attributes:
                          selector="css" fullPage="true" maxDiff="0.02"
                          threshold="0.1" viewport="1280x800" wait="500|css".
                          Diffs land in flows/.reports/screenshots/.
                          AXN_FLOW_UPDATE_SCREENSHOTS=1 rewrites the reference.

Examples:
  axn-dev flow -f flows/example.xml
  axn-dev flow -f flows/example.xml -m llama3.1:latest
  axn-dev flow -f flows/example.xml -t "app loads"
  axn-dev flow -f flows/example.xml -t "app loads" --manual
`;
  }

  async execute(args: string[]): Promise<void> {
    if (args[0] === "list") {
      this.listFlows();
      return;
    }

    if (args[0] === "list-adapters") {
      this.listAdapters();
      return;
    }

    let filePath: string | null = null;
    let modelFilter: string | null = null;
    let flowFilter: string | null = null;
    let infra: string | null = null;
    const adapterOverrides: Record<string, string> = {};
    let autoPort = false;
    let portFlag: number | null = null;
    let stopAfter = true;
    let cleanStart = false;
    let yes = false;
    let manual = false;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-f" || arg === "--file") {
        filePath = args[++i];
        if (!filePath) throw new Error("--file requires a value");
      } else if (arg === "-m" || arg === "--model") {
        modelFilter = args[++i];
        if (!modelFilter) throw new Error("--model requires a value");
      } else if (arg === "-t" || arg === "--filter") {
        flowFilter = args[++i];
        if (!flowFilter) throw new Error("--filter requires a value");
      } else if (arg === "-i" || arg === "--infra") {
        infra = args[++i];
        if (!infra) throw new Error("--infra requires a value");
      } else if (arg === "--runner") {
        this.runnerMode = normalizeRunnerName(args[++i]) ?? null;
        if (!this.runnerMode) throw new Error("--runner requires a value");
      } else if (arg === "--adapter") {
        const adapterArg = args[++i];
        if (!adapterArg) throw new Error("--adapter requires a value");
        const eq = adapterArg.indexOf("=");
        if (eq <= 0 || eq === adapterArg.length - 1) {
          throw new Error("--adapter value must be in the form <name>=<path>");
        }
        const name = adapterArg.slice(0, eq);
        const path = adapterArg.slice(eq + 1);
        adapterOverrides[name] = resolve(path);
      } else if (arg === "--port" || arg === "-p") {
        const value = args[++i];
        const parsed = value ? parseInt(value, 10) : NaN;
        if (isNaN(parsed) || parsed <= 0 || parsed > 65535) {
          throw new Error("--port requires a valid port number (1-65535)");
        }
        portFlag = parsed;
      } else if (arg === "--auto-port") {
        autoPort = true;
      } else if (arg === "--no-stop") {
        stopAfter = false;
      } else if (arg === "--manual") {
        manual = true;
      } else if (arg === "--clean-start") {
        cleanStart = true;
      } else if (arg === "--yes" || arg === "-y") {
        yes = true;
      } else if (arg === "-h" || arg === "--help") {
        console.log(this.help());
        return;
      }
    }

    if (!filePath) {
      throw new Error("--file is required. Run 'axn-dev flow --help' for examples.");
    }

    const axnConfig = loadAxnDevConfig();
    this.adapterRegistry = new AdapterRegistry(
      configSection<Record<string, string>>(axnConfig, "adapters") ?? {},
      adapterOverrides,
    );

    this._resolvedFilePath = resolve(process.cwd(), filePath);
    const flows = loadFlowsFromFile(this._resolvedFilePath);
    const selectedFlows = flowFilter
      ? flows.filter((f) => f.name.toLowerCase().includes(flowFilter.toLowerCase()))
      : flows;

    if (selectedFlows.length === 0) {
      throw new Error(`No flows matched filter '${flowFilter}'`);
    }

    if (manual) {
      if (selectedFlows.length > 1) {
        throw new Error("--manual requires a single flow; use -t to select one");
      }
      if (infra) {
        throw new Error("--manual cannot be used with --infra");
      }
      if (cleanStart) {
        throw new Error("--manual cannot be used with --clean-start");
      }

      const flow = selectedFlows[0];
      const startedScenarios = new Set<string>();

      try {
        if (flow.scenarios.length > 0) {
          const startScenario = await this.confirm(
            `Start scenario(s) automatically for manual run? [y/N] `
          );
          if (startScenario) {
            for (const scenario of flow.scenarios) {
              await this.prepareScenario(scenario, flow, startedScenarios, autoPort, portFlag);
              console.log(`Scenario '${scenario.name}' is ready.`);
            }
          } else {
            console.log("Continuing manual run without starting scenarios.");
          }
        }

        const runner = new ManualFlowRunner(flow, this._resolvedFilePath);
        const result = await runner.runInteractive();
        if (!result.passed) {
          throw new Error("Manual flow did not pass");
        }
      } finally {
        if (stopAfter) {
          for (const scenario of startedScenarios) {
            try {
              await new StopCommand().execute(["-s", scenario]);
            } catch (err) {
              console.error(`\x1b[33mWarning: failed to stop scenario '${scenario}': ${err instanceof Error ? err.message : err}\x1b[0m`);
            }
          }
        }
      }
      return;
    }

    if (cleanStart && infra) {
      throw new Error("--clean-start cannot be used with --infra");
    }

    if (cleanStart) {
      const scenarioNames = new Set<string>();
      for (const flow of selectedFlows) {
        for (const scenario of flow.scenarios) {
          scenarioNames.add(scenario.name);
        }
      }
      if (scenarioNames.size > 0 && !yes) {
        const confirmed = await this.confirm(
          `This will wipe all data for the scenario(s) used by this flow. Continue? [y/N] `
        );
        if (!confirmed) {
          console.log("Aborted.");
          return;
        }
      }
      for (const name of scenarioNames) {
        await new CleanCommand().execute(["-s", name, "-y"]);
      }
    }

    const startedScenarios = new Set<string>();
    const results: FlowResult[] = [];

    try {
      for (const flow of selectedFlows) {
        const flowResults = await this.runFlow(flow, modelFilter, startedScenarios, infra, autoPort, portFlag);
        results.push(...flowResults);
      }
    } finally {
      for (const [key, proc] of this.orchestratorProcesses) {
        try {
          await proc.stop();
        } catch (err) {
          console.error(`\x1b[33mWarning: failed to stop orchestrator for '${key}': ${err instanceof Error ? err.message : err}\x1b[0m`);
        }
      }
      this.orchestratorProcesses.clear();

      if (stopAfter) {
        for (const scenario of startedScenarios) {
          try {
            await new StopCommand().execute(["-s", scenario]);
          } catch (err) {
            console.error(`\x1b[33mWarning: failed to stop scenario '${scenario}': ${err instanceof Error ? err.message : err}\x1b[0m`);
          }
        }
      }
    }

    if (this._resolvedFilePath) {
      writeFlowReport(this._resolvedFilePath, results);
    }
    this.printSummary(results);

    if (results.some((r) => !r.passed)) {
      throw new Error("One or more flow assertions failed");
    }
  }

  private listAdapters(): void {
    const specs = flowAdapterSpecs();
    console.log("Built-in:");
    console.log("  tsAdapter            script engine (tsx subprocess, orchestrator batching)");
    if (specs.length === 0) {
      console.log("\nNo plugin flow adapters registered.");
      console.log("Install one via 'axn-dev install --plugin <pkg>' (axn-dev.flowAdapters manifest).");
      return;
    }
    console.log("\nPlugin adapters:");
    for (const s of specs) {
      const tags = s.tags.length ? `tags: ${s.tags.join(", ")}` : "by name only";
      const ext = s.extends ? `, extends ${s.extends}` : "";
      const scen = s.wantsScenario ? ", starts scenario" : "";
      console.log(`  ${s.name.padEnd(20)} ${tags}${ext}${scen}`);
    }
  }

  private printFlow(f: FlowInfo, indent: string = "  "): void {
    const adapters = f.adapters.length > 0 ? ` [${f.adapters.join(", ")}]` : "";
    const desc = f.description ? ` — ${f.description}` : "";
    console.log(`${indent}${f.name.padEnd(44)} ${f.fileName}${adapters}${desc}`);
  }

  private listFlows(): void {
    const config = new ScenarioDiscoveryService(process.cwd()).getConfig();
    const flows = discoverAllFlows(config);

    const globalFlows = flows.filter((f) => f.scope === "global");
    const projectFlows = flows.filter((f) => f.scope === "project");

    if (globalFlows.length === 0 && projectFlows.length === 0) {
      console.log("No flows found. Add flows/*.xml to an integration repo or a configured repo.");
      return;
    }

    if (globalFlows.length > 0) {
      console.log("Global flows:");
      for (const f of globalFlows) this.printFlow(f);
      console.log("");
    }

    if (projectFlows.length > 0) {
      console.log("Project flows:");
      const byRepo = new Map<string, FlowInfo[]>();
      for (const f of projectFlows) {
        const list = byRepo.get(f.rootName) ?? [];
        list.push(f);
        byRepo.set(f.rootName, list);
      }
      for (const [repo, repoFlows] of [...byRepo.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        console.log(`  ${repo}:`);
        for (const f of repoFlows) this.printFlow(f, "    ");
      }
    }
  }

  private async runFlow(
    flow: ParsedFlow,
    modelFilter: string | null,
    startedScenarios: Set<string>,
    infra: string | null = null,
    autoPort = false,
    portFlag: number | null = null
  ): Promise<FlowResult[]> {
    const tsScenario = flow.scenarios.find((s) => s.adapter === "tsAdapter");
    if (tsScenario) {
      return [await this.runTsAdapterFlow(flow, tsScenario, startedScenarios, infra, autoPort, portFlag)];
    }

    const hasCustomAdapterStep = flow.steps.some(
      (s) =>
        // <script adapter="x"> routed to a non-message adapter (plugin or file)
        (s.type === "script" &&
          !!s.adapter &&
          s.adapter !== "tsAdapter" &&
          !this.servesMessage(s.adapter)) ||
        // custom step tags dispatch to the adapter owning the tag
        (s.type !== "script" && s.type !== "message" && s.type !== "assertions")
    );
    if (hasCustomAdapterStep) {
      return [await this.runCustomAdapterFlow(flow)];
    }

    if (infra) {
      throw new Error("--infra is currently only supported with tsAdapter flows");
    }

    const models = modelFilter
      ? flow.models.filter((m) => m.name === modelFilter || `${m.provider}/${m.name}` === modelFilter)
      : flow.models;

    if (models.length === 0) {
      throw new Error(`No matching model for flow '${flow.name}'`);
    }

    // The scenario adapter must be a registered plugin adapter serving
    // <usermessage> (e.g. restAdapter, cliAdapter).
    const msgScenario = flow.scenarios.find((s) => this.servesMessage(s.adapter));

    if (!msgScenario) {
      const serving = flowAdaptersForTag("usermessage").map((a) => a.name);
      throw new Error(
        `Flow '${flow.name}' has no scenario adapter serving <usermessage>. ` +
          `Registered: ${serving.join(", ") || "(none)"}. ` +
          `Install a plugin package declaring one via axn-dev.flowAdapters.`,
      );
    }

    const messageStep = flow.steps.find((s) => s.type === "message");
    const message = messageStep?.value || flow.userMessage;
    if (!message) {
      throw new Error(`Flow '${flow.name}' is missing <usermessage>`);
    }

    const results: FlowResult[] = [];

    for (const model of models) {
      const start = Date.now();
      const flowResult: FlowResult = {
        flow: flow.name,
        model,
        passed: false,
        assertions: [],
        durationMs: 0,
      };

      try {
        const activeScenario = msgScenario;
        const effectiveStep = messageStep ?? { type: "message" as const, value: message };
        const response = await this.runMessageStep(flow, effectiveStep, model, activeScenario, startedScenarios, null, undefined, undefined, autoPort, portFlag);

        flowResult.response = response;

        const assertCtx = {
          flowDir: dirname(this._resolvedFilePath!),
          env: this.expandEnvVars({ ...(process.env as Record<string, string>), ...flow.env }),
          flowName: flow.name,
        };
        for (const assertion of flow.assertions) {
          const result = await this.evaluateAssertion(assertion, response, undefined, assertCtx);
          flowResult.assertions.push(result);
        }

        flowResult.passed = flowResult.assertions.every((a) => a.passed);
      } catch (err) {
        flowResult.error = err instanceof Error ? err.message : String(err);
      }

      flowResult.durationMs = Date.now() - start;
      results.push(flowResult);
    }

    return results;
  }

  private async runCustomAdapterFlow(flow: ParsedFlow): Promise<FlowResult> {
    const start = Date.now();
    const flowResult: FlowResult = {
      flow: flow.name,
      model: { provider: "custom", name: "adapter" },
      passed: false,
      assertions: [],
      durationMs: 0,
    };

    try {
      const env: Record<string, string> = this.expandEnvVars({
        ...(process.env as Record<string, string>),
        ...flow.env,
      });
      let allStdout = "";
      let lastExitCode = 0;
      let stopFlow = false;

      for (const step of flow.steps) {
        if (stopFlow) break;
        if (step.type === "picture" || step.type === "video") {
          throw new Error(
            `<${step.type}> evidence requires a browser orchestrator (tsAdapter) — ` +
              `adapter '${step.adapter ?? "custom"}' steps cannot capture evidence`
          );
        }
        if (
          (step.type === "script" &&
            !!step.adapter &&
            step.adapter !== "tsAdapter" &&
            !this.servesMessage(step.adapter)) ||
          (step.type !== "script" && step.type !== "message" && step.type !== "assertions")
        ) {
          const response = await this.runCustomAdapterStep(flow, step, env);
          allStdout += (allStdout ? "\n" : "") + response;
        } else if (step.type === "assertions") {
          const assertCtx = {
            flowDir: dirname(this._resolvedFilePath!),
            env,
            flowName: flow.name,
          };
          for (const a of step.assertions ?? []) {
            const result = await this.evaluateAssertion(a, allStdout, lastExitCode, assertCtx);
            flowResult.assertions.push(result);
            if (!result.passed) stopFlow = true;
          }
        }
      }

      flowResult.response = allStdout;
      flowResult.passed = flowResult.assertions.every((a) => a.passed);
      if (!flowResult.passed && !flowResult.error) {
        flowResult.error = "One or more assertions failed";
      }
    } catch (err) {
      flowResult.error = err instanceof Error ? err.message : String(err);
    }

    flowResult.durationMs = Date.now() - start;
    return flowResult;
  }

  private async runTsAdapterFlow(
    flow: ParsedFlow,
    scenario: ParsedScenario,
    startedScenarios: Set<string>,
    infra: string | null = null,
    autoPort = false,
    portFlag: number | null = null
  ): Promise<FlowResult> {
    const start = Date.now();
    const flowResult: FlowResult = {
      flow: flow.name,
      model: { provider: "ts", name: "script" },
      passed: false,
      assertions: [],
      durationMs: 0,
    };

    const tmpDirs: string[] = [];
    const pendingEvidence: EvidenceArtifact[] = [];

    try {
      let baseUrl: string;
      let env: Record<string, string>;

      if (infra) {
        const deviceEnv = await this.buildDeviceEnv(infra);
        baseUrl = deviceEnv.BASE_URL;
        await this.waitForProbe(baseUrl, "GET", "ok", 120000);
        env = this.expandEnvVars({ ...deviceEnv, ...flow.env });
      } else {
        const prepared = await this.prepareScenario(scenario, flow, startedScenarios, autoPort, portFlag);
        baseUrl = prepared.baseUrl;
        await this.waitForReadiness(scenario, prepared.scenarioPath, prepared.env, prepared.endpoints);
        env = this.expandEnvVars({ ...prepared.env, ...flow.env, BASE_URL: baseUrl });
      }

      const flowDir = dirname(this._resolvedFilePath!);

      // Execution engine: --runner / AXN_FLOW_RUNNER override the flow's own
      // runner= attribute (<flow runner="pw"> or <flows runner="pw">);
      // default is the axn orchestrator engine. 'pw' runs steps as
      // test.step()s in a PW worker (traces, retries, standard reporters).
      const runner = normalizeRunnerName(this.runnerMode) ?? flow.runner ?? "axn";
      if (runner === "pw") {
        const adapterPathFor = (step: ParsedStep): string | null => {
          if (!step.adapter) return null;
          const registered = this.adapterRegistry?.resolve(step.adapter) ?? null;
          const candidates = [
            registered?.path ?? null,
            step.src ? resolve(flowDir, step.src) : null,
            resolve(flowDir, "adapters", `${step.adapter}.ts`),
            resolve(flowDir, "adapters", `${step.adapter}.js`),
          ];
          return candidates.find((p) => p && existsSync(p)) ?? null;
        };
        return await runFlowWithPlaywright({
          flow,
          filePath: this._resolvedFilePath!,
          baseUrl,
          env,
          tsxBin: this.resolveTsx(),
          adapterPathFor,
        });
      }

      // Ordered execution units: consecutive script steps batch into one
      // orchestrator run; each <assertions> block is a verification step
      // evaluated against the output accumulated so far. A failed verification
      // stops the flow (later steps are skipped).
      const units = flow.steps;
      // <video> children are steps too — flatten for the checks below.
      const flatUnits = units.flatMap((u) => (u.type === "video" ? [u, ...(u.children ?? [])] : [u]));
      const tsScriptSteps = flatUnits.filter((s) => s.type === "script" && (!s.adapter || s.adapter === "tsAdapter"));
      const hasMessageStep = flatUnits.some(
        (s) =>
          s.type === "message" ||
          (s.type === "script" && !!s.adapter && s.adapter !== "tsAdapter")
      );
      const hasEvidence = flatUnits.some((s) => s.type === "picture" || s.type === "video");

      if (tsScriptSteps.length === 0 && !hasMessageStep) {
        throw new Error(`Flow '${flow.name}' has no <script>, <step>, or <usermessage> elements`);
      }

      const stepPathFor = (step: ParsedStep): string => {
        if (step.src) {
          const scriptPath = resolve(flowDir, step.src);
          if (!existsSync(scriptPath)) {
            throw new Error(`Script not found: ${scriptPath}`);
          }
          return scriptPath;
        }
        if (step.value) {
          const dir = mkdtempSync(join(flowDir, ".axn-flow-"));
          const scriptPath = join(dir, "flow.ts");
          writeFileSync(scriptPath, step.value);
          tmpDirs.push(dir);
          return scriptPath;
        }
        throw new Error("A <script>/<step> must have a 'src' attribute or inline text");
      };

      const orchestrator = flow.orchestrator ?? scenario.orchestrator;

      // Evidence steps require a browser — without an orchestrator there is
      // no page to capture from.
      let evidenceDir: string | null = null;
      if (hasEvidence) {
        if (!orchestrator) {
          throw new Error(
            `Flow '${flow.name}' uses <picture>/<video> evidence but has no orchestrator — ` +
              `evidence capture requires a browser orchestrator (set orchestrator= on the <flow> or <scenario>)`
          );
        }
        evidenceDir = evidenceDirFor(this._resolvedFilePath!, flow.name);
      }

      let allStdout = "";
      let lastStderr = "";
      let lastExitCode = 0;
      let stopFlow = false;

      const evalBlock = async (assertions: ParsedAssertion[]) => {
        const assertCtx = { flowDir, env, flowName: flow.name };
        for (const a of assertions) {
          const result = await this.evaluateAssertion(a, allStdout, lastExitCode, assertCtx);
          flowResult.assertions.push(result);
          if (!result.passed) stopFlow = true;
        }
      };

      if (orchestrator) {
        const orchestratorPath = resolve(flowDir, orchestrator);
        if (!existsSync(orchestratorPath)) {
          throw new Error(`Orchestrator not found: ${orchestratorPath}`);
        }

        const hostPath = this.resolveOrchestratorHost();
        const isFlowOverride = !!flow.orchestrator;
        const processKey = isFlowOverride ? `flow:${flow.name}` : `scenario:${scenario.name}`;

        let proc: OrchestratorProcess;
        if (isFlowOverride || !this.orchestratorProcesses.has(processKey)) {
          proc = new OrchestratorProcess(this.resolveTsx(), hostPath);
          await proc.start(orchestratorPath, env, flowDir);
          if (!isFlowOverride) {
            this.orchestratorProcesses.set(processKey, proc);
          }
        } else {
          proc = this.orchestratorProcesses.get(processKey)!;
        }

        // Run script batches, message steps, and assertion blocks in document order.
        // <picture> becomes a generated capture script that runs through the
        // same (page, baseUrl) step convention the orchestrator already uses.
        let evidenceCounter = 0;
        const videoStepIndex = new Map<string, number>();
        const artifactSlug = (s: string) =>
          s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "artifact";
        const captureScriptFor = (step: ParsedStep, stepIndex: number): string => {
          const artifactName = step.name ?? "picture";
          const fileName = `${String(evidenceCounter++).padStart(3, "0")}-${artifactSlug(artifactName)}.png`;
          const artifactPath = join(evidenceDir!, fileName);
          pendingEvidence.push({ kind: "picture", name: artifactName, path: artifactPath, stepIndex });
          const dir = mkdtempSync(join(flowDir, ".axn-flow-"));
          tmpDirs.push(dir);
          const scriptPath = join(dir, "capture.ts");
          const body = step.selector
            ? `await page.locator(${JSON.stringify(step.selector)}).screenshot({ path: ${JSON.stringify(artifactPath)} });`
            : `await page.screenshot({ path: ${JSON.stringify(artifactPath)}${step.fullPage ? ", fullPage: true" : ""} });`;
          writeFileSync(
            scriptPath,
            `export default async function capture(page: any) {\n  ${body}\n  return "captured ${artifactName}";\n}\n`
          );
          return scriptPath;
        };

        let batch: unknown[] = [];
        const flush = async () => {
          if (batch.length === 0) return;
          const { stdout, stderr, exitCode, videos } = await proc.run(batch);
          batch = [];
          allStdout += (allStdout ? "\n" : "") + stdout;
          lastStderr = stderr;
          lastExitCode = exitCode;
          for (const v of videos ?? []) {
            pendingEvidence.push({
              kind: "video",
              name: v.name,
              path: v.path ?? join(evidenceDir!, `${artifactSlug(v.name)}.webm`),
              stepIndex: videoStepIndex.get(v.name),
            });
          }
          if (exitCode !== 0) {
            throw new Error(`Orchestrator exited with ${exitCode}: ${stderr || stdout}`);
          }
        };

        const processUnit = async (unit: ParsedStep, stepIndex: number): Promise<void> => {
          if (unit.type === "script" && (!unit.adapter || unit.adapter === "tsAdapter")) {
            const path = stepPathFor(unit);
            if (unit.args && Object.keys(unit.args).length > 0) {
              batch.push({ path, args: this.expandStepArgs(unit.args, env) });
            } else {
              batch.push(path);
            }
          } else if (unit.type === "picture") {
            batch.push(captureScriptFor(unit, stepIndex));
          } else if (unit.type === "video") {
            const videoName = unit.name ?? "video";
            videoStepIndex.set(videoName, stepIndex);
            batch.push({ __axnVideo: "start", name: videoName, dir: evidenceDir });
            for (const inner of unit.children ?? []) {
              if (stopFlow) break;
              await processUnit(inner, stepIndex);
            }
            batch.push({ __axnVideo: "stop", name: videoName });
          } else if (unit.type === "assertions") {
            await flush();
            await evalBlock(unit.assertions ?? []);
          } else if (unit.type === "message" || (unit.type === "script" && this.servesMessage(unit.adapter))) {
            await flush();
            const model = flow.models[0];
            if (!model) {
              throw new Error(`Flow '${flow.name}' has a message step but no <model> in <setup>`);
            }
            const response = await this.runMessageStep(flow, unit, model, scenario, startedScenarios, infra, baseUrl, env, autoPort, portFlag);
            allStdout += (allStdout ? "\n" : "") + response;
          } else {
            await flush();
            const stdout = await this.runCustomAdapterStep(flow, unit, env);
            allStdout += (allStdout ? "\n" : "") + stdout;
            lastStderr = "";
            lastExitCode = 0;
          }
        };

        for (const [i, unit] of units.entries()) {
          if (stopFlow) break;
          await processUnit(unit, i);
        }
        if (!stopFlow) await flush();

        if (isFlowOverride) {
          await proc.stop();
        }
      } else {
        if (tsScriptSteps.length > 1) {
          throw new Error(
            `Flow '${flow.name}' has multiple <step> elements but no orchestrator. ` +
              `Set an orchestrator on the <flow> or <scenario> to run multi-step flows.`
          );
        }

        for (const unit of units) {
          if (stopFlow) break;
          if (unit.type === "script" && (!unit.adapter || unit.adapter === "tsAdapter")) {
            const { stdout, stderr, exitCode } = await this.runTsScript(stepPathFor(unit), env, flowDir);
            allStdout += (allStdout ? "\n" : "") + stdout;
            lastStderr = stderr;
            lastExitCode = exitCode;
            if (exitCode !== 0) {
              throw new Error(`TS script exited with ${exitCode}: ${stderr || stdout}`);
            }
          } else if (unit.type === "assertions") {
            await evalBlock(unit.assertions ?? []);
          } else if (unit.type === "message" || (unit.type === "script" && this.servesMessage(unit.adapter))) {
            const model = flow.models[0];
            if (!model) {
              throw new Error(`Flow '${flow.name}' has a message step but no <model> in <setup>`);
            }
            const response = await this.runMessageStep(flow, unit, model, scenario, startedScenarios, infra, baseUrl, env, autoPort, portFlag);
            allStdout += (allStdout ? "\n" : "") + response;
          } else {
            const stdout = await this.runCustomAdapterStep(flow, unit, env);
            allStdout += (allStdout ? "\n" : "") + stdout;
            lastStderr = "";
            lastExitCode = 0;
          }
        }
      }

      flowResult.response = allStdout;
      flowResult.exitCode = lastExitCode;

      flowResult.passed = flowResult.assertions.every((a) => a.passed);
      if (!flowResult.passed && !flowResult.error) {
        flowResult.error = lastStderr || "One or more assertions failed";
      }
    } catch (err) {
      flowResult.error = err instanceof Error ? err.message : String(err);
    } finally {
      for (const dir of tmpDirs) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
    }

    const evidence = pendingEvidence.filter((e) => existsSync(e.path));
    if (evidence.length > 0) {
      flowResult.evidence = evidence;
    }
    flowResult.durationMs = Date.now() - start;
    return flowResult;
  }

  private async buildDeviceEnv(device: string): Promise<Record<string, string>> {
    const resolved = await resolveDeviceEnv(device);
    if (!resolved) {
      throw new Error(
        `No device-env resolver could handle '${device}'. ` +
          "Install a plugin that provides device definitions (e.g. an infra plugin), " +
          "or check the device name.",
      );
    }
    return { ...(process.env as Record<string, string>), ...resolved };
  }

  private resolveTsx(): string {
    try {
      const require = createRequire(import.meta.url);
      const tsxPackagePath = require.resolve("tsx/package.json");
      const tsxPackageJson = JSON.parse(readFileSync(tsxPackagePath, "utf-8")) as { bin: string };
      return resolve(dirname(tsxPackagePath), tsxPackageJson.bin);
    } catch (err) {
      throw new Error("tsx is not available. Install tsx to use the tsAdapter.");
    }
  }

  private resolveOrchestratorHost(): string {
    const current = fileURLToPath(import.meta.url);
    const ext = current.endsWith(".ts") ? ".ts" : ".js";
    return resolve(dirname(current), `orchestrator-host${ext}`);
  }

  /** True when `name` is a registered plugin adapter serving the
   * <usermessage> tag — those adapters receive message steps, not scripts. */
  private servesMessage(name: string | undefined): boolean {
    if (!name) return false;
    return flowAdaptersForTag("usermessage").some((s) => s.name === name);
  }

  /** The adapter that should handle a step: explicit adapter= wins, else a
   * custom step tag resolves to the adapter declaring that tag. */
  private adapterForStep(step: ParsedStep): string | null {
    if (step.adapter) return step.adapter;
    if (step.type === "script" || step.type === "message" || step.type === "assertions") return null;
    return flowAdaptersForTag(step.type)[0]?.name ?? null;
  }

  /** Build the context handed to a plugin adapter. */
  private makeAdapterCtx(
    flow: ParsedFlow | null,
    step: ParsedStep,
    env: Record<string, string>,
    extra?: {
      scenario?: ParsedScenario;
      model?: ParsedModel;
      baseUrl?: string;
    },
  ): FlowAdapterContext {
    const flowDir = this._resolvedFilePath ? dirname(this._resolvedFilePath) : process.cwd();
    return {
      env,
      flowDir,
      cwd: process.cwd(),
      flowName: flow?.name ?? "",
      flow: (flow ?? { name: "", env: {} }) as unknown as FlowAdapterContext["flow"],
      scenario: extra?.scenario as FlowAdapterContext["scenario"],
      model: extra?.model,
      baseUrl: extra?.baseUrl,
      runScript: (path, scriptEnv, cwd) =>
        this.runTsScript(path, scriptEnv ?? env, cwd ?? flowDir),
      log: (message) => console.log(`    ${message}`),
    };
  }

  private async runCustomAdapterStep(
    flow: ParsedFlow | null,
    step: ParsedStep,
    env: Record<string, string>,
  ): Promise<string> {
    const name = this.adapterForStep(step);
    if (!name) {
      throw new Error(
        `No adapter found for <${step.type}> — pass adapter="..." or install ` +
          `a plugin adapter declaring the tag via axn-dev.flowAdapters`,
      );
    }

    const expandedStep: ParsedStep = step.args
      ? { ...step, args: this.expandStepArgs(step.args, env) }
      : step;

    // Registered plugin adapters run in-process.
    if (hasFlowAdapter(name)) {
      console.log(`    Adapter '${name}' resolved via plugin registry`);
      const adapter = await flowAdapter(name);
      const out = await adapter.run(
        expandedStep as FlowAdapterStep,
        this.makeAdapterCtx(flow, expandedStep, env)
      );
      return typeof out === "string" ? out : "";
    }

    // File-path adapters run as tsx subprocesses.
    if (expandedStep.type !== "script") {
      throw new Error(`<${expandedStep.type}> requires a plugin adapter named '${name}' — not registered`);
    }
    const { exitCode, stdout, stderr } = await this.runExternalAdapter(expandedStep, env, dirname(this._resolvedFilePath!));
    if (exitCode !== 0) {
      throw new Error(`External adapter '${name}' exited with ${exitCode}: ${stderr || stdout}`);
    }
    return stdout;
  }

  private async runExternalAdapter(
    step: ParsedStep,
    env: Record<string, string>,
    flowDir: string
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const adapter = step.adapter!;
    const registered = this.adapterRegistry?.resolve(adapter) ?? null;
    const candidates = [
      { via: registered?.via ?? "", path: registered?.path ?? null },
      { via: "step 'src' attribute", path: step.src ? resolve(flowDir, step.src) : null },
      { via: "flow directory", path: resolve(flowDir, "adapters", `${adapter}.ts`) },
      { via: "flow directory", path: resolve(flowDir, "adapters", `${adapter}.js`) },
    ];

    let adapterPath: string | null = null;
    let adapterVia = "";
    for (const c of candidates) {
      if (c.path && existsSync(c.path)) {
        adapterPath = c.path;
        adapterVia = c.via;
        break;
      }
    }
    if (!adapterPath) {
      const searched = candidates.map((c) => c.path).filter(Boolean).join(", ");
      throw new Error(`External adapter '${adapter}' not found. Searched: ${searched}`);
    }
    console.log(`    Adapter '${adapter}' resolved via ${adapterVia}: ${adapterPath}`);

    return new Promise((resolve, reject) => {
      const tsxBin = this.resolveTsx();
      const child = spawn(process.execPath, [tsxBin, adapterPath], {
        env: { ...env, AXN_STEP: JSON.stringify(step), AXN_FLOW_DIR: flowDir },
        cwd: flowDir,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });
      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      child.on("error", (err) => reject(err));
      child.on("close", (code) => {
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
    });
  }

  private runTsScript(
    scriptPath: string,
    env: Record<string, string>,
    cwd: string
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const tsxBin = this.resolveTsx();
      const child = spawn(process.execPath, [tsxBin, scriptPath], {
        env,
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("error", (err) => reject(err));

      child.on("close", (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
        });
      });
    });
  }

  private async runMessageStep(
    flow: ParsedFlow,
    step: ParsedStep,
    model: ParsedModel,
    scenario: ParsedScenario,
    startedScenarios: Set<string>,
    infra: string | null = null,
    deviceBaseUrl?: string,
    env?: Record<string, string>,
    autoPort = false,
    portFlag: number | null = null
  ): Promise<string> {
    const adapterName = step.adapter ?? scenario.adapter;
    const spec = adapterName
      ? flowAdapterSpecs().find((s) => s.name === adapterName)
      : undefined;

    if (!adapterName || adapterName === "tsAdapter" || !spec) {
      const serving = flowAdaptersForTag("usermessage").map((s) => s.name);
      throw new Error(
        `Message step in flow '${flow.name}' has no usable adapter ` +
          `(registered <usermessage> adapters: ${serving.join(", ") || "(none)"})`,
      );
    }

    let stepEnv =
      env ?? this.expandEnvVars({ ...(process.env as Record<string, string>), ...flow.env });
    let baseUrl: string | undefined;

    if (infra) {
      const deviceEnv = await this.buildDeviceEnv(infra);
      stepEnv = this.expandEnvVars({ ...deviceEnv, ...flow.env });
      baseUrl = deviceBaseUrl ?? deviceEnv.BASE_URL;
    } else if (spec.wantsScenario) {
      // Engine-side lifecycle: start the scenario, probe readiness, hand the
      // adapter the service's base URL.
      const prepared = await this.prepareScenario(scenario, flow, startedScenarios, autoPort, portFlag);
      await this.waitForReadiness(scenario, prepared.scenarioPath, prepared.env, prepared.endpoints);
      stepEnv = prepared.env;
      baseUrl = prepared.baseUrl;
    }

    const adapter = await flowAdapter(adapterName);
    const out = await adapter.run(
      step as FlowAdapterStep,
      this.makeAdapterCtx(flow, step, stepEnv, { scenario, model, baseUrl }),
    );
    return typeof out === "string" ? out : "";
  }

  /** Expand ${VAR} / ${VAR:-default} references in step args against the
   * merged env — enables parameterized reusable steps like
   * <step action="login" TEST_USER="${MOM_USER}"/>. */
  private expandStepArgs(
    args: Record<string, string>,
    env: Record<string, string>
  ): Record<string, string> {
    const pattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(args)) {
      out[k] = v.replace(pattern, (m, name: string, def?: string) =>
        name in env ? env[name] : def !== undefined ? def : m
      );
    }
    return out;
  }

  private async prepareScenario(
    scenario: ParsedScenario,
    flow: ParsedFlow,
    startedScenarios: Set<string>,
    autoPort = false,
    portFlag: number | null = null
  ): Promise<{ baseUrl: string; scenarioPath: string; env: Record<string, string>; endpoints: ServiceEndpoint[] }> {
    const discovery = new ScenarioDiscoveryService(process.cwd());
    const workspace = discovery.getWorkspaceConfig();
    const resolution = discovery.resolveScenario(scenario.name);
    const scenarioPath = resolution.scenario.path;

    const env = {
      ...process.env,
      ...workspace.repoEnv,
      ...resolution.scenario.env,
      ...flow.env,
    } as Record<string, string>;

    if (!isScenarioRunning(scenarioPath)) {
      const startArgs = ["-s", scenario.name];
      if (autoPort) startArgs.push("--auto-port");
      if (portFlag !== null) {
        startArgs.push("--port", String(portFlag));
      }
      await new StartCommand().execute(startArgs, { env: flow.env });
      startedScenarios.add(scenario.name);
    } else {
      console.log(`\x1b[32mScenario '${scenario.name}' is already running\x1b[0m`);
    }

    const runningPort = getRunningScenarioPort(scenarioPath);
    if (runningPort !== null) {
      env.SCENARIO_PORT = String(runningPort);
    }

    // Compose-published ports first; in single-port (Caddy) scenarios the
    // individual services only exist as name → URL entries in axn-dev.yaml
    // (frontend-services / backend-services / proxies), so merge those in too.
    const named = resolveEndpoints(
      {
        ...(resolution.scenario.proxies ?? {}),
        ...(resolution.scenario.frontendServices ?? {}),
        ...(resolution.scenario.backendServices ?? {}),
      },
      env,
    );
    const endpoints: ServiceEndpoint[] = [
      ...getServiceEndpoints(scenarioPath, env),
      ...Object.entries(named).map(([service, ep]) => ({ service, port: ep.port, url: ep.url })),
    ];
    const server = endpoints.find((e) => e.service === scenario.service);
    if (!server) {
      throw new Error(`Service '${scenario.service}' not found in scenario '${scenario.name}'`);
    }

    return { baseUrl: server.url, scenarioPath, env, endpoints };
  }

  /**
   * Expand ${VAR} and ${VAR:-default} references inside env values against the
   * env itself (e.g. KC_URL=http://keycloak.localhost:${SCENARIO_PORT}).
   * Unresolved references without a default are left as-is. Iterates so values
   * may reference other env vars; bounded to avoid infinite loops on cycles.
   */
  private expandEnvVars(env: Record<string, string>): Record<string, string> {
    const result = { ...env };
    const pattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
    for (let pass = 0; pass < 10; pass++) {
      let changed = false;
      for (const key of Object.keys(result)) {
        const expanded = result[key].replace(pattern, (match, name: string, def?: string) => {
          if (name in result) {
            changed = true;
            return result[name];
          }
          return def !== undefined ? ((changed = true), def) : match;
        });
        if (expanded !== result[key]) result[key] = expanded;
      }
      if (!changed) break;
    }
    return result;
  }

  private async waitForReadiness(
    scenario: ParsedScenario,
    scenarioPath: string,
    env: Record<string, string>,
    endpoints?: ServiceEndpoint[]
  ): Promise<void> {
    if (!scenario.readiness || scenario.readiness.length === 0) return;

    const resolvedEndpoints = endpoints ?? getServiceEndpoints(scenarioPath, env);

    for (const r of scenario.readiness) {
      const targetService = r.service ?? scenario.service;
      const endpoint = resolvedEndpoints.find((e) => e.service === targetService);
      const port = r.port ? parseInt(r.port, 10) : endpoint?.port;

      if (!port && !endpoint?.url) {
        throw new Error(
          `Readiness probe for service '${targetService}' cannot resolve a port. ` +
            `Either publish a port in the compose file or set the 'port' attribute on <readiness>.`
        );
      }

      const path = r.path ?? "/";
      // Named (frontend-services) endpoints resolve to a full URL — required
      // for host-based routing in single-port Caddy scenarios.
      const url = r.port || !endpoint?.url
        ? `http://localhost:${port}${path}`
        : `${endpoint.url}${path}`;
      const method = r.method ?? "GET";
      const expected = r.expected ?? "ok";
      const timeout = r.timeout ? parseInt(r.timeout, 10) : 120000;

      await this.waitForProbe(url, method, expected, timeout);
    }
  }

  private async waitForProbe(
    url: string,
    method: string = "GET",
    expected: string = "ok",
    timeoutMs: number = 120000
  ): Promise<void> {
    const start = Date.now();
    const expectedStatus = parseInt(expected, 10);
    const checkByStatus = !isNaN(expectedStatus);

    while (Date.now() - start < timeoutMs) {
      try {
        const response = await fetch(url, { method, signal: AbortSignal.timeout(1000) });
        if (checkByStatus ? response.status === expectedStatus : response.ok) {
          return;
        }
      } catch { /* not ready yet */ }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(`Timed out waiting for ${url} to respond with ${expected}`);
  }

  private async evaluateAssertion(
    assertion: ParsedAssertion,
    response: string,
    exitCode?: number,
    ctx?: { flowDir: string; env: Record<string, string>; flowName?: string }
  ): Promise<AssertionResult> {
    const result: AssertionResult = { that: assertion.that, value: assertion.value, passed: false };

    if (assertion.that === "screenshot") {
      const outcome = await evaluateScreenshotAssertion(
        assertion,
        ctx ?? {
          flowDir: dirname(this._resolvedFilePath ?? process.cwd()),
          env: this.expandEnvVars(process.env as Record<string, string>),
        }
      );
      result.passed = outcome.passed;
      result.actual = outcome.detail;
      return result;
    }

    if (assertion.that === "contains") {
      const actual = response.toLowerCase();
      const expected = assertion.value.toLowerCase();
      result.passed = actual.includes(expected);
      if (!result.passed) result.actual = response;
    } else if (assertion.that === "num_responses") {
      const expected = parseInt(assertion.value, 10);
      const count = response.trim() ? 1 : 0;
      result.passed = count === expected;
      result.actual = String(count);
    } else if (assertion.that === "exitCode") {
      const expected = parseInt(assertion.value, 10);
      if (exitCode === undefined) {
        result.passed = false;
        result.actual = "undefined";
      } else {
        result.passed = exitCode === expected;
        result.actual = String(exitCode);
      }
    } else {
      throw new Error(`Unknown assertion type: ${assertion.that}`);
    }

    return result;
  }

  private printSummary(results: FlowResult[]): void {
    console.log("\n== Flow Results ==\n");
    for (const r of results) {
      const status = r.passed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
      const duration = r.durationMs !== undefined ? ` (${r.durationMs}ms)` : "";
      console.log(`${status} ${r.flow} :: ${r.model.provider}/${r.model.name}${duration}`);
      if (r.error) console.log(`  error: ${r.error}`);
      for (const a of r.assertions) {
        const aStatus = a.passed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
        console.log(`  ${aStatus}  ${a.that}=${a.value}`);
        if (a.actual) console.log(`      actual: ${a.actual}`);
      }
    }
  }

  private confirm(prompt: string): Promise<boolean> {
    return new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase() === "y");
      });
    });
  }
}

class OrchestratorProcess {
  private child?: ReturnType<typeof spawn>;
  private nextId = 1;
  private pending = new Map<number, (value: any) => void>();

  constructor(
    private tsxBin: string,
    private hostPath: string
  ) {}

  async start(orchestratorPath: string, env: Record<string, string>, cwd: string): Promise<void> {
    const fullEnv = {
      ...env,
      AXN_FLOW_ORCHESTRATOR: orchestratorPath,
    };

    this.child = spawn(process.execPath, [this.tsxBin, this.hostPath], {
      env: fullEnv,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = createInterface({ input: this.child.stdout! });
    rl.on("line", (line) => this.handleLine(line));
    this.child.stderr?.on("data", (data) => {
      process.stderr.write(String(data));
    });
    this.child.on("error", (err) => {
      for (const resolve of this.pending.values()) {
        resolve({ error: err.message });
      }
      this.pending.clear();
    });
    this.child.on("exit", (code, signal) => {
      for (const resolve of this.pending.values()) {
        resolve(
          Promise.reject(new Error(`Orchestrator exited (code=${code}, signal=${signal})`))
        );
      }
      this.pending.clear();
    });

    await this.send("start", {});
  }

  async run(steps: unknown[]): Promise<{ exitCode: number; stdout: string; stderr: string; videos?: { name: string; path?: string }[] }> {
    return this.send("run", { steps });
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    try {
      await this.send("stop", {});
    } catch {
      /* best effort */
    }
    this.child.kill();
  }

  private handleLine(line: string): void {
    if (!line.startsWith("__AXN__")) {
      console.log(line);
      return;
    }

    const json = line.slice("__AXN__".length);
    let msg: { id: number; error?: string; exitCode?: number; stdout?: string; stderr?: string } | undefined;
    try {
      msg = JSON.parse(json);
    } catch {
      return;
    }
    if (!msg || typeof msg.id !== "number") return;

    const resolve = this.pending.get(msg.id);
    if (!resolve) return;
    this.pending.delete(msg.id);

    if (msg.error) {
      resolve(Promise.reject(new Error(msg.error)));
    } else {
      resolve(msg as any);
    }
  }

  private async send(method: string, args: Record<string, any>): Promise<any> {
    if (!this.child || !this.child.stdin) {
      throw new Error("Orchestrator process is not running");
    }

    const id = this.nextId++;
    const request = { id, method, ...args };

    return new Promise<any>((resolve) => {
      this.pending.set(id, resolve);
      this.child!.stdin!.write(JSON.stringify(request) + "\n");
    });
  }
}
