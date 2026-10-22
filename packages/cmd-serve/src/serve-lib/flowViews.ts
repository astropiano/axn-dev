import { escapeHtml, pageShell, type MenuCounts } from "./html.js";
import type { FlowInfo, FlowReport, FlowReportFile, FlowRun } from "./flows.js";
import type { EvidenceArtifact, ParsedFlow, ParsedStep } from "@axn-dev/flow-format";
import {
  tagBadgesHtml,
  tagSearchInputHtml,
  viewToggleHtml,
  tagTreeViewHtml,
  tagViewScripts,
} from "./tagViews.js";

function flowUrl(flow: FlowInfo): string {
  return `/flow?file=${encodeURIComponent(flow.file)}&name=${encodeURIComponent(flow.name)}`;
}

function reportUrl(report: FlowReportFile, flowName?: string): string {
  let url = `/flow-report?file=${encodeURIComponent(report.file)}`;
  if (flowName) url += `&flow=${encodeURIComponent(flowName)}`;
  return url;
}

function statusPill(status: string): string {
  const cls = status === "passed" ? "running" : status === "running" ? "running" : "stopped";
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return `<span class="status-pill ${cls}${status === "failed" || status === "error" ? " failed" : ""}">${escapeHtml(label)}</span>`;
}

function fmtDuration(ms?: number): string {
  if (ms === undefined) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function fmtTimestamp(ts: string): string {
  // Report timestamps have ':' and '.' replaced by '-': 2026-09-05T09-57-38-027Z
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?Z?$/.exec(ts);
  const iso = m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}${m[5] ? "." + m[5] : ""}Z` : ts;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? ts : d.toLocaleString();
}

/** Latest report entry result for a flow (from reports that contain it). */
function lastResult(flow: FlowInfo, reports: FlowReportFile[]): FlowReportFile | null {
  return reports.find((r) => r.flowNames.includes(flow.name)) ?? null;
}

/**
 * Flows list — table of all discovered flows, very similar to the scenario table.
 */
export function flowsListHtml(
  flows: FlowInfo[],
  reports: FlowReportFile[],
  runs: FlowRun[],
  counts: MenuCounts,
): string {
  const renderRow = (f: FlowInfo): string => {
    const run = runs.find((r) => r.file === f.file && r.flowName === f.name);
    const running = run?.status === "running";
    const report = lastResult(f, reports);
    const lastPassed = report ? (report.passed === report.total ? "passed" : "failed") : null;

    const status = running ? "running" : (run?.status ?? lastPassed ?? "never run");

    return `
      <tr class="scenario-row flow-row${running ? " running" : ""}" data-name="${escapeHtml(f.name)}" data-scope="${f.scope}" data-file="${escapeHtml(f.fileName)}" data-root="${escapeHtml(f.rootName)}" data-desc="${escapeHtml(f.description ?? "")}" data-tags="${escapeHtml(JSON.stringify(f.tags ?? []))}">
        <td class="col-name">
          <div class="scenario-title-line">
            <a class="scenario-name flow-link" href="${flowUrl(f)}">${escapeHtml(f.name)}</a>
            <span class="meta-badge repo-badge" title="${escapeHtml(f.file)}">${escapeHtml(f.fileName)}</span>
            <span class="meta-badge branch-badge">${escapeHtml(f.rootName)}</span>
            ${tagBadgesHtml(f.tags)}
          </div>
          ${f.description ? `<div class="scenario-desc">${escapeHtml(f.description)}</div>` : ""}
        </td>
        <td class="col-scope"><span class="scope-badge scope-${f.scope}">${f.scope}</span></td>
        <td class="col-links"><span class="scope-badge scope-global">${escapeHtml(f.adapters.join(", ") || "—")}</span></td>
        <td class="col-status" data-status="${escapeHtml(status)}">${statusPill(status)}</td>
        <td class="col-links">${f.models.length > 0 ? escapeHtml(f.models.join(", ")) : "—"}</td>
        <td class="col-actions">
          <a class="btn btn-secondary btn-sm" href="${flowUrl(f)}">Open</a>
          <a class="btn btn-secondary btn-sm" href="/flow/manual?file=${encodeURIComponent(f.file)}&name=${encodeURIComponent(f.name)}">Manual</a>
          <button class="btn btn-primary btn-sm" ${running ? "disabled" : ""}
            onclick="startFlow('${escapeHtml(f.file)}', '${escapeHtml(f.name)}')">Run</button>
        </td>
      </tr>
    `;
  };

  const hasGlobal = flows.some((f) => f.scope === "global");
  const hasProject = flows.some((f) => f.scope === "project");
  const repoNames = [...new Set(flows.map((f) => f.rootName))].sort();

  const iconChevron = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;

  const repoFilter = repoNames.length === 0 ? "" : `
    <div class="filter-group">
      <div class="filter-dropdown" id="flow-repo-dropdown">
        <button type="button" class="filter-dropdown-toggle" onclick="toggleFlowRepoFilter(event)">
          <span id="flow-repo-label">All repos</span>
          ${iconChevron}
        </button>
      </div>
    </div>`;

  const repoPortal = repoNames.length === 0 ? "" : `
    <div id="flow-repo-portal" class="filter-dropdown-panel">
      <label class="dropdown-item dropdown-item--header">
        <input type="checkbox" id="flow-repo-all" checked onchange="toggleAllFlowRepos()">
        <span>All</span>
      </label>
      ${repoNames.map((r) => `
        <label class="dropdown-item">
          <input type="checkbox" class="flow-repo-cb" value="${escapeHtml(r)}" checked onchange="updateFlowRepoFilter()">
          <span>${escapeHtml(r)}</span>
        </label>
      `).join("\n")}
    </div>`;

  const filterBar = `
    <div class="filter-bar" style="margin-bottom: 0.75rem;">
      <div class="filter-group filter-group--search">
        <input type="search" id="flow-search" placeholder="Search flows (name, file, repo, description)..." oninput="filterFlows()">
      </div>
      ${tagSearchInputHtml("flow-tag-search", "Filter by tag...")}
      <div class="filter-group">
        ${hasGlobal ? `<label class="filter-toggle"><input type="checkbox" id="flow-global" checked onchange="filterFlows()"><span>Global</span></label>` : ""}
        ${hasProject ? `<label class="filter-toggle"><input type="checkbox" id="flow-project" checked onchange="filterFlows()"><span>Project</span></label>` : ""}
      </div>
      ${repoFilter}
      ${viewToggleHtml("flow-table-view", "flow-tree-view", "axn-dev-flow-view")}
    </div>
  `;

  const flowTableHeader = `
    <thead>
      <tr>
        <th class="col-name">Flow</th>
        <th class="col-scope">Scope</th>
        <th class="col-links">Adapter</th>
        <th class="col-status">Status</th>
        <th class="col-links">Models</th>
        <th class="col-actions">Actions</th>
      </tr>
    </thead>
  `;

  const treeItems = flows.map((f) => ({
    id: f.file + "::" + f.name,
    name: f.name,
    tags: f.tags,
    bodyHtml: renderRow(f),
  }));

  const tableView = `
    <div id="flow-table-view" class="table-view-wrapper">
      <div class="table-container">
        <table class="scenario-table">
          ${flowTableHeader}
          <tbody id="flows-tbody">
            ${flows.map(renderRow).join("\n")}
          </tbody>
        </table>
        <div id="no-flows" class="no-results" style="display: none;">No flows match the current filters.</div>
      </div>
    </div>
  `;

  const treeView = tagTreeViewHtml("flow-tree-view", treeItems, flowTableHeader, "Untagged flows");

  const table = flows.length > 0
    ? `
      ${filterBar}
      ${tableView}
      ${treeView}
      ${repoPortal}
    `
    : `<div class="status-card">
        <div class="status-card-content">
          <p class="status-title">No flows found</p>
          <p class="status-hint">Add <code>flows/*.xml</code> files to an integration repo or a configured repo to see them here.</p>
          <code class="status-code">axn-dev flow -f flows/example.xml</code>
        </div>
      </div>`;

  const scripts = `<script>
    function filterFlows() {
      const q = (document.getElementById('flow-search')?.value || '').toLowerCase();
      const globalEl = document.getElementById('flow-global');
      const projectEl = document.getElementById('flow-project');
      const wantGlobal = globalEl ? globalEl.checked : true;
      const wantProject = projectEl ? projectEl.checked : true;
      const allowedRepos = new Set();
      document.querySelectorAll('.flow-repo-cb:checked').forEach((cb) => allowedRepos.add(cb.value));
      const rows = document.querySelectorAll('.flow-row');
      let visible = 0;
      rows.forEach((row) => {
        const scope = row.dataset.scope;
        const matchesScope = (scope === 'global' && wantGlobal) || (scope === 'project' && wantProject);
        const matchesRepo = allowedRepos.size === 0 || allowedRepos.has(row.dataset.root);
        const haystack = (row.dataset.name + ' ' + row.dataset.file + ' ' + row.dataset.root + ' ' + (row.dataset.desc || '')).toLowerCase();
        const matchesSearch = !q || haystack.includes(q);
        const show = matchesScope && matchesSearch && matchesRepo;
        row.style.display = show ? '' : 'none';
        if (show) visible++;
      });
      const none = document.getElementById('no-flows');
      if (none) none.style.display = visible === 0 ? '' : 'none';
    }

    function updateFlowRepoLabel() {
      const checked = [...document.querySelectorAll('.flow-repo-cb:checked')].map((cb) => cb.value);
      const all = document.querySelectorAll('.flow-repo-cb');
      const label = document.getElementById('flow-repo-label');
      if (!label) return;
      if (checked.length === 0) label.textContent = 'No repos';
      else if (all.length === checked.length) label.textContent = 'All repos';
      else if (checked.length === 1) label.textContent = checked[0];
      else label.textContent = checked.length + ' repos';
    }

    function updateFlowRepoFilter() {
      const checked = document.querySelectorAll('.flow-repo-cb:checked');
      const all = document.querySelectorAll('.flow-repo-cb');
      const allBox = document.getElementById('flow-repo-all');
      if (checked.length === all.length) { allBox.checked = true; allBox.indeterminate = false; }
      else if (checked.length === 0) { allBox.checked = false; allBox.indeterminate = false; }
      else { allBox.checked = false; allBox.indeterminate = true; }
      updateFlowRepoLabel();
      filterFlows();
    }

    function toggleAllFlowRepos() {
      const checked = document.getElementById('flow-repo-all').checked;
      document.querySelectorAll('.flow-repo-cb').forEach((cb) => cb.checked = checked);
      updateFlowRepoLabel();
      filterFlows();
    }

    function positionFlowRepoPortal() {
      const dropdown = document.getElementById('flow-repo-dropdown');
      const portal = document.getElementById('flow-repo-portal');
      const toggle = dropdown?.querySelector('.filter-dropdown-toggle');
      if (!toggle || !portal) return;
      const rect = toggle.getBoundingClientRect();
      portal.style.left = rect.left + 'px';
      portal.style.minWidth = rect.width + 'px';
      portal.style.top = (rect.bottom + 4) + 'px';
    }

    function closeFlowRepoFilter() {
      document.getElementById('flow-repo-dropdown')?.classList.remove('open');
      const portal = document.getElementById('flow-repo-portal');
      if (portal) portal.classList.remove('open');
      document.removeEventListener('click', closeFlowRepoOutside);
      window.removeEventListener('resize', closeFlowRepoFilter);
    }

    function closeFlowRepoOutside(e) {
      const dropdown = document.getElementById('flow-repo-dropdown');
      const portal = document.getElementById('flow-repo-portal');
      if (dropdown && (dropdown.contains(e.target) || portal?.contains(e.target))) return;
      closeFlowRepoFilter();
    }

    function toggleFlowRepoFilter(e) {
      e.stopPropagation();
      const dropdown = document.getElementById('flow-repo-dropdown');
      const portal = document.getElementById('flow-repo-portal');
      if (!dropdown || !portal) return;
      const isOpen = portal.classList.contains('open');
      if (isOpen) { closeFlowRepoFilter(); return; }
      dropdown.classList.add('open');
      positionFlowRepoPortal();
      portal.classList.add('open');
      document.addEventListener('click', closeFlowRepoOutside);
      window.addEventListener('resize', closeFlowRepoFilter);
    }

    async function startFlow(file, name) {
      const btn = event.target;
      btn.disabled = true;
      btn.textContent = 'Starting...';
      try {
        const res = await fetch('/flows/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file, name }),
        });
        const data = await res.json();
        if (data.success) {
          location.reload();
        } else {
          alert('Failed to start flow: ' + (data.error || 'Unknown error'));
          btn.disabled = false;
          btn.textContent = 'Run';
        }
      } catch (err) {
        alert('Failed to start flow: ' + err.message);
        btn.disabled = false;
        btn.textContent = 'Run';
      }
    }

    // Auto-refresh the page when a tracked run transitions out of "running".
    setInterval(async () => {
      try {
        const res = await fetch('/api/flow-runs', { cache: 'no-store' });
        const runs = await res.json();
        if (runs.some((r) => r.status === 'running')) {
          // still running — keep waiting
        } else if (document.querySelector('[data-status="running"]')) {
          location.reload();
        }
      } catch { /* ignore */ }
    }, 3000);
  </script>`;

  const tagScripts = tagViewScripts("flow-table-view", "flow-tree-view", "flow-tag-search", "axn-dev-flow-view");
  return pageShell("Flows — axn-dev", "flows", counts, table, scripts + tagScripts);
}

/** Describe one parsed step for the Flow tab. */
function stepKindLabel(step: ParsedStep): string {
  if (step.type === "message") return "usermessage";
  if (step.type === "assertions") return "verify";
  if (step.type === "picture") return "picture";
  if (step.type === "video") return "video";
  if (step.type === "repeat") return "repeat";
  if (step.type === "extract") return "extract";
  const runner = step.runner ?? "";
  const lang = step.lang ?? "";
  const isTs = lang === "ts" || lang === "typescript" || runner === "tsx" || (step.src?.endsWith(".ts") ?? false) || (!step.src && !!step.value);
  return isTs ? "typescript" : (lang || runner || "script");
}

function stepKindBadge(step: ParsedStep): string {
  const label = stepKindLabel(step);
  const cls =
    label === "typescript" ? "step-kind-ts" :
    label === "usermessage" ? "step-kind-msg" :
    label === "verify" ? "step-kind-verify" :
    "step-kind-other";
  return `<span class="meta-badge step-kind ${cls}">${escapeHtml(label)}</span>`;
}

function renderStepCard(step: ParsedStep, index: number): string {
  const src = step.src ? `<code>${escapeHtml(step.src)}</code>` : "";
  const value = step.value ? `<pre class="step-code">${escapeHtml(step.value)}</pre>` : "";
  const runner = step.runner ? `<span class="menu-meta">runner: ${escapeHtml(step.runner)}</span>` : "";
  const lang = step.lang ? `<span class="menu-meta">lang: ${escapeHtml(step.lang)}</span>` : "";
  const asserts = step.assertions?.length
    ? `<ul class="step-asserts">${step.assertions.map((a) =>
        `<li><code>${escapeHtml(a.that)}</code> = <code>${escapeHtml(a.value)}</code></li>`
      ).join("\n")}</ul>`
    : "";

  const pictureMeta = step.type === "picture"
    ? `<div class="evidence-meta">
        ${step.name ? `<code>${escapeHtml(step.name)}</code>` : ""}
        ${step.selector ? `<span class="menu-meta">selector: <code>${escapeHtml(step.selector)}</code></span>` : ""}
        ${step.fullPage ? `<span class="menu-meta">fullPage</span>` : ""}
      </div>`
    : "";

  const videoChildren = step.type === "video" && step.children?.length
    ? `<ul class="step-asserts video-children">${step.children.map((c) =>
        `<li>${stepKindBadge(c)} ${c.src ? `<code>${escapeHtml(c.src)}</code> ` : ""}${c.description ? escapeHtml(c.description) : (c.value ? `<code>${escapeHtml(c.value)}</code>` : "")}</li>`
      ).join("\n")}</ul>`
    : "";

  const videoMeta = step.type === "video"
    ? `<div class="evidence-meta">${step.name ? `<code>${escapeHtml(step.name)}</code>` : ""}<span class="menu-meta">records the enclosed steps</span></div>${videoChildren}`
    : "";

  const repeatChildren = step.type === "repeat" && step.children?.length
    ? `<ul class="step-asserts video-children">${step.children.map((c) =>
        `<li>${stepKindBadge(c)} ${c.src ? `<code>${escapeHtml(c.src)}</code> ` : ""}${c.description ? escapeHtml(c.description) : (c.value ? `<code>${escapeHtml(c.value)}</code>` : "")}</li>`
      ).join("\n")}</ul>`
    : "";

  const repeatMeta = step.type === "repeat"
    ? `<div class="evidence-meta"><span class="menu-meta">runs ${step.num ?? "?"}× — block passes at ≥${Math.round((step.success ?? 1) * 100)}% success</span></div>${repeatChildren}`
    : "";

  return `
    <div class="step-card">
      <div class="step-head">
        <span class="step-index">${index + 1}</span>
        ${stepKindBadge(step)}
        ${src}
        ${runner}
        ${lang}
      </div>
      ${step.description ? `<p class="step-desc">${escapeHtml(step.description)}</p>` : ""}
      ${value}
      ${asserts}
      ${pictureMeta}
      ${videoMeta}
      ${repeatMeta}
    </div>
  `;
}

/**
 * Flow detail view — "flow" tab renders the parsed flow (steps, scenarios,
 * models, env, assertions); "reports" tab lists run reports with a filter bar.
 * Left menu stays visible (unlike the iframe scenario view).
 */
export function flowViewHtml(
  flow: FlowInfo,
  parsed: ParsedFlow | null,
  allReports: FlowReportFile[],
  runs: FlowRun[],
  counts: MenuCounts,
): string {
  const reports = allReports.filter((r) => r.flowNames.includes(flow.name));

  // ── Flow tab ──────────────────────────────────────────────
  const scenariosRows = (parsed?.scenarios ?? []).map((s) => `
    <tr>
      <td><span class="scenario-name">${escapeHtml(s.name)}</span></td>
      <td><code>${escapeHtml(s.service ?? "—")}</code></td>
      <td><span class="scope-badge scope-global">${escapeHtml(s.adapter ?? "—")}</span></td>
      <td>${s.readiness.length > 0
        ? s.readiness.map((r) => `<code>${escapeHtml(r.method ?? "GET")} ${escapeHtml(r.path ?? "/")}</code>${r.expected ? ` → <code>${escapeHtml(r.expected)}</code>` : ""}`).join("<br>")
        : "—"}</td>
      <td>${s.orchestrator ? `<code>${escapeHtml(s.orchestrator)}</code>` : "—"}</td>
    </tr>
  `).join("\n");

  const modelsRows = (parsed?.models ?? []).map((m) => `
    <tr><td><code>${escapeHtml(m.provider ?? "")}</code></td><td><code>${escapeHtml(m.name ?? "")}</code></td></tr>
  `).join("\n");

  const envRows = Object.entries(parsed?.env ?? {}).map(([k, v]) => `
    <tr><td><code>${escapeHtml(k)}</code></td><td><code>${escapeHtml(v)}</code></td></tr>
  `).join("\n");

  const setupBadges = [
    parsed?.toolMode ? `<span class="meta-badge repo-badge">tool-mode: ${escapeHtml(parsed.toolMode)}</span>` : "",
    parsed?.useDocker ? `<span class="meta-badge repo-badge">use-docker</span>` : "",
    parsed?.orchestrator ? `<span class="meta-badge branch-badge">orchestrator: ${escapeHtml(parsed.orchestrator)}</span>` : "",
  ].filter(Boolean).join(" ");

  const stepsHtml = (parsed?.steps ?? []).map(renderStepCard).join("\n");

  const flowTab = parsed
    ? `
      ${scenariosRows ? `
        <div class="section-title">Scenarios</div>
        <div class="table-container">
          <table class="scenario-table">
            <thead><tr><th>Name</th><th>Service</th><th>Adapter</th><th>Readiness</th><th>Orchestrator</th></tr></thead>
            <tbody>${scenariosRows}</tbody>
          </table>
        </div>` : ""}
      ${(modelsRows || envRows || setupBadges) ? `
        <div class="section-title" style="margin-top: 1.5rem;">Setup</div>
        ${setupBadges ? `<div class="scenario-meta-badges" style="margin-bottom: 0.75rem;">${setupBadges}</div>` : ""}
        ${modelsRows ? `
          <div class="table-container">
            <table class="scenario-table">
              <thead><tr><th>Model provider</th><th>Model name</th></tr></thead>
              <tbody>${modelsRows}</tbody>
            </table>
          </div>` : ""}
        ${envRows ? `
          <div class="table-container" style="margin-top: 0.5rem;">
            <table class="scenario-table">
              <thead><tr><th>Env var</th><th>Value</th></tr></thead>
              <tbody>${envRows}</tbody>
            </table>
          </div>` : ""}` : ""}
      <div class="section-title" style="margin-top: 1.5rem;">Steps</div>
      ${stepsHtml || `<p class="status-hint">No steps defined.</p>`}
    `
    : `<p class="status-hint">Could not parse the flow file (${escapeHtml(flow.fileName)}).</p>`;

  // ── Reports tab ───────────────────────────────────────────
  const runsRows = runs.map((r) => `
    <tr>
      <td>${escapeHtml(fmtTimestamp(r.startedAt))}</td>
      <td>${statusPill(r.status)}</td>
      <td>${r.exitCode !== undefined ? escapeHtml(String(r.exitCode)) : "—"}</td>
      <td><code>${escapeHtml(r.tail.split("\n").filter(Boolean).slice(-3).join(" ") || "")}</code></td>
    </tr>
  `).join("\n");

  const runsTable = runs.length > 0
    ? `
      <div class="section-title">Runs</div>
      <div class="table-container">
        <table class="scenario-table">
          <thead><tr><th>Started</th><th>Status</th><th>Exit</th><th>Output tail</th></tr></thead>
          <tbody>${runsRows}</tbody>
        </table>
      </div>
    `
    : "";

  const reportRows = reports.map((r) => `
    <tr class="scenario-row report-row" data-ts="${escapeHtml(r.timestamp)}" data-result="${r.passed === r.total ? "passed" : "failed"}">
      <td class="col-name">
        <a class="flow-link" href="${reportUrl(r, flow.name)}">${escapeHtml(fmtTimestamp(r.timestamp))}</a>
      </td>
      <td>${r.passed === r.total
        ? `<span class="status-pill running">Passed ${r.passed}/${r.total}</span>`
        : `<span class="status-pill failed">Failed ${r.passed}/${r.total}</span>`}</td>
      <td class="col-links">${escapeHtml(r.fileName)}</td>
      <td class="col-actions"><a class="btn btn-secondary btn-sm" href="${reportUrl(r, flow.name)}">Open</a></td>
    </tr>
  `).join("\n");

  const reportsTab = `
    ${runsTable}
    <div class="section-title"${runsTable ? ` style="margin-top: 1.5rem;"` : ""}>Reports</div>
    <div class="filter-bar" style="margin-bottom: 0.75rem;">
      <div class="filter-group filter-group--search">
        <input type="search" id="report-search" placeholder="Filter by date (e.g. 9/5/2026 or 14:30)..." oninput="filterReports()">
      </div>
      <div class="filter-group">
        <button class="btn btn-secondary btn-sm" id="report-sort-btn" onclick="toggleReportSort()">Newest first</button>
        <label class="filter-toggle"><input type="checkbox" id="report-passed" onchange="filterReports()"><span>Passed</span></label>
        <label class="filter-toggle"><input type="checkbox" id="report-failed" onchange="filterReports()"><span>Failed</span></label>
      </div>
    </div>
    ${reports.length > 0
      ? `
        <div class="table-container">
          <table class="scenario-table">
            <thead><tr><th>Report</th><th>Result</th><th>File</th><th></th></tr></thead>
            <tbody id="reports-tbody">${reportRows}</tbody>
          </table>
          <div id="no-reports" class="no-results" style="display: none;">No reports match the current filters.</div>
        </div>
      `
      : `<p class="status-hint">No reports for this flow yet.</p>`}
  `;

  const content = `
    <div class="flow-header">
      <div class="scenario-title-line">
        <h2 class="flow-title">${escapeHtml(flow.name)}</h2>
        <span class="meta-badge repo-badge">${escapeHtml(flow.fileName)}</span>
        <span class="meta-badge branch-badge">${escapeHtml(flow.rootName)}</span>
        ${flow.adapters.map((a) => `<span class="scope-badge scope-global">${escapeHtml(a)}</span>`).join("")}
      </div>
      ${flow.description ? `<p class="description">${escapeHtml(flow.description)}</p>` : ""}
      <div class="card-actions">
        <button class="btn btn-primary" onclick="startFlow('${escapeHtml(flow.file)}', '${escapeHtml(flow.name)}')">Run flow</button>
        <a class="btn btn-secondary" href="/flow/manual?file=${encodeURIComponent(flow.file)}&name=${encodeURIComponent(flow.name)}">Manual run</a>
        <a class="btn btn-secondary" href="/flows">← All flows</a>
      </div>
    </div>
    <div class="flow-tabs">
      <button class="flow-tab active" data-tab="flow" onclick="switchFlowTab('flow')">Flow</button>
      <button class="flow-tab" data-tab="reports" onclick="switchFlowTab('reports')">Reports${reports.length > 0 ? ` <span class="menu-meta">(${reports.length})</span>` : ""}</button>
    </div>
    <div class="flow-tab-panel" id="tab-flow">${flowTab}</div>
    <div class="flow-tab-panel" id="tab-reports" hidden>${reportsTab}</div>
  `;

  const scripts = `<script>
    function switchFlowTab(tab) {
      document.querySelectorAll('.flow-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
      document.getElementById('tab-flow').hidden = tab !== 'flow';
      document.getElementById('tab-reports').hidden = tab !== 'reports';
      try { localStorage.setItem('axn-dev-flow-tab:${escapeHtml(flow.name)}', tab); } catch {}
    }
    (function() {
      try {
        const saved = localStorage.getItem('axn-dev-flow-tab:${escapeHtml(flow.name)}');
        if (saved === 'reports') switchFlowTab('reports');
      } catch {}
    })();

    let reportSortDesc = true;

    function toggleReportSort() {
      reportSortDesc = !reportSortDesc;
      document.getElementById('report-sort-btn').textContent = reportSortDesc ? 'Newest first' : 'Oldest first';
      sortReports();
    }

    function sortReports() {
      const tbody = document.getElementById('reports-tbody');
      if (!tbody) return;
      const rows = [...tbody.querySelectorAll('.report-row')];
      rows.sort((a, b) => reportSortDesc
        ? b.dataset.ts.localeCompare(a.dataset.ts)
        : a.dataset.ts.localeCompare(b.dataset.ts));
      rows.forEach((r) => tbody.appendChild(r));
    }

    function filterReports() {
      const q = (document.getElementById('report-search').value || '').toLowerCase();
      const wantPassed = document.getElementById('report-passed').checked;
      const wantFailed = document.getElementById('report-failed').checked;
      const rows = document.querySelectorAll('.report-row');
      let visible = 0;
      rows.forEach((row) => {
        const label = row.querySelector('.flow-link').textContent.toLowerCase();
        const file = row.querySelector('.col-links').textContent.toLowerCase();
        const result = row.dataset.result;
        const matchesSearch = !q || label.includes(q) || file.includes(q);
        const matchesResult = (!wantPassed && !wantFailed) || (wantPassed && result === 'passed') || (wantFailed && result === 'failed');
        const show = matchesSearch && matchesResult;
        row.style.display = show ? '' : 'none';
        if (show) visible++;
      });
      const none = document.getElementById('no-reports');
      if (none) none.style.display = visible === 0 ? '' : 'none';
    }

    async function startFlow(file, name) {
      const btn = event.target;
      btn.disabled = true;
      btn.textContent = 'Starting...';
      try {
        const res = await fetch('/flows/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file, name }),
        });
        const data = await res.json();
        if (data.success) location.reload();
        else { alert('Failed to start flow: ' + (data.error || 'Unknown')); btn.disabled = false; btn.textContent = 'Run flow'; }
      } catch (err) { alert('Failed: ' + err.message); btn.disabled = false; btn.textContent = 'Run flow'; }
    }
    setInterval(async () => {
      try {
        const res = await fetch('/api/flow-runs', { cache: 'no-store' });
        const runs = await res.json();
        const running = runs.filter((r) => r.status === 'running' && r.file === ${JSON.stringify(flow.file)});
        if (running.length === 0 && ${runs.some((r) => r.status === "running") ? "true" : "false"}) location.reload();
      } catch { /* ignore */ }
    }, 3000);
  </script>`;

  return pageShell(`${flow.name} — axn-dev flows`, "flows", counts, content, scripts);
}

/**
 * Report detail — per-flow entries, assertions with pass/fail and expected vs actual.
 */
export function flowReportHtml(
  file: string,
  report: FlowReport,
  flowName: string | undefined,
  counts: MenuCounts,
): string {
  const entries = flowName ? report.flows.filter((f) => f.flow === flowName) : report.flows;

  const sections = entries.map((entry) => {
    const manualStepIndexes = new Set((entry.manualSteps ?? []).map((s) => s.stepIndex));
    const evidenceByStep = new Map<number, EvidenceArtifact[]>();
    const looseEvidence: EvidenceArtifact[] = [];
    for (const e of entry.evidence ?? []) {
      if (e.stepIndex !== undefined && manualStepIndexes.has(e.stepIndex)) {
        const list = evidenceByStep.get(e.stepIndex) ?? [];
        list.push(e);
        evidenceByStep.set(e.stepIndex, list);
      } else {
        looseEvidence.push(e);
      }
    }

    const evidenceThumb = (e: EvidenceArtifact): string => {
      const url = `/flow-evidence?path=${encodeURIComponent(e.path)}`;
      const name = escapeHtml(e.name);
      const inner = e.kind === "video"
        ? `<video src="${url}" preload="metadata" muted></video><span class="thumb-badge">&#9654;</span>`
        : `<img src="${url}" loading="lazy" alt="${name}">`;
      return `<button type="button" class="evidence-thumb" data-evidence-src="${url}" data-evidence-kind="${e.kind}" data-evidence-name="${name}" title="${name}">${inner}</button>`;
    };

    const assertionRows = entry.assertions.map((a) => {
      const repeatDetail = a.repeat
        ? `<div class="assertion-notes">repeat: ${a.repeat.succeeded}/${a.repeat.runs} ok (needed ${a.repeat.needed})${a.repeat.failures.length
            ? `<ul>${a.repeat.failures.map((f) => `<li><code>${escapeHtml(f)}</code></li>`).join("")}</ul>` : ""}</div>`
        : "";
      return `
      <tr>
        <td>
          ${a.description ? `<div class="assertion-desc">${escapeHtml(a.description)}</div>` : ""}
          <code>${escapeHtml(a.that)}</code>
        </td>
        <td><code>${escapeHtml(a.value)}</code></td>
        <td>${a.actual !== undefined ? `<code>${escapeHtml(a.actual)}</code>` : "—"}${repeatDetail}</td>
        <td>${a.notes ? `<div class="assertion-notes">${escapeHtml(a.notes)}</div>` : "—"}</td>
        <td>${a.passed
          ? `<span class="status-pill running">Pass</span>`
          : `<span class="status-pill failed">Fail</span>`}</td>
      </tr>
    `;
    }).join("\n");

    const manualStepsRows = (entry.manualSteps ?? []).map((s) => {
      const thumbs = (evidenceByStep.get(s.stepIndex) ?? []).map(evidenceThumb).join("");
      return `
      <tr>
        <td>${s.stepIndex + 1}</td>
        <td>${s.stepType ? `<code>${escapeHtml(s.stepType)}</code>` : "—"}</td>
        <td>${s.stepDescription ? escapeHtml(s.stepDescription) : "—"}</td>
        <td>${s.response ? `<pre class="step-code">${escapeHtml(s.response)}</pre>` : "—"}</td>
        <td>${s.notes ? escapeHtml(s.notes) : "—"}</td>
        <td>${thumbs ? `<div class="evidence-thumbs">${thumbs}</div>` : "—"}</td>
        <td>${s.passed
          ? `<span class="status-pill running">Pass</span>`
          : `<span class="status-pill failed">Fail</span>`}</td>
      </tr>
    `;
    }).join("\n");

    const manualStepsTable = entry.manualSteps && entry.manualSteps.length > 0
      ? `
        <div class="section-title" style="margin-top: 1.5rem;">Manual steps</div>
        <div class="table-container" style="margin-bottom: 1rem;">
          <table class="scenario-table">
            <thead>
              <tr><th>#</th><th>Type</th><th>Description</th><th>Response</th><th>Notes</th><th>Evidence</th><th>Result</th></tr>
            </thead>
            <tbody>${manualStepsRows}</tbody>
          </table>
        </div>
      `
      : "";

    const evidenceItems = looseEvidence.map((e) => {
      return `
        <figure class="evidence-item">
          ${evidenceThumb(e)}
          <figcaption><code>${escapeHtml(e.name)}</code>${e.stepIndex !== undefined ? `<span class="meta-badge">step ${e.stepIndex + 1}</span>` : ""}<span class="menu-meta">${escapeHtml(e.path)}</span></figcaption>
        </figure>
      `;
    }).join("\n");

    const evidenceSection = looseEvidence.length > 0
      ? `<div class="section-title" style="margin-top: 1.5rem;">Evidence</div><div class="evidence-grid">${evidenceItems}</div>`
      : "";

    return `
      <div class="table-container" style="margin-bottom: 1rem;">
        <table class="scenario-table">
          <thead>
            <tr><th colspan="5">
              <div class="scenario-title-line">
                <span class="scenario-name">${escapeHtml(entry.flow)}</span>
                <span class="meta-badge repo-badge">${escapeHtml(entry.model.provider)}/${escapeHtml(entry.model.name)}</span>
                <span class="status-pill ${entry.passed ? "running" : "failed"}">${entry.passed ? "Passed" : "Failed"}</span>
                <span class="menu-meta">${entry.model.provider === "manual" ? "manual run" : fmtDuration(entry.durationMs)}</span>
              </div>
            </th></tr>
            <tr><th>Assertion</th><th>Expected</th><th>Actual</th><th>Notes</th><th>Result</th></tr>
          </thead>
          <tbody>${assertionRows}</tbody>
        </table>
      </div>
      ${manualStepsTable}
      ${evidenceSection}
      ${entry.error ? `<div class="flow-error"><strong>Error:</strong><pre>${escapeHtml(entry.error)}</pre></div>` : ""}
      ${entry.response ? `<details class="flow-response"><summary>Response</summary><pre>${escapeHtml(entry.response)}</pre></details>` : ""}
    `;
  }).join("\n");

  const title = `Report ${fmtTimestamp(report.timestamp)} — axn-dev`;
  const content = `
    <div class="flow-header">
      <div class="scenario-title-line">
        <h2 class="flow-title">Flow report</h2>
        <span class="meta-badge repo-badge">${escapeHtml(file.split("/").pop() ?? file)}</span>
        ${flowName ? `<span class="meta-badge branch-badge">${escapeHtml(flowName)}</span>` : ""}
      </div>
      <p class="description">${escapeHtml(fmtTimestamp(report.timestamp))} · ${entries.length} entr${entries.length === 1 ? "y" : "ies"}</p>
      <div class="report-path">
        <code id="report-path">${escapeHtml(file)}</code>
        <button type="button" class="btn btn-secondary btn-sm" onclick="copyReportPath()">Copy path</button>
        <button type="button" class="btn btn-secondary btn-sm" onclick="openReportFile()">Open file</button>
      </div>
      <div class="card-actions"><a class="btn btn-secondary" href="${flowName ? "/flows" : "/flows"}">← Back</a></div>
    </div>
    ${sections}
    <div id="evidence-modal" class="evidence-modal" onclick="closeEvidenceModal()">
      <div class="evidence-modal-content" onclick="event.stopPropagation()">
        <button type="button" class="evidence-modal-close" onclick="closeEvidenceModal()">&times;</button>
        <div id="evidence-modal-media"></div>
        <div id="evidence-modal-caption" class="menu-meta"></div>
      </div>
    </div>
  `;

  const scripts = `<script>
    function openEvidenceModal(src, kind, name) {
      const media = document.getElementById('evidence-modal-media');
      media.innerHTML = kind === 'video'
        ? '<video controls autoplay src="' + src + '"></video>'
        : '<img src="' + src + '" alt="">';
      document.getElementById('evidence-modal-caption').textContent = name || '';
      document.getElementById('evidence-modal').classList.add('open');
    }
    function closeEvidenceModal() {
      document.getElementById('evidence-modal').classList.remove('open');
      document.getElementById('evidence-modal-media').innerHTML = '';
    }
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.evidence-thumb');
      if (btn) openEvidenceModal(btn.dataset.evidenceSrc, btn.dataset.evidenceKind, btn.dataset.evidenceName);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeEvidenceModal();
    });

    function copyReportPath() {
      const path = document.getElementById('report-path').textContent;
      navigator.clipboard.writeText(path).then(() => {
        alert('Copied: ' + path);
      }).catch(() => {
        prompt('Copy path:', path);
      });
    }

    async function openReportFile() {
      const path = document.getElementById('report-path').textContent;
      try {
        const res = await fetch('/flow-report/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: path }),
        });
        const data = await res.json();
        if (!data.success) {
          alert('Failed to open file: ' + (data.error || 'Unknown error'));
        }
      } catch (err) {
        alert('Failed: ' + err.message);
      }
    }
  </script>`;

  return pageShell(title, "flows", counts, content, scripts);
}
