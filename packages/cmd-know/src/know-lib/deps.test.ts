import { describe, it, expect } from "vitest";
import { dependencyPath, findArtifacts, mergeGraphs, parseDependencyTree, reach } from "./deps.js";

// Console form: what `mvn dependency:tree` prints, between Maven's own lines.
const CONSOLE = `[INFO] Scanning for projects...
[INFO] --- dependency:3.7.0:tree (default-cli) @ webapp ---
[INFO] info.magnolia:webapp:war:6.4
[INFO] +- info.magnolia:magnolia-core:jar:6.4:compile
[INFO] |  +- org.apache.jackrabbit:jackrabbit-core:jar:2.20.0:compile
[INFO] |  |  \\- commons-io:commons-io:jar:2.11.0:compile
[INFO] |  \\- javax.inject:javax.inject:jar:1:compile
[INFO] +- info.magnolia:magnolia-rendering:jar:6.4:compile
[INFO] \\- junit:junit:jar:4.13:test
[INFO]
[INFO] ------------------------------------------------------------------------
[INFO] info.magnolia:other-module:jar:6.4
[INFO] \\- info.magnolia:magnolia-core:jar:6.3:compile
[INFO] BUILD SUCCESS`;

// File form: -DoutputFile writes the trees alone, without [INFO].
const FILE = `info.magnolia:magnolia-rendering:jar:6.4
+- info.magnolia:magnolia-core:jar:6.4:provided
\\- org.freemarker:freemarker:jar:jdk8:2.3.32:compile
`;

describe("parseDependencyTree", () => {
  const g = parseDependencyTree(CONSOLE);
  const edges = g.edges.map((e) => `${e.from} > ${e.to} (${e.scope})`);

  it("reads every module's tree, nesting by indent, between Maven's own lines", () => {
    expect(edges).toEqual([
      "info.magnolia:webapp > info.magnolia:magnolia-core (compile)",
      "info.magnolia:magnolia-core > org.apache.jackrabbit:jackrabbit-core (compile)",
      "org.apache.jackrabbit:jackrabbit-core > commons-io:commons-io (compile)",
      "info.magnolia:magnolia-core > javax.inject:javax.inject (compile)",
      "info.magnolia:webapp > info.magnolia:magnolia-rendering (compile)",
      "info.magnolia:webapp > junit:junit (test)",
      "info.magnolia:other-module > info.magnolia:magnolia-core (compile)",
    ]);
  });

  it("keys artifacts by group:artifact, keeping every version seen, and marks the modules", () => {
    const core = g.artifacts.find((a) => a.key === "info.magnolia:magnolia-core")!;
    expect(core.versions).toEqual(["6.3", "6.4"]);
    expect(g.artifacts.filter((a) => a.module).map((a) => a.key)).toEqual(["info.magnolia:webapp", "info.magnolia:other-module"]);
  });

  it("reads -DoutputFile output and coordinates with a classifier", () => {
    const f = parseDependencyTree(FILE);
    expect(f.edges.map((e) => `${e.to}@${f.artifacts.find((a) => a.key === e.to)!.versions[0]} (${e.scope})`)).toEqual([
      "info.magnolia:magnolia-core@6.4 (provided)",
      "org.freemarker:freemarker@2.3.32 (compile)",
    ]);
  });
});

describe("parseDependencyTree — verbose output", () => {
  it("reads the edges Maven omits as duplicates or conflicts, without nesting under them", () => {
    const g = parseDependencyTree(`info.magnolia:webapp:war:6.4
+- info.magnolia:magnolia-rendering:jar:6.4:compile
|  +- (info.magnolia:magnolia-core:jar:6.4:compile - omitted for duplicate)
|  \\- (commons-io:commons-io:jar:2.9.0:compile - omitted for conflict with 2.11.0)
\\- info.magnolia:magnolia-core:jar:6.4:compile
`);
    expect(g.edges.map((e) => `${e.from} > ${e.to}`)).toEqual([
      "info.magnolia:webapp > info.magnolia:magnolia-rendering",
      "info.magnolia:magnolia-rendering > info.magnolia:magnolia-core",
      "info.magnolia:magnolia-rendering > commons-io:commons-io",
      "info.magnolia:webapp > info.magnolia:magnolia-core",
    ]);
  });
});

describe("dependency queries", () => {
  const g = parseDependencyTree(CONSOLE);

  it("lists what an artifact depends on, transitively, at the shortest depth", () => {
    expect(reach(g, "info.magnolia:webapp").map((r) => `${r.depth} ${r.key}`)).toEqual([
      "1 info.magnolia:magnolia-core",
      "1 info.magnolia:magnolia-rendering",
      "1 junit:junit",
      "2 javax.inject:javax.inject",
      "2 org.apache.jackrabbit:jackrabbit-core",
      "3 commons-io:commons-io",
    ]);
  });

  it("lists what depends on an artifact, and stops at a depth", () => {
    expect(reach(g, "commons-io:commons-io", true).map((r) => r.key)).toEqual([
      "org.apache.jackrabbit:jackrabbit-core",
      "info.magnolia:magnolia-core",
      "info.magnolia:other-module",
      "info.magnolia:webapp",
    ]);
    expect(reach(g, "info.magnolia:magnolia-core", true, 1).map((r) => r.key)).toEqual(["info.magnolia:other-module", "info.magnolia:webapp"]);
  });

  it("explains why one artifact pulls in another with the shortest chain", () => {
    expect(dependencyPath(g, "info.magnolia:webapp", "commons-io:commons-io")).toEqual([
      "info.magnolia:webapp",
      "info.magnolia:magnolia-core",
      "org.apache.jackrabbit:jackrabbit-core",
      "commons-io:commons-io",
    ]);
    expect(dependencyPath(g, "junit:junit", "commons-io:commons-io")).toBeNull();
  });

  it("matches an artifact by exact key, then artifact id, then substring", () => {
    expect(findArtifacts(g, "info.magnolia:magnolia-core").map((a) => a.key)).toEqual(["info.magnolia:magnolia-core"]);
    expect(findArtifacts(g, "junit").map((a) => a.key)).toEqual(["junit:junit"]);
    expect(findArtifacts(g, "magnolia-r").map((a) => a.key)).toEqual(["info.magnolia:magnolia-rendering"]);
  });

  it("prefers the exact key when it is also a prefix of another artifact", () => {
    const both = parseDependencyTree("info.magnolia:m:jar:1\n+- info.magnolia:magnolia-core:jar:6.4:compile\n\\- info.magnolia:magnolia-core-compatibility:jar:6.4:compile\n");
    expect(findArtifacts(both, "info.magnolia:magnolia-core").map((a) => a.key)).toEqual(["info.magnolia:magnolia-core"]);
    expect(findArtifacts(both, "magnolia-core").map((a) => a.key)).toEqual(["info.magnolia:magnolia-core"]);
  });

  it("merges two projects' graphs, combining versions and deduplicating edges", () => {
    const merged = mergeGraphs(g, parseDependencyTree(FILE));
    expect(merged.edges.filter((e) => e.to === "info.magnolia:magnolia-core").map((e) => e.from).sort()).toEqual([
      "info.magnolia:magnolia-rendering",
      "info.magnolia:other-module",
      "info.magnolia:webapp",
    ]);
    expect(merged.artifacts.find((a) => a.key === "info.magnolia:magnolia-rendering")!.module).toBe(true);
  });
});
