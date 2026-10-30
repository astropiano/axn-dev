import { describe, it, expect } from "vitest";
import { codeLocationOf } from "./codeLocation.js";
import type { SearchResult } from "./types.js";

const hit = (path: string, titlePath?: string, startLine?: number): SearchResult =>
  ({ path, titlePath, startLine, score: 1, snippet: "", chunkOffset: 0 });

describe("codeLocationOf", () => {
  it("reads a Java method's type and member, dropping the parameter list", () => {
    expect(codeLocationOf(hit("/r/ModuleManagerImpl.java", "info.magnolia.module.ModuleManagerImpl.applyDeltas(ModuleDefinition, List<Delta>, InstallContextImpl)", 516)))
      .toEqual({ path: "/r/ModuleManagerImpl.java", line: 516, typeName: "ModuleManagerImpl", memberName: "applyDeltas" });
  });

  it("reads a Java constructor as a member named like its type", () => {
    expect(codeLocationOf(hit("/r/AbstractTask.java", "a.b.AbstractTask.AbstractTask(String)", 12)))
      .toMatchObject({ typeName: "AbstractTask", memberName: "AbstractTask" });
  });

  it("reads a qualified Java type, nested or not, as a type", () => {
    expect(codeLocationOf(hit("/r/AbstractRepositoryTask.java", "info.magnolia.module.delta.AbstractRepositoryTask", 48)))
      .toEqual({ path: "/r/AbstractRepositoryTask.java", line: 48, typeName: "AbstractRepositoryTask" });
    expect(codeLocationOf(hit("/r/Outer.java", "a.Outer.Inner", 9))).toMatchObject({ typeName: "Inner" });
    expect(codeLocationOf(hit("/r/Outer.java", "a.Outer.Inner.run()", 10))).toMatchObject({ typeName: "Inner", memberName: "run" });
  });

  it("reads a TypeScript member and a TypeScript type from the regex extractor's titles", () => {
    expect(codeLocationOf(hit("/r/know.ts", "KnowCommand.find"))).toEqual({ path: "/r/know.ts", typeName: "KnowCommand", memberName: "find" });
    expect(codeLocationOf(hit("/r/know.ts", "KnowCommand"))).toEqual({ path: "/r/know.ts", typeName: "KnowCommand" });
  });

  it("is null for a hit that is not a code symbol", () => {
    expect(codeLocationOf(hit("/r/docs/setup.md", "Setup"))).toBeNull();
    expect(codeLocationOf(hit("/r/notes.txt"))).toBeNull();
  });
});
