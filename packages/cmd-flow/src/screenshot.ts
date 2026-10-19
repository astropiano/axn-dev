import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

import type { ParsedAssertion } from "@axn-dev/flow-format";

/** Default fraction of pixels allowed to differ (1%). */
const DEFAULT_MAX_DIFF_RATIO = 0.01;
/** pixelmatch per-pixel color distance threshold. */
const DEFAULT_COLOR_THRESHOLD = 0.1;
/** Viewport used when the assertion does not set one. */
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

export interface ScreenshotCompareResult {
  passed: boolean;
  /** Pixels that differ beyond color threshold and are not anti-aliasing. */
  diffPixels: number;
  totalPixels: number;
  /** diffPixels / totalPixels — 1 when the dimensions differ. */
  diffRatio: number;
  sizeMismatch: boolean;
  reference: { width: number; height: number };
  actual: { width: number; height: number };
  /** PNG highlighting real diffs in red and anti-aliased pixels in yellow. */
  diffImage?: Buffer;
}

/**
 * Compare two PNG buffers pixel-by-pixel with anti-aliasing awareness:
 * pixels pixelmatch classifies as AA (edge blending) are not counted, so
 * sub-pixel rendering noise passes while layout/shape changes fail.
 */
export function comparePngImages(
  actual: Buffer,
  reference: Buffer,
  opts: { threshold?: number; maxDiffRatio?: number } = {}
): ScreenshotCompareResult {
  const threshold = opts.threshold ?? DEFAULT_COLOR_THRESHOLD;
  const maxDiffRatio = opts.maxDiffRatio ?? DEFAULT_MAX_DIFF_RATIO;

  const ref = PNG.sync.read(reference);
  const act = PNG.sync.read(actual);

  const base = {
    reference: { width: ref.width, height: ref.height },
    actual: { width: act.width, height: act.height },
  };

  if (ref.width !== act.width || ref.height !== act.height) {
    return {
      ...base,
      passed: false,
      sizeMismatch: true,
      diffPixels: Math.max(ref.width * ref.height, act.width * act.height),
      totalPixels: Math.max(ref.width * ref.height, act.width * act.height),
      diffRatio: 1,
    };
  }

  const { width, height } = ref;
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(act.data, ref.data, diff.data, width, height, {
    threshold,
    includeAA: false,
  });
  const totalPixels = width * height;
  const diffRatio = diffPixels / totalPixels;

  return {
    ...base,
    passed: diffRatio <= maxDiffRatio,
    sizeMismatch: false,
    diffPixels,
    totalPixels,
    diffRatio,
    diffImage: diffPixels > 0 ? PNG.sync.write(diff) : undefined,
  };
}

interface PlaywrightModule {
  chromium: {
    launch(opts: { headless?: boolean }): Promise<{
      newPage(opts?: {
        viewport?: { width: number; height: number } | null;
      }): Promise<PlaywrightPage>;
      close(): Promise<void>;
    }>;
  };
}

interface PlaywrightPage {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  waitForSelector(selector: string, opts?: { timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  locator(selector: string): {
    screenshot(opts?: Record<string, unknown>): Promise<Buffer>;
  };
  screenshot(opts?: Record<string, unknown>): Promise<Buffer>;
}

let playwrightModule: Promise<PlaywrightModule> | null = null;

function loadPlaywright(): Promise<PlaywrightModule> {
  if (!playwrightModule) {
    playwrightModule = import("playwright-core")
      .then((m) => m as unknown as PlaywrightModule)
      .catch((err) => {
        playwrightModule = null;
        throw new Error(
          `playwright-core is required for screenshot assertions but could not be loaded: ${
            err instanceof Error ? err.message : err
          }`
        );
      });
  }
  return playwrightModule;
}

export interface ScreenshotCaptureOptions {
  url: string;
  /** CSS selector — when set, only that element is captured. */
  selector?: string;
  /** Capture the full scrollable page instead of the viewport. */
  fullPage?: boolean;
  /** "WxH", e.g. "1280x800". */
  viewport?: string;
  /** Extra settle wait: milliseconds ("500") or a CSS selector to wait for. */
  wait?: string;
  timeoutMs?: number;
}

/**
 * Take a screenshot of `url` — the whole page, or only the element matching
 * `selector` — with headless Chromium via playwright-core.
 *
 * Note: an element capture is cropped to the element's own bounding box, so
 * it compares *content* only. To catch position changes, capture a container
 * element or the whole page.
 */
export async function captureScreenshot(opts: ScreenshotCaptureOptions): Promise<Buffer> {
  const pw = await loadPlaywright();
  const viewport = parseViewport(opts.viewport);
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport });
    const timeout = opts.timeoutMs ?? 30000;
    await page.goto(opts.url, { waitUntil: "load", timeout });
    if (opts.wait) {
      const ms = Number(opts.wait);
      if (Number.isFinite(ms) && String(ms) === opts.wait.trim()) {
        await page.waitForTimeout(ms);
      } else {
        await page.waitForSelector(opts.wait, { timeout });
      }
    }
    const shotOpts = { animations: "disabled", caret: "hide", timeout } as Record<string, unknown>;
    if (opts.selector) {
      return await page.locator(opts.selector).screenshot(shotOpts);
    }
    return await page.screenshot({ ...shotOpts, fullPage: !!opts.fullPage });
  } finally {
    await browser.close();
  }
}

function parseViewport(viewport?: string): { width: number; height: number } | undefined {
  if (!viewport) return { ...DEFAULT_VIEWPORT };
  const m = viewport.match(/^(\d+)x(\d+)$/);
  if (!m) {
    throw new Error(`Invalid viewport '${viewport}' — expected format "WxH" (e.g. "1280x800")`);
  }
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

/** Expand ${VAR} / ${VAR:-default} references in a single string. */
export function expandString(input: string, env: Record<string, string>): string {
  return input.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (match, name: string, def?: string) => {
    if (name in env) return env[name];
    return def !== undefined ? def : match;
  });
}

export interface ScreenshotAssertionContext {
  /** Directory containing the flow XML — base for the reference path and script-relative paths. */
  flowDir: string;
  /** Merged environment (BASE_URL, SCENARIO_PORT, flow <env> vars). */
  env: Record<string, string>;
  /** Flow name — used in artifact file names. */
  flowName?: string;
}

export interface ScreenshotAssertionOutcome {
  passed: boolean;
  /** Short human-readable summary for the report's `actual` field. */
  detail: string;
}

/**
 * Evaluate a `that="screenshot"` assertion: capture the page (or element),
 * compare it against the reference image at `value` (relative to the flow
 * file), and write `*.actual.png` / `*.diff.png` artifacts under
 * `<flows-dir>/.reports/screenshots/`.
 *
 * A `selector` capture is cropped to the element itself — it detects content
 * and shape changes. To detect *position* changes, select a container
 * element or omit `selector` for a whole-page capture.
 *
 * Set AXN_FLOW_UPDATE_SCREENSHOTS=1 to write the actual capture over the
 * reference instead of comparing (baseline update mode).
 */
export async function evaluateScreenshotAssertion(
  assertion: ParsedAssertion,
  ctx: ScreenshotAssertionContext
): Promise<ScreenshotAssertionOutcome> {
  if (!assertion.value) {
    throw new Error("screenshot assertion requires 'value' = reference image path (relative to the flow file)");
  }

  const urlTemplate = assertion.url ?? ctx.env.BASE_URL;
  if (!urlTemplate) {
    throw new Error(
      "screenshot assertion requires a 'url' attribute or BASE_URL in the environment"
    );
  }
  const url = expandString(urlTemplate, ctx.env);

  const referencePath = resolve(ctx.flowDir, assertion.value);
  const actual = await captureScreenshot({
    url,
    selector: assertion.selector,
    fullPage: assertion.fullPage,
    viewport: assertion.viewport,
    wait: assertion.wait,
  });

  const artifactsDir = join(ctx.flowDir, ".reports", "screenshots");
  const slug = (ctx.flowName ?? "flow")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "flow";
  const refBase = basename(assertion.value).replace(/\.png$/i, "");
  const writeArtifact = (suffix: string, data: Buffer): string => {
    mkdirSync(artifactsDir, { recursive: true });
    const p = join(artifactsDir, `${slug}--${refBase}.${suffix}.png`);
    writeFileSync(p, data);
    return p;
  };

  if (process.env.AXN_FLOW_UPDATE_SCREENSHOTS === "1") {
    mkdirSync(dirname(referencePath), { recursive: true });
    writeFileSync(referencePath, actual);
    return { passed: true, detail: `reference updated: ${referencePath}` };
  }

  if (!existsSync(referencePath)) {
    const actualPath = writeArtifact("actual", actual);
    return {
      passed: false,
      detail: `reference image not found: ${referencePath} (actual capture written to ${actualPath}; run with AXN_FLOW_UPDATE_SCREENSHOTS=1 to create it)`,
    };
  }

  const result = comparePngImages(actual, readFileSync(referencePath), {
    threshold: assertion.threshold,
    maxDiffRatio: assertion.maxDiff,
  });

  const actualPath = writeArtifact("actual", actual);
  const diffPath = result.diffImage ? writeArtifact("diff", result.diffImage) : null;

  if (result.sizeMismatch) {
    return {
      passed: false,
      detail:
        `size mismatch: actual ${result.actual.width}x${result.actual.height}, ` +
        `reference ${result.reference.width}x${result.reference.height} (actual: ${actualPath})`,
    };
  }

  const pct = (result.diffRatio * 100).toFixed(2);
  const maxPct = ((assertion.maxDiff ?? DEFAULT_MAX_DIFF_RATIO) * 100).toFixed(2);
  const parts = [`diff ${pct}% (${result.diffPixels}/${result.totalPixels}px), allowed ${maxPct}%`, `actual: ${actualPath}`];
  if (diffPath) parts.push(`diff: ${diffPath}`);
  return { passed: result.passed, detail: parts.join(" — ") };
}
