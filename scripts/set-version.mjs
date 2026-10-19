#!/usr/bin/env node
// Synced versioning: sets the same version on all public packages.
// Usage: node scripts/set-version.mjs 0.2.0
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error("Usage: node scripts/set-version.mjs <semver>");
  process.exit(1);
}

const pkgs = join(import.meta.dirname, "..", "packages");
const touched = [];
for (const dir of readdirSync(pkgs)) {
  const file = join(pkgs, dir, "package.json");
  let d;
  try { d = JSON.parse(readFileSync(file, "utf-8")); } catch { continue; }
  if (d.private) continue; // internal packages stay unpublished
  d.version = version;
  writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
  touched.push(`${d.name}@${version}`);
}
console.log(touched.join("\n"));
