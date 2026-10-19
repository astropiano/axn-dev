---
name: axn-dev-flow
description: Run XML-defined flow tests against scenarios or deployed devices with `axn-dev flow`. Supports the built-in tsAdapter (TypeScript/Playwright scripts), pluggable adapters (http, keycloak, custom tags), readiness checks, orchestrators, and JSON report output.
---

# axn-dev flow Skill

`axn-dev flow` runs XML-defined tests against Docker Compose scenarios or deployed devices. A flow describes which scenario to start, which model/adapter to use, the steps to execute, and assertions to verify.

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

`<flow name="..." orchestrator="...">`:: A single test flow. `orchestrator` points to a TypeScript orchestrator script (see below).

`<scenarios>`:: One or more `<scenario>` elements to start and test against.

`<scenario name="..." service="..." adapter="..."/>`:: Attributes:
  - `name` — scenario name (its meaning is adapter-defined: usually a compose scenario)
  - `service` — target service inside the compose file
  - `adapter` — a registered adapter name (`http`, `tsAdapter`, `keycloak`, a plugin adapter, or a file path)
  - `orchestrator` — (tsAdapter) path to a TypeScript orchestrator script, relative to the flow file
  - Plugin adapters may define additional attributes (e.g. `project`, `workingDirectory`, `branch`).

`<readiness path="..." port="..." expected="..."/>`:: Optional child of `<scenario>`: poll an HTTP endpoint on the scenario's published port until it responds with the expected body substring (default: the service's published port).

`<setup>`:: Optional `<models>`, `<env>` (`<var name="..." value="..."/>`), plus adapter-specific children.

`<steps>`:: `<usermessage>` (served by any adapter claiming that tag), one or more `<step>`/`<script>` elements (tsAdapter or `adapter="..."`), custom plugin tags, plus `<assertions>`.

`<step src="path/to/script.ts"/>` / `<script src="..."/>`:: (tsAdapter) a TypeScript/Playwright script, either via `src` (relative to the flow file) or inline text. Multiple steps require an `orchestrator` on the `<flow>` or `<scenario>`. The tag body can be used as a description when `src` is set, e.g. `<step src="steps/login.ts" myArgs="xyz">Login of user</step>`.

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

- `videoStart(name: string, dir?: string)` — begin recording (e.g. swap in a `recordVideo` browser context, preserving storage state and the current URL).
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

`num_responses`:: Number of responses received (`1` for a single REST call, non-empty output for scripts).
`contains`:: A string that must appear (case-insensitive) in the response/stdout.
`exitCode`:: (tsAdapter) the process exit code must equal `value`.
`screenshot`:: Visual regression: captures `url` (default `BASE_URL`) with headless Chromium and compares it against the reference PNG at `value` (relative to the flow file). Antialiasing is tolerated; layout/shape changes fail. Attributes: `selector` (element capture — cropped to the element, so position changes are invisible; select a *container* element or omit it for a whole-page capture to catch moves), `fullPage`, `maxDiff` (fraction of differing pixels, default 0.01), `threshold` (per-pixel color, default 0.1), `viewport` ("WxH", default 1280x800), `wait` (ms or CSS selector). Diffs land in `flows/.reports/screenshots/`; `AXN_FLOW_UPDATE_SCREENSHOTS=1` rewrites the reference. Requires `playwright-core` and a Chromium browser (`npx playwright install chromium`).

```xml
<assert that="screenshot" value="refs/button.png" selector="#buy"
        url="${BASE_URL}/shop" maxDiff="0.02"/>
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
