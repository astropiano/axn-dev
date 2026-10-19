import type { ScenarioInfo } from "@axn-dev/core";
import type { ScenarioLink } from "@axn-dev/core";
import { hasDriver } from "@axn-dev/core";
import { escapeHtml, menuChevronHtml, menuButtonHtml, menuStyles, menuScripts, type MenuAction } from "./menu.js";

export { escapeHtml };

import { basename } from "node:path";
import {
  tagBadgesHtml,
  tagSearchInputHtml,
  viewToggleHtml,
  tagTreeViewHtml,
  tagViewScripts,
} from "./tagViews.js";

/**
 * Extract the port from a link URL, so it can be auto-associated with the
 * service in `frontend-services` / `backend-services` that owns that port.
 */
export function portFromUrl(url: string): number | null {
  try {
    const u = new URL(url);
    if (u.port) return parseInt(u.port, 10);
    return u.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

/**
 * A chevron rendered as the last element *inside* a service button/link.
 * Clicking it opens the shared fixed-position menu portal (see menu.ts) so
 * the dropdown can never be clipped by an `overflow-x: auto` tab strip or
 * covered by an iframe.
 *
 * `action`: "open" opens links in a new tab; "nav" navigates the same tab.
 */
export function linksChevronHtml(links: ScenarioLink[], action: MenuAction = "open"): string {
  return menuChevronHtml(links, action, "Interesting links");
}

export function linksButtonHtml(links: ScenarioLink[], action: MenuAction = "open", label = "Links"): string {
  return menuButtonHtml(links, action, label);
}

/** Which main menu entry the current page belongs to. */
export type MenuSection = "scenarios" | "flows";

export interface MenuCounts {
  scenarioTotal: number;
  scenarioRunning: number;
  flowTotal: number;
  flowRunning: number;
}

const iconSun = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`;
const iconMoon = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`;
const iconMonitor = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>`;

/**
 * Shared page chrome for all menu views (dashboard, flows, flow detail).
 * Top header: "axn-dev" wordmark + concise theme cycle toggle.
 * Left: clickable menu (scenarios / flows) with small counters.
 * The scenario view (iframe) does NOT use this shell.
 */
export function pageShell(
  title: string,
  active: MenuSection,
  counts: MenuCounts,
  content: string,
  extraScripts = "",
): string {
  const scenarioMeta = `${counts.scenarioRunning} running / ${counts.scenarioTotal} total`;
  const flowMeta = counts.flowRunning > 0
    ? `${counts.flowRunning} running / ${counts.flowTotal} total`
    : `${counts.flowTotal} total`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <link href="https://fonts.googleapis.com/css2?family=Raleway:wght@400;500;700;900&family=Lato:wght@400;700&display=swap" rel="stylesheet">
  ${dashboardStyles}
  ${menuStyles}
</head>
<body>
  <header class="top-header">
    <a class="app-brand" href="/" onclick="axnDevNavigate('/'); return false;">axn-dev</a>
    <div class="top-header-right">
      <button type="button" class="theme-cycle" id="theme-cycle" title="Theme: auto" onclick="cycleTheme()"></button>
    </div>
  </header>
  <div class="app">
    <nav class="side-menu">
      <a class="menu-item${active === "scenarios" ? " active" : ""}" href="/" onclick="axnDevNavigate('/'); return false;">
        <span class="menu-label">Scenarios</span>
        <span class="menu-meta">${escapeHtml(scenarioMeta)}</span>
      </a>
      <a class="menu-item${active === "flows" ? " active" : ""}" href="/flows" onclick="axnDevNavigate('/flows'); return false;">
        <span class="menu-label">Flows</span>
        <span class="menu-meta">${escapeHtml(flowMeta)}</span>
      </a>
    </nav>
    <main class="main">
      <div id="main-loading" class="main-loading" aria-hidden="true" style="display: none;">
        <div class="spinner"></div>
        <span class="page-loading-text">Loading...</span>
      </div>
      ${content}
    </main>
  </div>

  ${sharedScripts}
  ${menuScripts}
  ${extraScripts}
</body>
</html>`;
}

export function dashboardHtml(
  projectScenarios: Array<ScenarioInfo & { repoName: string }>,
  globalScenarios: ScenarioInfo[],
  runningDirs: Set<string>,
  counts: MenuCounts,
  linksByScenario: Map<ScenarioInfo, ScenarioLink[]> = new Map(),
): string {
  const isRunning = (s: ScenarioInfo) => runningDirs.has(s.path.replace(/\/+$/, ""));

  const allRepoNames = [...new Set(projectScenarios.map((s) => s.repoName))].sort();
  const hasScenarios = globalScenarios.length > 0 || projectScenarios.length > 0;

  const renderRow = (s: ScenarioInfo, source: "global" | "project", repoName?: string): string => {
    const running = isRunning(s);
    const frontendMap: Record<string, string> = s.frontendServices ?? s.proxies ?? {};
    // Non-compose scenarios synthesize their endpoints via the driver in
    // the scenario view, so they always have an Open target.
    const hasFrontend = Object.keys(frontendMap).length > 0
      || (s.type !== undefined && s.type !== "compose" && hasDriver(s.type));

    const repoPath = s.worktree?.path;
    const repoBadge = repoName
      ? `<span class="meta-badge repo-badge" title="${escapeHtml(repoPath ?? "")}">${escapeHtml(repoName)}</span>`
      : "";
    const branchBadge = s.worktree?.branch
      ? `<span class="meta-badge branch-badge" title="branch: ${escapeHtml(s.worktree.branch)}">${escapeHtml(s.worktree.branch)}</span>`
      : "";
    const worktreeBadge = s.worktree && !s.worktree.isMain
      ? `<span class="meta-badge worktree-badge" title="${escapeHtml(s.worktree.path)}">${escapeHtml(basename(s.worktree.path))}</span>`
      : "";

    // Link resolution (running endpoints / compose ports + static links)
    // happens in handleDashboard — it needs async docker lookups, so rows
    // just consume the precomputed lists.
    const rowLinks = linksByScenario.get(s) ?? [];
    const linksHtml = rowLinks.length > 0 ? linksButtonHtml(rowLinks, "open") : "";

    // Variant scenarios may share a directory name across roots
    // (gen1/sim vs gen2/sim) — address them by qualified name.
    const qName = s.variant ? `${s.variant}/${s.name}` : s.name;
    const variantBadge = s.variant
      ? `<span class="scope-badge">${escapeHtml(s.variant)}</span>`
      : "";

    return `
      <tr class="scenario-row${running ? " running" : ""}" data-name="${escapeHtml(qName)}" data-repo="${escapeHtml(repoName ?? "")}" data-scope="${source}" data-running="${running ? "true" : "false"}" data-tags="${escapeHtml(JSON.stringify(s.tags ?? []))}">
        <td class="col-name">
          <div class="scenario-title-line">
            <span class="scenario-name">${escapeHtml(s.name)}</span>
            <span class="scenario-meta-badges">${variantBadge}${repoBadge}${branchBadge}${worktreeBadge}${tagBadgesHtml(s.tags)}</span>
          </div>
          ${s.description ? `<div class="scenario-desc">${escapeHtml(s.description)}</div>` : ""}
        </td>
        <td class="col-scope"><span class="scope-badge scope-${source}">${source}</span></td>
        <td class="col-status"><span class="status-pill ${running ? "running" : "stopped"}">${running ? "Running" : "Stopped"}</span></td>
        <td class="col-links">${linksHtml}</td>
        <td class="col-actions">
          ${running
            ? `${hasFrontend ? `<a class="btn btn-secondary btn-sm" href="/scenario/${encodeURIComponent(qName)}" title="Open scenario view" onclick="axnDevNavigate(this.href); return false;">Open</a>` : ""}
               <button class="btn btn-danger btn-sm" onclick="stopScenario('${escapeHtml(qName)}', '${source}'${repoName ? `, '${escapeHtml(repoName)}'` : ""})">Stop</button>`
            : `<button class="btn btn-primary btn-sm" onclick="startScenario('${escapeHtml(qName)}', '${source}'${repoName ? `, '${escapeHtml(repoName)}'` : ""})">Start</button>`
          }
        </td>
      </tr>
    `;
  };

  const totalCount = globalScenarios.length + projectScenarios.length;

  const iconSearch = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>`;
  const iconChevron = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
  const iconAlert = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`;

  const repoFilterOptions = allRepoNames.length === 0
    ? ""
    : `
      <div class="filter-group">
        <div class="filter-dropdown" id="repo-filter-dropdown">
          <button type="button" class="filter-dropdown-toggle" onclick="toggleRepoFilter(event)">
            <span id="repo-filter-label">All repos</span>
            ${iconChevron}
          </button>
        </div>
      </div>
    `;

  const repoFilterPortal = allRepoNames.length === 0
    ? ""
    : `
      <div id="repo-filter-portal" class="filter-dropdown-panel">
        <label class="dropdown-item dropdown-item--header">
          <input type="checkbox" id="repo-filter-all" checked onchange="toggleAllRepos(); saveDashboardFilters()">
          <span>All</span>
        </label>
        ${allRepoNames.map((repo) => `
          <label class="dropdown-item">
            <input type="checkbox" class="repo-filter" value="${escapeHtml(repo)}" checked onchange="updateRepoFilter(); saveDashboardFilters()">
            <span>${escapeHtml(repo)}</span>
          </label>
        `).join("\n")}
      </div>
    `;

  const filterBar = hasScenarios
    ? `
      <div class="dashboard-header">
        <div class="filter-bar">
          <div class="filter-group filter-group--search">
            ${iconSearch}
            <input type="search" id="scenario-search" placeholder="Filter by scenario name..." oninput="filterScenarios(); saveDashboardFilters()">
          </div>
          ${tagSearchInputHtml("scenario-tag-search", "Filter by tag...")}
          <div class="filter-group">
            <label class="filter-toggle">
              <input type="checkbox" id="show-global" checked onchange="filterScenarios(); saveDashboardFilters()">
              <span>Global</span>
            </label>
            <label class="filter-toggle">
              <input type="checkbox" id="show-project" checked onchange="filterScenarios(); saveDashboardFilters()">
              <span>Project</span>
            </label>
          </div>
          ${repoFilterOptions}
          ${viewToggleHtml("scenario-table-view", "scenario-tree-view", "axn-dev-scenario-view")}
        </div>
      </div>
    `
    : "";

  const allScenarios: Array<ScenarioInfo & { source: "global" | "project"; repoName?: string }> = [
    ...globalScenarios.map((s) => ({ ...s, source: "global" as const })),
    ...projectScenarios.map((s) => ({ ...s, source: "project" as const, repoName: s.repoName })),
  ];

  const scenarioTableHeader = `
    <thead>
      <tr>
        <th class="col-name sortable" onclick="sortBy('name')">
          <span>Scenario</span>
          <span class="sort-indicator" data-column="name"></span>
        </th>
        <th class="col-scope sortable" onclick="sortBy('scope')">
          <span>Type</span>
          <span class="sort-indicator" data-column="scope"></span>
        </th>
        <th class="col-status sortable" onclick="sortBy('status')">
          <span>Status</span>
          <span class="sort-indicator" data-column="status"></span>
        </th>
        <th class="col-links">Links</th>
        <th class="col-actions">Actions</th>
      </tr>
    </thead>
  `;

  const treeItems = allScenarios.map((s) => ({
    id: s.path,
    name: s.name,
    tags: s.tags,
    bodyHtml: renderRow(s as any, s.source, s.repoName),
  }));

  const tableView = `
    <div id="scenario-table-view" class="table-view-wrapper">
      <div class="table-container">
        <table class="scenario-table">
          ${scenarioTableHeader}
          <tbody id="scenarios-tbody">
            ${globalScenarios.map((s) => renderRow(s, "global")).join("\n")}
            ${projectScenarios.map((s) => renderRow(s, "project", s.repoName)).join("\n")}
          </tbody>
        </table>
        <div id="no-results" class="no-results" style="display: none;">
          No scenarios match the current filters.
        </div>
      </div>
    </div>
  `;

  const treeView = tagTreeViewHtml("scenario-tree-view", treeItems, scenarioTableHeader, "Untagged scenarios");

  const tableHtml = hasScenarios
    ? `${tableView}${treeView}`
    : "";

  const emptyStateHtml = totalCount === 0
    ? `<div class="status-card">
        <div class="status-card-content">
          <div class="status-icon alert">${iconAlert}</div>
          <p class="status-title">No scenarios configured</p>
          <p class="status-hint">Add scenarios to your project or global config to see them here.</p>
          <code class="status-code">axn-dev start -s &lt;scenario&gt;</code>
        </div>
      </div>`
    : "";

  const content = `
    ${emptyStateHtml}
    ${filterBar}
    ${tableHtml}
    ${repoFilterPortal}
  `;

  const tagScripts = tagViewScripts("scenario-table-view", "scenario-tree-view", "scenario-tag-search", "axn-dev-scenario-view");
  return pageShell("axn-dev", "scenarios", counts, content, dashboardScripts + tagScripts);
}

const dashboardStyles = `<style>
  :root {
    --primary-blue: #1E6F9A;
    --primary-blue-hover: #3C99AF;
    --neutral-obsidian: #0F0B0A;
    --neutral-slate: #3A3A3A;
    --neutral-cloud: #A2D7D7;
    --neutral-mist: #EBEBEB;
    --neutral-surface: #FFFFFF;
    --accent-red: #F45B69;
    --accent-green: #22C55E;
    --font-heading: "Raleway", sans-serif;
    --font-body: "Lato", sans-serif;
    --bg: var(--neutral-mist);
    --text: var(--neutral-obsidian);
    --text-muted: var(--neutral-slate);
    --surface: rgba(255, 255, 255, 0.8);
    --surface-solid: var(--neutral-surface);
    --border: var(--neutral-cloud);
    --accent: var(--primary-blue);
    --accent-hover: var(--primary-blue-hover);
    --accent-text: #FFFFFF;
  }

  [data-theme="dark"] {
    --bg: var(--neutral-obsidian);
    --text: var(--neutral-mist);
    --text-muted: #B0B0B0;
    --surface: rgba(26, 26, 26, 0.8);
    --surface-solid: #1A1A1A;
    --border: #3A3A3A;
    --accent: var(--accent-red);
    --accent-hover: #F0A3AA;
    --accent-text: var(--neutral-obsidian);
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { height: 100%; }

  body {
    font-family: var(--font-body), -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.4;
    transition: background-color 0.2s ease, color 0.2s ease;
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  /* ── Top header ─────────────────────────────────────────── */
  .top-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 48px;
    padding: 0 1rem;
    background: var(--surface);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .app-brand {
    font-family: var(--font-heading);
    font-size: 1.05rem;
    font-weight: 900;
    color: var(--primary-blue);
    letter-spacing: -0.01em;
    text-decoration: none;
  }

  .top-header-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  /* Single icon-only theme toggle, cycles light → dark → auto → light */
  .theme-cycle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text-muted);
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .theme-cycle:hover {
    color: var(--accent);
    border-color: var(--accent);
  }

  .theme-cycle:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .app {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  /* ── Left menu ──────────────────────────────────────────── */
  .side-menu {
    width: 200px;
    min-width: 160px;
    background: var(--surface);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-right: 1px solid var(--border);
    padding: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    overflow-y: auto;
    flex-shrink: 0;
  }

  .menu-item {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 0.55rem 0.75rem;
    border-radius: 8px;
    text-decoration: none;
    color: var(--text-muted);
    transition: all 0.15s ease;
    border: 1px solid transparent;
  }

  .menu-item:hover {
    background: var(--surface-solid);
    color: var(--text);
  }

  .menu-item.active {
    background: var(--surface-solid);
    border-color: var(--border);
    color: var(--text);
  }

  .menu-item.active .menu-label {
    color: var(--accent);
  }

  .menu-label {
    font-family: var(--font-heading);
    font-weight: 700;
    font-size: 0.9rem;
    color: var(--text);
  }

  .menu-meta {
    font-size: 0.68rem;
    font-weight: 500;
    color: var(--text-muted);
    letter-spacing: 0.02em;
  }

  .main {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    padding: 1rem;
  }

  .scenario-section {
    margin-bottom: 2rem;
  }

  .section-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1rem;
    color: var(--text-muted);
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .section-title svg {
    color: var(--primary-blue);
  }

  .dashboard-header {
    margin-bottom: 0.75rem;
  }

  .filter-bar {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: 0.6rem;
    background: var(--surface);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 0.5rem 0.75rem;
    overflow-x: auto;
  }

  .filter-group {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
    flex-shrink: 0;
  }

  .filter-group--search {
    flex: 1;
    min-width: 160px;
    max-width: 320px;
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
    color: var(--text-muted);
    background: var(--surface-solid);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0 0.5rem;
  }

  .filter-group--search input[type="search"] {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    padding: 0.45rem 0;
    color: var(--text);
    font-family: var(--font-body);
    font-size: 0.85rem;
    outline: none;
  }

  .filter-group--search input[type="search"]::placeholder {
    color: var(--text-muted);
  }

  .filter-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.4rem 0.6rem;
    background: var(--surface-solid);
    border: 1px solid var(--border);
    border-radius: 8px;
    cursor: pointer;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text);
    user-select: none;
  }

  .filter-toggle input {
    accent-color: var(--accent);
    width: 14px;
    height: 14px;
  }

  .filter-dropdown {
    position: relative;
  }

  .filter-dropdown-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    padding: 0.4rem 0.6rem;
    background: var(--surface-solid);
    border: 1px solid var(--border);
    border-radius: 2px;
    cursor: pointer;
    font-family: var(--font-body);
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--text);
  }

  .filter-dropdown-toggle:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .filter-dropdown.open .filter-dropdown-toggle {
    border-color: var(--accent);
  }

  .filter-dropdown.open .filter-dropdown-toggle svg {
    transform: rotate(180deg);
  }

  .filter-dropdown-panel {
    display: none;
    position: fixed;
    top: 0;
    left: 0;
    min-width: 180px;
    max-height: 600px;
    overflow-y: auto;
    background: var(--surface-solid);
    border: 1px solid var(--border);
    border-radius: 2px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
    padding: 0.25rem;
    z-index: 1000;
  }

  .filter-dropdown-panel.open {
    display: block;
  }

  .dropdown-item {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.5rem;
    border-radius: 2px;
    cursor: pointer;
    font-size: 0.8rem;
    color: var(--text);
  }

  .dropdown-item:hover {
    background: rgba(30, 111, 154, 0.08);
  }

  .dropdown-item--header {
    border-bottom: 1px solid var(--border);
    font-weight: 500;
  }

  .dropdown-item input {
    accent-color: var(--accent);
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }

  .table-container {
    background: var(--surface-solid);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
  }

  .scenario-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }

  .scenario-table thead {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }

  .scenario-table th {
    padding: 0.55rem 0.75rem;
    text-align: left;
    font-size: 0.6rem;
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    white-space: nowrap;
  }

  .scenario-table th.sortable {
    cursor: pointer;
    user-select: none;
  }

  .scenario-table th.sortable:hover {
    color: var(--text);
  }

  .sort-indicator {
    display: inline-block;
    width: 0.7rem;
    margin-left: 0.25rem;
    text-align: center;
    color: var(--accent);
    font-size: 0.7rem;
  }

  .scenario-table td {
    padding: 0.55rem 0.75rem;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }

  .scenario-table tbody tr:last-child td {
    border-bottom: none;
  }

  .scenario-table tbody tr:hover {
    background: rgba(30, 111, 154, 0.04);
  }

  .scenario-table tbody tr.running {
    border-left: 3px solid var(--accent-green);
  }

  .scenario-title-line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
  }

  .scenario-name {
    font-family: var(--font-heading);
    font-weight: 700;
    color: var(--text);
  }

  .scenario-meta-badges {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem;
  }

  .scenario-desc {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-top: 0.25rem;
    line-height: 1.4;
  }

  .scope-badge {
    display: inline-block;
    padding: 0.15rem 0.45rem;
    border-radius: 999px;
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: capitalize;
    letter-spacing: 0.02em;
    background: rgba(162, 215, 215, 0.35);
    color: var(--text);
  }

  .scope-badge.scope-global {
    background: rgba(30, 111, 154, 0.15);
    color: var(--primary-blue);
  }

  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.2rem 0.5rem;
    border-radius: 999px;
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.01em;
    white-space: nowrap;
  }

  .status-pill.running {
    background: rgba(34, 197, 94, 0.12);
    color: var(--accent-green);
  }

  .status-pill.stopped {
    background: var(--surface);
    color: var(--text-muted);
    border: 1px solid var(--border);
  }

  .status-pill.failed {
    background: rgba(244, 91, 105, 0.12);
    color: var(--accent-red);
  }

  .flow-header {
    margin-bottom: 0.25rem;
  }

  .flow-title {
    font-family: var(--font-heading);
    font-weight: 700;
    font-size: 1.3rem;
    color: var(--text);
  }

  .flow-link {
    color: var(--text);
    text-decoration: none;
  }

  .flow-link:hover {
    color: var(--accent);
    text-decoration: underline;
  }

  .flow-error {
    background: rgba(244, 91, 105, 0.08);
    border: 1px solid rgba(244, 91, 105, 0.25);
    border-radius: 8px;
    padding: 0.75rem 1rem;
    margin-bottom: 1rem;
    color: var(--accent-red);
    font-size: 0.85rem;
  }

  .flow-response {
    background: var(--surface-solid);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.75rem 1rem;
    margin-bottom: 1rem;
  }

  .flow-response summary {
    cursor: pointer;
    font-size: 0.8rem;
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .flow-response pre,
  .flow-error pre {
    margin-top: 0.5rem;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.8rem;
    color: var(--text);
    max-height: 320px;
    overflow-y: auto;
  }

  /* ── Flow view tabs ─────────────────────────────────────── */
  .flow-tabs {
    display: flex;
    gap: 0.25rem;
    border-bottom: 1px solid var(--border);
    margin-top: 1.25rem;
    margin-bottom: 1.25rem;
  }

  .flow-tab {
    padding: 0.55rem 1.1rem;
    border: none;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: var(--text-muted);
    font-family: var(--font-body);
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .flow-tab:hover {
    color: var(--text);
  }

  .flow-tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }

  .flow-tab:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .flow-tab-panel {
    min-height: 0;
  }

  /* ── Flow steps ─────────────────────────────────────────── */
  .step-card {
    background: var(--surface-solid);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0.85rem 1rem;
    margin-bottom: 0.6rem;
  }

  .step-head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }

  .step-index {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 999px;
    background: rgba(30, 111, 154, 0.12);
    color: var(--primary-blue);
    font-family: var(--font-heading);
    font-weight: 700;
    font-size: 0.72rem;
    flex-shrink: 0;
  }

  .step-kind-ts {
    background: rgba(49, 120, 198, 0.15);
    color: #4d9be6;
  }

  .step-kind-msg {
    background: rgba(34, 197, 94, 0.12);
    color: var(--accent-green);
  }

  .step-kind-other {
    background: rgba(30, 111, 154, 0.12);
    color: var(--primary-blue);
  }

  .step-kind-verify {
    background: rgba(245, 166, 35, 0.15);
    color: #d99413;
  }

  .step-asserts {
    margin: 0.5rem 0 0;
    padding-left: 1.2rem;
    font-size: 0.82rem;
    color: var(--text);
  }

  .step-asserts li {
    margin-bottom: 0.15rem;
  }

  .evidence-meta {
    margin-top: 0.5rem;
    display: flex;
    gap: 0.75rem;
    align-items: baseline;
    font-size: 0.82rem;
  }

  .video-children {
    margin-top: 0.4rem;
  }

  .video-children li {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
  }

  .evidence-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .evidence-item {
    margin: 0;
    max-width: 480px;
  }

  .evidence-media {
    max-width: 100%;
    border: 1px solid var(--border, #ddd);
    border-radius: 6px;
    display: block;
  }

  .evidence-item figcaption {
    margin-top: 0.35rem;
    font-size: 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .evidence-item figcaption .menu-meta {
    word-break: break-all;
  }

  .evidence-thumbs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }

  .evidence-thumb {
    position: relative;
    width: 72px;
    height: 48px;
    padding: 0;
    border: 1px solid var(--border, #ddd);
    border-radius: 4px;
    overflow: hidden;
    cursor: zoom-in;
    background: #000;
  }

  .evidence-thumb img,
  .evidence-thumb video {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .evidence-thumb .thumb-badge {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-size: 1.1rem;
    text-shadow: 0 0 4px rgba(0, 0, 0, 0.8);
    background: rgba(0, 0, 0, 0.25);
  }

  .evidence-modal {
    display: none;
    position: fixed;
    inset: 0;
    z-index: 1000;
    background: rgba(0, 0, 0, 0.8);
    align-items: center;
    justify-content: center;
  }

  .evidence-modal.open {
    display: flex;
  }

  .evidence-modal-content {
    position: relative;
    max-width: 90vw;
    max-height: 90vh;
  }

  .evidence-modal-content img,
  .evidence-modal-content video {
    max-width: 90vw;
    max-height: 82vh;
    display: block;
  }

  .evidence-modal-close {
    position: absolute;
    top: -0.5rem;
    right: -0.5rem;
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    border: none;
    background: var(--surface, #fff);
    color: var(--text, #000);
    font-size: 1.2rem;
    line-height: 1;
    cursor: pointer;
  }

  .evidence-modal-content .menu-meta {
    color: #ccc;
    margin-top: 0.5rem;
    text-align: center;
    word-break: break-all;
  }

  .step-desc {
    margin-top: 0.5rem;
    font-size: 0.85rem;
    color: var(--text);
  }

  .step-code {
    margin-top: 0.5rem;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.78rem;
    color: var(--text-muted);
    background: var(--bg);
    border-radius: 6px;
    padding: 0.6rem 0.75rem;
    max-height: 220px;
    overflow-y: auto;
  }

  .filter-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.8rem;
    color: var(--text-muted);
    cursor: pointer;
    user-select: none;
  }

  .filter-toggle input {
    accent-color: var(--accent);
    cursor: pointer;
  }

  .service-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }

  .service-link--small {
    padding: 0.15rem 0.4rem;
    font-size: 0.7rem;
    border-radius: 5px;
  }

  .btn-sm {
    padding: 0.2rem 0.5rem;
    font-size: 0.75rem;
    border-radius: 2px;
    white-space: nowrap;
  }

  .col-actions {
    width: 1%;
    white-space: nowrap;
    text-align: right;
  }

  .col-actions .btn + .btn {
    margin-left: 0.35rem;
  }

  .no-results {
    padding: 2.5rem 1.5rem;
    text-align: center;
    color: var(--text-muted);
    font-size: 0.95rem;
  }

  .scenario-card {
    background: var(--surface-solid);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 1.25rem;
    margin-bottom: 0.75rem;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
    transition: border-color 0.2s ease, box-shadow 0.2s ease;
  }

  .scenario-card.running {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent), 0 4px 12px rgba(30, 111, 154, 0.08);
  }

  [data-theme="dark"] .scenario-card.running {
    box-shadow: 0 0 0 1px var(--accent), 0 4px 12px rgba(244, 91, 105, 0.08);
  }

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1rem;
    margin-bottom: 0.5rem;
  }

  .card-title-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .card-header h3 {
    font-family: var(--font-heading);
    font-weight: 700;
    font-size: 1.125rem;
    color: var(--text);
    line-height: 1.3;
  }

  .meta-badge {
    display: inline-flex;
    align-items: center;
    padding: 0.12rem 0.35rem;
    border-radius: 4px;
    font-size: 0.65rem;
    font-weight: 600;
    letter-spacing: 0.01em;
    cursor: default;
  }

  .repo-badge {
    background: rgba(162, 215, 215, 0.35);
    color: var(--text);
  }

  [data-theme="dark"] .repo-badge {
    background: rgba(244, 91, 105, 0.15);
  }

  .branch-badge {
    background: rgba(30, 111, 154, 0.12);
    color: var(--primary-blue);
  }

  [data-theme="dark"] .branch-badge {
    background: rgba(30, 111, 154, 0.2);
  }

  .worktree-badge {
    background: rgba(30, 111, 154, 0.08);
    color: #2e8b8b;
    border: 1px solid rgba(30, 111, 154, 0.25);
  }

  [data-theme="dark"] .worktree-badge {
    background: rgba(46, 139, 139, 0.12);
    color: #5bc0be;
    border-color: rgba(91, 192, 190, 0.3);
  }

  .card-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .description {
    color: var(--text-muted);
    font-size: 0.95rem;
    margin-bottom: 0.75rem;
    line-height: 1.5;
  }

  .services {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .service-link {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    background: var(--surface);
    color: var(--accent);
    text-decoration: none;
    padding: 0.4rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.8rem;
    transition: all 0.2s ease;
  }

  .service-link:hover {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-text);
  }

  .services--backend {
    align-items: center;
    margin-top: 0.25rem;
    opacity: 0.7;
  }

  .services-label {
    font-size: 0.65rem;
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-right: 0.25rem;
    white-space: nowrap;
  }

  .service-link--backend {
    font-size: 0.75rem;
    padding: 0.25rem 0.55rem;
  }

  .links-chevron {
    display: inline-flex;
    align-items: center;
    margin-left: 0.35rem;
    padding: 0 0.15rem;
    font-size: 0.65rem;
    line-height: 1;
    opacity: 0.7;
  }

  .service-link:hover .links-chevron {
    opacity: 1;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    padding: 0.5rem 1rem;
    border-radius: 2px;
    border: 1px solid transparent;
    cursor: pointer;
    font-family: var(--font-body);
    font-size: 0.85rem;
    font-weight: 500;
    transition: all 0.2s ease;
  }

  .btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .btn-primary {
    background: var(--accent);
    color: var(--accent-text);
    border-color: var(--accent);
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }

  .btn-secondary {
    background: transparent;
    color: var(--accent);
    border-color: var(--accent);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--accent);
    color: var(--accent-text);
  }

  .btn-danger {
    background: transparent;
    color: var(--accent-red);
    border-color: var(--accent-red);
  }

  .btn-danger:hover:not(:disabled) {
    background: var(--accent-red);
    color: #FFFFFF;
  }

  .status-badge {
    display: inline-flex;
    align-items: center;
    padding: 0.35rem 0.75rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .status-badge.running {
    background: rgba(34, 197, 94, 0.12);
    color: var(--accent-green);
  }

  .status-card {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 60vh;
  }

  .status-card-content {
    width: 100%;
    max-width: 560px;
    background: var(--surface);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid var(--border);
    border-radius: 24px;
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.08);
    padding: 3rem 2.5rem;
    text-align: center;
  }

  .status-icon {
    display: inline-flex;
    border-radius: 50%;
    padding: 1.25rem;
    margin-bottom: 1.5rem;
  }

  .status-icon.alert {
    background: rgba(244, 91, 105, 0.08);
    color: var(--accent-red);
    border: 1px solid rgba(244, 91, 105, 0.2);
  }

  .status-title {
    font-family: var(--font-heading);
    font-size: 1.75rem;
    font-weight: 700;
    font-style: italic;
    color: var(--text);
    margin-bottom: 0.75rem;
    line-height: 1.2;
  }

  .status-hint {
    color: var(--text-muted);
    font-size: 1rem;
    line-height: 1.6;
    margin-bottom: 1.5rem;
  }

  .status-code {
    display: block;
    width: 100%;
    text-align: left;
    background: var(--surface-solid);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.9rem;
    color: var(--text-muted);
    word-break: break-all;
  }

  code {
    background: var(--surface-solid);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.15rem 0.35rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.85em;
  }

  @media (max-width: 900px) {
    .app {
      flex-direction: column;
      overflow: auto;
    }

    .side-menu {
      width: 100%;
      flex-direction: row;
      border-right: none;
      border-bottom: 1px solid var(--border);
    }

    .menu-item {
      flex: 1;
    }

    .main {
      padding: 1rem;
    }

    .filter-bar {
      flex-wrap: wrap;
    }

    .card-header {
      flex-direction: column;
      gap: 0.75rem;
    }

    .card-actions {
      width: 100%;
      justify-content: flex-start;
    }
  }

  .tag-badge {
    background: rgba(245, 166, 35, 0.15);
    color: #b47b12;
    border: 1px solid rgba(245, 166, 35, 0.25);
  }

  [data-theme="dark"] .tag-badge {
    background: rgba(245, 166, 35, 0.12);
    color: #f5a623;
    border-color: rgba(245, 166, 35, 0.3);
  }

  .view-toggle {
    display: inline-flex;
    gap: 0;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }

  .view-toggle-btn {
    padding: 0.4rem 0.7rem;
    background: var(--surface-solid);
    border: none;
    font-family: var(--font-body);
    font-size: 0.8rem;
    color: var(--text-muted);
    cursor: pointer;
  }

  .view-toggle-btn.active {
    background: var(--accent);
    color: var(--accent-text);
  }

  .tree-view-wrapper {
    margin-top: 0.5rem;
  }

  .tag-folder {
    margin: 0.25rem 0 0.25rem 0.75rem;
  }

  .tag-folder-summary {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.35rem 0;
    font-weight: 600;
    font-size: 0.85rem;
    color: var(--text);
    cursor: pointer;
    user-select: none;
  }

  .tag-untagged {
    margin-bottom: 0.75rem;
  }

  .tag-untagged-summary {
    cursor: default;
  }

  .tag-tree-list {
    list-style: none;
    padding-left: 1.5rem;
    margin: 0;
  }

  .tag-tree-leaf {
    padding: 0.25rem 0;
    font-size: 0.85rem;
  }

  .tag-folder-content {
    padding-left: 0.5rem;
    border-left: 1px solid var(--border);
    margin-left: 0.25rem;
  }

  .folder-icon {
    display: inline-flex;
    align-items: center;
    color: var(--text-muted);
  }

  .folder-icon svg {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }

  .main {
    position: relative;
  }

  .main-loading {
    display: none;
    position: absolute;
    inset: 0;
    z-index: 10;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    background: var(--bg);
    color: var(--text);
  }

  .spinner {
    width: 32px;
    height: 32px;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .page-loading-text {
    font-family: var(--font-heading);
    font-size: 0.9rem;
    color: var(--text-muted);
  }

  /* ── Manual flow execution ──────────────────────────────── */
  .manual-scenario-check {
    background: var(--surface-solid);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1rem;
    margin-bottom: 1rem;
  }
  .manual-scenario-check h3 {
    font-family: var(--font-heading);
    font-size: 0.95rem;
    margin-bottom: 0.5rem;
  }
  .manual-scenario-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0;
  }
  .manual-step-card {
    background: var(--surface-solid);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0.9rem;
    margin-bottom: 0.75rem;
  }
  .manual-step-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }
  .manual-step-controls,
  .manual-assertion-controls {
    display: flex;
    gap: 1rem;
    margin: 0.5rem 0;
  }
  .manual-assertion {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.75rem;
    margin: 0.5rem 0;
  }
  .manual-assertion-label {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: baseline;
    margin-bottom: 0.35rem;
  }
  .manual-assertion-desc {
    color: var(--text-muted);
    font-style: italic;
  }
  .manual-input {
    width: 100%;
    padding: 0.45rem 0.55rem;
    margin-top: 0.35rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    font-family: inherit;
    font-size: 0.85rem;
  }
  .manual-input:focus {
    outline: 2px solid var(--accent);
    outline-offset: -1px;
  }
  .manual-submit-bar {
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border);
  }
  .manual-evidence-label {
    display: block;
    margin-top: 0.5rem;
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  .manual-evidence-label .manual-input {
    margin-top: 0.25rem;
    font-size: 0.8rem;
    padding: 0.3rem 0.5rem;
  }

  /* ── Flow report detail ─────────────────────────────────── */
  .report-path {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0.5rem 0 0.75rem;
    flex-wrap: wrap;
  }
  .report-path code {
    font-size: 0.85rem;
    word-break: break-all;
  }
  .assertion-desc {
    color: var(--text-muted);
    font-style: italic;
    margin-bottom: 0.2rem;
  }
  .assertion-notes {
    color: var(--text-muted);
    font-style: italic;
    font-size: 0.85rem;
  }
</style>`;

const sharedScripts = `<script>
  const THEME_ICONS = {
    light: ${JSON.stringify(iconSun)},
    dark: ${JSON.stringify(iconMoon)},
    auto: ${JSON.stringify(iconMonitor)},
  };
  const THEME_CYCLE = { light: 'dark', dark: 'auto', auto: 'light' };

  function getSystemTheme() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function currentThemePref() {
    return localStorage.getItem('axn-dev-theme') || 'auto';
  }

  function applyTheme(pref) {
    const root = document.documentElement;
    const resolved = pref === 'auto' ? getSystemTheme() : pref;
    root.setAttribute('data-theme', resolved);

    const btn = document.getElementById('theme-cycle');
    if (btn) {
      btn.innerHTML = THEME_ICONS[pref] || THEME_ICONS.auto;
      const next = THEME_CYCLE[pref] || 'light';
      btn.title = 'Theme: ' + pref + ' — switch to ' + next;
    }
  }

  function setTheme(pref) {
    localStorage.setItem('axn-dev-theme', pref);
    applyTheme(pref);
  }

  function cycleTheme() {
    const cur = currentThemePref();
    setTheme(THEME_CYCLE[cur] || 'light');
  }

  function initTheme() {
    applyTheme(currentThemePref());
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (currentThemePref() === 'auto') {
        document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
      }
    });
  }

  function showLoading() {
    const el = document.getElementById('main-loading');
    if (el) el.style.display = 'flex';
  }

  function hideLoading() {
    const el = document.getElementById('main-loading');
    if (el) el.style.display = 'none';
  }

  function axnDevNavigate(url) {
    sessionStorage.setItem('axn-dev-loading', '1');
    showLoading();
    setTimeout(() => { window.location.href = url; }, 10);
  }

  function initLoading() {
    if (sessionStorage.getItem('axn-dev-loading') === '1') {
      showLoading();
      const finish = () => {
        sessionStorage.removeItem('axn-dev-loading');
        hideLoading();
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', finish);
      } else {
        finish();
      }
    } else {
      hideLoading();
    }
  }

  initTheme();
  initLoading();
</script>`;

const dashboardScripts = `<script>
  let currentSort = { column: 'scope', direction: 'asc' };

  async function startScenario(name, source, repoName) {
    const btn = event.target;
    btn.disabled = true;
    btn.textContent = 'Starting...';

    try {
      const body = { scenarioName: name, source };
      if (repoName) body.repoName = repoName;
      const res = await fetch('/scenarios/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (data.success && data.runId) {
        // The server returns 202 immediately and runs compose in the
        // background — poll until the start finishes.
        pollScenarioRun(data.runId, btn);
      } else {
        alert('Failed to start: ' + (data.error || 'Unknown error'));
        btn.disabled = false;
        btn.textContent = 'Start';
      }
    } catch (err) {
      alert('Failed to start: ' + err.message);
      btn.disabled = false;
      btn.textContent = 'Start';
    }
  }

  function pollScenarioRun(runId, btn) {
    setTimeout(async () => {
      let run = null;
      try {
        const res = await fetch('/api/scenario-runs', { cache: 'no-store' });
        run = (await res.json()).find((r) => r.id === runId) ?? null;
      } catch { /* retry below */ }
      if (!run || run.status === 'running') {
        if (run && btn) btn.textContent = run.phase || 'Starting...';
        pollScenarioRun(runId, btn);
      } else if (run.status === 'succeeded') {
        location.reload();
      } else {
        alert('Failed to start: ' + (run.error || 'Unknown error'));
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Start';
        }
      }
    }, 2000);
  }

  // Re-attach to scenario starts still in flight (e.g. after a reload).
  (async function resumeScenarioRuns() {
    let runs;
    try {
      const res = await fetch('/api/scenario-runs', { cache: 'no-store' });
      runs = await res.json();
    } catch { return; }
    for (const run of runs.filter((r) => r.status === 'running')) {
      const row = document.querySelector(
        '.scenario-row[data-name="' + CSS.escape(run.scenarioName) + '"][data-scope="' + run.source + '"]' +
        (run.repoName ? '[data-repo="' + CSS.escape(run.repoName) + '"]' : '')
      );
      const btn = row && row.dataset.running === 'false'
        ? row.querySelector('.col-actions button')
        : null;
      if (btn) {
        btn.disabled = true;
        btn.textContent = run.phase || 'Starting...';
      }
      pollScenarioRun(run.id, btn);
    }
  })();

  async function stopScenario(name, source, repoName) {
    const btn = event.target;
    btn.disabled = true;
    btn.textContent = 'Stopping...';

    try {
      const body = { scenarioName: name, source };
      if (repoName) body.repoName = repoName;
      const res = await fetch('/scenarios/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (data.success) {
        btn.textContent = 'Stopped';
        setTimeout(() => location.reload(), 1500);
      } else {
        alert('Failed to stop: ' + (data.error || 'Unknown error'));
        btn.disabled = false;
        btn.textContent = 'Stop';
      }
    } catch (err) {
      alert('Failed to stop: ' + err.message);
      btn.disabled = false;
      btn.textContent = 'Stop';
    }
  }

  function filterScenarios() {
    const query = (document.getElementById('scenario-search').value || '').toLowerCase();
    const showGlobal = document.getElementById('show-global').checked;
    const showProject = document.getElementById('show-project').checked;
    const allowedRepos = new Set();
    document.querySelectorAll('.repo-filter:checked').forEach((cb) => allowedRepos.add(cb.value));
    const rows = document.querySelectorAll('.scenario-row');
    let visibleCount = 0;
    rows.forEach((row) => {
      const name = row.dataset.name.toLowerCase();
      const repo = row.dataset.repo;
      const scope = row.dataset.scope;
      const matchesSearch = name.includes(query);
      const matchesScope = (scope === 'global' && showGlobal) || (scope === 'project' && showProject);
      const matchesRepo = !repo || allowedRepos.has(repo);
      const isVisible = matchesSearch && matchesScope && matchesRepo;
      row.style.display = isVisible ? '' : 'none';
      if (isVisible) visibleCount++;
    });
    document.getElementById('no-results').style.display = visibleCount === 0 ? '' : 'none';
  }

  function updateRepoFilterLabel() {
    const checked = [...document.querySelectorAll('.repo-filter:checked')].map((cb) => cb.value);
    const all = document.querySelectorAll('.repo-filter');
    const label = document.getElementById('repo-filter-label');
    if (!label) return;
    if (checked.length === 0) {
      label.textContent = 'No repos';
    } else if (all.length === checked.length) {
      label.textContent = 'All repos';
    } else if (checked.length === 1) {
      label.textContent = checked[0];
    } else {
      label.textContent = checked.length + ' repos';
    }
  }

  function updateRepoFilter() {
    const checked = document.querySelectorAll('.repo-filter:checked');
    const all = document.querySelectorAll('.repo-filter');
    const allBox = document.getElementById('repo-filter-all');
    if (checked.length === all.length) {
      allBox.checked = true;
      allBox.indeterminate = false;
    } else if (checked.length === 0) {
      allBox.checked = false;
      allBox.indeterminate = false;
    } else {
      allBox.checked = false;
      allBox.indeterminate = true;
    }
    updateRepoFilterLabel();
    filterScenarios();
  }

  function toggleAllRepos() {
    const allChecked = document.getElementById('repo-filter-all').checked;
    document.querySelectorAll('.repo-filter').forEach((cb) => cb.checked = allChecked);
    updateRepoFilterLabel();
    filterScenarios();
  }

  function positionRepoFilterPortal() {
    const dropdown = document.getElementById('repo-filter-dropdown');
    const portal = document.getElementById('repo-filter-portal');
    const toggle = dropdown?.querySelector('.filter-dropdown-toggle');
    if (!toggle || !portal) return;
    const rect = toggle.getBoundingClientRect();
    const gap = 4;
    const margin = 20;
    const maxHeight = 600;
    const spaceBelow = window.innerHeight - rect.bottom - gap - margin;
    const spaceAbove = rect.top - gap - margin;
    portal.style.left = rect.left + 'px';
    portal.style.minWidth = rect.width + 'px';
    if (spaceBelow >= 150 || spaceBelow >= spaceAbove) {
      portal.style.top = (rect.bottom + gap) + 'px';
      portal.style.bottom = 'auto';
      portal.style.maxHeight = Math.min(maxHeight, Math.max(150, spaceBelow)) + 'px';
    } else {
      portal.style.bottom = (window.innerHeight - rect.top + gap) + 'px';
      portal.style.top = 'auto';
      portal.style.maxHeight = Math.min(maxHeight, Math.max(150, spaceAbove)) + 'px';
    }
  }

  function closeRepoFilter() {
    const dropdown = document.getElementById('repo-filter-dropdown');
    const portal = document.getElementById('repo-filter-portal');
    if (dropdown) dropdown.classList.remove('open');
    if (portal) {
      portal.classList.remove('open');
      portal.style.display = '';
    }
    document.removeEventListener('click', closeRepoFilterOnClickOutside);
    window.removeEventListener('scroll', closeRepoFilterOnScroll, true);
    window.removeEventListener('resize', closeRepoFilter);
  }

  function closeRepoFilterOnClickOutside(e) {
    const dropdown = document.getElementById('repo-filter-dropdown');
    const portal = document.getElementById('repo-filter-portal');
    if (dropdown && (dropdown.contains(e.target) || (portal && portal.contains(e.target)))) return;
    closeRepoFilter();
  }

  function closeRepoFilterOnScroll(e) {
    const portal = document.getElementById('repo-filter-portal');
    if (portal && e.target === portal) return;
    closeRepoFilter();
  }

  function toggleRepoFilter(event) {
    if (event) event.stopPropagation();
    const dropdown = document.getElementById('repo-filter-dropdown');
    const portal = document.getElementById('repo-filter-portal');
    if (!dropdown || !portal) return;
    const isOpen = dropdown.classList.toggle('open');
    if (isOpen) {
      positionRepoFilterPortal();
      portal.classList.add('open');
      setTimeout(() => {
        document.addEventListener('click', closeRepoFilterOnClickOutside);
        window.addEventListener('scroll', closeRepoFilterOnScroll, true);
        window.addEventListener('resize', closeRepoFilter);
      }, 0);
    } else {
      closeRepoFilter();
    }
  }

  function sortStateKey() {
    return 'axn-dev-dashboard-sort';
  }

  function getSortIcon(direction) {
    return direction === 'asc' ? '▲' : '▼';
  }

  function updateSortHeaders() {
    document.querySelectorAll('.sort-indicator').forEach((el) => {
      const column = el.dataset.column;
      el.textContent = column === currentSort.column ? getSortIcon(currentSort.direction) : '';
    });
  }

  function applySort(column, direction) {
    const tbody = document.querySelector('.scenario-table tbody');
    if (!tbody) return;
    const rows = [...tbody.querySelectorAll('.scenario-row')];
    rows.sort((a, b) => {
      let cmp = 0;
      if (column === 'name') {
        cmp = a.dataset.name.localeCompare(b.dataset.name);
      } else if (column === 'scope') {
        cmp = a.dataset.scope.localeCompare(b.dataset.scope);
      } else if (column === 'status') {
        const ar = a.dataset.running === 'true' ? 0 : 1;
        const br = b.dataset.running === 'true' ? 0 : 1;
        cmp = ar - br;
      }
      return direction === 'asc' ? cmp : -cmp;
    });
    rows.forEach((row) => tbody.appendChild(row));
  }

  function saveSortState() {
    try {
      localStorage.setItem(sortStateKey(), JSON.stringify(currentSort));
    } catch { /* ignore storage errors */ }
  }

  function restoreSortState() {
    try {
      const saved = localStorage.getItem(sortStateKey());
      if (saved) currentSort = JSON.parse(saved);
    } catch { /* ignore storage errors */ }
    applySort(currentSort.column, currentSort.direction);
    updateSortHeaders();
  }

  function sortBy(column) {
    if (currentSort.column === column) {
      currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
      currentSort.column = column;
      currentSort.direction = 'asc';
    }
    applySort(currentSort.column, currentSort.direction);
    updateSortHeaders();
    saveSortState();
  }

  function saveDashboardFilters() {
    try {
      const search = document.getElementById('scenario-search');
      const showGlobal = document.getElementById('show-global');
      const showProject = document.getElementById('show-project');
      const allBox = document.getElementById('repo-filter-all');
      const state = {
        search: search ? search.value : '',
        showGlobal: showGlobal ? showGlobal.checked : true,
        showProject: showProject ? showProject.checked : true,
        repos: [...document.querySelectorAll('.repo-filter:checked')].map((cb) => cb.value),
        allRepos: allBox ? allBox.checked : true,
      };
      localStorage.setItem('axn-dev-dashboard-filters', JSON.stringify(state));
    } catch { /* ignore storage errors */ }
  }

  function restoreDashboardFilters() {
    try {
      const saved = localStorage.getItem('axn-dev-dashboard-filters');
      if (!saved) return;
      const state = JSON.parse(saved);
      const search = document.getElementById('scenario-search');
      const showGlobal = document.getElementById('show-global');
      const showProject = document.getElementById('show-project');
      const allBox = document.getElementById('repo-filter-all');
      const repoFilters = document.querySelectorAll('.repo-filter');
      if (search && state.search !== undefined) search.value = state.search;
      if (showGlobal && state.showGlobal !== undefined) showGlobal.checked = state.showGlobal;
      if (showProject && state.showProject !== undefined) showProject.checked = state.showProject;
      if (state.repos && repoFilters.length > 0) {
        repoFilters.forEach((cb) => { cb.checked = state.repos.includes(cb.value); });
      }
      if (allBox && state.allRepos !== undefined) allBox.checked = state.allRepos;
      updateRepoFilterLabel();
      if (allBox && repoFilters.length > 0) {
        updateRepoFilter();
      } else {
        filterScenarios();
      }
    } catch { /* ignore storage errors */ }
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('scenario-search')) {
      restoreDashboardFilters();
      restoreSortState();
    }
  });
</script>`;


