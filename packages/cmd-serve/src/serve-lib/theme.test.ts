import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AxnDevConfig } from "@axn-dev/core";
import {
  loadServeThemes,
  themeBootScript,
  themeCssVars,
  themeStyles,
  type ServeTheme,
} from "./theme.js";

const mockHome = vi.hoisted(() => ({ dir: "/nonexistent-home" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockHome.dir };
});

function configWith(sections: Record<string, unknown> = {}): AxnDevConfig {
  return {
    integration: [],
    repos: {},
    repoAliases: {},
    autoPort: false,
    autoPortRange: null,
    sections,
  };
}

function themeFixture(partial: Partial<ServeTheme>): ServeTheme {
  return {
    id: "test-theme",
    name: "Test Theme",
    mode: "dark",
    colors: {},
    ...partial,
  };
}

/** Redirects homedir() at a temp dir and writes files into ~/.axn-dev/themes. */
function withUserThemes(files: Record<string, string>): () => void {
  const home = mkdtempSync(join(tmpdir(), "axn-home-"));
  mockHome.dir = home;
  const dir = join(home, ".axn-dev", "themes");
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(dir, file), content);
  }
  return () => {
    mockHome.dir = "/nonexistent-home";
    rmSync(home, { recursive: true, force: true });
  };
}

describe("themeCssVars", () => {
  it("falls back to the axn palette of the same mode for sparse themes", () => {
    const vars = themeCssVars(themeFixture({ colors: { background: "#000000" } }));
    expect(vars["--bg"]).toBe("#000000");
    expect(vars["--accent"]).toBe("#82C6DC"); // axn-dark accent
    expect(vars["--accent-red"]).toBe("#F45B69");
    expect(vars["color-scheme"]).toBe("dark");
  });

  it("maps ui keys over palette keys", () => {
    const vars = themeCssVars(themeFixture({
      mode: "light",
      colors: { blue: "#111111" },
      ui: { accent: "#222222", surface: "#F0F0F0", surfaceHover: "#DDDDDD" },
    }));
    expect(vars["--accent"]).toBe("#222222");
    expect(vars["--surface"]).toBe("#F0F0F0");
    expect(vars["--surface-solid"]).toBe("#F0F0F0");
    expect(vars["--surface-hover"]).toBe("#DDDDDD");
  });

  it("uses accent-text from ui.textInverted", () => {
    const vars = themeCssVars(themeFixture({ ui: { textInverted: "#123456" } }));
    expect(vars["--accent-text"]).toBe("#123456");
    expect(vars["--text-inverted"]).toBe("#123456");
  });
});

describe("loadServeThemes", () => {
  it("discovers bundled axn themes and picks axn defaults", () => {
    const set = loadServeThemes(configWith());
    const ids = set.themes.map((t) => t.id);
    expect(ids).toContain("axn-dark");
    expect(ids).toContain("axn-light");
    expect(set.defaults).toEqual({ mode: "auto", light: "axn-light", dark: "axn-dark" });
    expect(set.fontImports.length).toBeGreaterThan(0);
  });

  it("loads user themes from ~/.axn-dev/themes and honours theme: <id> pinning", () => {
    const cleanup = withUserThemes({ "mine.yaml": [
      "id: mine",
      "name: Mine",
      "mode: light",
      "colors: { background: '#EEEEEE' }",
      "",
    ].join("\n") });
    try {
      const set = loadServeThemes(configWith({ serve: { theme: "mine" } }));

      const mine = set.themes.find((t) => t.id === "mine");
      expect(mine?.mode).toBe("light");
      expect(set.defaults.mode).toBe("light");
      expect(set.defaults.light).toBe("mine");
      expect(set.defaults.dark).toBe("mine");
    } finally {
      cleanup();
    }
  });

  it("supports explicit light-theme/dark-theme selection", () => {
    const cleanup = withUserThemes({ "solar.json": JSON.stringify({
      id: "solar", name: "Solar", mode: "dark", colors: {},
    }) });
    try {
      const set = loadServeThemes(configWith({
        serve: { "dark-theme": "solar" },
      }));
      expect(set.defaults.dark).toBe("solar");
      expect(set.defaults.light).toBe("axn-light");
    } finally {
      cleanup();
    }
  });

  it("lets a user theme override a bundled one by id", () => {
    const cleanup = withUserThemes({ "axn-dark.yaml": [
      "id: axn-dark",
      "name: Custom Dark",
      "mode: dark",
      "colors: { background: '#010203' }",
      "",
    ].join("\n") });
    try {
      const set = loadServeThemes(configWith());
      const dark = set.themes.find((t) => t.id === "axn-dark");
      expect(dark?.name).toBe("Custom Dark");
      expect(dark?.source).toContain(".axn-dev/themes");
    } finally {
      cleanup();
    }
  });

  it("skips malformed theme files instead of failing", () => {
    const cleanup = withUserThemes({
      "bad.yaml": "id: [unclosed",
      "noid.yaml": "name: No Id\nmode: dark\n",
    });
    try {
      const set = loadServeThemes(configWith());
      expect(set.themes.map((t) => t.id)).not.toContain("noid");
    } finally {
      cleanup();
    }
  });
});

describe("emission", () => {
  it("scopes every theme under [data-theme-name]", () => {
    const css = themeStyles(loadServeThemes(configWith()));
    expect(css).toContain('[data-theme-name="axn-dark"]');
    expect(css).toContain("[data-theme-name=\"axn-dark\"] {\n    color-scheme: dark;");
    expect(css).toContain("--font-heading:");
  });

  it("boot script carries defaults and modes", () => {
    const js = themeBootScript(loadServeThemes(configWith()));
    expect(js).toContain('"defaults":{"mode":"auto","light":"axn-light","dark":"axn-dark"}');
    expect(js).toContain('"axn-dark":"dark"');
    expect(js).toContain('"axn-light":"light"');
  });
});
