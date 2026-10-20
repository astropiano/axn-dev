#!/usr/bin/env node
// Print the GitVersion-computed version for this checkout.
// Usage: node scripts/version-next.mjs [--json]
//
// Requires GitVersion (`dotnet tool install -g GitVersion.Tool` or
// `brew install gitversion`). On the GitLab repo run from `develop`;
// on the GitHub mirror run from `main` — both yield the same SemVer
// at tagged commits (see docs/release.adoc).

import { execFileSync, spawnSync } from "node:child_process";

const json = process.argv.includes("--json");

for (const bin of ["gitversion", "dotnet-gitversion"]) {
  const r = spawnSync(bin, ["/showvariable", "FullSemVer"], {
    cwd: import.meta.dirname + "/..",
    encoding: "utf-8",
  });
  if (r.status === 0) {
    const v = r.stdout.trim();
    console.log(json ? JSON.stringify({ version: v }) : v);
    process.exit(0);
  }
  if (r.error && r.error.code !== "ENOENT") {
    console.error(r.stderr || String(r.error));
    process.exit(1);
  }
}

console.error(
  "gitversion not found. Install: dotnet tool install -g GitVersion.Tool (or `brew install gitversion`)",
);
process.exit(2);
