import { describe, it, expect } from "vitest";
import { browserSettings } from "./browser.js";

describe("browserSettings", () => {
  it("defaults to headless Playwright Chromium", () => {
    expect(browserSettings({})).toEqual({ engine: "chromium", headed: false, launch: { headless: true } });
  });

  it("shows a window in interactive runs unless told otherwise", () => {
    expect(browserSettings({ AXN_DEV_INTERACTIVE: "1" }).headed).toBe(true);
    expect(browserSettings({ AXN_DEV_INTERACTIVE: "1", AXN_DEV_BROWSER_HEADED: "false" }).headed).toBe(false);
    expect(browserSettings({ AXN_DEV_BROWSER_HEADED: "true" }).launch.headless).toBe(false);
  });

  it("passes engine, channel and attach through", () => {
    expect(browserSettings({ AXN_DEV_BROWSER: "Firefox" }).engine).toBe("firefox");
    const chrome = browserSettings({ AXN_DEV_BROWSER_CHANNEL: "chrome", AXN_DEV_BROWSER_ATTACH: "http://127.0.0.1:9222" });
    expect(chrome.launch).toEqual({ headless: true, channel: "chrome" });
    expect(chrome.attach).toBe("http://127.0.0.1:9222");
  });

  it("rejects what cannot work, naming the variable", () => {
    expect(() => browserSettings({ AXN_DEV_BROWSER: "safari" })).toThrow(/AXN_DEV_BROWSER: 'safari'/);
    expect(() => browserSettings({ AXN_DEV_BROWSER: "firefox", AXN_DEV_BROWSER_CHANNEL: "chrome" }))
      .toThrow(/CHANNEL works with chromium only/);
    expect(() => browserSettings({ AXN_DEV_BROWSER: "webkit", AXN_DEV_BROWSER_ATTACH: "http://x" }))
      .toThrow(/ATTACH works with chromium only/);
    expect(() => browserSettings({ AXN_DEV_BROWSER_HEADED: "yes" })).toThrow(/AXN_DEV_BROWSER_HEADED/);
  });
});
