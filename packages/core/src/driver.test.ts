import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectScenarioType,
  driverFor,
  hasDriver,
  registerScenarioDriver,
  scenarioDriverSpecs,
  getRunningDriverDirs,
  type ScenarioDriver,
} from "./driver.js";
import { discoverScenarios, type RepoContext } from "./util/repo.js";
import { mkdirSync } from "node:fs";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "axn-driver-test-"));
}

/** Fabricate a repo ctx whose <root>/scenarios/<name> holds the fixture. */
function discoverOne(name: string, files: Record<string, string>) {
  const root = dir();
  const scenarioDir = join(root, "scenarios", name);
  mkdirSync(scenarioDir, { recursive: true });
  for (const [f, content] of Object.entries(files)) {
    writeFileSync(join(scenarioDir, f), content);
  }
  const ctx: RepoContext = { repoName: "test-repo", repoRoot: root, reposRoot: root };
  return discoverScenarios(ctx).find((s) => s.name === name);
}

describe("scenario driver registry", () => {
  it("has compose and shell built in", () => {
    const types = scenarioDriverSpecs().map((s) => s.type);
    expect(types).toEqual(["compose", "shell"]);
    expect(hasDriver("compose")).toBe(true);
    expect(hasDriver("bogus")).toBe(false);
  });

  it("detects compose via compose.yaml marker", () => {
    const d = dir();
    writeFileSync(join(d, "compose.yaml"), "services: {}\n");
    expect(detectScenarioType(d)).toBe("compose");
  });

  it("detects compose via docker-compose.yml marker", () => {
    const d = dir();
    writeFileSync(join(d, "docker-compose.yml"), "services: {}\n");
    expect(detectScenarioType(d)).toBe("compose");
  });

  it("detects shell via scenario.sh marker", () => {
    const d = dir();
    writeFileSync(join(d, "scenario.sh"), "#!/bin/sh\n");
    expect(detectScenarioType(d)).toBe("shell");
  });

  it("compose wins when both markers exist (registration order)", () => {
    const d = dir();
    writeFileSync(join(d, "compose.yaml"), "services: {}\n");
    writeFileSync(join(d, "scenario.sh"), "#!/bin/sh\n");
    expect(detectScenarioType(d)).toBe("compose");
  });

  it("returns null for a dir with no markers", () => {
    expect(detectScenarioType(dir())).toBeNull();
  });

  it("registered plugin markers participate in detection", () => {
    registerScenarioDriver({
      type: "test-marker-type",
      markers: ["marker.test"],
      load: () => stubDriver("test-marker-type"),
    });
    const d = dir();
    expect(detectScenarioType(d)).toBeNull();
    writeFileSync(join(d, "marker.test"), "");
    expect(detectScenarioType(d)).toBe("test-marker-type");
  });

  it("plugin markers lose to compose (compose registers first)", () => {
    registerScenarioDriver({
      type: "test-losing-type",
      markers: ["compose.yaml"],
      load: () => stubDriver("test-losing-type"),
    });
    const d = dir();
    writeFileSync(join(d, "compose.yaml"), "services: {}\n");
    expect(detectScenarioType(d)).toBe("compose");
  });

  it("explicit type: in axn-dev.yaml overrides markers", () => {
    const s = discoverOne("my-scenario", {
      "compose.yaml": "services: {}\n",
      "axn-dev.yaml": "type: shell\n",
    });
    expect(s?.type).toBe("shell");
  });

  it("declared type: makes a marker-less dir a scenario", () => {
    const s = discoverOne("my-scenario", { "axn-dev.yaml": "type: my-custom-type\n" });
    expect(s?.type).toBe("my-custom-type");
  });

  it("a dir with neither markers nor declared type is not a scenario", () => {
    const s = discoverOne("my-scenario", { "axn-dev.yaml": "description: x\n" });
    expect(s).toBeUndefined();
  });

  it("driverFor lazily loads and caches a registered driver", async () => {
    let loads = 0;
    registerScenarioDriver({
      type: "test-lazy-type",
      markers: [],
      load: () => { loads++; return stubDriver("test-lazy-type"); },
    });
    const a = await driverFor({ type: "test-lazy-type", name: "x" });
    const b = await driverFor({ type: "test-lazy-type", name: "y" });
    expect(loads).toBe(1);
    expect(a).toBe(b);
    expect(a.type).toBe("test-lazy-type");
  });

  it("driverFor throws a helpful error for unknown types", async () => {
    await expect(driverFor({ type: "no-such-type", name: "x" }))
      .rejects.toThrow(/Unknown scenario type 'no-such-type'/);
  });

  it("getRunningDriverDirs probes non-compose scenarios through drivers", async () => {
    const d = dir();
    registerScenarioDriver({
      type: "test-running-type",
      markers: ["run.test"],
      load: () => stubDriver("test-running-type", d),
    });
    const running = await getRunningDriverDirs([
      { path: d, type: "test-running-type" },
      { path: "/nonexistent", type: "test-running-type" },
      { path: d, type: "compose" },
    ]);
    expect([...running]).toEqual([d]);
  });
});

function stubDriver(type: string, runningDir?: string): ScenarioDriver {
  return {
    type,
    async isRunning(s) { return s.path === runningDir; },
    async start() {},
    async stop() {},
  };
}
