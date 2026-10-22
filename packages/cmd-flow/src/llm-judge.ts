// that="llm" — binary judge assertion. The captured output is evaluated
// against a rubric ('prompt' attr, or 'value') by:
//   - an LLM via an OpenAI-compatible chat endpoint (ollama/<model>,
//     openai/<model>)
//   - a local agent CLI in one-shot mode (claude, gemini, codex, devin — e.g.
//     `judge="claude"` spawns `claude -p`, `judge="claude/sonnet"` adds
//     the model flag)
//   - an http(s):// binary judge service (POSTed {prompt, response},
//     returning a binary verdict)
//   - a plugin-registered FlowJudge (axn-dev.judges manifest, name or
//     name/<arg>)
//
// Judge selection: the assertion's 'judge' attribute, else $AXN_JUDGE.
// $AXN_JUDGE_TIMEOUT_MS overrides the 60s default timeout.

import { execFile } from "node:child_process";
import { hasFlowJudge, flowJudge } from "@axn-dev/core";
import type { ParsedAssertion } from "@axn-dev/flow-format";

export interface JudgeOutcome {
  passed: boolean;
  actual: string;
}

const BINARY_RE = /\b(pass|fail|yes|no|true|false)\b/i;

function verdictFromText(text: string): boolean | null {
  const m = text.match(BINARY_RE);
  if (!m) return null;
  const w = m[1].toLowerCase();
  return w === "pass" || w === "yes" || w === "true";
}

/** Parse a judge-endpoint reply: {pass|passed|verdict|result|ok|success},
 * a bare boolean/number JSON, or plain text containing a verdict word. */
function verdictFromBody(body: string): boolean | null {
  const trimmed = body.trim();
  try {
    const json = JSON.parse(trimmed);
    if (typeof json === "boolean") return json;
    if (typeof json === "number") return json !== 0;
    if (json && typeof json === "object") {
      for (const key of ["pass", "passed", "verdict", "result", "ok", "success"]) {
        if (!(key in json)) continue;
        const v = (json as Record<string, unknown>)[key];
        if (typeof v === "boolean") return v;
        if (typeof v === "number") return v !== 0;
        if (typeof v === "string") {
          const parsed = verdictFromText(v);
          if (parsed !== null) return parsed;
        }
      }
    }
  } catch { /* not JSON — fall through to text scan */ }
  return verdictFromText(trimmed);
}

function expandVars(s: string, env: Record<string, string>): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (m, name: string, def?: string) =>
    name in env ? env[name] : def !== undefined ? def : m
  );
}

const JUDGE_SYSTEM =
  "You are a strict test judge. Given a rubric and the text under evaluation, " +
  "decide whether the text satisfies the rubric. Answer with exactly one word: PASS or FAIL.";

const judgePrompt = (rubric: string, response: string) =>
  `Rubric:\n${rubric}\n\nText under evaluation:\n${response}`;

/** Local agent CLIs usable as one-shot judges — the binary is spawned
 * non-interactively and its stdout scanned for a verdict word. The spec
 * suffix selects the model where the CLI supports it:
 * `claude/haiku` → `claude -p --model haiku`, `codex/o4` → `codex exec -m o4`. */
const AGENT_JUDGES: Record<
  string,
  { cmd: string; args: (prompt: string, model?: string) => string[] }
> = {
  claude: { cmd: "claude", args: (p, m) => ["-p", ...(m ? ["--model", m] : []), p] },
  gemini: { cmd: "gemini", args: (p, m) => ["-p", ...(m ? ["-m", m] : []), p] },
  codex: { cmd: "codex", args: (p, m) => ["exec", ...(m ? ["-m", m] : []), p] },
  // print mode refuses untrusted dirs — the flag is required for CI/flow runs
  // where no interactive trust prompt can be answered.
  devin: {
    cmd: "devin",
    args: (p, m) => ["-p", p, ...(m ? ["--model", m] : []), "--respect-workspace-trust", "false"],
  },
};

/** Run a local agent CLI in one-shot mode: judge="claude[/model]" etc. */
function runAgentJudge(
  name: string,
  arg: string | undefined,
  rubric: string,
  response: string,
  timeoutMs: number,
): Promise<JudgeOutcome> {
  const agent = AGENT_JUDGES[name];
  const prompt = `${JUDGE_SYSTEM}\n\n${judgePrompt(rubric, response)}`;
  return new Promise((resolve, reject) => {
    execFile(
      agent.cmd,
      agent.args(prompt, arg),
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              (err as NodeJS.ErrnoException).code === "ENOENT"
                ? `judge '${name}' needs the '${agent.cmd}' CLI on PATH`
                : `judge '${name}' exited ${(err as { code?: unknown }).code}: ${stderr.slice(0, 200)}`,
            ),
          );
          return;
        }
        const verdict = verdictFromText(stdout);
        resolve(
          verdict === null
            ? { passed: false, actual: `agent reply not binary: ${stdout.trim().slice(0, 200)}` }
            : { passed: verdict, actual: `${name}${arg ? `/${arg}` : ""} → ${stdout.trim().slice(0, 120)}` },
        );
      },
    );
  });
}

export async function evaluateLlmAssertion(
  assertion: ParsedAssertion,
  response: string,
  env: Record<string, string>,
): Promise<JudgeOutcome> {
  const rubric = expandVars(assertion.prompt || assertion.value || assertion.description || "", env);
  if (!rubric.trim()) {
    throw new Error(`that="llm" needs a rubric — set 'prompt' or 'value'`);
  }

  const judgeSpec = assertion.judge ? expandVars(assertion.judge, env) : env.AXN_JUDGE;
  if (!judgeSpec) {
    throw new Error(
      `that="llm" needs a judge — set 'judge' on the assert or the AXN_JUDGE env var. ` +
        `Forms: 'ollama/<model>', 'openai/<model>', a local agent CLI ` +
        `('claude[/model]', 'gemini[/model]', 'codex[/model]'), ` +
        `'https://<binary-judge-endpoint>', or a plugin judge name.`
    );
  }
  const timeoutMs = Number(env.AXN_JUDGE_TIMEOUT_MS ?? 60_000);

  if (/^https?:\/\//.test(judgeSpec)) {
    const res = await fetch(judgeSpec, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: rubric, response }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`Judge endpoint ${judgeSpec} → HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const verdict = verdictFromBody(body);
    if (verdict === null) {
      return { passed: false, actual: `unparseable judge verdict: ${body.slice(0, 200)}` };
    }
    return { passed: verdict, actual: `${judgeSpec} → ${verdict ? "PASS" : "FAIL"}` };
  }

  // name[/arg] — a local agent CLI, or a plugin-registered FlowJudge.
  const slash = judgeSpec.indexOf("/");
  const name = slash > 0 ? judgeSpec.slice(0, slash) : judgeSpec;
  const arg = slash > 0 ? judgeSpec.slice(slash + 1) : undefined;

  if (name in AGENT_JUDGES) {
    return runAgentJudge(name, arg, rubric, response, timeoutMs);
  }

  if (hasFlowJudge(name)) {
    const judge = await flowJudge(name);
    const r = await judge({ rubric, response, arg, env });
    return {
      passed: r.passed,
      actual: r.actual ?? `${name}${arg ? `/${arg}` : ""} → ${r.passed ? "PASS" : "FAIL"}`,
    };
  }

  // provider/model — OpenAI-compatible /v1/chat/completions (ollama and
  // openai both speak it).
  const provider = slash > 0 ? name : (env.AXN_JUDGE_PROVIDER ?? "ollama");
  const model = slash > 0 ? arg! : judgeSpec;

  let base: string;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (provider === "openai") {
    const key = env.OPENAI_API_KEY;
    if (!key) throw new Error(`judge 'openai/${model}' requires OPENAI_API_KEY`);
    base = (env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    headers.Authorization = `Bearer ${key}`;
  } else if (provider === "ollama") {
    base = `${(env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/+$/, "")}/v1`;
  } else {
    throw new Error(
      `Unknown judge provider '${provider}' — use ollama/<model>, openai/<model>, ` +
        `a local agent CLI (claude, gemini, codex, devin), an http(s):// endpoint, ` +
        `or a plugin-registered judge name`
    );
  }

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: JUDGE_SYSTEM },
        { role: "user", content: judgePrompt(rubric, response) },
      ],
    }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Judge ${provider}/${model} → HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  let content = "";
  try {
    content = (JSON.parse(body) as { choices?: { message?: { content?: string } }[] })
      .choices?.[0]?.message?.content ?? "";
  } catch { /* fall through */ }
  const verdict = verdictFromText(content);
  if (verdict === null) {
    return { passed: false, actual: `judge reply not binary: ${content.slice(0, 200)}` };
  }
  return { passed: verdict, actual: `${provider}/${model} → ${content.trim().slice(0, 120)}` };
}
