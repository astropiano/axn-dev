import type { ScenarioLink } from "@axn-dev/core";
import { escapeHtml, linksChevronHtml, portFromUrl } from "./html.js";
import { menuChevronHtml, menuStyles, menuScripts } from "./menu.js";

export function scenarioViewHtml(
  scenarioName: string,
  frontendServices: Record<string, string>,
  links: ScenarioLink[] = [],
  frontend?: string | string[],
  switchableScenarios: { name: string; url: string }[] = [],
): string {
  const frontSet = new Set(Array.isArray(frontend) ? frontend : frontend ? [frontend] : []);
  const tabs = Object.entries(frontendServices).sort(([a], [b]) => {
    const aFront = frontSet.has(a);
    const bFront = frontSet.has(b);
    if (aFront && !bFront) return -1;
    if (!aFront && bFront) return 1;
    return 0;
  });
  const firstUrl = tabs.length > 0 ? tabs[0][1] : null;

  const linksForUrl = (url: string) => links.filter((l) => l.url === url || portFromUrl(l.url) === portFromUrl(url));

  const switcherItems = switchableScenarios.map((s) => ({ label: s.name, url: s.url }));

  const tabsHtml = tabs.map(([name, url], i) => {
    const port = portFromUrl(url);
    const chevron = port !== null ? linksChevronHtml(linksForUrl(url), "open") : "";
    const portLabel = port !== null ? port : "";
    const faviconUrl = (() => {
      try {
        return new URL("/favicon.ico", url).href;
      } catch {
        return url + "/favicon.ico";
      }
    })();
    return `
    <button class="tab${i === 0 ? " active" : ""}" data-name="${escapeHtml(name)}" data-url="${escapeHtml(url)}" data-port="${port ?? ""}" onclick="switchTab(this)">
      <img class="tab-favicon" src="${escapeHtml(faviconUrl)}" onload="this.style.display='inline-block'" onerror="this.remove()" alt="">
      <span class="health-dot" data-port="${port ?? ""}"></span>
      ${escapeHtml(name)}
      <span class="tab-port">${portLabel}</span>
      ${chevron}
    </button>
  `;
  }).join("");

  const emptyState = tabs.length === 0
    ? `No frontend services configured for this scenario.<br>Add a <code>frontend-services:</code> section to its <code>axn-dev.yaml</code>.`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(scenarioName)} — axn-dev</title>
  <link href="https://fonts.googleapis.com/css2?family=Raleway:wght@400;500;700;900&family=Lato:wght@400;700&display=swap" rel="stylesheet">
  ${scenarioViewStyles}
  ${menuStyles}
</head>
<body data-scenario="${escapeHtml(scenarioName)}">
  <div class="topbar">
    <a class="back-btn" href="/">← axn-dev</a>
    <span class="scenario-title${switchableScenarios.length > 0 ? " has-switcher" : ""}">${escapeHtml(scenarioName)}${menuChevronHtml(switcherItems, "nav", "Switch running scenario")}</span>
    <div class="tabs">
      ${tabsHtml}
    </div>
  </div>
  <div class="iframe-container">
    ${tabs.length > 0 && firstUrl
      ? `<iframe id="view" src="${escapeHtml(firstUrl)}" allow="*" onload="hideFrameLoading()"></iframe>
         <div id="frame-loading" class="frame-loading"><div class="spinner"></div><span class="page-loading-text">Loading...</span></div>`
      : `<div class="empty-proxy">${emptyState}</div>`
    }
  </div>
  <div id="main-loading" class="main-loading" aria-hidden="true" style="display: none;">
    <div class="spinner"></div>
    <span class="page-loading-text">Loading...</span>
  </div>
  ${scenarioViewScripts}
  ${menuScripts}
</body>
</html>`;
}

const scenarioViewStyles = `<style>
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
    --surface: var(--neutral-surface);
    --border: var(--neutral-cloud);
    --accent: var(--primary-blue);
    --accent-hover: var(--primary-blue-hover);
    --accent-text: #FFFFFF;
  }
  [data-theme="dark"] {
    --bg: var(--neutral-obsidian);
    --text: var(--neutral-mist);
    --text-muted: #B0B0B0;
    --surface: #1A1A1A;
    --border: #3A3A3A;
    --accent: var(--accent-red);
    --accent-hover: #F0A3AA;
    --accent-text: var(--neutral-obsidian);
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; overflow: hidden; }
  body {
    font-family: var(--font-body), -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .topbar {
    display: flex;
    align-items: center;
    gap: 0;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    height: 44px;
    padding: 0;
    overflow-x: auto;
  }
  .back-btn {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0 0.75rem;
    height: 100%;
    background: transparent;
    border: none;
    border-right: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text-muted);
    cursor: pointer;
    font-family: var(--font-body);
    font-size: 0.85rem;
    font-weight: 500;
    white-space: nowrap;
    text-decoration: none;
    flex-shrink: 0;
    transition: all 0.2s ease;
  }
  .back-btn:hover { background: var(--bg); color: var(--text); }
  .scenario-title {
    padding: 0 0.75rem;
    font-family: var(--font-heading);
    font-weight: 700;
    font-size: 0.85rem;
    color: var(--text-muted);
    border-right: 1px solid var(--border);
    height: 100%;
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }
  .scenario-title.has-switcher {
    color: var(--text);
  }
  .scenario-title .links-chevron {
    font-size: 0.75rem;
    opacity: 1;
    cursor: pointer;
    padding: 0.2rem;
    margin-left: 0.35rem;
    border-radius: 2px;
  }
  .scenario-title .links-chevron:hover {
    background: var(--bg);
    color: var(--accent);
  }
  .tabs {
    display: flex;
    height: 100%;
    overflow-x: auto;
  }
  .links-chevron {
    display: inline-flex;
    align-items: center;
    margin-left: 0.25rem;
    padding: 0 0.15rem;
    font-size: 0.65rem;
    line-height: 1;
    opacity: 0.6;
  }
  .tab:hover .links-chevron,
  .tab.active .links-chevron {
    opacity: 1;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0 0.75rem;
    height: 100%;
    background: transparent;
    border: none;
    border-right: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text-muted);
    cursor: pointer;
    font-family: var(--font-body);
    font-size: 0.85rem;
    font-weight: 500;
    white-space: nowrap;
    text-transform: capitalize;
    transition: all 0.15s ease;
  }
  .tab:hover { background: var(--bg); color: var(--text); }
  .tab.active {
    background: var(--bg);
    color: var(--accent);
    border-bottom: 2px solid var(--accent);
    margin-bottom: -2px;
  }
  .tab-port {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.75rem;
    color: var(--text-muted);
    background: var(--bg);
    padding: 0.1rem 0.35rem;
    border-radius: 4px;
  }
  .tab.active .tab-port { color: var(--accent); }
  .health-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #888;
    flex-shrink: 0;
    transition: background 0.4s ease;
  }
  .health-dot.up   { background: var(--accent-green); }
  .health-dot.down { background: var(--accent-red); }
  .tab-favicon {
    width: 14px;
    height: 14px;
    object-fit: contain;
    display: none;
    flex-shrink: 0;
  }
  .iframe-container {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--bg);
    position: relative;
  }
  .main-loading {
    display: none;
    position: fixed;
    inset: 0;
    z-index: 2000;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    background: var(--bg);
    color: var(--text);
  }
  .frame-loading {
    position: absolute;
    inset: 0;
    z-index: 5;
    display: flex;
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
  iframe {
    flex: 1;
    width: 100%;
    height: 100%;
    border: none;
    background: var(--surface);
  }
  .empty-proxy {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    color: var(--text-muted);
    line-height: 1.8;
    font-size: 1rem;
    padding: 2rem;
  }
  code {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.2rem 0.4rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.9em;
  }
</style>`;

const scenarioViewScripts = `<script>
  (function() {
    const saved = localStorage.getItem('axn-dev-theme');
    const theme = saved === 'auto' || !saved
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : saved;
    document.documentElement.setAttribute('data-theme', theme);
  })();

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

  // Same loading UX as the dashboard/flows navigation: the overlay covers the
  // current page while the server renders the next one.
  window.addEventListener('beforeunload', showLoading);

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

  function showFrameLoading() {
    const el = document.getElementById('frame-loading');
    if (el) el.style.display = 'flex';
  }

  function hideFrameLoading() {
    const el = document.getElementById('frame-loading');
    if (el) el.style.display = 'none';
  }

  const STORAGE_KEY = 'axn-dev-scenario-tab';

  function scenarioStorageKey(name) {
    return STORAGE_KEY + ':' + name;
  }

  function applyTab(btn) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    const url = btn.dataset.url;
    const port = btn.dataset.port;
    const iframe = document.getElementById('view');
    iframe.src = url;
    iframe.dataset.port = port;
    showFrameLoading();
  }

  function switchTab(btn) {
    applyTab(btn);
    const scenarioName = document.body.dataset.scenario;
    if (!scenarioName) return;
    try {
      localStorage.setItem(scenarioStorageKey(scenarioName), btn.dataset.name);
    } catch { /* ignore storage errors */ }
  }

  function restoreTab() {
    const scenarioName = document.body.dataset.scenario;
    if (!scenarioName) return;
    try {
      const savedName = localStorage.getItem(scenarioStorageKey(scenarioName));
      if (!savedName) return;
      const tabs = document.querySelectorAll('.tab');
      for (const tab of tabs) {
        if (tab.dataset.name === savedName) {
          if (tab.classList.contains('active')) return;
          applyTab(tab);
          return;
        }
      }
    } catch { /* ignore storage errors */ }
  }

  function updateHealth() {
    const dots = document.querySelectorAll('.health-dot');
    dots.forEach(async (dot) => {
      const port = dot.dataset.port;
      try {
        const res = await fetch('/health?ports=' + port, { cache: 'no-store' });
        const status = await res.json();
        dot.classList.remove('up', 'down');
        dot.classList.add(status[port] === 'up' ? 'up' : 'down');
      } catch {
        dot.classList.remove('up');
        dot.classList.add('down');
      }
    });
  }

  setInterval(updateHealth, 3000);
  updateHealth();

  initLoading();
  restoreTab();
</script>`;
