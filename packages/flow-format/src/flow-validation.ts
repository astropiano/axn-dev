/**
 * Flow validation — a structural sanity pass that runs after parsing and
 * step-ref expansion, so step files are checked through the flow that bound
 * them. Everything here is static: adapter existence and script/orchestrator
 * paths stay runtime concerns.
 */

import type { ParsedAssertion, ParsedFlow, ParsedStep } from "./flow-util.js";

export {
  FLOW_ENGINE_STEP_TAGS,
  FLOW_STRUCTURAL_TAGS,
  FLOW_STEP_REF_KEYWORDS,
  FLOW_RESERVED_STEP_NAMES,
  FLOW_ADAPTER_TAG_BLOCKLIST,
} from "@axn-dev/core";

/** Assertion types implemented by the axn and pw runners. `repeat` is
 * engine-generated for reports — it is not valid in XML. */
export const KNOWN_ASSERTION_TYPES: ReadonlySet<string> = new Set([
  "contains", "num_responses", "exitCode", "screenshot", "llm", "duration", "script",
]);

function checkAssertion(a: ParsedAssertion, where: string): void {
  if (!a.that) {
    throw new Error(`${where}: <assert> requires a 'that' attribute`);
  }
  if (!KNOWN_ASSERTION_TYPES.has(a.that)) {
    throw new Error(
      `${where}: unknown assertion type '${a.that}' — expected one of: ` +
        [...KNOWN_ASSERTION_TYPES].join(", ")
    );
  }
  switch (a.that) {
    case "contains":
      if (!a.value) throw new Error(`${where}: that="contains" requires 'value'`);
      break;
    case "num_responses":
    case "exitCode":
      if (!a.value) {
        throw new Error(`${where}: that="${a.that}" requires 'value'`);
      }
      if (!/^-?\d+$/.test(a.value.trim())) {
        throw new Error(`${where}: that="${a.that}" value must be an integer (got '${a.value}')`);
      }
      break;
    case "screenshot":
      if (!a.value) {
        throw new Error(`${where}: that="screenshot" requires 'value' (reference PNG path)`);
      }
      break;
    case "llm":
      if (!a.prompt?.trim() && !a.value?.trim() && !a.description?.trim()) {
        throw new Error(`${where}: that="llm" needs a rubric — set 'prompt' or 'value'`);
      }
      break;
    case "duration":
      if (a.min !== undefined && isNaN(a.min)) {
        throw new Error(`${where}: that="duration" min= must be numeric`);
      }
      if (a.max !== undefined && isNaN(a.max)) {
        throw new Error(`${where}: that="duration" max= must be numeric`);
      }
      if (a.min === undefined && a.max === undefined && (a.value.trim() === "" || isNaN(Number(a.value)))) {
        throw new Error(`${where}: that="duration" needs a bound — set min=, max= or a numeric 'value'`);
      }
      break;
    case "script":
      if (!a.src && !a.value) {
        throw new Error(`${where}: that="script" needs a script path — set 'src' or 'value'`);
      }
      break;
  }
}

function checkStep(step: ParsedStep, where: string): void {
  const at = (label: string) => `${where}: <${label}>${step.description ? ` '${step.description}'` : ""}`;

  switch (step.type) {
    case "message":
      if (!step.value?.trim()) {
        throw new Error(`${at("usermessage")} requires a message — set 'value' or put text in the body`);
      }
      break;
    case "script":
      if (!step.src && !step.value && !step.adapter && !step.args?.action && !step.args?.file) {
        throw new Error(
          `${at("step")} needs a 'src' script, inline text, an 'action'/'file' step reference, or 'adapter'`
        );
      }
      break;
    case "picture":
      if (!step.name?.trim()) {
        throw new Error(`${at("picture")} requires 'name' for the evidence artifact`);
      }
      break;
    case "video":
      if (!step.name?.trim()) {
        throw new Error(`${at("video")} requires 'name' for the evidence artifact`);
      }
      if (!step.children?.length) {
        throw new Error(`${at("video")} wraps no steps`);
      }
      break;
    case "repeat":
      if (!step.children?.length) {
        throw new Error(`${at("repeat")} has no child steps`);
      }
      break;
    case "extract":
      if (!step.selector) {
        throw new Error(`${at("extract")} requires a 'selector' attribute`);
      }
      break;
  }

  for (const a of step.assertions ?? []) {
    checkAssertion(a, where);
  }
  for (const child of step.children ?? []) {
    checkStep(child, where);
  }
}

/**
 * Validate a fully parsed + expanded flow. Throws on the first problem.
 * Called by loadFlowsFromFile after step-ref expansion; exported so other
 * entry points can check a ParsedFlow the same way.
 */
export function validateFlow(flow: ParsedFlow): void {
  const where = `flow '${flow.name}'`;

  if (!flow.name?.trim()) {
    throw new Error("<flow> is missing the 'name' attribute");
  }
  if (flow.steps.length === 0) {
    throw new Error(`${where} has no steps`);
  }

  for (const s of flow.scenarios) {
    if (!s.name?.trim()) {
      throw new Error(`${where}: <scenario> requires a 'name' attribute`);
    }
    if (!s.adapter?.trim()) {
      throw new Error(`${where}: <scenario name="${s.name}"> requires an 'adapter' attribute`);
    }
  }

  for (const m of flow.models) {
    if (!m.provider?.trim() || !m.name?.trim()) {
      throw new Error(`${where}: <model> requires 'provider' and 'name' attributes`);
    }
  }

  for (const step of flow.steps) {
    checkStep(step, where);
  }
  for (const a of flow.assertions) {
    checkAssertion(a, where);
  }
}
