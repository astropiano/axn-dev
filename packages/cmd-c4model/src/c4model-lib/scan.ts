import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, dirname, relative } from "node:path";
import { execSync } from "node:child_process";

export interface RepoScan {
  root: string;
  name: string;
  git?: { branch: string; remote?: string };
  readme?: { path: string; excerpt: string };
  manifests: ManifestInfo[];
  tree: string[];
  sources: Record<string, number>;
  notables: string[];
}

interface ManifestInfo {
  file: string;
  kind: string;
  summary?: string;
}

const MANIFEST_FILES: Record<string, string> = {
  "package.json": "node",
  "pnpm-workspace.yaml": "node-workspace",
  "tsconfig.json": "typescript",
  "go.mod": "go",
  "Cargo.toml": "rust",
  "pyproject.toml": "python",
  "requirements.txt": "python",
  "pom.xml": "java",
  "build.gradle": "java",
  "build.gradle.kts": "java",
  "composer.json": "php",
  "Gemfile": "ruby",
};

const NOTABLE_FILES = [
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  "Makefile",
  ".gitlab-ci.yml",
  "Jenkinsfile",
  "helm",
  "charts",
  "k8s",
  "terraform",
  "ansible",
];

const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  ".git",
  ".idea",
  ".vscode",
  "__pycache__",
  ".next",
  "coverage",
]);

const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|py|go|rs|java|kt|cs|cpp|c|h|hpp|rb|php|swift|scala|sh)$/;

/** Walk up from `start` until a .git entry (dir or file for worktrees) is found. */
function findGitRoot(start: string): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function gitExec(root: string, args: string): string | undefined {
  try {
    return execSync(`git -C "${root}" ${args}`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

function readExcerpt(path: string, maxLines = 60): string {
  return readFileSync(path, "utf-8").split("\n").slice(0, maxLines).join("\n");
}

function summarizeManifest(root: string, file: string, kind: string): ManifestInfo {
  const info: ManifestInfo = { file, kind };
  try {
    const raw = readFileSync(join(root, file), "utf-8");
    if (file === "package.json") {
      const pkg = JSON.parse(raw);
      const deps = Object.keys(pkg.dependencies ?? {});
      const devDeps = Object.keys(pkg.devDependencies ?? {});
      info.summary = `${pkg.name ?? "?"} — deps: ${deps.join(", ") || "none"}; devDeps: ${devDeps.join(", ") || "none"}`;
    } else if (file === "go.mod") {
      info.summary = raw.split("\n").find((l) => l.startsWith("module "))?.trim();
    } else if (file === "Cargo.toml") {
      info.summary = raw.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[0]?.trim();
    } else {
      info.summary = raw.split("\n").filter((l) => l.trim()).slice(0, 5).join(" | ");
    }
  } catch {
    /* unreadable manifest — keep file+kind only */
  }
  return info;
}

/** Shallow directory listing: top-level entries plus one level into directories. */
function shallowTree(root: string, maxEntries = 120): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= maxEntries || depth > 1) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxEntries) return;
      if (e.name.startsWith(".") && depth > 0) continue;
      if (e.isDirectory() && IGNORED_DIRS.has(e.name)) continue;
      const rel = relative(root, join(dir, e.name)) || e.name;
      out.push(e.isDirectory() ? `${rel}/` : rel);
      if (e.isDirectory() && depth === 0) walk(join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** Count source files by extension across the repo (bounded walk). */
function countSources(root: string, maxFiles = 5000): Record<string, number> {
  const counts: Record<string, number> = {};
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    if (seen >= maxFiles || depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (seen >= maxFiles) return;
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        walk(join(dir, e.name), depth + 1);
      } else {
        const m = e.name.match(SOURCE_EXT_RE);
        if (m) {
          seen++;
          const ext = m[1];
          counts[ext] = (counts[ext] ?? 0) + 1;
        }
      }
    }
  };
  walk(root, 0);
  return counts;
}

export function scanRepo(startPath: string): RepoScan {
  const root = findGitRoot(startPath) ?? startPath;
  const scan: RepoScan = {
    root,
    name: basename(root),
    manifests: [],
    tree: shallowTree(root),
    sources: countSources(root),
    notables: NOTABLE_FILES.filter((f) => existsSync(join(root, f))),
  };

  const branch = gitExec(root, "rev-parse --abbrev-ref HEAD");
  if (branch) {
    scan.git = { branch };
    const remote = gitExec(root, "config --get remote.origin.url");
    if (remote) scan.git.remote = remote;
  }

  for (const readmeName of ["README.md", "README.adoc", "README.rst", "README"]) {
    const p = join(root, readmeName);
    if (existsSync(p) && statSync(p).isFile()) {
      scan.readme = { path: readmeName, excerpt: readExcerpt(p) };
      break;
    }
  }

  for (const [file, kind] of Object.entries(MANIFEST_FILES)) {
    if (existsSync(join(root, file))) {
      scan.manifests.push(summarizeManifest(root, file, kind));
    }
  }

  return scan;
}
