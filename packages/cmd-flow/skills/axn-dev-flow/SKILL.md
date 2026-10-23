---
name: axn-dev-flow
description: Run XML-defined flow tests against scenarios, deployed devices, or any deployment URL with `axn-dev flow`. Supports the built-in tsAdapter (TypeScript/Playwright scripts), pluggable adapters (http, keycloak, custom tags), readiness checks, orchestrators, and JSON report output.
---

# axn-dev flow Skill

`axn-dev flow` runs XML-defined tests against Docker Compose scenarios, deployed devices (`-i`), or any already-running deployment (`--base-url` / `url=` on `<scenario>`). A flow describes which scenario to start, which model/adapter to use, the steps to execute, and assertions to verify.

## When to use this skill

- Regression-testing API behavior end-to-end (e.g. an agent or chat endpoint).
- Verifying that a specific user message still triggers the right response.
- Running TypeScript/Playwright E2E scripts against a scenario (`tsAdapter`).
- Testing against a deployed device (`-i <device>` with tsAdapter).
- Running the same prompt against multiple models (e.g. `ollama/llama3.1` and `openai/gpt-4o`).
- Collecting structured pass/fail reports over time.

## Repo layout

```
<integration-repo>/                # e.g. app-integration
├── flows/
│   ├── example.xml                # one or more <flow> definitions
│   └── .reports/                  # generated JSON reports (gitignored)
└── scenarios/
    └── app-dev/
        └── compose.yaml
```

## XML format

```xml
<?xml version="1.0" encoding="UTF-8"?>
<flows>
  <flow name="example - how late is it">
    <description>
      Example flow - about asking about current time
    </description>
    <scenarios>
      <scenario name="app-dev" service="app-server" adapter="http">
        <readiness path="/health" expected="ok"/>
      </scenario>
    </scenarios>
    <setup>
      <models>
        <model provider="ollama" name="llama3.1:latest"/>
      </models>
      <env>
        <var name="MY_VAR" value="value"/>
      </env>
    </setup>
    <steps>
      <usermessage>What time is it?</usermessage>
      <assertions>
        <assert that="num_responses" value="1"/>
        <assert that="contains" value="time"/>
      </assertions>
    </steps>
  </flow>
</flows>
```

### Elements

`<flow name="..." orchestrator="..." adapter="..." base-url="...">`:: A single test flow. `orchestrator` points to a TypeScript orchestrator script (see below). `adapter` is the *default step adapter* — `<step>`/`<script>` units without their own `adapter=` use it — e.g. `<flow adapter="axn-term">` lets a flow of adapter steps omit `adapter=` on every step; it does **not** affect `<usermessage>` or custom tags. `base-url` is the *default deployment URL* — a scenario-less flow pointing at an already-running deployment (k8s, staging…); `url=` on a `<scenario>` and `--base-url` take precedence.

`<scenarios>`:: One or more `<scenario>` elements to start and test against.

`<scenario name="..." service="..." adapter="..."/>`:: Attributes:
  - `name` — scenario name (its meaning is adapter-defined: usually a compose scenario)
  - `service` — target service inside the compose file
  - `adapter` — a registered adapter name (`http`, `tsAdapter`, `keycloak`, a plugin adapter, or a file path)
  - `orchestrator` — (tsAdapter) path to a TypeScript orchestrator script, relative to the flow file
  - `url` — base URL of an already-running deployment (k8s, VM, staging…); no scenario is started and `name` becomes a label only. `${VAR}` expands against process + flow env; `--base-url` overrides it.
  - Plugin adapters may define additional attributes (e.g. `project`, `workingDirectory`, `branch`).

`<readiness path="..." port="..." expected="..."/>`:: Optional child of `<scenario>`: poll an HTTP endpoint on the scenario's published port until it responds with the expected body substring (default: the service's published port).

`<setup>`:: Optional `<models>`, `<env>` (`<var name="..." value="..."/>`), plus adapter-specific children.

`<steps>`:: `<usermessage>` (served by any adapter claiming that tag), one or more `<step>`/`<script>` elements (tsAdapter or `adapter="..."`), custom plugin tags, plus `<assertions>`.

`<step src="path/to/script.ts"/>` / `<script src="..."/>`:: (tsAdapter) a TypeScript/Playwright script, either via `src` (relative to the flow file) or inline text. Multiple steps require an `orchestrator` on the `<flow>` or `<scenario>`. The tag body can be used as a description when `src` is set, e.g. `<step src="steps/login.ts" myArgs="xyz">Login of user</step>`.

**`<step>` vs `<script>`** — pure aliases (both parse to the same `script` unit; no adapter can tell them apart). Recommended convention by readability: `<step adapter="x" action="…"/>` for adapter/command calls — it reads like a pipeline step — and `<script>` only when the content literally is code (`<script src="…"/>` or an inline body).

`<step adapter="keycloak" action="createUser" .../>`:: (keycloak plugin adapter) creates a Keycloak user and sets the password. Supported actions: `createUser`, `deleteUser`, `resetPassword`.

`<usermessage value="...">`:: The user message, dispatched to whichever adapter claims the `usermessage` tag — selected by the scenario's `adapter` attribute. The tag body can be used as a description when a `value` attribute provides the message.

`<assertions>`:: One or more `<assert that="..." value="..."/>` checks. The tag body (before the child `<assert>` elements) can be used as a description.

`<picture name="after-login" [selector=".data-grid"] [fullPage="true"]/>`:: (tsAdapter + orchestrator) captures a screenshot at that exact point in the step order — viewport by default, a single element with `selector`, or the whole scrollable page with `fullPage`. Saved as a PNG in the run's evidence dir.

`<video name="segment">...</video>`:: (tsAdapter + orchestrator) records a video while the enclosed steps run. Steps inside `<video>` execute normally; the orchestrator's `videoStart(name, dir)`/`videoStop(name)` hooks drive the recording (see "Orchestrator contract" below). Saved as `.webm` in the evidence dir.

### Reusable step files

A step can live in its own `.xml` file (exactly one step element — `<step>`/`<script>`, `<usermessage>`, `<assertions>` or a custom adapter tag — as root or inside a single-child `<steps>`) and be bound by name or path:

```xml
<!-- flows/steps/login.xml -->
<step src="ft-login.ts"/>

<!-- in the flow -->
<steps include="../shared/step-lib">
  <step action="login" user="mom"/>   <!-- binds login.xml by name -->
  <step file="steps/logout.xml"/>     <!-- explicit path, relative to flow -->
</steps>
```

- Lookup dirs: the flow dir, `steps/` next to it, plus `include="a,b"` dirs on `<flows>`, `<flow>` or `<steps>` (relative to the flow file).
- `src`/`script` inside the step file resolves relative to the step file's dir; `script` is an alias for `src`.
- Duplicate names across step dirs are an error — disambiguate with `file=`.
- `action=` on a plain `<step>` is a step-file ref; combined with `adapter=` it stays an adapter argument. `file=` cannot be combined with `src`/`adapter`.
- Extra attributes on the referencing step merge into the bound step's args (caller wins); `desc`/tag text override the description.
- Step files may chain (`<step action="other"/>` inside); cycles are an error.
- `file=` and `action=` cannot be combined on one `<step>`.

### Reserved names

Self-declared names must not reuse the engine's vocabulary — custom `<steps>` tags, `<step action="name">` refs and step-file basenames. Reserved: the step elements (`usermessage`, `step`, `script`, `assert`, `assertions`, `picture`, `video`, `repeat`, `extract`), structural elements (`flows`, `flow`, `steps`, `scenarios`, `scenario`, `setup`, `models`, `model`, `env`, `var`, `readiness`, `tags`, `tag`, `description`, `tool-mode`, `use-docker`) and the step-ref keywords (`file`, `action`, `include`, `src`). `<file .../>` in `<steps>` or `<step action="file">` fails at load time. Plugin adapters cannot claim these tags either (dropped with a warning; `usermessage` exempt).

Flow files are validated at load: required attributes, known `that` assertion types (`contains`, `num_responses`, `exitCode`, `screenshot`, `llm`, `duration`, `script`) plus their per-type requirements, evidence `name`s, non-empty steps, unique flow names per file.

### Evidence capture

`<picture>` and `<video>` are inline step units — like `<assertions>` they can sit anywhere between steps. Artifacts are written to `flows/.reports/evidence/<flow>-<timestamp>/` (alongside the JSON reports in the gitignored `.reports/` dir) and listed in the JSON report under `flows[].evidence` (`{kind, name, path}`). The `axn-dev serve` report view renders screenshots inline and plays videos.

```xml
<steps>
  <step src="steps/login.ts">Log in</step>
  <picture name="after-login" />
  <picture name="grid" selector=".data-grid" />
  <video name="booking">
    <step src="steps/open-booking.ts" />
    <step src="steps/confirm.ts" />
  </video>
  <assertions><assert that="exitCode" value="0"/></assertions>
</steps>
```

Evidence requires an orchestrator-driven `tsAdapter` flow (a browser must exist); on other adapters the run fails with an error.

In **manual runs** (`--manual` or the serve manual view) evidence is supplied by the human: every step card has an "Attach evidence" file input (web) or an "Attach evidence file" prompt (CLI). Uploaded/copied files land in the same evidence dir layout and are recorded with their `stepIndex`, so a screenshot of a failure shows up in the report next to the failed step.

### Orchestrator contract

An orchestrator is a TypeScript module (run via `tsx`) whose default export has `start(baseUrl, env)`, `run(steps)` and `stop()`. Steps are script paths (or `{path, args}` objects); each script's default export is called with whatever the orchestrator passes — the Playwright convention is `(page, baseUrl)`.

For `<video>` support the orchestrator additionally implements:

- `videoStart(name: string, dir?: string)` — begin recording. Prefer `page.screencast.start({ path })`, which records the live page in place; swapping in a `recordVideo` context reloads the page, so state (an open dialog) is lost across `</video>` and a `<picture>` right after it captures a loading page.
- `videoStop(name: string)` — stop recording, finalize the artifact in `dir`, and return its absolute path (or `void`).

The host splits each `run()` batch at video boundaries and calls the hooks between segments, so `run()` itself never sees markers. If a step inside a video fails, still-open recordings are finalized best-effort before the error propagates. Orchestrators without the hooks fail with a clear error when a `<video>` step runs.

### Adapters

Adapters are pluggable — declared in a plugin's `package.json` under `axn-dev.flowAdapters` with `{name, entry, tags, extends, wantsScenario}`. An adapter claims XML tags; `axn-dev flow list-adapters` shows the registry.

`tsAdapter` (built-in):: Executes TypeScript/Playwright scripts via `tsx` against the scenario (or a device with `-i`). Requires `tsx` to be installed. Script output goes to stdout and is evaluated by the assertions.

`http` (bundled):: POSTs `<usermessage>` as `{message, provider, model}` to the scenario service — path defaults to `/chat`, overridable per step via the `path` attribute; `field` picks the JSON response field to use as output. Base URL is discovered from the scenario's published port, overridable via `BASE_URL`.

`keycloak` (`@axn-dev/adapter-keycloak`):: Creates, deletes or resets Keycloak users through the Admin API. Claims the `<keycloak>` tag; attributes on the `<step>` are passed to the adapter.

`<custom>`:: Any unregistered `adapter` attribute resolves to a script file run by `tsx`, receiving the step as `process.env.AXN_STEP` JSON plus the merged flow env. Resolved in order: `--adapter <name=path>`, `adapters:` in `.axn-dev/config.yaml`, the step's `src` attribute, then `adapters/<adapter>.ts`/`.js` next to the flow file. Use this for product-specific logic.

Plugin adapters:: Any installed plugin can contribute adapters — including custom XML tags (e.g. `<keycloak>`) and adapters that `extend` an existing one. See `docs/plugins.adoc`.

### Assertions

Assertions judge **captured stdout** — step output, adapter responses, `<extract>` reads — accumulating in one buffer per flow. Placement decides *which slice* of that buffer an assert sees:

- **Nested in a producing step** (`<step>`, `<usermessage>`, `<extract>`, custom tags) — the assert judges *that step's own output only* (and `that="duration"` measures its wall-clock ms). The subject under test is explicit — the preferred shape.
- **Bare `<assert/>` or `<assertions>` between steps** — sees **all output accumulated since the flow started** (or since the current `<repeat>` iteration started). Cumulative — *not* just the last step.
- **`fresh="true"`** (on `<assert>` or the whole `<assertions>` group) — sees only output produced **since the previous assertions unit**. A `fresh` first assert behaves like a normal one (there is no previous unit yet).

The window mechanic: after *every* assertions unit — a bare `<assert/>` counts as a one-element block — an internal cursor moves to the end of output at that moment. `fresh` asserts evaluate the slice since that cursor; non-fresh asserts ignore it entirely. Inside one `<assertions>` group, all asserts share the same window (the cursor moves only after the group completes).

```text
<step/> 1  <step/> 2  <step/> 3
<assert/>                     → sees 1,2,3
<step> 4 <assert/></step>     → sees 4 only (nested = step-scoped)
<assert/>                     → sees 1,2,3,4  (cumulative)
<step/> 5
<assert fresh="true"/>        → sees 5 only  (since previous assertions unit)
<step/> 6  <step/> 7
<assertions>
  <assert/>                   → sees 1..7 — NOT just 6,7
</assertions>
<assertions fresh="true">
  <assert/>                   → sees 6,7 — windowed by the flag
</assertions>
<assert/>                     → sees 1..7
```

Rules of thumb: want "check what just happened" → `fresh="true"` or nest the assert in the step; want "did this ever appear in the run" → bare assert. Inside `<repeat>`, each iteration gets its own buffer start, so plain asserts there see only that iteration's output.

**When to use `<assertions>`** — only two reasons, both optional:

1. **`desc="…"`** — a named report group: the label shows on its asserts in reports and the serve view. Without it, each assert is a standalone line item.
2. **`fresh="true"`** — apply the windowed scope to several asserts at once instead of repeating the flag on each.

An `<assertions>` group with neither is just bare asserts with extra indentation — it does **not** create a sub-scope or narrow the window.

```xml
<usermessage value="What time is it?">
  <assert that="llm" judge="ollama/qwen2.5:14b">The reply states a concrete time</assert>
  <assert that="duration" max="3000"/>
</usermessage>
<step src="steps/book.ts"><assert that="contains" value="confirmed"/></step>
<extract selector=".chat .bubble:last-child"><assert that="contains" value="Berlin"/></extract>
<assertions fresh="true" desc="latest output only">
  <assert that="contains" value="done"/>
</assertions>
```

`num_responses`:: Number of responses received (`1` for a single REST call, non-empty output for scripts).
`contains`:: A string that must appear (case-insensitive) in the response/stdout.
`exitCode`:: (tsAdapter) the process exit code must equal `value`.
`duration`:: Step wall-clock time in ms — `min`/`max` bounds, or numeric `value` as shorthand max. Needs a producing-step context (nested asserts).
`script`:: A ts/js assertion script (`src` or `value`), run via tsx: gets the output under test as `$AXN_OUTPUT`, the assert JSON as `$AXN_ASSERT`; exit 0 = pass, stdout becomes the report detail.
`screenshot`:: Visual regression: captures `url` (default `BASE_URL`) with headless Chromium and compares it against the reference PNG at `value` (relative to the flow file). Antialiasing is tolerated; layout/shape changes fail. Attributes: `selector` (element capture — cropped to the element, so position changes are invisible; select a *container* element or omit it for a whole-page capture to catch moves), `fullPage`, `maxDiff` (fraction of differing pixels, default 0.01), `threshold` (per-pixel color, default 0.1), `viewport` ("WxH", default 1280x800), `wait` (ms or CSS selector). Diffs land in `flows/.reports/screenshots/`; `AXN_FLOW_UPDATE_SCREENSHOTS=1` rewrites the reference. Requires `playwright-core` and a Chromium browser (`npx playwright install chromium`).

```xml
<assert that="screenshot" value="refs/button.png" selector="#buy"
        url="${BASE_URL}/shop" maxDiff="0.02"/>
```

`llm`:: Judges the captured output with an LLM, a local agent CLI, a binary judge service, or a plugin-registered judge. Rubric comes from `prompt` (or `value`); `judge` selects the evaluator: `ollama/<model>` (`OLLAMA_BASE_URL`), `openai/<model>` (`OPENAI_API_KEY`, `OPENAI_BASE_URL`), a local agent CLI in one-shot mode (`claude[/model]` → `claude -p`, `gemini[/model]` → `gemini -p`, `codex[/model]` → `codex exec`, `devin[/model]` → `devin -p`), an `http(s)://` endpoint POSTed `{prompt, response}` returning a binary verdict (`{"pass":true|false}` or `PASS`/`FAIL` text), or a plugin judge declared via `axn-dev.judges` (`judge="<name>"` or `"<name>/<arg>"`). Falls back to `$AXN_JUDGE`; `AXN_JUDGE_TIMEOUT_MS` overrides the 60s timeout.

```xml
<assert that="llm" prompt="The response states a concrete time" judge="ollama/llama3.1"/>
<assert that="llm" value="mentions Berlin" judge="https://jev.example/eval"/>
```

### DOM extraction: `<extract>`

`<extract selector=".chat .msg:last-child" [attr="text|value|html|<attr-name>"] [url="…"/>` reads a DOM element's content into the output stream, so `contains`/`llm` assertions — and `<repeat>` blocks — can judge e.g. the last message of an interactive HTML chat. On orchestrator flows it reads the **live page** (state after prior steps); under `runner="pw"` the worker page. Requires `selector`; `attr` defaults to `text`. Without a browser context (sequential/custom/message flows) it fails with a clear error — pair it with an orchestrator or `runner="pw"`.

```xml
<extract selector=".chat-history .bubble:last-child"/>
<assertions><assert that="llm" prompt="the reply mentions Berlin" judge="ollama/qwen2.5:14b"/></assertions>
```

### Flakiness: `<repeat>`

`<repeat num="N" success="R">` wraps any steps: the children run N times and the block passes when ≥R of the iterations pass — a rate (`"0.8"`) or percent (`"80%"`, `"80"`); `success` defaults to 1. An iteration fails on a failed inner assertion or a step error; failed iterations do not stop the block, and assertions inside a repeat see only that iteration's output. The loop exits early once the threshold is unreachable. Works in every engine (axn orchestrator, sequential, custom-adapter and message flows, and the `pw` runner); nested repeats are allowed. In message-adapter flows children must be `<usermessage>`/`<assertions>` only. The block reports as a `repeat` assertion with `repeat: {runs, succeeded, needed, failures[]}` detail in the JSON report.

```xml
<repeat num="10" success="0.8">
  <usermessage>What time is it?</usermessage>
  <assertions>
    <assert that="llm" prompt="states a concrete time" judge="ollama/llama3.1"/>
  </assertions>
</repeat>
```

### Locating flows/scenarios (`paths:`)

By default flows live in `<root>/flows/` and scenarios in `<root>/scenarios/`. Override per repo or globally — precedence: **env > repo `.axn-dev/config.yaml` > `~/.axn-dev/config.yaml`**:

```yaml
paths:
  flows: qa/flows            # or [qa/flows, e2e/flows]
  scenarios: qa/scenarios    # relative to each scanned root…
  # …or absolute paths, scanned as standalone locations
```

```bash
AXN_FLOW_DIRS=qa/flows,e2e/flows AXN_SCENARIO_DIRS=/data/scenarios axn-dev list
```

## Core commands

```bash
# Run a flow file
axn-dev flow -f flows/example.xml

# Run only one model from the configured list
axn-dev flow -f flows/example.xml -m llama3.1:latest

# Run only flows whose name matches a string
axn-dev flow -f flows/example.xml -t "how late"

# Keep the scenario running after the test
axn-dev flow -f flows/example.xml --no-stop

# Wipe scenario data and start fresh (non-interactive)
axn-dev flow -f flows/app-dev-e2e.xml --clean-start --yes

# Keep the scenario running after a clean start
axn-dev flow -f flows/app-dev-e2e.xml --clean-start --yes --no-stop

# Run a tsAdapter flow against a deployed device
axn-dev flow -f flows/device-check.xml -i my-device

# Run against any already-running deployment — no scenario is started
axn-dev flow -f flows/e2e.xml --base-url https://staging.example.com

# List registered adapters and their claimed tags
axn-dev flow list-adapters
```

## How it works

1. `axn-dev flow` reads the XML file.
2. It starts the requested scenario if it is not already running (for adapters that declare `wantsScenario`, and without `-i`).
3. Waits for the scenario's readiness probe (or the service's published port).
4. For each flow and each configured model, it dispatches steps to the selected adapter, or runs `<step>`/`<script>` scripts (through an `orchestrator` if configured).
5. It evaluates all `<assert>` elements against the response/stdout.
6. It writes a JSON report to `flows/.reports/` next to the flow file.
7. It stops the started scenario and any scenario-scoped orchestrators unless `--no-stop` is used.

## Report output

Reports are written to `flows/.reports/flow-report-<timestamp>.json` next to the flow file:

```json
{
  "timestamp": "2026-08-18T07-54-13-540Z",
  "flows": [
    {
      "flow": "example - how late is it",
      "model": { "provider": "ollama", "name": "llama3.1:latest" },
      "passed": true,
      "assertions": [
        { "that": "num_responses", "value": "1", "passed": true, "actual": "1" },
        { "that": "contains", "value": "time", "passed": true }
      ],
      "durationMs": 11999,
      "evidence": [
        { "kind": "picture", "name": "after-login", "path": ".../flow-reports/evidence/example-2026-08-18T07-54-13-540Z/000-after-login.png" },
        { "kind": "video", "name": "booking", "path": ".../flow-reports/evidence/example-2026-08-18T07-54-13-540Z/booking.webm" }
      ]
    }
  ]
}
```

## Common tasks (cookbook)

**"Run all flows in the example file":**
```bash
axn-dev flow -f flows/example.xml
```

**"Run only the Ollama model":**
```bash
axn-dev flow -f flows/example.xml -m llama3.1:latest
```

**"Run a flow without stopping the scenario afterwards":**
```bash
axn-dev flow -f flows/example.xml --no-stop
```

**"Run a Playwright check against a real device":**
```bash
axn-dev flow -f flows/device.xml -i my-device
```

**"Run a flow against a Kubernetes/staging deployment (no local scenario)":**
```bash
axn-dev flow -f flows/e2e.xml --base-url https://staging.example.com
# or pin it in XML: <scenario name="staging" adapter="tsAdapter" url="https://staging.example.com"/>
```
`--base-url` overrides `url=` and applies to all scenarios in the run; env gets `BASE_URL` (+`SCENARIO_PORT` when the URL has an explicit port). Declared `<readiness>` probes address the base URL. Not combinable with `-i`, `--clean-start`, `--port`, `--auto-port`.

**"Run a flow while inspecting the report":**
```bash
axn-dev flow -f flows/example.xml
ls flows/.reports/
```

## Gotchas

- `-i/--infra` is currently only supported with `tsAdapter` flows.
- `tsAdapter` requires `tsx` to be installed.
- Multiple `<step>`/`<script>` elements require an `orchestrator` on the `<flow>` or `<scenario>`; orchestrators are long-lived processes that are reused across flows for the same scenario.
- `<picture>`/`<video>` evidence requires an orchestrator-driven tsAdapter flow; `<video>` additionally needs the orchestrator's `videoStart`/`videoStop` hooks.
- The `flows/.reports/` directory is created automatically (with a `.gitignore`), but individual JSON reports and evidence files should not be committed.
- A non-zero exit code from a tsAdapter script is reported via the `exitCode` assertion and fails the flow.

## Source files

- `packages/cmd-flow/src/flow.ts` — main `flow` command implementation
- `packages/cmd-flow/src/adapters/http.ts` — bundled generic HTTP adapter
- `packages/flow-format/src/flow-util.ts` — XML parser and flow types
- `packages/core/src/flow-adapter.ts` — adapter registry (lazy load, tag routing, `extends`)
- `<integration-repo>/flows/*.xml` — flow files
