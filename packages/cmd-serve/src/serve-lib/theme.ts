/**
 * Pluggable theme system for the axn-dev serve dashboard.
 *
 * Theme files share axn-term's theme format (`id`/`name`/`mode`/`colors`/`ui`),
 * extended with a serve-specific `fonts:` section — axn-term theme files drop
 * in unchanged. Themes are discovered from two channels:
 *
 *   1. <pkg>/themes/                       bundled assets (axn-dark, axn-light)
 *   2. ~/.axn-dev/themes/                  user themes
 *
 * User themes win on id collisions, so a user file can replace a bundled
 * one. Selection comes from the `serve:` config section:
 *
 *   serve:
 *     theme: auto | light | dark | <theme-id>   # default for new browsers
 *     light-theme: axn-light                    # theme used in light mode
 *     dark-theme: axn-dark                      # theme used in dark mode
 *
 * `theme:` accepts a theme id as a shorthand for pinning the same theme to
 * both modes. The light/dark/auto toggle still applies per browser (choice
 * in localStorage, like before); the config only sets which theme each
 * mode resolves to and the default mode.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AxnDevConfig } from "@axn-dev/core";
import { configSection, parseYaml } from "@axn-dev/core";

export type ThemeMode = "light" | "dark";
export type ThemeModePref = ThemeMode | "auto";

/** Palette keys shared with axn-term's ThemeColors (all optional for serve). */
export interface ThemeColors {
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
  orange?: string;
  violet?: string;
}

/** UI-chrome keys shared with axn-term's ThemeUi (all optional for serve). */
export interface ThemeUi {
  bg?: string;
  bgSecondary?: string;
  surface?: string;
  /**
   * Serve extension: solid counterpart of `surface`, used where translucency
   * breaks (form fields, menu portals). Defaults to `surface`.
   */
  surfaceSolid?: string;
  surfaceHover?: string;
  text?: string;
  textSecondary?: string;
  textInverted?: string;
  border?: string;
  accent?: string;
  accentHover?: string;
  cursor?: string;
}

export interface ThemeFonts {
  /** Heading/brand font-family stack. */
  heading?: string;
  /** Body font-family stack. */
  body?: string;
  /** Optional stylesheet URL (e.g. Google Fonts) emitted as a <link>. */
  import?: string;
}

export interface ServeTheme {
  id: string;
  name: string;
  mode: ThemeMode;
  colors: ThemeColors;
  ui?: ThemeUi;
  fonts?: ThemeFonts;
  /** File the theme was loaded from (undefined for fallbacks). */
  source?: string;
}

export interface ServeThemeSet {
  /** All discovered themes, sorted by display name. */
  themes: ServeTheme[];
  /** Server-side defaults baked into the page (localStorage wins). */
  defaults: {
    mode: ThemeModePref;
    light: string;
    dark: string;
  };
  /** Unique font stylesheet URLs across all discovered themes. */
  fontImports: string[];
}

const DEFAULT_LIGHT_THEME = "axn-light";
const DEFAULT_DARK_THEME = "axn-dark";
const DEFAULT_HEADING_FONT = '"Raleway", sans-serif';
const DEFAULT_BODY_FONT = '"Lato", sans-serif';

/**
 * Last-resort palettes used when a theme omits colours or the bundled files
 * cannot be read — the axn-dark / axn-light palettes.
 */
const FALLBACK_COLORS: Record<ThemeMode, Required<Pick<ThemeColors,
  "background" | "foreground" | "selectionBackground" | "brightBlack" |
  "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "orange" | "violet"
>>> = {
  dark: {
    background: "#141110", foreground: "#E9E5E2", selectionBackground: "#3A3330",
    brightBlack: "#877D79", red: "#F45B69", green: "#3DBB72", yellow: "#E3B341",
    blue: "#4F9FD0", magenta: "#C08FD8", cyan: "#59C3C3", orange: "#F97316",
    violet: "#C08FD8",
  },
  light: {
    background: "#F5F5F4", foreground: "#1A1615", selectionBackground: "#D3E4EB",
    brightBlack: "#6F6865", red: "#B8323F", green: "#1E7A46", yellow: "#8A5F00",
    blue: "#175A7E", magenta: "#8A47A6", cyan: "#1C7475", orange: "#B4500C",
    violet: "#8A47A6",
  },
};

const FALLBACK_UI: Record<ThemeMode, Required<Pick<ThemeUi,
  "bg" | "bgSecondary" | "surface" | "surfaceHover" | "text" | "textSecondary" |
  "textInverted" | "border" | "accent" | "accentHover" | "cursor"
>>> = {
  dark: {
    bg: "#141110", bgSecondary: "#1C1918", surface: "#1C1918",
    surfaceHover: "#26211F", text: "#E9E5E2", textSecondary: "#AAA6A3",
    textInverted: "#141110", border: "#36312F", accent: "#82C6DC",
    accentHover: "#A2D7D7", cursor: "#F0A3AA",
  },
  light: {
    bg: "#EBEBEB", bgSecondary: "#F5F5F4", surface: "#F5F5F4",
    surfaceHover: "#E0DFDD", text: "#0F0B0A", textSecondary: "#4F4C4A",
    textInverted: "#F5F5F4", border: "#C9C7C4", accent: "#175A7E",
    accentHover: "#1E6F9A", cursor: "#B8323F",
  },
};

function normalizeTheme(raw: unknown, source: string): ServeTheme | null {
  if (typeof raw !== "object" || raw === null) return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.id !== "string" || typeof t.name !== "string") return null;

  const colors = (typeof t.colors === "object" && t.colors !== null
    ? t.colors : {}) as ThemeColors;
  const ui = (typeof t.ui === "object" && t.ui !== null
    ? t.ui : undefined) as ThemeUi | undefined;
  const fonts = (typeof t.fonts === "object" && t.fonts !== null
    ? t.fonts : undefined) as ThemeFonts | undefined;

  return {
    id: t.id,
    name: t.name,
    mode: t.mode === "light" ? "light" : "dark",
    colors,
    ui,
    fonts,
    source,
  };
}

const THEME_FILE_RE = /\.(json|ya?ml)$/i;

/** Theme dirs rescan per request — keep each parse warning to one line. */
const warnedThemeFiles = new Set<string>();

function loadThemeDir(dir: string, into: Map<string, ServeTheme>): void {
  if (!existsSync(dir)) return;
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => THEME_FILE_RE.test(f)).sort();
  } catch {
    return;
  }
  for (const file of entries) {
    const path = join(dir, file);
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = file.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
      const theme = normalizeTheme(parsed, path);
      if (theme) into.set(theme.id, theme);
      warnedThemeFiles.delete(path);
    } catch (e) {
      if (!warnedThemeFiles.has(path)) {
        warnedThemeFiles.add(path);
        console.warn(`axn-dev serve: skipping theme ${path}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
}

function builtinThemeDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/serve-lib and dist/serve-lib both resolve to <pkg>/themes.
  return resolve(here, "..", "..", "themes");
}

/**
 * Directories scanned for theme files, lowest precedence first: bundled
 * package assets → user themes in ~/.axn-dev/themes.
 */
function themeDirs(): string[] {
  return [builtinThemeDir(), join(homedir(), ".axn-dev", "themes")];
}

function serveSection(config: AxnDevConfig): Record<string, unknown> | undefined {
  const s = configSection<unknown>(config, "serve");
  return typeof s === "object" && s !== null && !Array.isArray(s)
    ? (s as Record<string, unknown>)
    : undefined;
}

/**
 * Discover all themes and resolve the server-side defaults. Rescans on every
 * call — page handlers invoke this per request so theme edits (like config
 * edits) apply on refresh without restarting the server.
 */
export function loadServeThemes(config: AxnDevConfig): ServeThemeSet {
  const byId = new Map<string, ServeTheme>();
  for (const dir of themeDirs()) loadThemeDir(dir, byId);
  const themes = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));

  const section = serveSection(config);
  const themeSel = typeof section?.theme === "string" ? section.theme : undefined;
  const pinnedId = themeSel && themeSel !== "auto" && themeSel !== "light" && themeSel !== "dark"
    ? themeSel : undefined;
  const pinned = pinnedId ? byId.get(pinnedId) : undefined;

  const pick = (key: "light-theme" | "dark-theme", fallback: string): string => {
    if (pinned) return pinned.id;
    const v = section?.[key];
    const id = typeof v === "string" && byId.has(v) ? v : fallback;
    return byId.has(id) ? id : fallback;
  };

  const defaults = {
    mode: (themeSel === "light" || themeSel === "dark" || themeSel === "auto"
      ? themeSel
      : pinned ? pinned.mode : "auto") as ThemeModePref,
    light: pick("light-theme", DEFAULT_LIGHT_THEME),
    dark: pick("dark-theme", DEFAULT_DARK_THEME),
  };

  const fontImports = [...new Set(
    themes.map((t) => t.fonts?.import).filter((u): u is string => typeof u === "string" && u.length > 0),
  )];

  return { themes, defaults, fontImports };
}

/**
 * Resolve every CSS custom property for a theme. Missing pieces fall back to
 * the axn palette of the same mode, so sparse theme files still yield a
 * complete variable set.
 */
export function themeCssVars(theme: ServeTheme): Record<string, string> {
  const mode = theme.mode;
  const c = theme.colors;
  const ui = theme.ui ?? {};
  const fc = FALLBACK_COLORS[mode];
  const fu = FALLBACK_UI[mode];

  const bg = ui.bg ?? c.background ?? fu.bg;
  const surface = ui.surface ?? c.selectionBackground ?? fu.surface;
  const text = ui.text ?? c.foreground ?? fu.text;
  const accent = ui.accent ?? c.blue ?? fu.accent;
  const accentHover = ui.accentHover ?? c.cyan ?? fu.accentHover;
  const accentText = ui.textInverted ?? fu.textInverted;

  return {
    "color-scheme": mode,
    "--bg": bg,
    "--bg-secondary": ui.bgSecondary ?? c.selectionBackground ?? fu.bgSecondary,
    "--text": text,
    "--text-muted": ui.textSecondary ?? c.brightBlack ?? fu.textSecondary,
    "--text-inverted": accentText,
    "--surface": surface,
    "--surface-solid": ui.surfaceSolid ?? surface,
    "--surface-hover": ui.surfaceHover ?? c.brightBlack ?? fu.surfaceHover,
    "--border": ui.border ?? c.brightBlack ?? fu.border,
    "--accent": accent,
    "--accent-hover": accentHover,
    "--accent-text": accentText,
    "--cursor": ui.cursor ?? c.cursor ?? fu.cursor,
    // Legacy brand names, kept as aliases for existing rules.
    "--primary-blue": "var(--accent)",
    "--primary-blue-hover": "var(--accent-hover)",
    "--accent-red": c.red ?? fc.red,
    "--accent-green": c.green ?? fc.green,
    "--accent-yellow": c.yellow ?? fc.yellow,
    "--accent-blue": c.blue ?? fc.blue,
    "--accent-cyan": c.cyan ?? fc.cyan,
    "--accent-magenta": c.magenta ?? fc.magenta,
    "--accent-orange": c.orange ?? fc.orange,
    "--accent-violet": c.violet ?? fc.violet,
    "--font-heading": theme.fonts?.heading ?? DEFAULT_HEADING_FONT,
    "--font-body": theme.fonts?.body ?? DEFAULT_BODY_FONT,
  };
}

/**
 * One <style> block holding every discovered theme's variables, each scoped
 * to `[data-theme-name="<id>"]` so the client can hot-swap by flipping the
 * attribute — no reload, no extra request.
 */
export function themeStyles(set: ServeThemeSet): string {
  const blocks = set.themes.map((t) => {
    const vars = Object.entries(themeCssVars(t))
      .map(([k, v]) => `    ${k}: ${v};`)
      .join("\n");
    return `  [data-theme-name="${t.id}"] {\n${vars}\n  }`;
  });
  return `<style id="axn-theme-vars">\n${blocks.join("\n\n")}\n</style>`;
}

/**
 * <link> tags for every font stylesheet the discovered themes reference.
 */
export function themeFontLinks(set: ServeThemeSet): string {
  return set.fontImports
    .map((u) => `  <link href="${u.replace(/"/g, "&quot;")}" rel="stylesheet">`)
    .join("\n");
}

/**
 * Boot data + early theme application, emitted into <head> before any styles
 * so the right `data-theme`/`data-theme-name` attributes are set before first
 * paint (no flash). sharedScripts reuses the AXN_THEME_* consts.
 */
export function themeBootScript(set: ServeThemeSet): string {
  const modes = Object.fromEntries(set.themes.map((t) => [t.id, t.mode]));
  const boot = {
    defaults: set.defaults,
    modes,
  };
  return `<script>
  const AXN_THEME = ${JSON.stringify(boot)};
  (function () {
    try {
      var pref = localStorage.getItem('axn-dev-theme') || AXN_THEME.defaults.mode;
      var mode = pref === 'auto'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : pref;
      var id = localStorage.getItem('axn-dev-' + mode + '-theme') || AXN_THEME.defaults[mode];
      if (!AXN_THEME.modes[id]) id = AXN_THEME.defaults[mode];
      var root = document.documentElement;
      root.setAttribute('data-theme', mode);
      root.setAttribute('data-theme-name', id);
    } catch (e) { /* defaults in the CSS apply */ }
  })();
</script>`;
}
