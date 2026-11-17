/**
 * .feature flow format — a Gherkin-flavoured front end for ParsedFlow.
 *
 * A file is an optional YAML frontmatter block followed by a Gherkin body.
 * The frontmatter carries everything Gherkin cannot express (scenarios, env,
 * models, orchestrator, runner); the body describes steps with Given/When/
 * Then keywords. Semantics are custom — no step-definition matching — but the
 * file stays parseable as ordinary Gherkin (blocks use `*` step lines).
 *
 *   ---
 *   orchestrator: orchestrators/playwright.ts
 *   runner: pw
 *   adapter: tsAdapter            # default adapter for script steps
 *   baseUrl: http://...           # scenario-less deployment target
 *   toolMode: ...                 # / useDocker: true
 *   include: steps,shared         # extra step-file search dirs
 *   tags: [smoke]                 # merged into every flow's tags
 *   scenarios:
 *     - name: demo-full
 *       service: web
 *       adapter: tsAdapter
 *       readiness:
 *         - { service: web, path: /, expected: "200" }
 *   env:    { ORGANIZER_USER: rsvp_mom }
 *   models: [ { provider: ollama, name: llama3.1 } ]
 *   ---
 *
 *   Feature: RSVP invite and respond
 *     Free-text lines here become the flow description.
 *
 *     Background:                 # steps prepended to every scenario
 *       Given step "db-cleanup"
 *
 *     @rsvp @smoke
 *     Scenario: invitee accepts
 *       Given step "keycloak-create-user"
 *         | username | rsvp_mom        |
 *         | email    | mom@rsvp.family |
 *       When step "um-login" TEST_USER="${ORGANIZER_USER}"
 *       And script "steps/rsvp-invite.ts"
 *       When the user says "What time is it?"
 *       Then the output contains "time"
 *       And there is 1 response
 *
 *     Scenario Outline: greeting <user>
 *       When the user says "hi <user>"
 *       Then the output contains "ok"
 *       Examples:
 *         | user |    # each row → one flow; <col> substitutes in steps,
 *         | mom  |    # and the row merges into the flow's env
 *
 * Producing step patterns (after Given/When/*):
 *   step "name" [k=v | k="v" ...]   step-file ref (like <step action="name"/>)
 *   step file "path.xml" [k=v ...]  step-file ref by path
 *   script "path.ts" [k=v ...]      script step (src=)
 *   script                          inline script — body from the docstring
 *   the user says "text"            usermessage; or `the user says` + docstring
 *   picture "name" [of "sel"] [fullpage]
 *   extract "sel" [as "name"] [attr "a"] [from "url"]
 *   <ident> [k=v ...]               custom adapter tag (<my-tag attr="v">)
 *   extra kv keys: adapter= lang= runner= desc= map to step fields,
 *   everything else goes to step args
 *
 * Assertion patterns (after Then; And/But continue the previous family):
 *   the output contains "x"      /  the new output contains "x"  (fresh)
 *   there is|are N response(s)
 *   the exit code is N
 *   it took less than N ms       /  it took between A and B ms    (duration)
 *   the page matches "ref.png"   /  "sel" matches "ref.png"       (screenshot)
 *   an llm judges "rubric" [using "judge"]
 *   script "x.ts" passes
 *   assert <that> [value] [k=v ...] [flag ...]   generic escape hatch —
 *   first bare token becomes value=, k=v become attrs, bare words after the
 *   value become boolean flags (e.g. `assert screenshot refs/a.png fullPage`)
 *   a data table right after a Then line merges k=v rows into its assert
 *
 * Blocks — custom syntax; children are the more-indented lines below them
 * (valid Gherkin only when `*`-prefixed):
 *   * video "name":
 *   * repeat 5: / * repeat 5 times: / * repeat 10 times at 80%:
 *   * stopwatch "id":
 *
 * Attachments:
 *   """ / ``` docstring under a step — message value, inline script code,
 *   or a description for other steps/asserts
 *   a `Then` line indented deeper than the preceding producing step binds
 *   to that step alone (like a nested <assert> in XML)
 *   | k | v | tables under a producing step become step args
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { load as loadYaml } from "js-yaml";
import { FLOW_RESERVED_STEP_NAMES } from "@axn-dev/core";
import {
  expandStepRefs,
  normalizeRunnerName,
  parseAssertAttrs,
  parseReadiness,
  stepRefOf,
  type ParsedAssertion,
  type ParsedFlow,
  type ParsedScenario,
  type ParsedStep,
} from "./flow-util.js";
import { validateFlow } from "./flow-validation.js";

// ── Line model ────────────────────────────────────────────────────────────

interface GLine {
  indent: number;
  text: string;
  no: number;
  /** docstring content + closing-fence lines — raw payload, never parsed */
  doc?: boolean;
}

class FeatureError extends Error {
  constructor(file: string, line: number | undefined, msg: string) {
    super(`${file}${line ? `:${line}` : ""}: ${msg}`);
  }
}

const FENCE_RE = /^("""|```)\s*$/;

/** Split the file into frontmatter (parsed yaml) and lexed body lines. */
function splitFrontmatter(file: string, text: string): { fm: any; body: GLine[] } {
  const raw = text.split("\n");
  let fm: any = null;
  let start = 0;
  if (raw[0]?.trim() === "---") {
    let end = -1;
    for (let i = 1; i < raw.length; i++) {
      const t = raw[i].trim();
      if (t === "---" || t === "...") {
        end = i;
        break;
      }
    }
    if (end < 0) throw new FeatureError(file, 1, `unterminated frontmatter — missing closing '---'`);
    try {
      fm = loadYaml(raw.slice(1, end).join("\n")) ?? {};
    } catch (err) {
      throw new FeatureError(file, 1, `invalid YAML frontmatter: ${err instanceof Error ? err.message : err}`);
    }
    if (typeof fm !== "object" || Array.isArray(fm)) {
      throw new FeatureError(file, 1, `frontmatter must be a YAML mapping`);
    }
    start = end + 1;
  }

  const body: GLine[] = [];
  let inDoc = false;
  let fence = "";
  for (let i = start; i < raw.length; i++) {
    const line = raw[i];
    const stripped = line.trimStart();
    const indent = line.length - stripped.length;
    const t = stripped.trimEnd();
    if (inDoc) {
      body.push({ indent, text: line.slice(indent), no: i + 1, doc: true });
      if (t === fence) inDoc = false;
      continue;
    }
    if (FENCE_RE.test(t)) {
      inDoc = true;
      fence = t;
    }
    body.push({ indent, text: t, no: i + 1 });
  }
  if (inDoc) throw new FeatureError(file, undefined, `unterminated docstring`);
  return { fm, body };
}

// ── Arg tokens ────────────────────────────────────────────────────────────

interface Tok {
  key?: string;
  val: string;
  bare: boolean;
}

function tokenize(rest: string): Tok[] {
  const out: Tok[] = [];
  for (const m of rest.matchAll(/([^\s"']+|"[^"]*"|'[^']*')+/g)) {
    const tok = m[0];
    const eq = tok.indexOf("=");
    if (eq > 0 && !tok.startsWith('"') && !tok.startsWith("'")) {
      let val = tok.slice(eq + 1);
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      out.push({ key: tok.slice(0, eq), val, bare: false });
    } else {
      const bare =
        (tok.startsWith('"') && tok.endsWith('"')) || (tok.startsWith("'") && tok.endsWith("'"))
          ? tok.slice(1, -1)
          : tok;
      out.push({ val: bare, bare: true });
    }
  }
  return out;
}

/** Trailing k=v tokens on a producing step: reserved keys land on step
 * fields (adapter/lang/runner/desc), everything else lands in args. */
function applyStepAttrs(step: ParsedStep, rest: string, file: string, no: number): ParsedStep {
  const args: Record<string, string> = { ...(step.args ?? {}) };
  for (const t of tokenize(rest)) {
    if (!t.key) {
      if (/^full\s?-?page$/i.test(t.val) && step.type === "picture") {
        step.fullPage = true;
        continue;
      }
      throw new FeatureError(file, no, `unexpected '${t.val}' — expected key=value arguments`);
    }
    switch (t.key) {
      case "adapter":
        step.adapter = t.val;
        break;
      case "lang":
        step.lang = t.val;
        break;
      case "runner":
        step.runner = t.val;
        break;
      case "desc":
      case "description":
        step.description = t.val;
        break;
      default:
        args[t.key] = t.val;
    }
  }
  if (Object.keys(args).length) step.args = args;
  return step;
}

// ── Step-line parsing ──────────────────────────────────────────────────────

interface ProducingMatch {
  step: ParsedStep;
  rest: string;
}

const PRODUCE_PATTERNS: [RegExp, (m: RegExpMatchArray) => ProducingMatch][] = [
  [/^step\s+file\s+"([^"]+)"(.*)$/is, (m) => ({ step: { type: "script", args: { file: m[1] } }, rest: m[2] })],
  [/^step\s+"([^"]+)"(.*)$/is, (m) => ({ step: { type: "script", args: { action: m[1] } }, rest: m[2] })],
  [/^script\s+"([^"]+)"(.*)$/is, (m) => ({ step: { type: "script", src: m[1] }, rest: m[2] })],
  [/^script\s*$/, () => ({ step: { type: "script" }, rest: "" })],
  [/^(?:the\s+)?user\s+(?:says|message)\s+"([^"]*)"\s*$/is, (m) => ({ step: { type: "message", value: m[1] }, rest: "" })],
  [/^(?:the\s+)?user\s+(?:says|message)\s*:?\s*$/i, () => ({ step: { type: "message" }, rest: "" })],
  [
    /^picture\s+"([^"]+)"(?:\s+of\s+"([^"]+)")?(.*)$/is,
    (m) => ({ step: { type: "picture", name: m[1], selector: m[2] }, rest: m[3] }),
  ],
  [
    /^extract\s+(?:attr\s+"([^"]+)"\s+)?"([^"]+)"(?:\s+as\s+"([^"]+)")?(?:\s+from\s+"([^"]+)")?(.*)$/is,
    (m) => ({
      step: { type: "extract", attr: m[1], selector: m[2], name: m[3], url: m[4] },
      rest: m[5],
    }),
  ],
];

const CUSTOM_TAG_RE = /^([a-zA-Z][\w-]*)\s*(.*)$/s;

/** Pattern-leading words that can never be a custom tag — they mean the user
 * typo'd a sugar pattern. */
const SUGAR_WORDS = new Set(["the", "a", "an", "user", "there", "it", "new", "output"]);

function parseProducingStep(file: string, line: GLine, text: string): ParsedStep {
  for (const [re, make] of PRODUCE_PATTERNS) {
    const m = text.match(re);
    if (m) {
      const { step, rest } = make(m);
      return applyStepAttrs(step, rest, file, line.no);
    }
  }
  const cm = text.match(CUSTOM_TAG_RE);
  if (cm) {
    const tag = cm[1];
    if (FLOW_RESERVED_STEP_NAMES.has(tag) || SUGAR_WORDS.has(tag.toLowerCase())) {
      throw new FeatureError(
        file,
        line.no,
        `unrecognized step: '${text}' — '${tag}' starts a built-in pattern; check its syntax`
      );
    }
    return applyStepAttrs({ type: tag }, cm[2], file, line.no);
  }
  throw new FeatureError(file, line.no, `unrecognized step: '${text}'`);
}

function parseAssertion(file: string, line: GLine, text: string): ParsedAssertion {
  let m: RegExpMatchArray | null;

  if ((m = text.match(/^the\s+(new\s+)?output\s+contains\s+"([^"]*)"(.*)$/is))) {
    return assertAttrs({ that: "contains", value: m[2], fresh: m[1] ? true : undefined }, m[3], file, line);
  }
  if (/does\s+not\s+contain/i.test(text)) {
    throw new FeatureError(
      file,
      line.no,
      `negated contains is not supported — express it with 'assert script' or an llm judge`
    );
  }
  if ((m = text.match(/^there\s+(?:is|are)\s+(\d+)\s+responses?\s*(.*)$/i))) {
    return assertAttrs({ that: "num_responses", value: m[1] }, m[2], file, line);
  }
  if ((m = text.match(/^the\s+exit\s*code\s+is\s+(-?\d+)\s*(.*)$/i))) {
    return assertAttrs({ that: "exitCode", value: m[1] }, m[2], file, line);
  }
  if ((m = text.match(/^(?:it|the\s+step)\s+took\s+between\s+(\d+)\s*(?:ms)?\s+and\s+(\d+)\s*ms(.*)$/i))) {
    return assertAttrs({ that: "duration", min: Number(m[1]), max: Number(m[2]) }, m[3], file, line);
  }
  if ((m = text.match(/^(?:it|the\s+step)\s+took\s+(?:less\s+than|at\s+most|under)\s+(\d+)\s*ms(.*)$/i))) {
    return assertAttrs({ that: "duration", max: Number(m[1]) }, m[2], file, line);
  }
  if ((m = text.match(/^the\s+page\s+matches\s+"([^"]+)"(.*)$/is))) {
    return assertAttrs({ that: "screenshot", value: m[1] }, m[2], file, line);
  }
  if ((m = text.match(/^"([^"]+)"\s+matches\s+"([^"]+)"(.*)$/is))) {
    return assertAttrs({ that: "screenshot", selector: m[1], value: m[2] }, m[3], file, line);
  }
  if ((m = text.match(/^an?\s+llm\s+judges\s+"([^"]*)"(?:\s+using\s+"([^"]+)")?(.*)$/is))) {
    return assertAttrs({ that: "llm", prompt: m[1], judge: m[2] }, m[3], file, line);
  }
  if ((m = text.match(/^script\s+"([^"]+)"\s+passes(.*)$/is))) {
    return assertAttrs({ that: "script", src: m[1] }, m[2], file, line);
  }
  if ((m = text.match(/^assert\s+([a-zA-Z_][\w-]*)\s*(.*)$/s))) {
    const attrs: Record<string, any> = { that: m[1] };
    let valueSet = false;
    for (const t of tokenize(m[2])) {
      if (t.key) {
        attrs[t.key] = t.val;
      } else if (!valueSet) {
        attrs.value = t.val;
        valueSet = true;
      } else {
        attrs[t.val] = true; // boolean flag
      }
    }
    return parseAssertAttrs(attrs);
  }
  throw new FeatureError(
    file,
    line.no,
    `unrecognized assertion: '${text}' — use 'assert <that> ...' for the generic form`
  );
}

/** Trailing k=v on a sugar pattern → extra assertion attrs (selector=, wait=, …). */
function assertAttrs(
  base: Record<string, any>,
  rest: string | undefined,
  file: string,
  line: GLine
): ParsedAssertion {
  const attrs = { ...base };
  for (const t of tokenize(rest ?? "")) {
    if (!t.key) throw new FeatureError(file, line.no, `unexpected '${t.val}' — expected key=value attributes`);
    attrs[t.key] = t.val;
  }
  return parseAssertAttrs(attrs);
}

// ── Step-list parsing (indentation-aware) ─────────────────────────────────

const STEP_RE = /^(Given|When|Then|And|But|\*)\s+(.*)$/s;
const BLOCK_RE = /^(video|repeat|stopwatch)\s+([^:]*?)\s*:\s*$/is;

type Family = "produce" | "assert";

function isTable(line: GLine): boolean {
  return !line.doc && line.text.startsWith("|") && line.text.endsWith("|");
}

function isFence(line: GLine): boolean {
  return !line.doc && FENCE_RE.test(line.text);
}

function tableRow(line: GLine): string[] {
  return line.text.slice(1, -1).split("|").map((c) => c.trim());
}

/** Skip blank/comment lines in a region — they carry no structure. */
function meaningful(line: GLine): boolean {
  return line.doc || (line.text !== "" && !line.text.startsWith("#"));
}

/** Words that lead assertion text — used to resolve `*` steps. */
const ASSERT_START_RE = /^(assert\b|there\b|an?\s+llm|the\s+(new\s+)?output|the\s+exit|the\s+page|the\s+step|it\b|"|script\s+"[^"]*"\s+passes)/i;

function isThenish(kw: string, last: Family | null, text: string): boolean {
  if (kw === "Then") return true;
  if (kw === "And" || kw === "But") return last === "assert";
  if (kw === "*") return ASSERT_START_RE.test(text);
  return false;
}

/**
 * Parse the step lines of a region starting at `start`, all at >= `indent`.
 * Stops at the first meaningful line with indent < `indent`.
 */
function parseSteps(
  file: string,
  lines: GLine[],
  start: number,
  indent: number
): { steps: ParsedStep[]; next: number } {
  const steps: ParsedStep[] = [];
  let last: Family | null = null;
  let i = start;

  while (i < lines.length) {
    const l = lines[i];
    if (!meaningful(l)) {
      i++;
      continue;
    }
    if (l.doc) throw new FeatureError(file, l.no, `dangling docstring — attach it under a step line`);
    if (l.indent < indent) break;
    if (l.indent > indent) {
      throw new FeatureError(file, l.no, `unexpected indentation — '${l.text}'`);
    }
    if (isTable(l)) throw new FeatureError(file, l.no, `dangling table — attach it under a step line`);
    if (isFence(l)) throw new FeatureError(file, l.no, `dangling docstring — attach it under a step line`);

    const sm = l.text.match(STEP_RE);
    const blockText = sm ? sm[2] : l.text;
    const bm = blockText.match(BLOCK_RE);

    // block headers: `* video "x":` or bare `video "x":` — children are the
    // deeper-indented lines below
    if (bm && (!sm || sm[1] === "*")) {
      i++;
      const child = nextMeaningful(lines, i);
      if (child === -1 || lines[child].indent <= indent) {
        throw new FeatureError(file, l.no, `'${bm[1]}' block has no children — indent them below the header`);
      }
      const sub = parseSteps(file, lines, child, lines[child].indent);
      i = sub.next;
      steps.push(makeBlock(file, l, bm[1].toLowerCase(), bm[2].trim(), sub.steps));
      last = "produce";
      continue;
    }

    if (!sm) {
      throw new FeatureError(file, l.no, `expected a step (Given/When/Then/And/But/*) — got '${l.text}'`);
    }
    const kw = sm[1];
    const text = sm[2];
    i++;

    if (isThenish(kw, last, text)) {
      // merge the whole Then/And/But run at this indent into one assertions step
      const asserts: ParsedAssertion[] = [parseAssertion(file, l, text)];
      last = "assert";
      while (i < lines.length) {
        const n = lines[i];
        if (!meaningful(n)) {
          i++;
          continue;
        }
        if (n.indent === indent) {
          const nm = n.text.match(STEP_RE);
          if (!nm || !isThenish(nm[1], "assert", nm[2])) break;
          asserts.push(parseAssertion(file, n, nm[2]));
          i++;
          continue;
        }
        if (n.indent > indent && isTable(n) && asserts.length) {
          // table under the last Then line → merge k=v rows into that assert
          const merged = { ...assertToAttrs(asserts[asserts.length - 1]) };
          while (i < lines.length && isTable(lines[i])) {
            const cells = tableRow(lines[i]);
            if (cells.length < 2) {
              throw new FeatureError(file, lines[i].no, `assert tables need two columns (key | value)`);
            }
            merged[cells[0]] = cells[1];
            i++;
          }
          asserts[asserts.length - 1] = parseAssertAttrs(merged);
          continue;
        }
        break;
      }
      steps.push({ type: "assertions", assertions: asserts });
      continue;
    }

    if ((kw === "And" || kw === "But") && last !== "produce") {
      throw new FeatureError(file, l.no, `'${kw}' here has no producing step to continue`);
    }
    const step = parseProducingStep(file, l, text);
    last = "produce";

    // attachments — deeper-indented (or fence/table at same indent) lines
    while (i < lines.length) {
      const n = lines[i];
      if (!meaningful(n)) {
        i++;
        continue;
      }
      const deeper = n.indent > indent;
      if (isFence(n) && n.indent >= indent) {
        i++;
        const content = collectDoc(lines, i);
        i = docEnd(lines, i);
        applyDocstring(step, content);
        continue;
      }
      if (isTable(n) && n.indent >= indent) {
        const args = { ...(step.args ?? {}) };
        while (i < lines.length && isTable(lines[i])) {
          const cells = tableRow(lines[i]);
          if (cells.length < 2) {
            throw new FeatureError(file, lines[i].no, `step tables need two columns (key | value)`);
          }
          args[cells[0]] = cells[1];
          i++;
        }
        step.args = args;
        continue;
      }
      if (deeper && !n.doc) {
        const nm = n.text.match(STEP_RE);
        if (nm && isThenish(nm[1], last, nm[2])) {
          step.assertions = [...(step.assertions ?? []), parseAssertion(file, n, nm[2])];
          last = "assert";
          i++;
          continue;
        }
        throw new FeatureError(file, n.no, `unexpected indented line '${n.text}'`);
      }
      break;
    }
    steps.push(step);
  }
  return { steps, next: i };
}

function nextMeaningful(lines: GLine[], i: number): number {
  while (i < lines.length && !meaningful(lines[i])) i++;
  return i < lines.length ? i : -1;
}

function collectDoc(lines: GLine[], i: number): string {
  const parts: string[] = [];
  while (i < lines.length && lines[i].doc && lines[i].text.trimEnd() !== '"""' && lines[i].text.trimEnd() !== "```") {
    parts.push(lines[i].text);
    i++;
  }
  return parts.join("\n").replace(/\n+$/, "");
}

function docEnd(lines: GLine[], i: number): number {
  while (i < lines.length && lines[i].doc) i++;
  return i;
}

function applyDocstring(step: ParsedStep, content: string): void {
  if (!content) return;
  if (step.type === "message" && !step.value) step.value = content;
  else if (step.type === "script" && !step.src && !step.args?.action && !step.args?.file) step.value = content;
  else if (!step.description) step.description = content;
}

/** Reverse of parseAssertAttrs — for merging table rows into an assert. */
function assertToAttrs(a: ParsedAssertion): Record<string, any> {
  const out: Record<string, any> = { that: a.that, value: a.value };
  for (const k of [
    "description", "prompt", "judge", "fresh", "src", "min", "max",
    "selector", "url", "fullPage", "maxDiff", "threshold", "viewport", "wait",
  ] as const) {
    if (a[k] !== undefined) out[k] = a[k];
  }
  return out;
}

function makeBlock(file: string, line: GLine, kind: string, arg: string, children: ParsedStep[]): ParsedStep {
  if (kind === "video" || kind === "stopwatch") {
    const m = arg.match(/^"([^"]+)"$/);
    if (!m) {
      throw new FeatureError(file, line.no, `${kind} needs a quoted name — '${kind} "name":'`);
    }
    return { type: kind, name: m[1], children };
  }
  // repeat — 'repeat 5:', 'repeat 5 times:', 'repeat 10 times at 80%:'
  const m = arg.match(/^(\d+)\s*(?:times?)?(?:\s*(?:,|at)\s*([\d.]+%?)\s*(?:success|passing|rate)?)?$/i);
  if (!m) {
    throw new FeatureError(file, line.no, `repeat needs a count — 'repeat 5:' or 'repeat 10 times at 80%:'`);
  }
  let success: number | undefined;
  if (m[2]) {
    const n = Number(m[2].replace(/%$/, ""));
    if (isNaN(n)) throw new FeatureError(file, line.no, `repeat success rate '${m[2]}' is not a number`);
    success = n > 1 ? n / 100 : n;
    if (success <= 0 || success > 1) {
      throw new FeatureError(file, line.no, `repeat success rate out of range — use (0,1] or 1–100%`);
    }
  }
  return { type: "repeat", num: parseInt(m[1], 10), success, children };
}

// ── Section / flow assembly ───────────────────────────────────────────────

interface RawScenario {
  name: string;
  outline: boolean;
  tags: string[];
  descLines: string[];
  lines: GLine[];
  examples: { header: string[]; rows: string[][] } | null;
}

const SECTION_RE = /^(Feature|Background|Scenario(?:\s+Outline)?|Examples|Rule)\s*:\s*(.*)$/is;
const TAG_RE = /^@[\w-]+/;

function substitute(text: string, row: Record<string, string>): string {
  return text.replace(/<(\w+)>/g, (all, name) => (name in row ? row[name] : all));
}

function substituteStep(step: ParsedStep, row: Record<string, string>): ParsedStep {
  const sub = (s?: string) => (s === undefined ? undefined : substitute(s, row));
  return {
    ...step,
    description: sub(step.description),
    value: sub(step.value),
    src: sub(step.src),
    name: sub(step.name),
    selector: sub(step.selector),
    url: sub(step.url),
    args: step.args
      ? Object.fromEntries(Object.entries(step.args).map(([k, v]) => [k, substitute(v, row)]))
      : undefined,
    assertions: step.assertions?.map((a) => ({
      ...a,
      value: substitute(a.value, row),
      prompt: sub(a.prompt),
      judge: sub(a.judge),
      description: sub(a.description),
      url: sub(a.url),
      selector: sub(a.selector),
    })),
    children: step.children?.map((c) => substituteStep(c, row)),
  };
}

/** Region ends at the next section boundary — Examples: belongs to its own
 * scenario, so it does not break the region. */
const REGION_BREAK_RE = /^(Feature|Background|Scenario(?:\s+Outline)?|Rule)\s*:/;

/** Collect the step region following a section header — everything until the
 * next section keyword or @tag line (docstring lines included). */
function collectRegion(body: GLine[], i: number): { region: GLine[]; next: number } {
  const region: GLine[] = [];
  let j = i;
  while (j < body.length) {
    const l = body[j];
    if (!l.doc && (REGION_BREAK_RE.test(l.text) || TAG_RE.test(l.text))) break;
    region.push(l);
    j++;
  }
  return { region, next: j };
}

/** Parse a .feature file into ParsedFlow[]. */
export function loadFlowsFromFeatureFile(filePath: string): ParsedFlow[] {
  if (!existsSync(filePath) || lstatSync(filePath).isDirectory()) {
    throw new Error(`The --file path must point to a .feature file, not a directory: ${filePath}`);
  }
  const { fm, body } = splitFrontmatter(filePath, readFileSync(filePath, "utf-8"));

  let featureName: string | undefined;
  const featureDesc: string[] = [];
  let background: GLine[] = [];
  const scenarios: RawScenario[] = [];
  let pendingTags: string[] = [];

  for (let i = 0; i < body.length; i++) {
    const l = body[i];
    if (l.doc) continue;
    if (!l.text || l.text.startsWith("#")) continue;

    if (TAG_RE.test(l.text)) {
      pendingTags.push(...(l.text.match(/@([\w-]+)/g) ?? []).map((x) => x.slice(1)));
      continue;
    }

    const sec = l.text.match(SECTION_RE);
    if (sec) {
      const kind = sec[1];
      const arg = sec[2].trim();
      if (/^Scenario/.test(kind)) {
        const cur: RawScenario = {
          name: arg,
          outline: /Outline/.test(kind),
          tags: pendingTags,
          descLines: [],
          lines: [],
          examples: null,
        };
        pendingTags = [];
        scenarios.push(cur);
        const { region, next } = collectRegion(body, i + 1);
        cur.lines = region;
        i = next - 1;
      } else if (kind === "Feature") {
        if (featureName !== undefined || scenarios.length) {
          throw new FeatureError(filePath, l.no, `only one Feature per file`);
        }
        featureName = arg;
      } else if (kind === "Background") {
        const { region, next } = collectRegion(body, i + 1);
        background = region;
        i = next - 1;
      } else if (kind === "Examples") {
        throw new FeatureError(filePath, l.no, `Examples: outside a Scenario Outline (must follow its steps)`);
      } else if (kind === "Rule") {
        throw new FeatureError(filePath, l.no, `Rule: is not supported by the flow dialect`);
      }
      continue;
    }

    if (scenarios.length) {
      throw new FeatureError(filePath, l.no, `content outside a Scenario — got '${l.text}'`);
    }
    if (featureName === undefined) {
      throw new FeatureError(filePath, l.no, `expected 'Feature:' — got '${l.text}'`);
    }
    featureDesc.push(l.text);
  }

  // Examples: sections are collected inside collectRegion — split them out now
  for (const sc of scenarios) {
    const ex = sc.lines.findIndex((l) => !l.doc && l.text.match(/^Examples\s*:/));
    if (ex === -1) continue;
    const exLines = sc.lines.splice(ex);
    exLines.shift(); // the Examples: header
    for (const l of exLines) {
      if (!meaningful(l) || l.doc) continue;
      if (isTable(l)) {
        const cells = tableRow(l);
        if (!sc.examples) sc.examples = { header: cells, rows: [] };
        else sc.examples.rows.push(cells);
      } else {
        throw new FeatureError(filePath, l.no, `expected an Examples table row — got '${l.text}'`);
      }
    }
  }

  if (!scenarios.length) {
    throw new FeatureError(filePath, undefined, `no Scenario found — every .feature needs at least one`);
  }
  if (pendingTags.length) {
    throw new FeatureError(filePath, undefined, `dangling @tags — they must precede a Scenario`);
  }

  // ── frontmatter → shared config ──
  const flowDir = dirname(filePath);
  const include = fm?.include;
  const includeSpecs = Array.isArray(include)
    ? include.map(String)
    : include
      ? String(include).split(",").map((s) => s.trim()).filter(Boolean)
      : [];
  const fmScenarios: ParsedScenario[] = (fm?.scenarios ?? []).map((s: any) => ({
    name: s?.name,
    service: s?.service,
    adapter: s?.adapter,
    project: s?.project,
    workingDirectory: s?.workingDirectory ?? s?.["working-directory"],
    branch: s?.branch,
    url: s?.url,
    orchestrator: s?.orchestrator,
    readiness: parseReadiness(s?.readiness),
  }));
  const fmEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(fm?.env ?? {})) fmEnv[k] = String(v);
  const fmTags: string[] = fm?.tags
    ? (Array.isArray(fm.tags) ? fm.tags : [fm.tags]).map(String)
    : [];

  const parsedAll = (lines: GLine[]): ParsedStep[] => {
    if (!lines.length) return [];
    const { steps, next } = parseSteps(filePath, lines, 0, nextIndent(lines));
    const leftover = lines.slice(next).find(meaningful);
    if (leftover) {
      throw new FeatureError(filePath, leftover.no, `inconsistent indentation — '${leftover.text}'`);
    }
    return steps;
  };

  const bgSteps = parsedAll(background);
  const desc = [fm?.description, featureDesc.join("\n").trim()].filter(Boolean).join("\n\n") || undefined;

  // description text inside a scenario region: non-step lines before the
  // first step line
  const splitDesc = (sc: RawScenario): void => {
    let k = 0;
    while (k < sc.lines.length) {
      const l = sc.lines[k];
      if (!meaningful(l) || l.doc) {
        k++;
        continue;
      }
      if (STEP_RE.test(l.text) || BLOCK_RE.test(l.text) || isTable(l) || isFence(l)) break;
      sc.descLines.push(l.text);
      k++;
    }
    sc.lines.splice(0, k);
  };

  // ── scenarios → flows ──
  const flows: ParsedFlow[] = [];
  for (const sc of scenarios) {
    splitDesc(sc);
    const rows = expandRows(filePath, sc);
    for (const row of rows) {
      const steps = parsedAll(sc.lines);
      const rowSub = row ?? undefined;
      const bodySteps = rowSub ? steps.map((s) => substituteStep(s, rowSub)) : steps;
      const bg = rowSub ? bgSteps.map((s) => substituteStep(s, rowSub)) : bgSteps;
      const flow: ParsedFlow = {
        name: substitute(sc.name, row ?? {}),
        description:
          [desc, sc.descLines.join("\n").trim() || undefined].filter(Boolean).join("\n\n") || undefined,
        scenarios: fmScenarios,
        orchestrator: fm?.orchestrator,
        runner: normalizeRunnerName(fm?.runner),
        adapter: fm?.adapter,
        baseUrl: fm?.baseUrl ?? fm?.["base-url"],
        models: (fm?.models ?? []).map((m: any) => ({
          provider: String(m?.provider ?? ""),
          name: String(m?.name ?? ""),
        })),
        env: row ? { ...fmEnv, ...row } : { ...fmEnv },
        toolMode: fm?.toolMode ?? fm?.["tool-mode"],
        useDocker: fm?.useDocker ?? fm?.["use-docker"],
        userMessage: "",
        steps: [...bg, ...bodySteps],
        assertions: [],
        tags: fmTags.length + sc.tags.length ? [...fmTags, ...sc.tags] : undefined,
      };
      flow.userMessage = flow.steps.find((s) => s.type === "message")?.value ?? "";
      flow.steps = expandStepRefs(flow.steps, flowDir, includeSpecs);
      if (flow.adapter) {
        flow.steps = flow.steps.map((s) =>
          s.type === "script" && !s.adapter && !stepRefOf(s) ? { ...s, adapter: flow.adapter } : s
        );
      }
      flow.assertions = flow.steps
        .filter((s) => s.type === "assertions")
        .flatMap((s) => s.assertions ?? []);
      validateFlow(flow);
      flows.push(flow);
    }
  }

  const seen = new Set<string>();
  for (const f of flows) {
    if (seen.has(f.name)) throw new FeatureError(filePath, undefined, `duplicate flow name '${f.name}'`);
    seen.add(f.name);
  }
  return flows;
}

function expandRows(file: string, sc: RawScenario): (Record<string, string> | null)[] {
  if (!sc.outline) return [null];
  if (!sc.examples || sc.examples.rows.length === 0) {
    throw new FeatureError(file, undefined, `Scenario Outline '${sc.name}' has no Examples table`);
  }
  const { header, rows } = sc.examples;
  return rows.map((r) => {
    if (r.length !== header.length) {
      throw new FeatureError(
        file,
        undefined,
        `Examples row has ${r.length} cells — expected ${header.length} (${header.join(", ")})`
      );
    }
    return Object.fromEntries(header.map((h, i) => [h, r[i]]));
  });
}

function nextIndent(lines: GLine[]): number {
  const first = lines.find(meaningful);
  return first ? first.indent : 0;
}
