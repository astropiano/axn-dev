import { themeBootScript, themeFontLinks, themeStyles, type ServeThemeSet } from "./theme.js";

/**
 * The one page head every axn-dev page renders — serve's dashboard, flow and
 * scenario pages as well as the interactive driver and stage — so a theme
 * applies to all of them by applying here. Pages use only the theme's custom
 * properties, never literal colours.
 */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function pageHead(title: string, themes: ServeThemeSet): string {
  return `<meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
${themeFontLinks(themes)}
  ${themeBootScript(themes)}
  ${themeStyles()}`;
}
