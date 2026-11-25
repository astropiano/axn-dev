import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AxnDevConfig } from "@axn-dev/core";
import {
  loadServeThemes,
  normalizeTheme,
  themeBootScript,
  themeCssVars,
  themeFontLinks,
  themeStyles,
  type ServeTheme,
  type ServeThemeSet,
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

afterEach(() => vi.restoreAllMocks());

describe("normalizeTheme", () => {
  it("drops values that could break out of CSS or HTML, keeping plain colours", () => {
    const t = normalizeTheme({
      id: "evil",
      name: "Evil",
      mode: "dark",
      colors: { background: "#101010", red: "rgb(200, 10, 10)" },
      ui: { bg: "red}</style><script>alert(1)</script>", accent: "#AABBCC", text: "var(--x); color: red" },
      fonts: { heading: '"Inter", sans-serif', body: "x</style>", import: "javascript:alert(1)" },
    });
    expect(t?.colors).toEqual({ background: "#101010", red: "rgb(200, 10, 10)" });
    expect(t?.ui).toEqual({ accent: "#AABBCC" });
    expect(t?.fonts).toEqual({ heading: '"Inter", sans-serif' });
  });

  it("rejects ids that are not plain names, and themes without a name", () => {
    expect(normalizeTheme({ id: 'my"theme', name: "X", colors: {} })).toBeNull();
    expect(normalizeTheme({ id: "</script>", name: "X", colors: {} })).toBeNull();
    expect(normalizeTheme({ id: "half", colors: {} })).toBeNull();
    expect(normalizeTheme({ id: "ok-1", name: "Ok", colors: {} })?.id).toBe("ok-1");
  });

  it("keeps only https font stylesheets", () => {
    expect(normalizeTheme({ id: "f", name: "F", fonts: { import: "http://x/f.css" } })?.fonts).toEqual({});
    expect(normalizeTheme({ id: "f", name: "F", fonts: { import: "https://x/f.css" } })?.fonts?.import)
      .toBe("https://x/f.css");
  });
});

describe("themeCssVars", () => {
  it("falls back to the built-in palette of the same mode for sparse themes", () => {
    const vars = themeCssVars(themeFixture({ colors: { background: "#000000" } }));
    expect(vars["--bg"]).toBe("#000000");
    expect(vars["--accent"]).toBe("#82C6DC"); // axn-dark accent
    expect(vars["--accent-red"]).toBe("#F45B69");
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

  it("leaves hover and border to the stylesheet unless pinned — brightBlack is a text grey", () => {
    const vars = themeCssVars(themeFixture({ mode: "light", colors: { brightBlack: "#6F6865" } }));
    expect(vars).not.toHaveProperty("--surface-hover");
    expect(vars).not.toHaveProperty("--border");
    expect(themeStyles()).toContain("--surface-hover: color-mix(in srgb, var(--text) 8%, var(--bg));");
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
    expect(set.fontImports).toHaveLength(1);
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

  it("warns once when the config names a theme that does not exist", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = configWith({ serve: { theme: "axn-drak" } });
    const set = loadServeThemes(config);
    loadServeThemes(config);
    expect(set.defaults).toEqual({ mode: "auto", light: "axn-light", dark: "axn-dark" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("no theme 'axn-drak'");
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
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const cleanup = withUserThemes({
      "bad.yaml": "id: [unclosed",
      "noid.yaml": "name: No Id\nmode: dark\n",
      "half.yaml": "id: half\nmode: dark\n",
    });
    try {
      const set = loadServeThemes(configWith());
      expect(set.themes.map((t) => t.id).sort()).toEqual(["axn-dark", "axn-light"]);
    } finally {
      cleanup();
    }
  });
});

describe("emission", () => {
  it("the stylesheet carries the built-in theme on :root and for dark, from constants only", () => {
    const css = themeStyles();
    expect(css).toContain(":root {\n    color-scheme: light;");
    expect(css).toContain("--bg: #EBEBEB;");
    expect(css).toContain('[data-theme="dark"] {\n    color-scheme: dark;');
    expect(css).toContain("--bg: #141110;");
    expect(css).not.toContain("data-theme-name");
  });

  it("boot script data cannot close the <script> element", () => {
    const set: ServeThemeSet = {
      // Unnormalized on purpose: escaping must hold even if a value slips through.
      themes: [themeFixture({ id: "</script><script>alert(1)</script>", colors: { background: "</script>" } })],
      defaults: { mode: "auto", light: "x", dark: "x" },
      fontImports: [],
    };
    const js = themeBootScript(set);
    expect(js.match(/<\/script>/g)).toHaveLength(1);
    expect(js.trimEnd().endsWith("</script>")).toBe(true);
  });

  it("font links cover only the default themes", () => {
    const set = loadServeThemes(configWith());
    expect(themeFontLinks(set).match(/<link /g)).toHaveLength(1);
  });
});

/** Runs the boot script against a minimal DOM and returns what it set. */
function boot(set: ServeThemeSet, opts: { storage?: Record<string, string>; storageThrows?: boolean; dark?: boolean }) {
  const attrs: Record<string, string> = {};
  const props: Record<string, string> = {};
  const root = {
    setAttribute: (k: string, v: string) => { attrs[k] = v; },
    removeAttribute: (k: string) => { delete attrs[k]; },
    style: {
      colorScheme: "",
      setProperty: (k: string, v: string) => { props[k] = v; },
      removeProperty: (k: string) => { delete props[k]; },
    },
  };
  const document = {
    documentElement: root,
    head: { appendChild: () => {} },
    querySelector: () => null,
    createElement: () => ({ setAttribute: () => {} }),
  };
  const localStorage = {
    getItem: (k: string) => {
      if (opts.storageThrows) throw new Error("blocked");
      return opts.storage?.[k] ?? null;
    },
    setItem: () => {},
  };
  const window: Record<string, unknown> = { matchMedia: () => ({ matches: !!opts.dark }) };
  const CSS = { supports: (_p: string, v: string) => /^(#|rgb|hsl)/.test(v) };
  const body = themeBootScript(set).replace(/^<script>/, "").replace(/<\/script>$/, "");
  new Function("window", "document", "localStorage", "CSS", body)(window, document, localStorage, CSS);
  return { attrs, props, colorScheme: root.style.colorScheme, api: window.axnTheme as { apply(p: string): void } };
}

describe("boot script in the browser", () => {
  const set = (): ServeThemeSet => loadServeThemes(configWith());

  it("applies the mode's default theme by setProperty", () => {
    const r = boot(set(), { dark: true });
    expect(r.attrs["data-theme"]).toBe("dark");
    expect(r.attrs["data-theme-name"]).toBe("axn-dark");
    expect(r.props["--bg"]).toBe("#141110");
  });

  it("sets data-theme from the applied theme's own mode, not the toggle", () => {
    const cleanup = withUserThemes({ "night.yaml": "id: night\nname: Night\nmode: dark\ncolors: {}\n" });
    try {
      const pinned = loadServeThemes(configWith({ serve: { theme: "night" } }));
      const r = boot(pinned, { storage: { "axn-dev-theme": "light" } });
      expect(r.attrs["data-theme-name"]).toBe("night");
      expect(r.attrs["data-theme"]).toBe("dark");
      expect(r.colorScheme).toBe("dark");
    } finally {
      cleanup();
    }
  });

  it("leaves the stylesheet's built-in theme in place when storage is blocked or the theme is missing", () => {
    const blocked = boot(set(), { storageThrows: true });
    expect(blocked.attrs["data-theme-name"]).toBe("axn-light");

    const none: ServeThemeSet = { themes: [], defaults: { mode: "dark", light: "axn-light", dark: "axn-dark" }, fontImports: [] };
    const r = boot(none, {});
    expect(r.attrs["data-theme"]).toBe("dark");
    expect(r.attrs).not.toHaveProperty("data-theme-name");
    expect(Object.keys(r.props)).toEqual([]);
  });

  it("switching themes clears properties the next theme does not set", () => {
    const cleanup = withUserThemes({
      "pinned.yaml": ["id: pinned", "name: Pinned", "mode: light", "colors: {}", "ui: { border: '#123456' }", ""].join("\n"),
      "plain.yaml": ["id: plain", "name: Plain", "mode: dark", "colors: {}", ""].join("\n"),
    });
    try {
      const both = loadServeThemes(configWith({ serve: { "light-theme": "pinned", "dark-theme": "plain" } }));
      const r = boot(both, { storage: { "axn-dev-theme": "light" } });
      expect(r.props["--border"]).toBe("#123456");
      r.api.apply("dark");
      expect(r.attrs["data-theme-name"]).toBe("plain");
      expect(r.props).not.toHaveProperty("--border");
    } finally {
      cleanup();
    }
  });
});
