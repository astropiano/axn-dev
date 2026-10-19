import { createInterface } from "node:readline";
import { copyFileSync, existsSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type {
  AssertionResult,
  EvidenceArtifact,
  FlowResult,
  ManualStepResult,
  ParsedAssertion,
  ParsedFlow,
  ParsedStep,
} from "./flow-util.js";
import { evidenceDirFor, isUnderEvidenceDir, writeFlowReport } from "./flow-util.js";

export interface ManualAssertionVerdict {
  that: string;
  value: string;
  description?: string;
  /** User-supplied observed/actual value for the assertion. */
  actual?: string;
  passed: boolean;
  notes?: string;
}

export interface ManualStepVerdict {
  stepIndex: number;
  stepDescription?: string;
  /** Observed response or output for this step (used as assertion input). */
  response?: string;
  passed: boolean;
  notes?: string;
  assertions: ManualAssertionVerdict[];
  /** Evidence files attached to this step (e.g. a screenshot of a failure). */
  evidence?: { name: string; path: string; kind?: "picture" | "video" }[];
}

export interface ManualFlowInput {
  /** Verdicts for each step, in document order. */
  steps: ManualStepVerdict[];
}

function defaultModel(flow: ParsedFlow) {
  return flow.models[0] ?? { provider: "manual", name: "manual" };
}

function describeStep(step: ParsedStep, index: number): string {
  const label = step.type === "message" ? "usermessage" : step.type;
  const base = `${index + 1}. [${label}]`;
  if (step.description) return `${base} ${step.description}`;
  if (step.type === "message" && step.value) return `${base} ${step.value}`;
  if (step.type === "script" && step.src) return `${base} ${step.src}`;
  if ((step.type === "picture" || step.type === "video") && step.name) return `${base} ${step.name}`;
  return base;
}

function describeAssertion(assertion: ParsedAssertion): string {
  const desc = assertion.description ? `${assertion.description} ` : "";
  return `${desc}(expect ${assertion.that}=${assertion.value})`;
}

/**
 * Collects human-provided pass/fail verdicts for a flow and turns them into a
 * standard FlowResult + JSON report. Used by the CLI --manual mode and by the
 * serve web UI's manual execution page.
 */
export class ManualFlowRunner {
  constructor(
    private readonly flow: ParsedFlow,
    private readonly resolvedFilePath: string,
  ) {}

  private evidenceDir: string | null = null;

  private evidenceDirPath(): string {
    if (!this.evidenceDir) {
      this.evidenceDir = evidenceDirFor(this.resolvedFilePath, this.flow.name);
    }
    return this.evidenceDir;
  }

  /**
   * Normalize an attached evidence file: paths already inside a
   * flow-reports/evidence/ dir are used as-is (e.g. web uploads); anything
   * else is copied into the run's evidence dir.
   */
  private collectEvidence(
    e: { name: string; path: string; kind?: "picture" | "video" },
    stepIndex: number
  ): EvidenceArtifact | null {
    let path = resolve(e.path);
    if (!existsSync(path)) return null;

    if (!isUnderEvidenceDir(path)) {
      const dir = this.evidenceDirPath();
      let target = join(dir, basename(path));
      let n = 2;
      while (existsSync(target)) {
        const ext = extname(path);
        target = join(dir, `${basename(path, ext)}-${n++}${ext}`);
      }
      copyFileSync(path, target);
      path = target;
    }

    const ext = extname(path).toLowerCase();
    const kind = e.kind ?? ([".webm", ".mp4", ".mov"].includes(ext) ? "video" : "picture");
    return { kind, name: e.name || basename(path), path, stepIndex };
  }

  /**
   * Build a FlowResult from a completed manual run. The caller is responsible
   * for presenting the steps and collecting the verdicts (web UI form, etc.).
   */
  execute(input: ManualFlowInput): FlowResult {
    const assertions: AssertionResult[] = [];
    const manualSteps: ManualStepResult[] = [];
    const evidence: EvidenceArtifact[] = [];
    let allResponse = "";

    for (const stepInput of input.steps) {
      const step = this.flow.steps[stepInput.stepIndex];
      if (!step) continue;

      for (const e of stepInput.evidence ?? []) {
        const artifact = this.collectEvidence(e, stepInput.stepIndex);
        if (artifact) evidence.push(artifact);
      }

      if (stepInput.response?.trim()) {
        allResponse += (allResponse ? "\n" : "") + stepInput.response.trim();
      }

      for (const assertInput of stepInput.assertions) {
        const result: AssertionResult = {
          that: assertInput.that,
          value: assertInput.value,
          passed: assertInput.passed,
          actual: assertInput.actual?.trim() || undefined,
          description: assertInput.description || step.assertions?.find((a) => a.that === assertInput.that && a.value === assertInput.value)?.description,
          notes: assertInput.notes?.trim() || undefined,
        };
        assertions.push(result);
      }

      manualSteps.push({
        stepIndex: stepInput.stepIndex,
        stepDescription: stepInput.stepDescription ?? step.description,
        stepType: step.type,
        response: stepInput.response?.trim() || undefined,
        passed: stepInput.passed,
        notes: stepInput.notes?.trim() || undefined,
      });
    }

    const passed = assertions.length === 0 || assertions.every((a) => a.passed);

    return {
      flow: this.flow.name,
      model: defaultModel(this.flow),
      passed,
      assertions,
      response: allResponse || undefined,
      manualSteps,
      evidence: evidence.length > 0 ? evidence : undefined,
    };
  }

  writeReport(result: FlowResult): string {
    return writeFlowReport(this.resolvedFilePath, [result]);
  }

  /**
   * CLI interactive mode: prompt the user for each step and assertion.
   */
  async runInteractive(): Promise<FlowResult> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const lines = rl[Symbol.asyncIterator]();
    const next = async (prompt: string): Promise<string> => {
      process.stdout.write(prompt);
      const result = await lines.next();
      if (result.done) {
        throw new Error("End of input reached");
      }
      return String(result.value).trim();
    };

    const steps: ManualStepVerdict[] = [];

    try {
      console.log(`\n== Manual flow: ${this.flow.name} ==\n`);
      if (this.flow.description) {
        console.log(this.flow.description);
        console.log("");
      }

      for (let i = 0; i < this.flow.steps.length; i++) {
        const step = this.flow.steps[i];
        const stepVerdict = await this.promptStep(next, step, i);
        steps.push(stepVerdict);
      }

      const input: ManualFlowInput = { steps };
      const result = this.execute(input);
      const reportPath = this.writeReport(result);
      console.log(`\nReport written: ${reportPath}`);
      return result;
    } finally {
      rl.close();
    }
  }

  private async promptStep(
    ask: (prompt: string) => Promise<string>,
    step: ParsedStep,
    index: number,
  ): Promise<ManualStepVerdict> {
    const assertionVerdicts: ManualAssertionVerdict[] = [];

    console.log(describeStep(step, index));
    if (step.type === "message" && step.value && !step.description?.includes(step.value)) {
      console.log(`  Message: ${step.value}`);
    }
    if (step.type === "script") {
      if (step.src) console.log(`  Script: ${step.src}`);
      if (step.value && !step.src) console.log(`  Script:\n${step.value.split("\n").map((l) => "    " + l).join("\n")}`);
      if (step.adapter) console.log(`  Adapter: ${step.adapter}`);
    }
    if (step.type === "picture") {
      console.log(`  Capture a screenshot${step.name ? ` named '${step.name}'` : ""}${step.selector ? ` of element '${step.selector}'` : ""}${step.fullPage ? " (full page)" : ""}`);
    }
    if (step.type === "video") {
      console.log(`  Record a video${step.name ? ` named '${step.name}'` : ""} covering ${step.children?.length ?? 0} step(s):`);
      for (const c of step.children ?? []) {
        console.log(`    - ${c.description ?? c.src ?? c.type}`);
      }
    }

    let response: string | undefined;
    if (step.type !== "assertions") {
      response = await ask("  Observed response/output (optional): ");
    }

    if (step.type === "assertions" && step.assertions && step.assertions.length > 0) {
      for (const assertion of step.assertions) {
        console.log(`  ${describeAssertion(assertion)}`);
        const actual = await ask("    Actual value (optional): ");
        const passed = (await ask("    Pass or fail? (p/f): ")).toLowerCase().startsWith("p");
        const notes = await ask("    Notes (optional): ");
        assertionVerdicts.push({
          that: assertion.that,
          value: assertion.value,
          description: assertion.description,
          actual,
          passed,
          notes: notes || undefined,
        });
      }
    }

    let passed: boolean;
    if (assertionVerdicts.length > 0) {
      passed = assertionVerdicts.every((a) => a.passed);
    } else {
      const answer = await ask("  Pass or fail? (p/f): ");
      passed = answer.toLowerCase().startsWith("p");
    }

    const notes = await ask("  Notes (optional): ");

    const evidence: { name: string; path: string }[] = [];
    while (true) {
      const p = await ask("  Attach evidence file (path, empty to skip): ");
      if (!p) break;
      const abs = resolve(p);
      if (existsSync(abs)) {
        evidence.push({ name: basename(abs), path: abs });
      } else {
        console.log(`    File not found: ${p}`);
      }
    }

    return {
      stepIndex: index,
      stepDescription: step.description,
      response,
      passed,
      notes: notes || undefined,
      assertions: assertionVerdicts,
      evidence: evidence.length > 0 ? evidence : undefined,
    };
  }
}
