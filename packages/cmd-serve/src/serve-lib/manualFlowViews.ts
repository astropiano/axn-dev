import { escapeHtml, pageShell, type MenuCounts } from "./html.js";
import type { FlowInfo } from "./flows.js";
import type { ParsedFlow, ParsedStep } from "@axn-dev/flow-format";

function stepKindBadge(step: ParsedStep): string {
  const label =
    step.type === "message" ? "usermessage" :
    step.type === "assertions" ? "verify" :
    step.type === "picture" ? "picture" :
    step.type === "video" ? "video" :
    "script";
  const cls =
    label === "script" ? "step-kind-ts" :
    label === "usermessage" ? "step-kind-msg" :
    label === "verify" ? "step-kind-verify" :
    "step-kind-other";
  return `<span class="meta-badge step-kind ${cls}">${escapeHtml(label)}</span>`;
}

function renderAssertionInput(stepIndex: number, assertIndex: number, assertion: { that: string; value: string; description?: string }): string {
  const name = `step-${stepIndex}-assert-${assertIndex}`;
  return `
    <div class="manual-assertion">
      <div class="manual-assertion-label">
        ${assertion.description ? `<span class="manual-assertion-desc">${escapeHtml(assertion.description)}</span>` : ""}
        <code>${escapeHtml(assertion.that)}=${escapeHtml(assertion.value)}</code>
      </div>
      <div class="manual-assertion-controls">
        <label><input type="radio" name="${name}-result" value="pass" required> Pass</label>
        <label><input type="radio" name="${name}-result" value="fail"> Fail</label>
      </div>
      <input type="hidden" name="${name}-that" value="${escapeHtml(assertion.that)}">
      <input type="hidden" name="${name}-value" value="${escapeHtml(assertion.value)}">
      <input type="text" name="${name}-actual" placeholder="Actual value (optional)" class="manual-input">
      <input type="text" name="${name}-notes" placeholder="Notes (optional)" class="manual-input">
    </div>
  `;
}

function renderStepInput(step: ParsedStep, index: number): string {
  const assertionInputs = step.type === "assertions" && step.assertions?.length
    ? step.assertions.map((a, i) => renderAssertionInput(index, i, a)).join("\n")
    : "";

  const responseInput = step.type !== "assertions"
    ? `<textarea name="step-${index}-response" rows="3" placeholder="Observed response/output (optional)" class="manual-input"></textarea>`
    : "";

  const stepResultControls = step.type === "assertions" && step.assertions?.length
    ? ""
    : `
      <div class="manual-step-controls">
        <label><input type="radio" name="step-${index}-result" value="pass" required> Pass</label>
        <label><input type="radio" name="step-${index}-result" value="fail"> Fail</label>
      </div>
    `;

  const src = step.src ? `<code>${escapeHtml(step.src)}</code>` : "";
  const value = step.value ? `<pre class="step-code">${escapeHtml(step.value)}</pre>` : "";

  const evidenceInfo = step.type === "picture"
    ? `<p class="step-desc">Capture a screenshot${step.name ? ` named <code>${escapeHtml(step.name)}</code>` : ""}${step.selector ? ` of element <code>${escapeHtml(step.selector)}</code>` : ""}${step.fullPage ? " (full page)" : ""}.</p>`
    : step.type === "video"
      ? `<p class="step-desc">Record a video${step.name ? ` named <code>${escapeHtml(step.name)}</code>` : ""} covering these steps:</p>
         <ul class="step-asserts video-children">${(step.children ?? []).map((c) =>
           `<li>${stepKindBadge(c)} ${c.description ? escapeHtml(c.description) : (c.src ? `<code>${escapeHtml(c.src)}</code>` : "")}</li>`
         ).join("\n")}</ul>`
      : "";

  return `
    <div class="manual-step-card">
      <div class="manual-step-head">
        <span class="step-index">${index + 1}</span>
        ${stepKindBadge(step)}
        ${src}
      </div>
      ${step.description ? `<p class="step-desc">${escapeHtml(step.description)}</p>` : ""}
      ${value}
      ${evidenceInfo}
      ${responseInput}
      ${assertionInputs}
      ${stepResultControls}
      <input type="text" name="step-${index}-notes" placeholder="Step notes (optional)" class="manual-input">
      <label class="manual-evidence-label">Attach evidence (optional)
        <input type="file" name="step-${index}-evidence" accept="image/*,video/*" multiple class="manual-input">
      </label>
    </div>
  `;
}

export function manualFlowViewHtml(
  flow: FlowInfo,
  parsed: ParsedFlow,
  counts: MenuCounts,
): string {
  const scenarioCheck = parsed.scenarios.length > 0
    ? `
      <div class="manual-scenario-check">
        <h3>Scenario setup</h3>
        ${parsed.scenarios.map((s) => `
          <div class="manual-scenario-row">
            <code>${escapeHtml(s.name)}</code> (${escapeHtml(s.adapter)})
          </div>
        `).join("\n")}
        <p class="status-hint" style="margin-top: 0.5rem;">Start the scenario(s) before continuing, or confirm they are already running.</p>
        <label class="filter-toggle" style="margin-top: 0.5rem;">
          <input type="checkbox" id="manual-scenario-ok" required>
          <span>I confirm the scenario is running / not needed</span>
        </label>
      </div>
    `
    : "";

  const stepsHtml = parsed.steps.map((s, i) => renderStepInput(s, i)).join("\n");

  const content = `
    <div class="flow-header">
      <div class="scenario-title-line">
        <h2 class="flow-title">Manual run: ${escapeHtml(flow.name)}</h2>
        <span class="meta-badge repo-badge">${escapeHtml(flow.fileName)}</span>
        <span class="meta-badge branch-badge">${escapeHtml(flow.rootName)}</span>
      </div>
      ${flow.description ? `<p class="description">${escapeHtml(flow.description)}</p>` : ""}
      <div class="card-actions">
        <a class="btn btn-secondary" href="/flow?file=${encodeURIComponent(flow.file)}&name=${encodeURIComponent(flow.name)}">← Flow details</a>
        <a class="btn btn-secondary" href="/flows">← All flows</a>
      </div>
    </div>

    <form id="manual-flow-form" onsubmit="return submitManualFlow(event)">
      <input type="hidden" name="file" value="${escapeHtml(flow.file)}">
      <input type="hidden" name="name" value="${escapeHtml(flow.name)}">
      <input type="hidden" name="stepCount" value="${parsed.steps.length}">
      ${parsed.steps.map((s, i) => `<input type="hidden" name="step-${i}-type" value="${s.type}"><input type="hidden" name="step-${i}-assert-count" value="${s.type === "assertions" ? (s.assertions?.length ?? 0) : 0}">`).join("\n")}

      ${scenarioCheck}
      ${stepsHtml}

      <div class="manual-submit-bar">
        <button type="submit" class="btn btn-primary" id="manual-submit-btn">Generate report</button>
      </div>
    </form>
  `;

  const scripts = `<script>
    async function submitManualFlow(e) {
      e.preventDefault();
      const form = document.getElementById('manual-flow-form');
      const scenarioOk = document.getElementById('manual-scenario-ok');
      if (scenarioOk && !scenarioOk.checked) {
        alert('Please confirm the scenario is running or not needed.');
        return false;
      }

      const fd = new FormData(form);
      const stepCount = parseInt(fd.get('stepCount') || '0', 10);
      const steps = [];
      let evidenceDir = '';

      for (let i = 0; i < stepCount; i++) {
        const type = fd.get('step-' + i + '-type');
        const assertCount = parseInt(fd.get('step-' + i + '-assert-count') || '0', 10);
        const assertions = [];

        for (let j = 0; j < assertCount; j++) {
          const base = 'step-' + i + '-assert-' + j;
          assertions.push({
            that: fd.get(base + '-that') || '',
            value: fd.get(base + '-value') || '',
            actual: fd.get(base + '-actual') || undefined,
            notes: fd.get(base + '-notes') || undefined,
            passed: fd.get(base + '-result') === 'pass',
          });
        }

        const evidence = [];
        const fileInput = form.querySelector('input[name="step-' + i + '-evidence"]');
        const files = fileInput && fileInput.files ? Array.from(fileInput.files) : [];
        for (const f of files) {
          const res = await fetch(
            '/flow/manual/evidence?file=' + encodeURIComponent(fd.get('file')) +
            '&flow=' + encodeURIComponent(fd.get('name')) +
            '&filename=' + encodeURIComponent(f.name) +
            (evidenceDir ? '&dir=' + encodeURIComponent(evidenceDir) : ''),
            { method: 'POST', body: f }
          );
          const data = await res.json();
          if (!data.success) throw new Error(data.error || 'Evidence upload failed');
          evidenceDir = data.dir;
          evidence.push({ name: f.name, path: data.path });
        }

        steps.push({
          stepIndex: i,
          stepDescription: form.querySelectorAll('.manual-step-card')[i]?.querySelector('.step-desc')?.textContent || undefined,
          response: fd.get('step-' + i + '-response') || undefined,
          passed: assertions.length > 0
            ? assertions.every((a) => a.passed)
            : fd.get('step-' + i + '-result') === 'pass',
          notes: fd.get('step-' + i + '-notes') || undefined,
          assertions,
          evidence: evidence.length ? evidence : undefined,
        });
      }

      const btn = document.getElementById('manual-submit-btn');
      btn.disabled = true;
      btn.textContent = 'Generating...';

      try {
        const res = await fetch('/flow/manual/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            file: fd.get('file'),
            name: fd.get('name'),
            steps,
          }),
        });
        const data = await res.json();
        if (data.success && data.reportPath) {
          window.location.href = '/flow-report?file=' + encodeURIComponent(data.reportPath);
        } else {
          alert('Failed to create report: ' + (data.error || 'Unknown error'));
          btn.disabled = false;
          btn.textContent = 'Generate report';
        }
      } catch (err) {
        alert('Failed: ' + err.message);
        btn.disabled = false;
        btn.textContent = 'Generate report';
      }
      return false;
    }
  </script>`;

  return pageShell(`Manual: ${flow.name} — axn-dev`, "flows", counts, content, scripts);
}
