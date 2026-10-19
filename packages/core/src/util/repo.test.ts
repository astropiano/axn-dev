import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectRepo, discoverScenarios, scenarioMatches, type RepoContext } from "./repo.js";

/** Fabricate a repo: .git marker + scenario dirs under variant roots. */
function repoWithVariants(
  scenarioRootsYaml: string | null,
  layout: Record<string, Record<string, string>>,
): string {
  const root = mkdtempSync(join(tmpdir(), "axn-repo-test-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  if (scenarioRootsYaml !== null) {
    mkdirSync(join(root, ".axn-dev"), { recursive: true });
    writeFileSync(join(root, ".axn-dev", "config.yaml"), scenarioRootsYaml);
  }
  for (const [rootDir, files] of Object.entries(layout)) {
    const dir = join(root, rootDir);
    mkdirSync(dir, { recursive: true });
    for (const [f, content] of Object.entries(files)) {
      writeFileSync(join(dir, f), content);
    }
  }
  return root;
}

function ctxFor(repoRoot: string): RepoContext {
  return { repoName: "test-repo", repoRoot, reposRoot: repoRoot };
}

const COMPOSE = "services: {}\n";
const VARIANT_LAYOUT = {
  "gen_a/v1/scenarios/mock": { "compose.yaml": COMPOSE },
  "gen_a/v1/scenarios/sim": { "scenario.sh": "#!/bin/sh\n" },
  "gen_b/v2/scenarios/mock": { "compose.yaml": COMPOSE },
  "gen_b/v2/scenarios/sim": { "scenario.sh": "#!/bin/sh\n" },
};

describe("scenario roots layout", () => {
  it("defaults to <repoRoot>/scenarios when no layout is declared", () => {
    const root = repoWithVariants(null, {
      "scenarios/mock": { "compose.yaml": COMPOSE },
    });
    const scenarios = discoverScenarios(ctxFor(root));
    expect(scenarios.map((s) => s.name)).toEqual(["mock"]);
    expect(scenarios[0].variant).toBeUndefined();
  });

  it("expands declared wildcard roots and derives variants", () => {
    const root = repoWithVariants("scenarios:\n  roots: gen_*/*\n", VARIANT_LAYOUT);
    const scenarios = discoverScenarios(ctxFor(root));
    expect(scenarios.map((s) => `${s.variant}/${s.name}`).sort()).toEqual([
      "v1/mock", "v1/sim", "v2/mock", "v2/sim",
    ]);
  });

  it("supports comma-separated root patterns", () => {
    const root = repoWithVariants(
      "scenarios:\n  roots: gen_a/*, gen_b/v2\n",
      VARIANT_LAYOUT,
    );
    const variants = new Set(discoverScenarios(ctxFor(root)).map((s) => s.variant));
    expect(variants).toEqual(new Set(["v1", "v2"]));
  });

  it("scopes discovery to the variant containing cwd", () => {
    const root = repoWithVariants("scenarios:\n  roots: gen_*/*\n", VARIANT_LAYOUT);
    const ctx = detectRepo(join(root, "gen_b", "v2", "src"));
    expect(ctx?.variant).toBe("v2");
    expect(discoverScenarios(ctx!).map((s) => s.variant)).toEqual(["v2", "v2"]);
  });

  it("auto-scopes when the layout yields exactly one nested root", () => {
    const root = repoWithVariants("scenarios:\n  roots: gen_*/*\n", {
      "gen_a/v1/scenarios/mock": { "compose.yaml": COMPOSE },
    });
    const ctx = detectRepo(root);
    expect(ctx?.variant).toBe("v1");
  });

  it("injects SCENARIO_VARIANT into scenario env; explicit env wins", () => {
    const root = repoWithVariants("scenarios:\n  roots: gen_*/*\n", {
      "gen_a/v1/scenarios/mock": { "compose.yaml": COMPOSE },
      "gen_a/v1/scenarios/override": {
        "compose.yaml": COMPOSE,
        "axn-dev.yaml": "env:\n  SCENARIO_VARIANT: custom\n",
      },
    });
    const scenarios = discoverScenarios(ctxFor(root));
    expect(scenarios.find((s) => s.name === "mock")?.env?.SCENARIO_VARIANT).toBe("v1");
    expect(scenarios.find((s) => s.name === "override")?.env?.SCENARIO_VARIANT).toBe("custom");
  });

  it("variant/name addressing still works via scenarioMatches", () => {
    const root = repoWithVariants("scenarios:\n  roots: gen_*/*\n", VARIANT_LAYOUT);
    const scenarios = discoverScenarios(ctxFor(root));
    const matches = scenarios.filter((s) => scenarioMatches(s, "v2/mock"));
    expect(matches).toHaveLength(1);
    expect(matches[0].variant).toBe("v2");
    expect(scenarios.filter((s) => scenarioMatches(s, "mock"))).toHaveLength(2);
  });
});
