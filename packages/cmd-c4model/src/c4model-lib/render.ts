import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { parseYaml } from "@axn-dev/core";

export type RenderFormat = "single" | "multi";

export interface RenderResult {
  format: RenderFormat;
  output: string;
  levels: string[];
}

interface Workdir {
  dir: string;
  title: string;
  date: string;
  levelFiles: string[];
}

const LEVEL_ORDER = ["context", "containers", "components", "code"];

function levelLabel(file: string): string {
  const m = basename(file, ".md").match(/^\d+-(.+)$/);
  return m ? m[1] : basename(file, ".md");
}

function loadWorkdir(dir: string): Workdir {
  const abs = resolve(dir);
  if (!existsSync(abs)) throw new Error(`Working directory not found: ${abs}`);

  let title = basename(abs);
  let date = "";
  const metaPath = join(abs, "meta.yaml");
  if (existsSync(metaPath)) {
    const meta = parseYaml(readFileSync(metaPath, "utf-8"));
    if (typeof meta["title"] === "string") title = meta["title"];
    if (typeof meta["date"] === "string") date = meta["date"];
  }

  const levelsDir = join(abs, "levels");
  const isEmpty = (p: string) =>
    readFileSync(p, "utf-8").replace(/<!--[\s\S]*?-->/g, "").trim() === "";
  const levelFiles = existsSync(levelsDir)
    ? readdirSync(levelsDir)
        .filter((f) => f.endsWith(".md") && !isEmpty(join(levelsDir, f)))
        .sort((a, b) => {
          const rank = (f: string) => {
            const idx = LEVEL_ORDER.indexOf(levelLabel(f));
            return idx === -1 ? LEVEL_ORDER.length : idx;
          };
          return rank(a) - rank(b) || a.localeCompare(b);
        })
        .map((f) => join(levelsDir, f))
    : [];

  if (levelFiles.length === 0) {
    throw new Error(`No level files found in ${levelsDir}. Expected files like 01-context.md.`);
  }

  return { dir: abs, title, date, levelFiles };
}

function headingFor(file: string): string {
  const label = levelLabel(file);
  const num = basename(file, ".md").match(/^(\d+)/)?.[1];
  const nice = label.charAt(0).toUpperCase() + label.slice(1);
  return num ? `Level ${parseInt(num, 10)} — ${nice}` : nice;
}

function renderSingle(work: Workdir, out: string): RenderResult {
  const parts: string[] = [`# C4 Decomposition — ${work.title}\n`];
  if (work.date) parts.push(`_Generated: ${work.date}_\n`);

  parts.push(`## Contents\n`);
  for (const f of work.levelFiles) {
    const anchor = headingFor(f).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    parts.push(`- [${headingFor(f)}](#${anchor})`);
  }
  parts.push("");

  for (const f of work.levelFiles) {
    parts.push(`## ${headingFor(f)}\n`);
    parts.push(readFileSync(f, "utf-8").trim() + "\n");
  }

  const outPath = resolve(out);
  mkdirSync(dirnameOf(outPath), { recursive: true });
  writeFileSync(outPath, parts.join("\n"), "utf-8");
  return { format: "single", output: outPath, levels: work.levelFiles.map((f) => basename(f)) };
}

function renderMulti(work: Workdir, out: string): RenderResult {
  const outDir = resolve(out);
  mkdirSync(outDir, { recursive: true });

  const lines: string[] = [`# C4 Decomposition — ${work.title}\n`];
  if (work.date) lines.push(`_Generated: ${work.date}_\n`);
  lines.push(`## Levels\n`);
  for (const f of work.levelFiles) {
    const name = basename(f);
    copyFileSync(f, join(outDir, name));
    lines.push(`- [${headingFor(f)}](./${name})`);
  }
  lines.push("");

  const indexPath = join(outDir, "index.md");
  writeFileSync(indexPath, lines.join("\n"), "utf-8");
  return { format: "multi", output: outDir, levels: work.levelFiles.map((f) => basename(f)) };
}

function dirnameOf(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? "." : p.slice(0, idx) || "/";
}

export function render(dir: string, format: RenderFormat, out: string): RenderResult {
  const work = loadWorkdir(dir);
  const defaultOut =
    format === "single"
      ? join(work.dir, "c4-decomposition.md")
      : join(work.dir, "c4");
  const target = out || defaultOut;
  return format === "single" ? renderSingle(work, target) : renderMulti(work, target);
}

export function defaultWorkdir(slug: string): string {
  return resolve(process.cwd(), ".axn-dev", "c4model", slug);
}

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return slug || `c4-${Date.now()}`;
}
