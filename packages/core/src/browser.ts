/**
 * Which browser a flow drives, resolved from the step environment so the
 * engine's own Playwright users (pw runner, screenshot assertions) and plugin
 * adapters agree — set it per flow in `<env>` or per run in the shell:
 *
 *   AXN_DEV_BROWSER          chromium (default) | firefox | webkit
 *   AXN_DEV_BROWSER_CHANNEL  chromium only: chrome | msedge | chrome-beta …
 *                            (unset: Playwright's own Chromium)
 *   AXN_DEV_BROWSER_HEADED   auto (default) | true | false — auto shows a
 *                            window in interactive runs (AXN_DEV_INTERACTIVE=1)
 *   AXN_DEV_BROWSER_ATTACH   chromium only: CDP URL of a browser that is
 *                            already open (chrome --remote-debugging-port=9222)
 *
 * Core has no Playwright dependency: callers launch with their own copy,
 * `pw[s.engine].launch(s.launch)` or `pw.chromium.connectOverCDP(s.attach)`.
 */

export type BrowserEngine = "chromium" | "firefox" | "webkit";

export interface BrowserSettings {
  engine: BrowserEngine;
  channel?: string;
  headed: boolean;
  attach?: string;
  /** Options for `browserType.launch()`. */
  launch: { headless: boolean; channel?: string };
}

/** Set by `axn-dev flow` in the step environment of interactive runs. */
export const INTERACTIVE_ENV = "AXN_DEV_INTERACTIVE";

const ENGINES: readonly BrowserEngine[] = ["chromium", "firefox", "webkit"];

export function browserSettings(env: Record<string, string | undefined>): BrowserSettings {
  const engine = (env.AXN_DEV_BROWSER?.trim().toLowerCase() || "chromium") as BrowserEngine;
  if (!ENGINES.includes(engine)) {
    throw new Error(`AXN_DEV_BROWSER: '${env.AXN_DEV_BROWSER}' is not one of ${ENGINES.join(", ")}`);
  }
  const channel = env.AXN_DEV_BROWSER_CHANNEL?.trim() || undefined;
  const attach = env.AXN_DEV_BROWSER_ATTACH?.trim() || undefined;
  if (engine !== "chromium" && (channel || attach)) {
    throw new Error(
      `AXN_DEV_BROWSER_${channel ? "CHANNEL" : "ATTACH"} works with chromium only (AXN_DEV_BROWSER=${engine})`,
    );
  }

  const raw = env.AXN_DEV_BROWSER_HEADED?.trim().toLowerCase() || "auto";
  let headed: boolean;
  if (raw === "auto") headed = env[INTERACTIVE_ENV] === "1";
  else if (raw === "true" || raw === "1") headed = true;
  else if (raw === "false" || raw === "0") headed = false;
  else throw new Error(`AXN_DEV_BROWSER_HEADED: '${env.AXN_DEV_BROWSER_HEADED}' is not auto, true or false`);

  return {
    engine,
    ...(channel ? { channel } : {}),
    headed,
    ...(attach ? { attach } : {}),
    launch: { headless: !headed, ...(channel ? { channel } : {}) },
  };
}
