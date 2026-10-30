/**
 * Maven dependency graph from `mvn dependency:tree` text output — the shape
 * Maven prints to the console (`[INFO] ` prefixed) and writes with
 * `-DoutputFile` (unprefixed). Artifacts are keyed `group:artifact`; the
 * versions seen are kept per artifact.
 *
 * Without `-Dverbose`, Maven prints each artifact once per module, at its
 * first path, so most "X depends on Y" edges are missing. With it, the repeats
 * appear as `(coordinates - omitted for duplicate)` lines; they are read as
 * edges like any other.
 */

export interface DepArtifact {
  key: string;
  versions: string[];
  /** A module the tree was built for, as opposed to a resolved dependency. */
  module: boolean;
}

export interface DepEdge {
  from: string;
  to: string;
  scope: string;
}

export interface DepGraph {
  artifacts: DepArtifact[];
  edges: DepEdge[];
}

const PREFIX = /^\[INFO\] ?/;
const TREE_LINE = /^((?:[| ] {2})*)[+\\]- (.+)$/;
const COORDINATES = /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+(:[A-Za-z0-9_.-]+){1,3}$/;

/** `group:artifact:type[:classifier]:version[:scope]` → key, version, scope. */
function parseCoordinates(spec: string): { key: string; version: string; scope?: string } | null {
  if (!COORDINATES.test(spec)) return null;
  const p = spec.split(":");
  switch (p.length) {
    case 4: return { key: `${p[0]}:${p[1]}`, version: p[3] };
    case 5: return { key: `${p[0]}:${p[1]}`, version: p[3], scope: p[4] };
    case 6: return { key: `${p[0]}:${p[1]}`, version: p[4], scope: p[5] };
    default: return null;
  }
}

export function parseDependencyTree(text: string): DepGraph {
  const artifacts = new Map<string, { versions: Set<string>; module: boolean }>();
  const edges = new Map<string, DepEdge>();
  const note = (key: string, version: string, module: boolean) => {
    const a = artifacts.get(key) ?? { versions: new Set<string>(), module: false };
    a.versions.add(version);
    a.module ||= module;
    artifacts.set(key, a);
  };

  // stack[d] is the artifact at depth d of the tree being read; depth 0 is the module.
  let stack: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(PREFIX, "").trimEnd();
    const tree = TREE_LINE.exec(line);
    if (tree) {
      if (stack.length === 0) continue;
      const depth = tree[1].length / 3 + 1;
      // `(g:a:t:v:scope - omitted for …)` in verbose output; otherwise the first token.
      const spec = tree[2].startsWith("(") ? tree[2].slice(1).split(" - ")[0].replace(/\)$/, "") : tree[2].split(" ")[0];
      const dep = parseCoordinates(spec);
      if (!dep || depth > stack.length) continue;
      note(dep.key, dep.version, false);
      const from = stack[depth - 1];
      edges.set(`${from}>${dep.key}`, edges.get(`${from}>${dep.key}`) ?? { from, to: dep.key, scope: dep.scope ?? "compile" });
      stack = [...stack.slice(0, depth), dep.key];
      continue;
    }
    // A module's coordinates start its tree; any other line — Maven's banners,
    // warnings, a blank — ends the current one.
    const root = parseCoordinates(line);
    if (root && root.scope === undefined) {
      note(root.key, root.version, true);
      stack = [root.key];
    } else {
      stack = [];
    }
  }

  return {
    artifacts: [...artifacts].map(([key, a]) => ({ key, versions: [...a.versions].sort(), module: a.module })),
    edges: [...edges.values()],
  };
}

/** Both graphs in one: artifacts by key with their versions combined, edges deduplicated. */
export function mergeGraphs(a: DepGraph, b: DepGraph): DepGraph {
  const artifacts = new Map<string, DepArtifact>();
  for (const x of [...a.artifacts, ...b.artifacts]) {
    const prev = artifacts.get(x.key);
    artifacts.set(x.key, prev
      ? { key: x.key, versions: [...new Set([...prev.versions, ...x.versions])].sort(), module: prev.module || x.module }
      : x);
  }
  const edges = new Map<string, DepEdge>();
  for (const e of [...a.edges, ...b.edges]) if (!edges.has(`${e.from}>${e.to}`)) edges.set(`${e.from}>${e.to}`, e);
  return { artifacts: [...artifacts.values()], edges: [...edges.values()] };
}

/** Artifacts matching a query: an exact key, else an exact artifact id, else a substring of the key. */
export function findArtifacts(graph: DepGraph, query: string): DepArtifact[] {
  const exact = graph.artifacts.filter((a) => a.key === query);
  if (exact.length > 0) return exact;
  const byId = graph.artifacts.filter((a) => a.key.split(":")[1] === query);
  if (byId.length > 0) return byId;
  return graph.artifacts.filter((a) => a.key.includes(query));
}

export interface Reached {
  key: string;
  /** 1 for a direct dependency (or dependent), 2 for one hop further, … */
  depth: number;
  /** The scope of the edge it was first reached through. */
  scope: string;
  /** The artifact it was first reached from. */
  via: string;
}

/**
 * Everything reachable from `start` along dependency edges — what it depends
 * on, or with `reverse` what depends on it — each once, at its shortest depth.
 */
export function reach(graph: DepGraph, start: string, reverse = false, maxDepth = Infinity): Reached[] {
  const next = new Map<string, DepEdge[]>();
  for (const e of graph.edges) {
    const k = reverse ? e.to : e.from;
    next.set(k, [...(next.get(k) ?? []), e]);
  }
  const seen = new Map<string, Reached>();
  let frontier = [start];
  for (let depth = 1; frontier.length > 0 && depth <= maxDepth; depth++) {
    const following: string[] = [];
    for (const k of frontier) {
      for (const e of next.get(k) ?? []) {
        const other = reverse ? e.from : e.to;
        if (other === start || seen.has(other)) continue;
        seen.set(other, { key: other, depth, scope: e.scope, via: k });
        following.push(other);
      }
    }
    frontier = following;
  }
  return [...seen.values()].sort((a, b) => a.depth - b.depth || a.key.localeCompare(b.key));
}

/** The shortest chain of dependencies from `from` to `to`, both included, or null. */
export function dependencyPath(graph: DepGraph, from: string, to: string): string[] | null {
  if (from === to) return [from];
  const reached = new Map(reach(graph, from).map((r) => [r.key, r]));
  if (!reached.has(to)) return null;
  const path = [to];
  while (path[0] !== from) path.unshift(reached.get(path[0])!.via);
  return path;
}
