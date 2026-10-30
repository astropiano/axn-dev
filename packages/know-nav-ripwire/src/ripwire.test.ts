import { describe, it, expect, vi } from "vitest";
import type { CodeLocation } from "@axn-dev/core";
import { navigate, type RipwireOutput } from "./ripwire.js";

const ROOT = "/repo";
const method: CodeLocation = {
  path: "/repo/core/src/main/java/a/ModuleManagerImpl.java",
  line: 516,
  typeName: "ModuleManagerImpl",
  memberName: "applyDeltas",
};
const type: CodeLocation = { path: "/repo/core/src/main/java/a/AbstractRepositoryTask.java", typeName: "AbstractRepositoryTask" };

// Shapes copied from ripwire 0.6.2 output on main-1, trimmed.
const CALLERS_JSON = JSON.stringify({
  of: "ModuleManagerImpl.java:applyDeltas",
  defs: 1,
  count: 2,
  graph_ambiguous: 5362,
  graph_unresolved: 479,
  counts_floor: true,
  callers: [
    { t: "method", n: "doExec", p: "core/src/main/java/a/ModuleManagerImpl.java:402" },
    { t: "method", n: "installOrUpdateModule", p: "core/src/main/java/a/ModuleManagerImpl.java:502", tested: true },
  ],
});
const USES_XML = `<!-- ripwire uses schema=… -->
<uses schema="ripwire.uses/v1" of="AbstractRepositoryTask" defs="2" external="0" count="3" root="." graph_ambiguous="5362" graph_unresolved="479" counts_floor="1">
<u role="extends" p="core/src/main/java/a/CopyNodeTask.java:42" in_id="CopyNodeTask"/>
<u role="import" p="core/src/main/java/a/Other.java:3"/>
<u role="extends" p="core/src/main/java/a/MoveNodeTask.java:40" in_id="MoveNodeTask"/>
</uses>`;

function runner(out: Partial<RipwireOutput>) {
  return vi.fn(async (_root: string, _args: string[]) => ({ stdout: "", stderr: "", exitCode: 0, ...out }));
}

describe("ripwire navigator", () => {
  it("asks for a method's callers by file-qualified name and returns them with absolute paths and lines", async () => {
    const run = runner({ stdout: CALLERS_JSON });

    const result = await navigate("callers", method, ROOT, run);

    expect(run).toHaveBeenCalledWith(ROOT, ["--callers=ModuleManagerImpl.java:applyDeltas", "--json"]);
    expect(result.hits).toEqual([
      { path: "/repo/core/src/main/java/a/ModuleManagerImpl.java", line: 402, symbol: "doExec", kind: "method" },
      { path: "/repo/core/src/main/java/a/ModuleManagerImpl.java", line: 502, symbol: "installOrUpdateModule", kind: "method" },
    ]);
  });

  it("says the hits are a lower bound when ripwire does", async () => {
    const result = await navigate("callers", method, ROOT, runner({ stdout: CALLERS_JSON }));
    expect(result.caveats.join(" ")).toContain("lower bound");
    expect(result.caveats.join(" ")).toContain("479 references unresolved");
  });

  it("finds implementations through the unqualified type's extends uses only", async () => {
    const run = runner({ stdout: USES_XML });

    const result = await navigate("implementations", type, ROOT, run);

    // A file qualifier would narrow --uses to that one file and lose every subclass.
    expect(run).toHaveBeenCalledWith(ROOT, ["--uses=AbstractRepositoryTask"]);
    expect(result.hits.map((h) => h.symbol)).toEqual(["CopyNodeTask", "MoveNodeTask"]);
    expect(result.hits[0]).toMatchObject({ path: "/repo/core/src/main/java/a/CopyNodeTask.java", line: 42, kind: "extends" });
  });

  it("asks for the enclosing type's implementations when the hit is a method", async () => {
    const run = runner({ stdout: USES_XML });
    await navigate("implementations", method, ROOT, run);
    expect(run).toHaveBeenCalledWith(ROOT, ["--uses=ModuleManagerImpl"]);
  });

  it("keeps every role for references", async () => {
    const result = await navigate("references", type, ROOT, runner({ stdout: USES_XML }));
    expect(result.hits.map((h) => h.kind)).toEqual(["extends", "import", "extends"]);
  });

  it("points a type's callers to references or implementations", async () => {
    const result = await navigate("callers", type, ROOT, runner({ stdout: JSON.stringify({ defs: 1, callers: [] }) }));
    expect(result.caveats).toContain("'AbstractRepositoryTask' is a type, and ripwire reports callers of methods; try references or implementations.");
  });

  it("warns when the name matches several definitions", async () => {
    const result = await navigate("implementations", type, ROOT, runner({ stdout: USES_XML }));
    expect(result.caveats.join(" ")).toContain("matches 2 definitions");
  });

  it("reports an unknown symbol as no hits with a caveat, not an error", async () => {
    const run = runner({ exitCode: 1, stderr: "ripwire: --callers symbol not found: ModuleManagerImpl.java:applyDeltas (…)" });

    const result = await navigate("callers", method, ROOT, run);

    expect(result.hits).toEqual([]);
    expect(result.caveats).toEqual(["ripwire found no definition of 'ModuleManagerImpl.java:applyDeltas' under /repo."]);
  });

  it("fails on any other ripwire error", async () => {
    const run = runner({ exitCode: 2, stderr: "ripwire: cannot read /repo\nmore" });
    await expect(navigate("callers", method, ROOT, run)).rejects.toThrow("ripwire failed (exit 2): ripwire: cannot read /repo");
  });
});
