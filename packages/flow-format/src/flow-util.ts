import { existsSync, lstatSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { getWorktreeInfo, getWorktreeInfoAsync } from "@axn-dev/core";
import type { AxnDevConfig } from "@axn-dev/core";

export interface ParsedModel {
  provider: string;
  name: string;
}

export interface ParsedAssertion {
  that: string;
  value: string;
  /** Optional human-readable description for the assertion (manual flows/reporting) */
  description?: string;
  /** that="screenshot": CSS selector — capture only this element (omit = whole page) */
  selector?: string;
  /** that="screenshot": page URL, supports ${VAR} expansion (defaults to BASE_URL) */
  url?: string;
  /** that="screenshot": capture the full scrollable page instead of the viewport */
  fullPage?: boolean;
  /** that="screenshot": max fraction of differing pixels (0..1, default 0.01) */
  maxDiff?: number;
  /** that="screenshot": per-pixel color threshold (0..1, default 0.1) */
  threshold?: number;
  /** that="screenshot": browser viewport as "WxH" (default 1280x800) */
  viewport?: string;
  /** that="screenshot": settle wait — ms ("500") or a CSS selector to wait for */
  wait?: string;
}

function parseAssertAttrs(attrs: Record<string, any>, text?: string): ParsedAssertion {
  const num = (v: any): number | undefined => (v === undefined ? undefined : Number(v));
  return {
    that: String(attrs.that ?? ""),
    value: attrs.value !== undefined ? String(attrs.value) : "",
    description: attrs.description ?? attrs.desc ?? (text || undefined),
    selector: attrs.selector !== undefined ? String(attrs.selector) : undefined,
    url: attrs.url !== undefined ? String(attrs.url) : undefined,
    fullPage: attrs.fullPage === true || String(attrs.fullPage) === "true" || undefined,
    maxDiff: num(attrs.maxDiff),
    threshold: num(attrs.threshold),
    viewport: attrs.viewport !== undefined ? String(attrs.viewport) : undefined,
    wait: attrs.wait !== undefined ? String(attrs.wait) : undefined,
  };
}

export interface ParsedReadiness {
  service?: string;
  path?: string;
  port?: string;
  method?: string;
  expected?: string;
  timeout?: string;
}

export interface ParsedScenario {
  name: string;
  service: string;
  adapter: string;
  project?: string;
  workingDirectory?: string;
  branch?: string;
  readiness: ParsedReadiness[];
  orchestrator?: string;
}

export interface ParsedStep {
  /** Engine tags: "message" (<usermessage>), "script" (<step>/<script>),
   * "assertions", "picture", "video" (evidence steps). Any other value is a
   * custom XML tag routed to the flow adapter that declared it
   * (axn-dev.flowAdapters manifest). */
  type: string;
  /** Optional human-readable description shown in the serve flow view */
  description?: string;
  value?: string;
  src?: string;
  lang?: string;
  runner?: string;
  /** Per-step arguments passed through to the script/orchestrator */
  args?: Record<string, string>;
  /** Override the scenario adapter for this step */
  adapter?: string;
  /** Present when type === "assertions" — a verification step */
  assertions?: ParsedAssertion[];
  /** picture/video: artifact name (required for evidence steps) */
  name?: string;
  /** picture: CSS selector — clip the screenshot to this element */
  selector?: string;
  /** picture: capture the full scrollable page instead of the viewport */
  fullPage?: boolean;
  /** video: steps recorded by this segment */
  children?: ParsedStep[];
}

export interface ParsedFlow {
  name: string;
  description?: string;
  scenarios: ParsedScenario[];
  orchestrator?: string;
  models: ParsedModel[];
  env: Record<string, string>;
  toolMode?: string;
  useDocker?: boolean;
  userMessage: string;
  steps: ParsedStep[];
  assertions: ParsedAssertion[];
  tags?: string[];
}

export interface AssertionResult {
  that: string;
  value: string;
  passed: boolean;
  actual?: string;
  /** Human-readable description for the assertion (manual flows/reporting) */
  description?: string;
  /** User-supplied notes (manual flows) */
  notes?: string;
}

/** Step-level result for manual flow executions. */
export interface ManualStepResult {
  stepIndex: number;
  stepDescription?: string;
  stepType?: string;
  /** Observed response/output for this step */
  response?: string;
  passed: boolean;
  notes?: string;
}

/** A captured evidence artifact (screenshot or video segment). */
export interface EvidenceArtifact {
  kind: "picture" | "video";
  /** Artifact name from the flow (e.g. "after-login") */
  name: string;
  /** Absolute path of the captured file */
  path: string;
  /** Step the artifact belongs to (manual runs / failure attachments) */
  stepIndex?: number;
}

export interface FlowResult {
  flow: string;
  model: ParsedModel;
  passed: boolean;
  assertions: AssertionResult[];
  response?: string;
  error?: string;
  exitCode?: number;
  /** Wall-clock duration of the run. Omitted for manual executions. */
  durationMs?: number;
  /** Step-level results for manual flow executions */
  manualSteps?: ManualStepResult[];
  /** Evidence captured during the run (screenshots, video segments) */
  evidence?: EvidenceArtifact[];
}

export interface FlowReport {
  timestamp: string;
  flows: FlowResult[];
}

const flowXmlArrays = new Set([
  "flow", "scenario", "model", "assert", "step", "script",
  "var", "readiness", "tag", "picture", "video",
]);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "#text",
  parseTagValue: true,
  trimValues: true,
  isArray: (name) => flowXmlArrays.has(name),
});

/**
 * Ordered parser — used to recover the document order of <steps> children
 * (usermessage / step / script / assertions blocks), which the flat parse loses.
 */
const orderParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "#text",
  preserveOrder: true,
  trimValues: true,
  isArray: (name) => flowXmlArrays.has(name),
});

interface OrderedNode {
  [tag: string]: OrderedNode[] | string | Record<string, string> | undefined;
  ":@"?: Record<string, string>;
}

function nodeAttrs(node: OrderedNode): Record<string, string> {
  return (node[":@"] as Record<string, string> | undefined) ?? {};
}

function nodeText(node: OrderedNode, tag: string): string {
  const children = node[tag] as OrderedNode[] | undefined;
  if (!children) return "";
  const text = children
    .map((c) => (typeof c === "object" && "#text" in c ? String(c["#text"]) : ""))
    .join("")
    .trim();
  return text;
}

/** The tag name of an ordered-parse element node, or null for
 * text/comment/attribute nodes. */
function elementTag(node: OrderedNode): string | null {
  for (const k of Object.keys(node)) {
    if (k === ":@" || k.startsWith("#") || k.startsWith("?")) continue;
    if (Array.isArray(node[k])) return k;
  }
  return null;
}

/** Convert one ordered-parse node inside <steps> to a ParsedStep. Returns
 * null for non-element nodes (text, comments). */
function stepNodeToParsedStep(child: OrderedNode): ParsedStep | null {
  const attrs = nodeAttrs(child);
  const desc = attrs.description ?? attrs.desc;

  if (child.usermessage !== undefined) {
    const text = nodeText(child, "usermessage");
    const value = attrs.value ?? text;
    const description = desc || (attrs.value ? text : undefined);
    return { type: "message", value, description, adapter: attrs.adapter };
  }

  if (child.step !== undefined || child.script !== undefined) {
    const tag = child.step !== undefined ? "step" : "script";
    const text = nodeText(child, tag);
    const src = attrs.src ?? attrs.script;
    const hasSource = !!src || !!attrs.value;
    const stepValue = hasSource ? (attrs.value || undefined) : (text || undefined);
    const stepArgs: Record<string, string> = {};
    for (const [k, v] of Object.entries(attrs)) {
      if (["src", "script", "description", "desc", "lang", "runner", "adapter", "value"].includes(k)) continue;
      stepArgs[k] = v;
    }
    return {
      type: "script",
      description: desc || (hasSource ? text || undefined : undefined),
      src,
      lang: attrs.lang,
      runner: attrs.runner,
      args: stepArgs,
      adapter: attrs.adapter,
      value: stepValue,
    };
  }

  if (child.picture !== undefined) {
    return {
      type: "picture",
      name: attrs.name,
      selector: attrs.selector,
      fullPage: attrs.fullPage === "true" || attrs.fullPage === "",
      description: desc || nodeText(child, "picture") || undefined,
    };
  }

  if (child.video !== undefined) {
    const inner = (child.video as OrderedNode[])
      .map(stepNodeToParsedStep)
      .filter((s): s is ParsedStep => s !== null);
    return {
      type: "video",
      name: attrs.name,
      children: inner,
      description: desc || undefined,
    };
  }

  if (child.assertions !== undefined) {
    const assertNodes = (child.assertions as OrderedNode[]).filter((a) => a.assert !== undefined);
    return {
      type: "assertions",
      description: desc || nodeText(child, "assertions") || undefined,
      assertions: assertNodes.map((a) =>
        parseAssertAttrs(nodeAttrs(a), nodeText(a, "assert") || undefined)
      ),
    };
  }

  // Custom tag — routed to the flow adapter declaring it. Attributes pass
  // through as step args (minus the adapter/selector keys).
  const tag = elementTag(child);
  if (!tag) return null;
  const text = nodeText(child, tag);
  const stepArgs: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (["src", "script", "description", "desc", "adapter", "value"].includes(k)) continue;
    stepArgs[k] = v;
  }
  return {
    type: tag,
    description: desc || (attrs.value ? text : undefined) || undefined,
    value: attrs.value ?? (text || undefined),
    src: attrs.src ?? attrs.script,
    adapter: attrs.adapter,
    args: stepArgs,
  };
}

/**
 * Extract the ordered <steps> children of the i-th <flow> from an ordered
 * (preserveOrder) parse of the same XML document. Returns null if the shapes
 * don't line up — callers fall back to the flat parse.
 */
function orderedStepsForFlow(orderedDoc: OrderedNode[], flowIndex: number): ParsedStep[] | null {
  const stepsChildren = orderedStepsChildren(orderedDoc, flowIndex);
  if (!stepsChildren) return null;

  const steps: ParsedStep[] = [];
  for (const child of stepsChildren) {
    const step = stepNodeToParsedStep(child);
    if (step) steps.push(step);
  }
  return steps;
}

/** The ordered children of the <steps> element of the i-th <flow>, or null. */
function orderedStepsChildren(orderedDoc: OrderedNode[], flowIndex: number): OrderedNode[] | null {
  const flowsNode = orderedDoc.find((n) => n.flows !== undefined)?.flows as OrderedNode[] | undefined;
  const flowNodes = (flowsNode ?? []).filter((n) => n.flow !== undefined);
  const flowChildren = flowNodes[flowIndex]?.flow as OrderedNode[] | undefined;
  if (!flowChildren) return null;
  return (flowChildren.find((n) => n.steps !== undefined)?.steps as OrderedNode[] | undefined) ?? [];
}

// ── Reusable step files ────────────────────────────────────────────────────
//
// A step file is an .xml file containing exactly one step element:
//   steps/login.xml   →   <step src="ft-login.ts"/>
// It is bound from a flow by name (file basename minus .xml) or by path:
//   <step action="login"/>              searches the step dirs for login.xml
//   <step file="steps/login.xml"/>      explicit path, relative to the flow
// Step dirs: the flow's own dir, its steps/ subdir, plus every dir listed in
// an include="dirA,dirB" attribute on <flows>, <flow> or <steps>.

/** Collect include="..." specs from <flows>, <flow> and <steps> (ordered
 * parse first, flat parse as fallback/merge). */
function collectStepIncludes(
  parsed: any,
  rawFlow: any,
  orderedDoc: OrderedNode[] | null,
  flowIndex: number
): string[] {
  const specs: string[] = [];
  const push = (v: unknown) => {
    if (typeof v !== "string") return;
    for (const part of v.split(",")) {
      const t = part.trim();
      if (t) specs.push(t);
    }
  };

  push(parsed?.flows?.include);
  push(rawFlow?.include);
  if (rawFlow?.steps && typeof rawFlow.steps === "object") push(rawFlow.steps.include);

  if (orderedDoc) {
    const flowsNode = orderedDoc.find((n) => n.flows !== undefined);
    const flowNodes = ((flowsNode?.flows as OrderedNode[] | undefined) ?? []).filter(
      (n) => n.flow !== undefined
    );
    const flowNode = flowNodes[flowIndex];
    const stepsNode = ((flowNode?.flow as OrderedNode[] | undefined) ?? []).find(
      (n) => n.steps !== undefined
    );
    push(nodeAttrs(flowsNode ?? {}).include);
    push(nodeAttrs(flowNode ?? {}).include);
    push(nodeAttrs(stepsNode ?? {}).include);
  }

  return specs;
}

/** Absolute search dirs for named step lookup: flow dir, flowDir/steps, then
 * the include dirs (resolved against the flow dir). Include dirs must exist. */
function stepSearchDirs(flowDir: string, includeSpecs: string[]): string[] {
  const dirs: string[] = [resolve(flowDir), resolve(flowDir, "steps")];
  for (const spec of includeSpecs) {
    const dir = resolve(flowDir, spec);
    if (!existsSync(dir) || !lstatSync(dir).isDirectory()) {
      throw new Error(`steps include '${spec}' does not resolve to a directory (${dir})`);
    }
    dirs.push(dir);
  }
  return [...new Set(dirs)];
}

type StepRef = { kind: "name"; value: string } | { kind: "file"; value: string };

/** A <step> is a step-file reference when it carries file= (always) or
 * action= without adapter/src — action= is an adapter arg otherwise. */
function stepRefOf(step: ParsedStep): StepRef | null {
  if (step.type !== "script") return null;
  const file = step.args?.file;
  const action = step.args?.action;
  if (file !== undefined) {
    if (step.adapter) {
      throw new Error(`<step file="${file}"> cannot be combined with adapter="${step.adapter}"`);
    }
    if (step.src) {
      throw new Error(`<step file="${file}"> cannot be combined with src="${step.src}"`);
    }
    return { kind: "file", value: String(file) };
  }
  if (action !== undefined && !step.adapter && !step.src) {
    return { kind: "name", value: String(action) };
  }
  return null;
}

/** Load a step file: an .xml file with exactly one step element — either a
 * single root element (<step>, <script>, <usermessage>, <assertions>, or a
 * custom adapter tag) or a <steps> wrapper around a single child. */
function loadStepFile(filePath: string): ParsedStep {
  const xml = readFileSync(filePath, "utf-8");
  let doc: OrderedNode[];
  try {
    doc = orderParser.parse(xml) as OrderedNode[];
  } catch (err) {
    throw new Error(
      `Step file ${filePath} is not valid XML: ${err instanceof Error ? err.message : err}`
    );
  }

  const elements = doc.filter((n) => elementTag(n) !== null);
  let stepNode: OrderedNode | undefined;

  if (elements.length === 1 && elementTag(elements[0]) === "steps") {
    const children = ((elements[0].steps as OrderedNode[] | undefined) ?? []).filter(
      (n) => elementTag(n) !== null
    );
    if (children.length !== 1) {
      throw new Error(
        `Step file ${filePath} must contain exactly one step element (found ${children.length})`
      );
    }
    stepNode = children[0];
  } else if (elements.length === 1) {
    const tag = elementTag(elements[0]);
    if (tag === "flows" || tag === "flow") {
      throw new Error(`Step file ${filePath} must contain a single step, not <${tag}>`);
    }
    stepNode = elements[0];
  } else {
    throw new Error(
      `Step file ${filePath} must contain exactly one step element (found ${elements.length})`
    );
  }

  const step = stepNodeToParsedStep(stepNode);
  if (!step) {
    throw new Error(`Step file ${filePath} does not contain a usable step element`);
  }
  return step;
}

/**
 * Resolve <step action="name"/> and <step file="path.xml"/> references in a
 * step list. The bound step's attributes (src, adapter, args, …) are taken
 * from the step file; attributes on the referencing step merge into its args
 * (caller wins) and desc/description override. src paths inside the step file
 * resolve relative to the step file's directory. Refs may nest (a step file
 * can itself hold an action=/file= ref) — cycles are an error.
 */
export function expandStepRefs(
  steps: ParsedStep[],
  flowDir: string,
  includeSpecs: string[] = []
): ParsedStep[] {
  const dirs = stepSearchDirs(flowDir, includeSpecs);

  const expand = (step: ParsedStep, stack: string[]): ParsedStep => {
    const ref = stepRefOf(step);
    if (!ref) return step;

    let file: string;
    if (ref.kind === "file") {
      if (!ref.value.endsWith(".xml")) {
        throw new Error(`<step file="${ref.value}"> must point to an .xml step file`);
      }
      file = resolve(flowDir, ref.value);
      if (!existsSync(file)) {
        throw new Error(`Step file not found: ${file} (referenced by <step file="${ref.value}">)`);
      }
    } else {
      const name = ref.value.replace(/\.xml$/, "");
      const candidates = dirs
        .map((d) => join(d, `${name}.xml`))
        .filter((p) => existsSync(p) && lstatSync(p).isFile());
      if (candidates.length === 0) {
        throw new Error(
          `No step file '${name}.xml' found for <step action="${ref.value}">. ` +
            `Searched: ${dirs.join(", ")}`
        );
      }
      if (candidates.length > 1) {
        throw new Error(
          `Step name '${name}' is ambiguous — found in: ${candidates.join(", ")}. ` +
            `Use <step file="path/to/${name}.xml"> to pick one.`
        );
      }
      file = candidates[0];
    }

    if (stack.includes(file)) {
      throw new Error(`Circular step reference: ${[...stack, file].join(" → ")}`);
    }

    const loaded = loadStepFile(file);
    if (loaded.src) {
      loaded.src = relative(flowDir, resolve(dirname(file), loaded.src));
    }

    const { action: _action, file: _file, ...refArgs } = step.args ?? {};
    const mergedArgs = { ...(loaded.args ?? {}), ...refArgs };
    const merged: ParsedStep = {
      ...loaded,
      description: step.description ?? (step.value || undefined) ?? loaded.description,
      lang: step.lang ?? loaded.lang,
      runner: step.runner ?? loaded.runner,
      args: Object.keys(mergedArgs).length > 0 ? mergedArgs : undefined,
    };

    return expand(merged, [...stack, file]);
  };

  return steps.map((s) => expand(s, []));
}

/**
 * Parse an XML flow file into ParsedFlow[]. Throws on missing file,
 * non-XML paths, and files with no <flow> elements.
 */
export function loadFlowsFromFile(filePath: string): ParsedFlow[] {
  if (!existsSync(filePath) || lstatSync(filePath).isDirectory()) {
    throw new Error(`The --file path must point to an XML file, not a directory: ${filePath}`);
  }

  const xml = readFileSync(filePath, "utf-8");
  const parsed = xmlParser.parse(xml);

  const rawFlows = parsed.flows?.flow;
  if (!rawFlows) {
    throw new Error(`No <flow> elements found in ${filePath}`);
  }

  const flowArray = Array.isArray(rawFlows) ? rawFlows : [rawFlows];

  // Second pass with preserveOrder so <steps> children keep document order —
  // <assertions> blocks interleaved between <step>s become numbered
  // verification steps instead of being flattened to the end.
  let orderedDoc: OrderedNode[] | null = null;
  try {
    orderedDoc = orderParser.parse(xml) as OrderedNode[];
  } catch {
    orderedDoc = null;
  }

  const flowDir = dirname(filePath);

  return flowArray.map((f: any, i: number) => {
    const flow = parseFlow(f);
    const ordered = orderedDoc ? orderedStepsForFlow(orderedDoc, i) : null;
    if (ordered) {
      flow.steps = ordered;
      // Keep flow.assertions as the flattened union (execution semantics:
      // assertions are still evaluated after the script steps run).
      flow.assertions = ordered
        .filter((s) => s.type === "assertions")
        .flatMap((s) => s.assertions ?? []);
    }
    const includeSpecs = collectStepIncludes(parsed, f, orderedDoc, i);
    flow.steps = expandStepRefs(flow.steps, flowDir, includeSpecs);
    return flow;
  });
}

/**
 * Lenient variant used by `axn-dev serve` for discovery: returns an empty
 * array for missing/unparseable files instead of throwing.
 */
export function loadFlowsFromFileSafe(filePath: string): ParsedFlow[] {
  try {
    return loadFlowsFromFile(filePath);
  } catch {
    return [];
  }
}

/** Flat-parse a <step>/<script> node — fallback used when the ordered
 * (preserveOrder) parse is unavailable; document order is lost. */
function flatScriptStep(s: any): ParsedStep {
  const text = typeof s === "string" ? s : (s?.["#text"] ?? "");
  const src = typeof s === "object" ? (s?.src ?? s?.script) : undefined;
  const valueAttr = typeof s === "object" ? s?.value : undefined;
  const hasSource = !!src || !!valueAttr;
  const stepArgs: Record<string, string> = {};
  if (s && typeof s === "object") {
    for (const [k, v] of Object.entries(s)) {
      if (["#text", "src", "script", "description", "desc", "lang", "runner", "adapter", "value"].includes(k)) continue;
      if (typeof v === "string") stepArgs[k] = v;
    }
  }
  return {
    type: "script",
    description: (typeof s === "object" ? (s?.description ?? s?.desc) : undefined) || (hasSource ? text || undefined : undefined),
    src,
    lang: typeof s === "object" ? s?.lang : undefined,
    runner: typeof s === "object" ? s?.runner : undefined,
    args: stepArgs,
    adapter: typeof s === "object" ? s?.adapter : undefined,
    value: hasSource ? (valueAttr || undefined) : (text || undefined),
  };
}

/** Flat-parse a <picture> evidence node (fallback for the flat parse). */
function flatPictureStep(p: any): ParsedStep {
  return {
    type: "picture",
    name: p?.name,
    selector: p?.selector,
    fullPage: p?.fullPage === "true" || p?.fullPage === "",
    description: p?.description ?? p?.desc ?? (typeof p === "object" ? p?.["#text"] : undefined),
  };
}

export function parseFlow(raw: any): ParsedFlow {
  const name = raw.name;
  if (!name) throw new Error("<flow> is missing the 'name' attribute");

  const scenarios = (raw.scenarios?.scenario || []).map((s: any) => ({
    name: s.name,
    service: s.service,
    adapter: s.adapter,
    project: s.project,
    workingDirectory: s.workingDirectory,
    branch: s.branch,
    readiness: parseReadiness(s.readiness),
    orchestrator: s.orchestrator,
  }));

  const models = (raw.setup?.models?.model || []).map((m: any) => ({
    provider: m.provider,
    name: m.name,
  }));

  const toolMode = raw.setup?.["tool-mode"]?.["#text"] || raw.setup?.["tool-mode"];
  const useDocker = (raw.setup?.["use-docker"]?.["#text"] || raw.setup?.["use-docker"]) === "true";

  const rawEnv = raw.setup?.env?.var ?? raw.env?.var;
  const envArray = rawEnv ? (Array.isArray(rawEnv) ? rawEnv : [rawEnv]) : [];
  const env: Record<string, string> = {};
  for (const v of envArray) {
    if (v.name) {
      env[v.name] = v.value ?? "";
    }
  }

  const rawSteps = raw.steps;
  const rawUserMessage = rawSteps?.usermessage;
  let userMessage = "";
  let userMessageDesc: string | undefined;
  let userMessageAdapter: string | undefined;
  if (typeof rawUserMessage === "string") {
    userMessage = rawUserMessage;
  } else if (rawUserMessage && typeof rawUserMessage === "object") {
    const text = rawUserMessage["#text"] ?? "";
    userMessageAdapter = rawUserMessage.adapter;
    userMessage = rawUserMessage.value ?? text;
    userMessageDesc = rawUserMessage.description ?? rawUserMessage.desc ?? (rawUserMessage.value ? text : undefined);
  }

  const rawTags = raw.tags?.tag;
  const tags = rawTags
    ? (Array.isArray(rawTags) ? rawTags : [rawTags]).map((t: any) =>
        typeof t === "string" ? t : t?.["#text"]
      ).filter(Boolean)
    : undefined;

  const steps: ParsedStep[] = [];
  if (userMessage) {
    steps.push({ type: "message", value: userMessage, description: userMessageDesc, adapter: userMessageAdapter });
  }

  const rawStepItems = rawSteps?.step ?? rawSteps?.script;
  const stepArray = rawStepItems ? (Array.isArray(rawStepItems) ? rawStepItems : [rawStepItems]) : [];
  for (const s of stepArray) {
    steps.push(flatScriptStep(s));
  }

  // Evidence steps — document order is lost in the flat parse; they are
  // appended after the script steps (the ordered parse preserves position).
  const rawPictures = rawSteps?.picture
    ? (Array.isArray(rawSteps.picture) ? rawSteps.picture : [rawSteps.picture])
    : [];
  for (const p of rawPictures) {
    steps.push(flatPictureStep(p));
  }

  const rawVideos = rawSteps?.video
    ? (Array.isArray(rawSteps.video) ? rawSteps.video : [rawSteps.video])
    : [];
  for (const v of rawVideos) {
    const children: ParsedStep[] = [];
    const innerScripts = v?.step ?? v?.script;
    const innerArray = innerScripts
      ? (Array.isArray(innerScripts) ? innerScripts : [innerScripts])
      : [];
    for (const s of innerArray) {
      children.push(flatScriptStep(s));
    }
    const innerPictures = v?.picture
      ? (Array.isArray(v.picture) ? v.picture : [v.picture])
      : [];
    for (const p of innerPictures) {
      children.push(flatPictureStep(p));
    }
    steps.push({
      type: "video",
      name: v?.name,
      children,
      description: v?.description ?? v?.desc,
    });
  }

  const assertions = (rawSteps?.assertions?.assert || []).map((a: any) =>
    typeof a === "object" && a !== null
      ? parseAssertAttrs(a, a["#text"])
      : parseAssertAttrs({})
  );

  return {
    name,
    description: raw.description?.["#text"] || raw.description,
    scenarios,
    orchestrator: raw.orchestrator,
    models,
    env,
    toolMode,
    useDocker,
    userMessage,
    steps,
    assertions,
    tags,
  };
}

export function parseReadiness(raw: any): ParsedReadiness[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((r: any) => ({
    service: r.service,
    path: r.path,
    port: r.port,
    method: r.method,
    expected: r.expected,
    timeout: r.timeout,
  }));
}

// ── Flow discovery (shared by `axn-dev flow` and `axn-dev serve`) ────────────

/** A single <flow> definition discovered in a repo's flows/ dir. */
export interface FlowInfo {
  /** Flow name from <flow name="..."> */
  name: string;
  description?: string;
  /** Absolute path to the .xml file containing this flow */
  file: string;
  /** Basename of the xml file, e.g. product-e2e.xml */
  fileName: string;
  /** Repo root containing the flows/ dir */
  root: string;
  /** Repo name (config key) or basename of the repo dir */
  rootName: string;
  /** "global" = integration repo flows/, "project" = repo-local flows/ */
  scope: "global" | "project";
  adapters: string[];
  models: string[];
  orchestrator?: string;
  /** Tags for grouping/filtering in `axn-dev serve`. */
  tags?: string[];
}

/** A flow report file on disk. */
export interface FlowReportFile {
  /** Absolute path */
  file: string;
  fileName: string;
  root: string;
  timestamp: string;
  /** Total / passed flow entries inside */
  total: number;
  passed: number;
  flowNames: string[];
}

function scanFlowsDir(root: string, scope: "global" | "project", rootName?: string): FlowInfo[] {
  const flowsDir = join(root, "flows");
  if (!existsSync(flowsDir)) return [];

  const flows: FlowInfo[] = [];
  for (const entry of readdirSync(flowsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".xml")) continue;
    const file = join(flowsDir, entry.name);

    for (const f of loadFlowsFromFileSafe(file)) {
      flows.push({
        name: f.name,
        description: f.description,
        file,
        fileName: entry.name,
        root,
        rootName: rootName ?? basename(root),
        scope,
        adapters: [...new Set(f.scenarios.map((s) => s.adapter).filter(Boolean))],
        models: f.models.map((m) => [m.provider, m.name].filter(Boolean).join("/")),
        orchestrator: f.orchestrator,
        tags: f.tags,
      });
    }
  }
  return flows;
}

/** Map repo checkout path → config repo name (for nicer rootName display). */
function repoNameByPath(config: AxnDevConfig): Map<string, string> {
  const map = new Map<string, string>();
  for (const [name, repoPath] of Object.entries(config.repos)) {
    for (const wt of getWorktreeInfo(repoPath).worktrees) {
      map.set(resolve(wt.path).replace(/\/+$/, ""), name);
    }
    map.set(resolve(repoPath).replace(/\/+$/, ""), name);
  }
  return map;
}

/** Async variant of repoNameByPath — worktree lookups run in parallel. */
async function repoNameByPathAsync(config: AxnDevConfig): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  await Promise.all(
    Object.entries(config.repos).map(async ([name, repoPath]) => {
      const { worktrees } = await getWorktreeInfoAsync(repoPath);
      for (const wt of worktrees) {
        map.set(resolve(wt.path).replace(/\/+$/, ""), name);
      }
      map.set(resolve(repoPath).replace(/\/+$/, ""), name);
    }),
  );
  return map;
}

/**
 * Global flows: flows/*.xml inside each configured integration repo.
 */
export function discoverFlows(integrationRoots: string[], nameMap?: Map<string, string>): FlowInfo[] {
  const flows = integrationRoots.flatMap((root) =>
    scanFlowsDir(root, "global", nameMap?.get(resolve(root).replace(/\/+$/, ""))));
  return flows.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Project flows: flows/*.xml inside every worktree of every configured repo
 * (excluding repos that are configured as integration roots — those are global).
 */
export function discoverProjectFlows(config: AxnDevConfig): FlowInfo[] {
  const integrationPaths = new Set(config.integration.map((p) => resolve(p).replace(/\/+$/, "")));
  const flows: FlowInfo[] = [];
  const seen = new Set<string>();

  for (const [repoName, repoPath] of Object.entries(config.repos)) {
    const { worktrees } = getWorktreeInfo(repoPath);
    for (const wt of worktrees) {
      const wtPath = resolve(wt.path).replace(/\/+$/, "");
      if (seen.has(wtPath) || integrationPaths.has(wtPath)) continue;
      seen.add(wtPath);
      if (!existsSync(wt.path) || !existsSync(join(wt.path, ".git"))) continue;
      flows.push(...scanFlowsDir(wt.path, "project", repoName));
    }
  }

  return flows;
}

/** Async variant of discoverProjectFlows — per-repo git lookups run in parallel. */
export async function discoverProjectFlowsAsync(config: AxnDevConfig): Promise<FlowInfo[]> {
  const integrationPaths = new Set(config.integration.map((p) => resolve(p).replace(/\/+$/, "")));
  const seen = new Set<string>();

  const perRepo = await Promise.all(
    Object.entries(config.repos).map(async ([repoName, repoPath]) => {
      const { worktrees } = await getWorktreeInfoAsync(repoPath);
      const flows: FlowInfo[] = [];
      for (const wt of worktrees) {
        const wtPath = resolve(wt.path).replace(/\/+$/, "");
        if (seen.has(wtPath) || integrationPaths.has(wtPath)) continue;
        seen.add(wtPath);
        if (!existsSync(wt.path) || !existsSync(join(wt.path, ".git"))) continue;
        flows.push(...scanFlowsDir(wt.path, "project", repoName));
      }
      return flows;
    }),
  );

  return perRepo.flat();
}

/**
 * All flows: global (integration) + project (repo-local), name-sorted.
 */
export function discoverAllFlows(config: AxnDevConfig): FlowInfo[] {
  const nameMap = repoNameByPath(config);
  return [...discoverFlows(config.integration, nameMap), ...discoverProjectFlows(config)]
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Async variant of discoverAllFlows — used by `axn-dev serve`. */
export async function discoverAllFlowsAsync(config: AxnDevConfig): Promise<FlowInfo[]> {
  const [nameMap, projectFlows] = await Promise.all([
    repoNameByPathAsync(config),
    discoverProjectFlowsAsync(config),
  ]);
  return [...discoverFlows(config.integration, nameMap), ...projectFlows]
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * All roots allowed to serve as flow sources — used for path validation.
 */
export function flowRoots(config: AxnDevConfig): string[] {
  const roots = new Set<string>(config.integration.map((p) => resolve(p).replace(/\/+$/, "")));
  for (const [, repoPath] of Object.entries(config.repos)) {
    for (const wt of getWorktreeInfo(repoPath).worktrees) {
      if (existsSync(wt.path) && existsSync(join(wt.path, ".git"))) {
        roots.add(resolve(wt.path).replace(/\/+$/, ""));
      }
    }
  }
  return [...roots];
}

/** Async variant of flowRoots — per-repo git lookups run in parallel. */
export async function flowRootsAsync(config: AxnDevConfig): Promise<string[]> {
  const roots = new Set<string>(config.integration.map((p) => resolve(p).replace(/\/+$/, "")));
  await Promise.all(
    Object.values(config.repos).map(async (repoPath) => {
      const { worktrees } = await getWorktreeInfoAsync(repoPath);
      for (const wt of worktrees) {
        if (existsSync(wt.path) && existsSync(join(wt.path, ".git"))) {
          roots.add(resolve(wt.path).replace(/\/+$/, ""));
        }
      }
    }),
  );
  return [...roots];
}

/** Find a single flow by file + name. */
export function findFlow(roots: string[], file: string, name: string): FlowInfo | null {
  return discoverFlows(roots).find((f) => f.file === file && f.name === name) ?? null;
}

/**
 * List flow report files under <root>/flows/.reports, newest first.
 */
export function listFlowReports(roots: string[]): FlowReportFile[] {
  const reports: FlowReportFile[] = [];

  for (const root of roots) {
    const dir = join(root, "flows", ".reports");
    if (!existsSync(dir)) continue;

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith("flow-report-") || !entry.name.endsWith(".json")) continue;
      const file = join(dir, entry.name);
      try {
        const report = JSON.parse(readFileSync(file, "utf-8")) as FlowReport;
        const entries = report.flows ?? [];
        reports.push({
          file,
          fileName: entry.name,
          root,
          timestamp: report.timestamp ?? "",
          total: entries.length,
          passed: entries.filter((e) => e.passed).length,
          flowNames: entries.map((e) => e.flow),
        });
      } catch {
        // skip unreadable reports
      }
    }
  }

  return reports.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export function loadFlowReport(file: string): FlowReport | null {
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as FlowReport;
  } catch {
    return null;
  }
}

/** Guard: report paths must live inside a flows/.reports dir of a known root. */
export function isReportPathAllowed(file: string, roots: string[]): boolean {
  const dir = resolve(dirname(file));
  if (basename(dir) !== ".reports") return false;
  if (basename(dirname(dir)) !== "flows") return false;
  return roots.includes(resolve(dirname(dirname(dir))).replace(/\/+$/, ""));
}

/** Guard: evidence paths must live under <root>/flows/.reports/evidence/ of a known root. */
export function isEvidencePathAllowed(file: string, roots: string[]): boolean {
  const resolved = resolve(file);
  for (const root of roots) {
    const prefix = join(resolve(root), "flows", ".reports", "evidence") + sep;
    if (resolved.startsWith(prefix)) return true;
  }
  return false;
}

/** Structural check: is this path inside any .reports/evidence/ directory? */
export function isUnderEvidenceDir(file: string): boolean {
  const resolved = resolve(file);
  const marker = join(".reports", "evidence") + sep;
  return resolved.includes(marker);
}

/** Guard: flow file paths must be an .xml inside a flows/ dir of a known root. */
export function isFlowFileAllowed(file: string, roots: string[]): boolean {
  if (!file.endsWith(".xml")) return false;
  const dir = resolve(dirname(file));
  if (basename(dir) !== "flows") return false;
  return roots.includes(resolve(dirname(dir)).replace(/\/+$/, ""));
}

/** Write a FlowReport to the .reports directory next to the flow file (flows/.reports). */
export function writeFlowReport(filePath: string, results: FlowResult[]): string {
  const reportsDir = join(dirname(filePath), ".reports");
  if (!existsSync(reportsDir)) {
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(join(reportsDir, ".gitignore"), "*\n");
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const report: FlowReport = { timestamp, flows: results };
  const fileName = `flow-report-${timestamp}.json`;
  const reportPath = join(reportsDir, fileName);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return reportPath;
}

function evidenceSlug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "flow";
}

/**
 * Create (and return) the evidence directory for one flow run:
 * <flowdir>/.reports/evidence/<flow-slug>-<timestamp>/ — under the same
 * gitignored .reports dir as the JSON reports.
 */
export function evidenceDirFor(filePath: string, flowName: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(dirname(filePath), ".reports", "evidence", `${evidenceSlug(flowName)}-${timestamp}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
