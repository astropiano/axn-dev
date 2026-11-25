/**
 * Pluggable theme system for axn-dev's pages: the serve dashboard and the
 * interactive driver/stage (`axn-dev flow --interactive-ui`).
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
 * Applied the way axn-term applies themes: the stylesheet carries a built-in
 * theme on :root (so a page without any theme still looks right), and the
 * chosen theme only overrides custom properties through
 * `style.setProperty` in the browser. Theme values never become stylesheet or
 * script text, so a theme file cannot inject markup or script.
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
  /** Optional https stylesheet URL (e.g. Google Fonts), loaded when the theme is active. */
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
  /** Font stylesheets of the two default themes, linked for first paint. */
  fontImports: string[];
}

const DEFAULT_LIGHT_THEME = "axn-light";
const DEFAULT_DARK_THEME = "axn-dark";
const DEFAULT_HEADING_FONT = '"Raleway", sans-serif';
const DEFAULT_BODY_FONT = '"Lato", sans-serif';
const DEFAULT_FONT_IMPORT =
  "https://fonts.googleapis.com/css2?family=Raleway:wght@400;500;700;900&family=Lato:wght@400;700&display=swap";

/** localStorage keys of the browser's own choice, shared by boot and toggle. */
const MODE_KEY = "axn-dev-theme";
const THEME_KEY_PREFIX = "axn-dev-";
const THEME_KEY_SUFFIX = "-theme";

/**
 * The built-in theme — the axn-dark / axn-light palettes. It is the
 * stylesheet's :root default, and fills what a sparse theme file leaves out.
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

/**
 * Hover and border, derived from the base colours when a theme does not pin
 * them — like axn-term's design tokens. A terminal palette's brightBlack is a
 * text grey, not a surface, so it is no fallback for either.
 */
const DERIVED_DEFAULTS: Record<string, string> = {
  "--surface-hover": "color-mix(in srgb, var(--text) 8%, var(--bg))",
  "--border": "color-mix(in srgb, var(--text) 18%, var(--bg))",
};

const THEME_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;
/** Colour values a theme may set: hex, or rgb()/hsl() with plain numbers. */
const COLOR_RE = /^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\))$/i;
/** A font-family stack: names, quotes, commas, spaces, hyphens. */
const FONT_RE = /^[\w\s"',.-]+$/;

function pickColors<T extends object>(raw: unknown): T | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string" && COLOR_RE.test(v.trim())) out[k] = v.trim();
  }
  return out as T;
}

function pickFonts(raw: unknown): ThemeFonts | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const f = raw as Record<string, unknown>;
  const out: ThemeFonts = {};
  if (typeof f.heading === "string" && FONT_RE.test(f.heading)) out.heading = f.heading;
  if (typeof f.body === "string" && FONT_RE.test(f.body)) out.body = f.body;
  if (typeof f.import === "string") {
    try {
      if (new URL(f.import).protocol === "https:") out.import = f.import;
    } catch {
      // not a URL
    }
  }
  return out;
}

/** Validated theme, or null. Values that are not plain colours or font stacks
 * are dropped (the built-in theme fills them), not passed to the page. */
export function normalizeTheme(raw: unknown, source?: string): ServeTheme | null {
  if (typeof raw !== "object" || raw === null) return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.id !== "string" || !THEME_ID_RE.test(t.id)) return null;
  if (typeof t.name !== "string" || t.name.trim() === "") return null;

  return {
    id: t.id,
    name: t.name,
    mode: t.mode === "light" ? "light" : "dark",
    colors: pickColors<ThemeColors>(t.colors) ?? {},
    ui: pickColors<ThemeUi>(t.ui),
    fonts: pickFonts(t.fonts),
    source,
  };
}

const THEME_FILE_RE = /\.(json|ya?ml)$/i;

/** Theme dirs and config rescan per request — keep each warning to one line. */
const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`axn-dev serve: ${message}`);
}

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
      if (!theme) throw new Error("needs an id (letters, digits, - and _) and a name");
      into.set(theme.id, theme);
      warned.delete(path);
    } catch (e) {
      warnOnce(path, `skipping theme ${path}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

function builtinThemeDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/ and dist/ both resolve to <pkg>/themes.
  return resolve(here, "..", "themes");
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

  const known = (key: string, id: unknown): id is string => {
    if (typeof id !== "string") return false;
    if (byId.has(id)) return true;
    warnOnce(`config:${key}:${id}`, `serve.${key}: no theme '${id}' — known: ${[...byId.keys()].join(", ") || "(none)"}`);
    return false;
  };

  const section = serveSection(config);
  const themeSel = typeof section?.theme === "string" ? section.theme : undefined;
  const isMode = themeSel === "auto" || themeSel === "light" || themeSel === "dark";
  const pinned = themeSel && !isMode && known("theme", themeSel) ? byId.get(themeSel) : undefined;

  const pick = (key: "light-theme" | "dark-theme", fallback: string): string => {
    if (pinned) return pinned.id;
    const v = section?.[key];
    return v !== undefined && known(key, v) ? v : fallback;
  };

  const defaults = {
    mode: (isMode ? themeSel : pinned ? pinned.mode : "auto") as ThemeModePref,
    light: pick("light-theme", DEFAULT_LIGHT_THEME),
    dark: pick("dark-theme", DEFAULT_DARK_THEME),
  };

  const fontImports = [...new Set(
    [defaults.light, defaults.dark]
      .map((id) => byId.get(id)?.fonts?.import ?? (byId.has(id) ? undefined : DEFAULT_FONT_IMPORT))
      .filter((u): u is string => typeof u === "string"),
  )];

  return { themes, defaults, fontImports };
}

/**
 * The custom properties a theme sets. Base values fall back to the built-in
 * palette of the same mode, so switching themes never leaves another theme's
 * colours behind. Hover and border are left out unless pinned (`ui`), so the
 * stylesheet derives them (DERIVED_DEFAULTS).
 */
export function themeCssVars(theme: ServeTheme): Record<string, string> {
  const mode = theme.mode;
  const c = theme.colors;
  const ui = theme.ui ?? {};
  const fc = FALLBACK_COLORS[mode];
  const fu = FALLBACK_UI[mode];

  const surface = ui.surface ?? c.selectionBackground ?? fu.surface;
  const accentText = ui.textInverted ?? fu.textInverted;

  const vars: Record<string, string> = {
    "--bg": ui.bg ?? c.background ?? fu.bg,
    "--bg-secondary": ui.bgSecondary ?? c.selectionBackground ?? fu.bgSecondary,
    "--text": ui.text ?? c.foreground ?? fu.text,
    "--text-muted": ui.textSecondary ?? c.brightBlack ?? fu.textSecondary,
    "--text-inverted": accentText,
    "--surface": surface,
    "--surface-solid": ui.surfaceSolid ?? surface,
    "--accent": ui.accent ?? c.blue ?? fu.accent,
    "--accent-hover": ui.accentHover ?? c.cyan ?? fu.accentHover,
    "--accent-text": accentText,
    "--cursor": ui.cursor ?? c.cursor ?? fu.cursor,
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
  if (ui.surfaceHover) vars["--surface-hover"] = ui.surfaceHover;
  if (ui.border) vars["--border"] = ui.border;
  return vars;
}

function builtinTheme(mode: ThemeMode): ServeTheme {
  return { id: `builtin-${mode}`, name: `Built-in ${mode}`, mode, colors: FALLBACK_COLORS[mode], ui: FALLBACK_UI[mode] };
}

function cssBlock(selector: string, vars: Record<string, string>): string {
  const body = Object.entries(vars).map(([k, v]) => `    ${k}: ${v};`).join("\n");
  return `  ${selector} {\n${body}\n  }`;
}

/**
 * The built-in theme as the stylesheet's default: light on :root, dark under
 * [data-theme="dark"], plus the derived hover/border tokens. Built from the
 * constants above only — never from theme files — so it is always there:
 * no theme selected, storage blocked, or the theme files missing.
 */
export function themeStyles(): string {
  return `<style id="axn-theme-base">
${cssBlock(":root", { "color-scheme": "light", ...themeCssVars(builtinTheme("light")), ...DERIVED_DEFAULTS })}

${cssBlock('[data-theme="dark"]', { "color-scheme": "dark", ...themeCssVars(builtinTheme("dark")) })}
</style>`;
}

/** <link> tags for the default themes' font stylesheets (first paint). */
export function themeFontLinks(set: ServeThemeSet): string {
  return set.fontImports
    .map((u) => `  <link href="${u.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" rel="stylesheet" data-axn-theme-font>`)
    .join("\n");
}

/** JSON that is safe inside a <script> element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Theme data and the browser side of theming, in <head> before first paint.
 * `window.axnTheme` resolves the browser's choice (localStorage, else the
 * config defaults) and applies a theme with style.setProperty. `data-theme`
 * follows the applied theme's own mode, so it never contradicts the colours.
 * sharedScripts' toggle calls the same functions.
 */
export function themeBootScript(set: ServeThemeSet): string {
  const data = {
    defaults: set.defaults,
    keys: { mode: MODE_KEY, prefix: THEME_KEY_PREFIX, suffix: THEME_KEY_SUFFIX },
    themes: Object.fromEntries(set.themes.map((t) => [t.id, {
      mode: t.mode,
      vars: themeCssVars(t),
      ...(t.fonts?.import ? { font: t.fonts.import } : {}),
    }])),
  };
  return `<script>
  window.axnTheme = (function (data) {
    var root = document.documentElement;
    var applied = [];
    function read(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
    function write(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* per tab only */ } }
    function systemMode() {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    function pref() {
      var p = read(data.keys.mode) || data.defaults.mode;
      return p === 'light' || p === 'dark' || p === 'auto' ? p : 'auto';
    }
    function themeFor(mode) {
      var id = read(data.keys.prefix + mode + data.keys.suffix);
      if (!id || !data.themes[id]) id = data.defaults[mode];
      return data.themes[id] ? { id: id, theme: data.themes[id] } : null;
    }
    function apply(p) {
      var mode = p === 'auto' ? systemMode() : p;
      var found = themeFor(mode);
      for (var i = 0; i < applied.length; i++) root.style.removeProperty(applied[i]);
      applied = [];
      if (!found) {
        // No such theme: the stylesheet's built-in theme for this mode applies.
        root.removeAttribute('data-theme-name');
        root.setAttribute('data-theme', mode);
        root.style.colorScheme = mode;
        return;
      }
      var vars = found.theme.vars;
      for (var k in vars) {
        var v = vars[k];
        if (k.indexOf('--font-') !== 0 && window.CSS && CSS.supports && !CSS.supports('color', v)) continue;
        root.style.setProperty(k, v);
        applied.push(k);
      }
      root.setAttribute('data-theme', found.theme.mode);
      root.setAttribute('data-theme-name', found.id);
      root.style.colorScheme = found.theme.mode;
      if (found.theme.font && !document.querySelector('link[data-axn-theme-font][href="' + found.theme.font.replace(/"/g, '') + '"]')) {
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = found.theme.font;
        link.setAttribute('data-axn-theme-font', '');
        document.head.appendChild(link);
      }
    }
    function store(p) { write(data.keys.mode, p); }
    try { apply(pref()); } catch (e) { /* the stylesheet's built-in theme applies */ }
    return { pref: pref, apply: apply, store: store, systemMode: systemMode };
  })(${scriptJson(data)});
</script>`;
}
