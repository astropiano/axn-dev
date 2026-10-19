import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { chromium } from "playwright-core";

import {
  captureScreenshot,
  comparePngImages,
  evaluateScreenshotAssertion,
  expandString,
} from "./screenshot.js";
import { loadFlowsFromFile } from "@axn-dev/flow-format";

// ── PNG fixtures ────────────────────────────────────────────────────────────

const WHITE: [number, number, number] = [255, 255, 255];
const BLUE: [number, number, number] = [44, 123, 229];

function fill(png: PNG, x0: number, y0: number, w: number, h: number, c: [number, number, number]) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (png.width * y + x) << 2;
      png.data[i] = c[0];
      png.data[i + 1] = c[1];
      png.data[i + 2] = c[2];
      png.data[i + 3] = 255;
    }
  }
}

/** Draw a corner-rounded rect: pixel is background when outside the corner circle. */
function fillRounded(png: PNG, x0: number, y0: number, w: number, h: number, r: number, c: [number, number, number], bg: [number, number, number]) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const dx = Math.max(x0 + r - x, x - (x0 + w - 1 - r), 0);
      const dy = Math.max(y0 + r - y, y - (y0 + h - 1 - r), 0);
      const color = dx * dx + dy * dy <= r * r ? c : bg;
      const i = (png.width * y + x) << 2;
      png.data[i] = color[0];
      png.data[i + 1] = color[1];
      png.data[i + 2] = color[2];
      png.data[i + 3] = 255;
    }
  }
}

interface ButtonOpts {
  x?: number;
  y?: number;
  radius?: number;
  /** Blend the button's border pixels 50% toward the background (fake AA). */
  antialias?: boolean;
}

function renderButtonPng(opts: ButtonOpts = {}): Buffer {
  const W = 220;
  const H = 100;
  const bx = opts.x ?? 20;
  const by = opts.y ?? 25;
  const bw = 180;
  const bh = 50;
  const r = opts.radius ?? 0;

  const png = new PNG({ width: W, height: H });
  fill(png, 0, 0, W, H, WHITE);
  fillRounded(png, bx, by, bw, bh, r, BLUE, WHITE);

  if (opts.antialias) {
    // Soften the border: pixels that sit between button and background get a
    // 50/50 blend — the pattern pixelmatch classifies as anti-aliasing.
    const blend: [number, number, number] = [
      Math.round((WHITE[0] + BLUE[0]) / 2),
      Math.round((WHITE[1] + BLUE[1]) / 2),
      Math.round((WHITE[2] + BLUE[2]) / 2),
    ];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (png.width * y + x) << 2;
        const isButton =
          png.data[i] === BLUE[0] && png.data[i + 1] === BLUE[1] && png.data[i + 2] === BLUE[2];
        if (!isButton) continue;
        const neighbors = [
          x > 0 ? i - 4 : -1,
          x < W - 1 ? i + 4 : -1,
          y > 0 ? i - (W << 2) : -1,
          y < H - 1 ? i + (W << 2) : -1,
        ];
        const touchesBg = neighbors.some(
          (n) => n >= 0 && png.data[n] === WHITE[0] && png.data[n + 1] === WHITE[1] && png.data[n + 2] === WHITE[2]
        );
        if (touchesBg) {
          png.data[i] = blend[0];
          png.data[i + 1] = blend[1];
          png.data[i + 2] = blend[2];
        }
      }
    }
  }

  return PNG.sync.write(png);
}

// ── comparePngImages ────────────────────────────────────────────────────────

describe("comparePngImages", () => {
  it("passes identical images", () => {
    const ref = renderButtonPng();
    const res = comparePngImages(renderButtonPng(), ref);
    expect(res.passed).toBe(true);
    expect(res.diffPixels).toBe(0);
    expect(res.diffRatio).toBe(0);
    expect(res.diffImage).toBeUndefined();
  });

  it("tolerates anti-aliased edges", () => {
    const ref = renderButtonPng();
    const res = comparePngImages(renderButtonPng({ antialias: true }), ref);
    expect(res.passed).toBe(true);
  });

  it("fails when the button moved", () => {
    const ref = renderButtonPng();
    const res = comparePngImages(renderButtonPng({ x: 26 }), ref, { maxDiffRatio: 0.01 });
    expect(res.passed).toBe(false);
    expect(res.diffPixels).toBeGreaterThan(0);
    expect(res.diffImage).toBeDefined();
  });

  it("fails when the rectangular button turned rounded", () => {
    const ref = renderButtonPng();
    const res = comparePngImages(renderButtonPng({ radius: 20 }), ref, { maxDiffRatio: 0.01 });
    expect(res.passed).toBe(false);
    expect(res.diffRatio).toBeGreaterThan(0.01);
  });

  it("fails on dimension mismatch", () => {
    const ref = renderButtonPng();
    const small = new PNG({ width: 50, height: 50 });
    fill(small, 0, 0, 50, 50, BLUE);
    const res = comparePngImages(PNG.sync.write(small), ref);
    expect(res.passed).toBe(false);
    expect(res.sizeMismatch).toBe(true);
  });
});

// ── expandString ────────────────────────────────────────────────────────────

describe("expandString", () => {
  it("expands ${VAR} and ${VAR:-default}", () => {
    const env = { BASE_URL: "http://localhost:8080" };
    expect(expandString("${BASE_URL}/app", env)).toBe("http://localhost:8080/app");
    expect(expandString("${MISSING:-fallback}/x", env)).toBe("fallback/x");
    expect(expandString("${MISSING}", env)).toBe("${MISSING}");
  });
});

// ── flow XML parsing ────────────────────────────────────────────────────────

describe("screenshot assertion parsing", () => {
  it("carries screenshot attributes from the flow file", () => {
    const dir = mkdtempSync(join(tmpdir(), "axn-flow-parse-"));
    try {
      const file = join(dir, "flows.xml");
      writeFileSync(
        file,
        `<?xml version="1.0"?>
<flows>
  <flow name="visual">
    <steps>
      <script>console.log("hi")</script>
      <assertions>
        <assert that="screenshot" value="refs/button.png" selector="#buy"
                url="\${BASE_URL}/shop" maxDiff="0.02" threshold="0.2"
                viewport="800x600" wait="250" fullPage="true"/>
      </assertions>
    </steps>
  </flow>
</flows>`
      );
      const [flow] = loadFlowsFromFile(file);
      const a = flow.assertions[0];
      expect(a.that).toBe("screenshot");
      expect(a.value).toBe("refs/button.png");
      expect(a.selector).toBe("#buy");
      expect(a.url).toBe("${BASE_URL}/shop");
      expect(a.maxDiff).toBe(0.02);
      expect(a.threshold).toBe(0.2);
      expect(a.viewport).toBe("800x600");
      expect(a.wait).toBe("250");
      expect(a.fullPage).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── end-to-end with headless Chromium ───────────────────────────────────────

function page(buttonStyle: string): string {
  return `<!doctype html><html><body style="margin:0;background:#fff">
  <div id="wrap" style="width:300px;padding:10px 0">
    <button id="buy" style="padding:12px 40px;font-size:18px;
      font-family:sans-serif;background:#2c7be5;color:#fff;border:0;${buttonStyle}">Buy now</button>
  </div>
</body></html>`;
}

describe("screenshot assertion (Chromium)", () => {
  let server: Server;
  let port: number;
  let browserOk = false;
  let workDir: string;
  let flowDir: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "axn-flow-shot-"));
    flowDir = join(workDir, "flows");
    mkdirSync(join(flowDir, "refs"), { recursive: true });

    server = createServer((req, res) => {
      const variant = new URL(req.url ?? "/", "http://x").searchParams.get("v") ?? "rect";
      const style =
        variant === "moved"
          ? "border-radius:0;margin-left:40px"
          : variant === "curved"
            ? "border-radius:22px"
            : "border-radius:0";
      res.setHeader("content-type", "text/html");
      res.end(page(style));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;

    try {
      const b = await chromium.launch({ headless: true });
      await b.close();
      browserOk = true;
    } catch {
      browserOk = false;
    }
  });

  afterAll(async () => {
    server?.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  const urlFor = (v: string) => `http://127.0.0.1:${port}/?v=${v}`;

  it("captures an element screenshot", async (ctx) => {
    if (!browserOk) ctx.skip();
    const shot = await captureScreenshot({ url: urlFor("rect"), selector: "#buy" });
    const png = PNG.sync.read(shot);
    expect(png.width).toBeGreaterThan(50);
    expect(png.height).toBeLessThan(60); // element crop, not the viewport
  });

  it("passes on the unchanged page, fails on curved button, and catches a move via the container", async (ctx) => {
    if (!browserOk) ctx.skip();

    const env = { TEST_URL: `http://127.0.0.1:${port}` };
    const assertions = [
      { that: "screenshot", value: "refs/button.png", selector: "#buy" },
      { that: "screenshot", value: "refs/container.png", selector: "#wrap" },
    ];

    // Bless both references.
    process.env.AXN_FLOW_UPDATE_SCREENSHOTS = "1";
    try {
      for (const a of assertions) {
        const blessed = await evaluateScreenshotAssertion(
          { ...a, url: "${TEST_URL}/?v=rect" },
          { flowDir, env }
        );
        expect(blessed.passed).toBe(true);
      }
    } finally {
      delete process.env.AXN_FLOW_UPDATE_SCREENSHOTS;
    }

    // Unchanged page passes for both captures.
    for (const a of assertions) {
      const res = await evaluateScreenshotAssertion(
        { ...a, url: "${TEST_URL}/?v=rect" },
        { flowDir, env }
      );
      expect(res.passed).toBe(true);
    }

    // Shape change: cropped element capture detects it.
    const curved = await evaluateScreenshotAssertion(
      { ...assertions[0], url: "${TEST_URL}/?v=curved" },
      { flowDir, env }
    );
    expect(curved.passed).toBe(false);

    // Moved button: the element capture itself is blind to position (cropped
    // to the element), but the container capture catches it.
    const movedElement = await evaluateScreenshotAssertion(
      { ...assertions[0], url: "${TEST_URL}/?v=moved" },
      { flowDir, env }
    );
    expect(movedElement.passed).toBe(true); // same pixels, cropped to element

    const movedContainer = await evaluateScreenshotAssertion(
      { ...assertions[1], url: "${TEST_URL}/?v=moved" },
      { flowDir, env }
    );
    expect(movedContainer.passed).toBe(false);
    expect(movedContainer.detail).toMatch(/diff .*%/);

    const artifacts = readdirSync(join(flowDir, ".reports", "screenshots"));
    expect(artifacts.some((f) => f.endsWith(".actual.png"))).toBe(true);
    expect(artifacts.some((f) => f.endsWith(".diff.png"))).toBe(true);
  });

  it("fails and reports when the reference image is missing", async (ctx) => {
    if (!browserOk) ctx.skip();
    const res = await evaluateScreenshotAssertion(
      { that: "screenshot", value: "refs/nope.png", selector: "#buy", url: urlFor("rect") },
      { flowDir, env: {} }
    );
    expect(res.passed).toBe(false);
    expect(res.detail).toContain("reference image not found");
  });

  it("writes the reference in AXN_FLOW_UPDATE_SCREENSHOTS=1 mode", async (ctx) => {
    if (!browserOk) ctx.skip();
    process.env.AXN_FLOW_UPDATE_SCREENSHOTS = "1";
    try {
      const res = await evaluateScreenshotAssertion(
        { that: "screenshot", value: "refs/blessed.png", url: urlFor("rect") },
        { flowDir, env: {} }
      );
      expect(res.passed).toBe(true);
      expect(existsSync(join(flowDir, "refs", "blessed.png"))).toBe(true);
      PNG.sync.read(readFileSync(join(flowDir, "refs", "blessed.png"))); // valid PNG
    } finally {
      delete process.env.AXN_FLOW_UPDATE_SCREENSHOTS;
    }
  });
});
