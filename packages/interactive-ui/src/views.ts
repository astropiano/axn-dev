import { pageHead } from "./head.js";
import type { ServeThemeSet } from "./theme.js";

export type InteractiveView = "stage" | "driver";

/**
 * The driver (steps, Next/Skip/Retry, live output) and the stage (the same
 * with the product framed). The stage falls back to the driver layout when
 * the product runs in its own browser window, where a frame would only show
 * a second, unrelated session. Both render from the run's event stream, which
 * opens with a full snapshot, so a reload mid-run loses nothing. No dashboard
 * chrome and no link into it.
 */
export function interactiveHtml(runId: string, view: InteractiveView, themes: ServeThemeSet): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  ${pageHead(view === "stage" ? "axn-dev · interactive stage" : "axn-dev · interactive", themes)}
  <style>${styles}</style>
</head>
<body class="view-${view}">
  <aside class="rail">
    <div class="flow-name" id="flow-name"></div>
    <ol class="steps" id="steps"></ol>
    <div class="conn" id="conn"></div>
  </aside>
  <main id="main"></main>
  <footer class="strip">
    <div class="next">
      <div class="next-head"><span class="badge" id="badge"></span><span class="next-label" id="next-label"></span></div>
      <div class="next-args" id="next-args"></div>
      <details class="next-text" id="next-text-wrap" hidden><summary>What it sends</summary><pre id="next-text"></pre></details>
      <div class="next-error" id="next-error" hidden></div>
    </div>
    <div class="buttons">
      <button type="button" id="btn-next" data-cmd="next" title="Right arrow, PageDown or Space">Next</button>
      <button type="button" id="btn-retry" data-cmd="retry" title="R">Retry</button>
      <button type="button" id="btn-skip" data-cmd="skip" title="S">Skip</button>
    </div>
    <pre class="output" id="output"></pre>
  </footer>
  <script>
    const RUN = ${JSON.stringify(runId)};
    const VIEW = ${JSON.stringify(view)};
    ${clientScript}
  </script>
</body>
</html>`;
}


const styles = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    font-family: var(--font-body), -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    display: grid;
    grid-template-columns: 260px 1fr;
    grid-template-rows: 1fr auto;
    grid-template-areas: "rail main" "strip strip";
  }
  .rail { grid-area: rail; border-right: 1px solid var(--border); padding: 16px 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
  .flow-name { font-family: var(--font-heading); font-weight: 700; font-size: 15px; }
  .steps { list-style: none; display: flex; flex-direction: column; gap: 4px; flex: 1; }
  .steps li { padding: 6px 8px; border-radius: 6px; font-size: 13px; color: var(--text-muted); display: flex; gap: 8px; align-items: baseline; }
  .steps li .dot { width: 8px; height: 8px; border-radius: 50%; border: 1px solid var(--text-muted); flex: none; }
  .steps li.running .dot { background: var(--accent); border-color: var(--accent); }
  .steps li.passed .dot { background: var(--accent-green); border-color: var(--accent-green); }
  .steps li.failed .dot { background: var(--accent-red); border-color: var(--accent-red); }
  .steps li.skipped { text-decoration: line-through; }
  .steps li.current { background: var(--surface-solid); color: var(--text); outline: 1px solid var(--accent); }
  .steps li.auto { font-style: italic; }
  .conn { font-size: 12px; color: var(--text-muted); }
  main { grid-area: main; min-height: 0; }
  .product { display: flex; }
  .product iframe { flex: 1; border: 0; background: var(--surface-solid); }
  .product-empty, .log-empty { margin: auto; color: var(--text-muted); }
  .log { overflow-y: auto; padding: 16px; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
  .log .line { white-space: pre-wrap; }
  .log .line .idx { color: var(--text-muted); margin-right: 8px; }
  .strip { grid-area: strip; border-top: 1px solid var(--border); background: var(--surface); padding: 12px 16px; display: grid; grid-template-columns: 1fr auto; gap: 8px 16px; }
  .next-head { display: flex; gap: 10px; align-items: baseline; }
  .badge { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--accent); }
  .next-label { font-family: var(--font-heading); font-weight: 700; font-size: 18px; }
  .next-args { font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: var(--text-muted); margin-top: 4px; }
  .next-text summary { cursor: pointer; font-size: 12px; color: var(--text-muted); margin-top: 4px; }
  .next-text pre { white-space: pre-wrap; font-size: 12px; max-height: 160px; overflow-y: auto; margin-top: 4px; }
  .next-error { color: var(--accent-red); font-size: 13px; margin-top: 4px; white-space: pre-wrap; }
  .buttons { display: flex; gap: 8px; align-items: center; }
  .buttons button { font: inherit; font-weight: 700; padding: 10px 18px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-solid); color: var(--text); cursor: pointer; }
  .buttons button#btn-next, .buttons button#btn-retry { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
  .buttons button:disabled { opacity: 0.35; cursor: default; }
  .output { grid-column: 1 / -1; font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: var(--text-muted); max-height: 120px; overflow-y: auto; white-space: pre-wrap; }
  .output:empty, .output.off { display: none; }
`;

const clientScript = `
  let state = null;
  let framed = null;
  const $ = (id) => document.getElementById(id);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function apply(ev) {
    switch (ev.type) {
      case 'flow':
        state.flowName = ev.flowName; state.steps = ev.steps; state.output = [];
        state.productWindow = ev.productWindow; state.productUrl = undefined;
        state.gate = null; state.finished = undefined; break;
      case 'gate': state.gate = ev.gate; break;
      case 'step': {
        const s = state.steps.find((x) => x.index === ev.index);
        if (s) { s.status = ev.status; s.error = ev.error; }
        if (ev.status === 'running') state.gate = null;
        break;
      }
      case 'output': state.output.push({ index: ev.index, line: ev.line }); break;
      case 'product': state.productUrl = ev.url; break;
      case 'finished': state.finished = { passed: ev.passed }; state.gate = null; break;
    }
  }

  function currentIndex() {
    if (state.gate) return state.gate.index;
    const running = state.steps.find((s) => s.status === 'running');
    return running ? running.index : null;
  }

  function render() {
    if (!state) return;
    $('flow-name').textContent = state.flowName;
    const cur = currentIndex();
    const list = $('steps');
    list.replaceChildren(...state.steps.map((s) => {
      const li = el('li', [s.status, s.index === cur ? 'current' : '', s.auto ? 'auto' : ''].join(' '));
      li.append(el('span', 'dot'), el('span', '', s.label));
      li.title = s.error || s.status;
      return li;
    }));

    const step = cur === null ? null : state.steps.find((s) => s.index === cur);
    let badge = '';
    if (state.finished) badge = state.finished.passed ? 'Finished · passed' : 'Finished · failed';
    else if (state.gate && state.gate.failed) badge = 'Failed · retry or skip';
    else if (state.gate) badge = 'Next';
    else if (step) badge = 'Running';
    $('badge').textContent = badge;
    $('next-label').textContent = state.finished ? '' : (step ? step.label : '');
    const args = step && step.args ? Object.entries(step.args).map(([k, v]) => k + '=' + v).join('  ') : '';
    $('next-args').textContent = state.finished ? '' : args;
    $('next-text-wrap').hidden = !(step && step.text) || !!state.finished;
    $('next-text').textContent = step && step.text ? step.text : '';
    const failed = state.gate && state.gate.failed;
    $('next-error').hidden = !failed;
    $('next-error').textContent = failed || '';

    const atGate = !!state.gate;
    $('btn-next').disabled = !atGate || !!failed;
    $('btn-retry').disabled = !failed;
    $('btn-skip').disabled = !atGate;

    // Frame the product only on the stage, and only when it is not already
    // in a browser window of its own.
    const framing = VIEW === 'stage' && !state.productWindow;
    const main = $('main');
    const out = $('output');
    out.classList.toggle('off', !framing);
    if (framing) {
      main.className = 'product';
      if (!state.productUrl) {
        if (framed !== '') {
          framed = '';
          main.replaceChildren(el('div', 'product-empty', 'The product appears here once the scenario is up.'));
        }
      } else if (framed !== state.productUrl) {
        framed = state.productUrl;
        const frame = el('iframe');
        frame.src = state.productUrl;
        main.replaceChildren(frame);
      }
      const lines = state.output.filter((o) => o.index === cur).slice(-50).map((o) => o.line);
      out.textContent = lines.join('\\n');
      out.scrollTop = out.scrollHeight;
    } else {
      framed = null;
      main.className = 'log';
      if (!state.output.length) {
        main.replaceChildren(el('div', 'log-empty',
          state.productWindow ? 'The product runs in its own browser window. Output appears here.' : 'No output yet.'));
      } else {
        main.replaceChildren(...state.output.map((o) => {
          const d = el('div', 'line');
          d.append(el('span', 'idx', String(o.index + 1)), document.createTextNode(o.line));
          return d;
        }));
        main.scrollTop = main.scrollHeight;
      }
    }
  }

  async function send(command) {
    await fetch('/api/interactive/' + RUN + '/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }),
    });
  }

  document.querySelectorAll('.buttons button').forEach((b) =>
    b.addEventListener('click', () => { if (!b.disabled) send(b.dataset.cmd); }));

  document.addEventListener('keydown', (e) => {
    if (!state || !state.gate || e.metaKey || e.ctrlKey || e.altKey) return;
    const failed = !!state.gate.failed;
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
      e.preventDefault(); send(failed ? 'retry' : 'next');
    } else if (e.key === 's' || e.key === 'S') {
      send('skip');
    } else if ((e.key === 'r' || e.key === 'R') && failed) {
      send('retry');
    }
  });

  const es = new EventSource('/api/interactive/' + RUN + '/events');
  es.addEventListener('snapshot', (e) => { state = JSON.parse(e.data); $('conn').textContent = ''; render(); });
  es.onmessage = (e) => { if (state) { apply(JSON.parse(e.data)); render(); } };
  es.onerror = () => {
    if (state && state.finished) { es.close(); $('conn').textContent = 'Run ended.'; }
    else $('conn').textContent = 'Reconnecting…';
  };
`;
