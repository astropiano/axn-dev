const iconFolderClosed = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide-folder" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`;

const iconFolderOpen = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide-folder-open" aria-hidden="true"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>`;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function tagBadgesHtml(tags?: string[]): string {
  if (!tags || tags.length === 0) return "";
  return tags
    .map((t) => `<span class="meta-badge tag-badge" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</span>`)
    .join(" ");
}

export function tagSearchInputHtml(id: string, placeholder = "Filter by tag..."): string {
  return `
    <div class="filter-group filter-group--search">
      <input type="search" id="${id}" placeholder="${escapeHtml(placeholder)}" oninput="filterByTag('${id}')">
    </div>
  `;
}

export function viewToggleHtml(tableId: string, treeId: string, storageKey: string): string {
  return `
    <div class="filter-group view-toggle" role="group" aria-label="View switcher">
      <button type="button" id="view-toggle-table" class="view-toggle-btn active" onclick="switchView('table', '${tableId}', '${treeId}', '${storageKey}')">Table</button>
      <button type="button" id="view-toggle-tree" class="view-toggle-btn" onclick="switchView('tree', '${tableId}', '${treeId}', '${storageKey}')">Tree</button>
    </div>
  `;
}

export interface TagTreeItem {
  id: string;
  name: string;
  tags?: string[];
  bodyHtml: string;
}

interface TreeNode {
  name: string;
  fullTag: string;
  children: Map<string, TreeNode>;
  items: TagTreeItem[];
}

function buildTagTree(items: TagTreeItem[]): { root: TreeNode; untagged: TagTreeItem[] } {
  const root: TreeNode = { name: "", fullTag: "", children: new Map(), items: [] };
  const untagged: TagTreeItem[] = [];

  for (const item of items) {
    if (!item.tags || item.tags.length === 0) {
      untagged.push(item);
      continue;
    }
    for (const tag of item.tags) {
      const parts = tag.split("/").filter(Boolean);
      if (parts.length === 0) continue;
      let node = root;
      let path = "";
      for (const part of parts) {
        path = path ? `${path}/${part}` : part;
        let child = node.children.get(part);
        if (!child) {
          child = { name: part, fullTag: path, children: new Map(), items: [] };
          node.children.set(part, child);
        }
        node = child;
      }
      node.items.push(item);
    }
  }

  return { root, untagged };
}

function renderNode(node: TreeNode, headerHtml?: string): string {
  const sortedChildren = [...node.children.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (sortedChildren.length === 0) return "";

  return sortedChildren
    .map(([_, child]) => {
      const nested = renderNode(child, headerHtml);
      const sortedItems = [...child.items].sort((a, b) => a.name.localeCompare(b.name));
      const rowsHtml = sortedItems.map((i) => i.bodyHtml).join("\n");

      const itemsContent = headerHtml
        ? `<div class="table-container"><table class="scenario-table">${headerHtml}<tbody>${rowsHtml}</tbody></table></div>`
        : `<ul class="tag-tree-list">${sortedItems.map((i) => `<li class="tag-tree-leaf" data-tree-item>${i.bodyHtml}</li>`).join("\n")}</ul>`;

      return `
        <details class="tag-folder" data-tree-node data-tree-tag="${escapeHtml(child.fullTag)}" open>
          <summary class="tag-folder-summary">
            <span class="folder-icon">${iconFolderClosed}</span> ${escapeHtml(child.name)}
          </summary>
          <div class="tag-folder-content">
            ${child.items.length > 0 ? itemsContent : ""}
            ${nested}
          </div>
        </details>
      `;
    })
    .join("\n");
}

export function tagTreeViewHtml(
  containerId: string,
  items: TagTreeItem[],
  headerHtml?: string,
  untaggedLabel = "Untagged",
): string {
  const { root, untagged } = buildTagTree(items);
  const treeHtml = renderNode(root, headerHtml);

  const untaggedRows = untagged
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((i) => i.bodyHtml)
    .join("\n");

  const untaggedContent = headerHtml
    ? `<div class="table-container"><table class="scenario-table">${headerHtml}<tbody>${untaggedRows}</tbody></table></div>`
    : `<ul class="tag-tree-list">${untagged.map((i) => `<li class="tag-tree-leaf" data-tree-item>${i.bodyHtml}</li>`).join("\n")}</ul>`;

  const untaggedHtml = untagged.length
    ? `
      <div class="tag-untagged" data-tree-node data-tree-tag="">
        <div class="tag-folder-summary tag-untagged-summary">
          <span class="folder-icon">${iconFolderOpen}</span> ${escapeHtml(untaggedLabel)}
        </div>
        ${untaggedContent}
      </div>
    `
    : "";

  return `
    <div id="${containerId}" class="tree-view-wrapper" style="display: none;">
      ${untaggedHtml}
      ${treeHtml}
    </div>
  `;
}

export function tagViewScripts(tableWrapperId: string, treeWrapperId: string, tagSearchId: string, storageKey: string): string {
  return `<script>
    function tagMatches(tag, q) {
      const t = tag.toLowerCase();
      const query = q.toLowerCase();
      return t.startsWith(query) || t.split("/").some(function (seg) { return seg.startsWith(query); });
    }

    function filterByTag(searchId) {
      const q = (document.getElementById(searchId || "${tagSearchId}")?.value || "").toLowerCase();
      const table = document.getElementById("${tableWrapperId}");
      if (!table) return;
      const rows = table.querySelectorAll(".scenario-row");
      let visible = 0;
      rows.forEach(function (row) {
        const tags = row.dataset.tags ? JSON.parse(row.dataset.tags) : [];
        const matches = !q || tags.some(function (tag) { return tagMatches(tag, q); });
        row.style.display = matches ? "" : "none";
        if (matches) visible++;
      });
      const none = table.querySelector(".no-results");
      if (none) none.style.display = visible === 0 ? "" : "none";
    }

    function switchView(view, tableId, treeId, key) {
      const table = document.getElementById(tableId || "${tableWrapperId}");
      const tree = document.getElementById(treeId || "${treeWrapperId}");
      localStorage.setItem(key || "${storageKey}", view);
      if (table) table.style.display = view === "table" ? "" : "none";
      if (tree) tree.style.display = view === "tree" ? "" : "none";
      document.querySelectorAll(".view-toggle-btn").forEach(function (b) { b.classList.remove("active"); });
      const active = document.getElementById("view-toggle-" + view);
      if (active) active.classList.add("active");
    }

    (function restoreView() {
      const view = localStorage.getItem("${storageKey}") || "table";
      switchView(view, "${tableWrapperId}", "${treeWrapperId}", "${storageKey}");
    })();
  </script>`;
}
