/**
 * Shared custom dropdown menu for all serve views (dashboard, flows, scenario
 * view). A single fixed-position <ul> portal is populated client-side from the
 * anchor's data-items JSON, so it is never clipped by `overflow-x: auto`
 * containers and never covered by iframes — and never uses the browser-native
 * <select>/<datalist> UI.
 *
 * Anchor contract: an element carrying
 *   data-items='[{"label":"…","url":"…"}, …]'
 *   data-action="open" | "nav"
 *   onclick="event.preventDefault(); event.stopPropagation(); toggleMenu(event, this)"
 * Action "open" opens the URL in a new tab; "nav" navigates the current page
 * (via axnDevNavigate when the view defines it, so the loading overlay shows).
 */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export interface MenuItem {
  label: string;
  url: string;
}

export type MenuAction = "open" | "nav";

function menuAttrs(items: MenuItem[], action: MenuAction): string {
  return `data-items="${escapeHtml(JSON.stringify(items))}" data-action="${action}"`;
}

const MENU_ONCLICK =
  "event.preventDefault(); event.stopPropagation(); toggleMenu(event, this)";

/**
 * Small ▾ chevron that opens the menu. Uses the existing .links-chevron style
 * shared by every view.
 */
export function menuChevronHtml(
  items: MenuItem[],
  action: MenuAction,
  title: string,
): string {
  if (items.length === 0) return "";
  return `<span class="links-chevron" ${menuAttrs(items, action)} onclick="${MENU_ONCLICK}" title="${escapeHtml(title)}">&#9662;</span>`;
}

/** Button-styled menu trigger (e.g. the dashboard row "Links" button). */
export function menuButtonHtml(
  items: MenuItem[],
  action: MenuAction,
  label: string,
): string {
  if (items.length === 0) return "";
  return `<button type="button" class="btn btn-secondary btn-sm" ${menuAttrs(items, action)} onclick="${MENU_ONCLICK}">${escapeHtml(label)}</button>`;
}

export const menuStyles = `<style>
  #axn-menu-portal {
    display: none;
    position: fixed;
    z-index: 1000;
    min-width: 160px;
    margin: 0;
    padding: 0.35rem;
    list-style: none;
    background: var(--surface-solid, var(--surface, #fff));
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  }
  #axn-menu-portal.open { display: block; }
  #axn-menu-portal li a {
    display: block;
    padding: 0.4rem 0.5rem;
    border-radius: 6px;
    font-size: 0.8rem;
    color: var(--text);
    text-decoration: none;
    white-space: nowrap;
    cursor: pointer;
  }
  #axn-menu-portal li a:hover {
    background: var(--accent);
    color: var(--accent-text, #fff);
  }
</style>`;

export const menuScripts = `<script>
  let axnMenuAnchor = null;

  function ensureMenuPortal() {
    let portal = document.getElementById('axn-menu-portal');
    if (!portal) {
      portal = document.createElement('ul');
      portal.id = 'axn-menu-portal';
      document.body.appendChild(portal);
    }
    return portal;
  }

  function closeMenu() {
    const portal = document.getElementById('axn-menu-portal');
    if (portal) { portal.classList.remove('open'); portal.innerHTML = ''; }
    axnMenuAnchor = null;
  }

  function toggleMenu(event, anchor) {
    const reopening = axnMenuAnchor === anchor;
    closeMenu();
    if (reopening) return;

    const items = JSON.parse(anchor.dataset.items || '[]');
    const action = anchor.dataset.action || 'open';
    const portal = ensureMenuPortal();
    items.forEach((item) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = item.url;
      a.textContent = item.label;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
        if (action === 'open') {
          window.open(item.url, '_blank');
        } else if (typeof axnDevNavigate === 'function') {
          axnDevNavigate(item.url);
        } else {
          window.location.href = item.url;
        }
      });
      li.appendChild(a);
      portal.appendChild(li);
    });

    const rect = anchor.getBoundingClientRect();
    portal.style.top = (rect.bottom + 6) + 'px';
    portal.style.left = 'auto';
    portal.style.right = Math.max(6, window.innerWidth - rect.right) + 'px';
    portal.classList.add('open');
    axnMenuAnchor = anchor;
  }

  document.addEventListener('click', closeMenu);
  window.addEventListener('scroll', closeMenu, true);
  window.addEventListener('resize', closeMenu);
</script>`;
