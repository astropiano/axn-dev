/**
 * The one page head every axn-dev page renders — serve's dashboard and flow
 * pages as well as the interactive stage — so a theme applies to all of them
 * by applying here. Pages use only these custom properties, never literal
 * colours.
 */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export const fontLinks =
  `<link href="https://fonts.googleapis.com/css2?family=Raleway:wght@400;500;700;900&family=Lato:wght@400;700&display=swap" rel="stylesheet">`;

/** CSS custom properties of the light and dark theme (no <style> wrapper). */
export const themeTokensCss = `
  :root {
    --primary-blue: #1E6F9A;
    --primary-blue-hover: #3C99AF;
    --neutral-obsidian: #0F0B0A;
    --neutral-slate: #3A3A3A;
    --neutral-cloud: #A2D7D7;
    --neutral-mist: #EBEBEB;
    --neutral-surface: #FFFFFF;
    --accent-red: #F45B69;
    --accent-green: #22C55E;
    --font-heading: "Raleway", sans-serif;
    --font-body: "Lato", sans-serif;
    --bg: var(--neutral-mist);
    --text: var(--neutral-obsidian);
    --text-muted: var(--neutral-slate);
    --surface: rgba(255, 255, 255, 0.8);
    --surface-solid: var(--neutral-surface);
    --border: var(--neutral-cloud);
    --accent: var(--primary-blue);
    --accent-hover: var(--primary-blue-hover);
    --accent-text: #FFFFFF;
  }

  [data-theme="dark"] {
    --bg: var(--neutral-obsidian);
    --text: var(--neutral-mist);
    --text-muted: #B0B0B0;
    --surface: rgba(26, 26, 26, 0.8);
    --surface-solid: #1A1A1A;
    --border: #3A3A3A;
    --accent: var(--accent-red);
    --accent-hover: #F0A3AA;
    --accent-text: var(--neutral-obsidian);
  }
`;

/** Applies the stored light/dark/auto choice before first paint, so a page
 * that has no theme toggle of its own still follows the dashboard's. */
export const themeBootScript = `<script>
  (function () {
    var pref = 'auto';
    try { pref = localStorage.getItem('axn-dev-theme') || 'auto'; } catch (e) {}
    var dark = pref === 'dark' || (pref === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  })();
</script>`;

export function pageHead(title: string): string {
  return `<meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  ${fontLinks}
  <style>${themeTokensCss}</style>
  ${themeBootScript}`;
}
