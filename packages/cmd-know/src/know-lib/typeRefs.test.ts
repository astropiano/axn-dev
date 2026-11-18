import { describe, it, expect } from "vitest";
import { extractJavaFacts } from "./extractors/java.js";
import { denotes, typeReferences } from "./typeRefs.js";
import type { CodeFacts, KnowItem } from "./types.js";

describe("extractJavaFacts", () => {
  it("records the package, type imports and wildcards, and every type use with its lines", async () => {
    const facts = await extractJavaFacts(`package a.b;
import x.y.Foo;
import x.z.*;
import static x.y.Util.helper;
class C extends Base<Foo> {
  private Map<String, Foo> m;
  Foo run(x.q.Qualified q) { return new Foo(); }
}`);

    expect(facts.package).toBe("a.b");
    expect(facts.imports).toEqual(["x.y.Foo", "x.z.*"]);
    expect(facts.types.Foo).toEqual([5, 6, 7]);
    // A qualified use is one name, not its parts.
    expect(facts.types["x.q.Qualified"]).toEqual([7]);
    expect(facts.types.Qualified).toBeUndefined();
  });
});

describe("denotes", () => {
  const T = "info.magnolia.module.ModuleVersionHandler";
  const facts = (pkg: string, imports: string[] = []): CodeFacts => ({ package: pkg, imports, types: {} });

  it("resolves a simple name through an explicit import, the same package, or a wildcard", () => {
    expect(denotes("ModuleVersionHandler", T, facts("other", [T]))).toBe(true);
    expect(denotes("ModuleVersionHandler", T, facts("info.magnolia.module"))).toBe(true);
    expect(denotes("ModuleVersionHandler", T, facts("other", ["info.magnolia.module.*"]))).toBe(true);
  });

  it("does not resolve a same-named type from another package", () => {
    expect(denotes("ModuleVersionHandler", T, facts("other"))).toBe(false);
    expect(denotes("ModuleVersionHandler", T, facts("other", ["com.acme.ModuleVersionHandler"]))).toBe(false);
  });

  it("lets an explicit import win over a wildcard, as Java does", () => {
    expect(denotes("ModuleVersionHandler", T, facts("other", ["com.acme.ModuleVersionHandler", "info.magnolia.module.*"]))).toBe(false);
  });

  it("resolves a fully qualified use, and a nested type through its enclosing type", () => {
    expect(denotes(T, T, facts("other"))).toBe(true);
    expect(denotes("Outer.Inner", "p.Outer.Inner", facts("other", ["p.Outer"]))).toBe(true);
    expect(denotes("Outer.Inner", "p.Outer.Inner", facts("p"))).toBe(true);
    expect(denotes("Inner", "p.Outer.Inner", facts("other", ["p.Outer.Inner"]))).toBe(true);
  });
});

describe("typeReferences", () => {
  const item = (path: string, code: CodeFacts, chunks: KnowItem["chunks"] = []): KnowItem =>
    ({ path, added: "", hash: "h", chunks, code });
  const T = "zoo.Pouch";

  it("finds resolved uses outside the declaring file, naming the innermost enclosing symbol", () => {
    const items = [
      item("/zoo/Pouch.java", { package: "zoo", imports: [], types: { Pouch: [3] } }),
      item("/zoo/Keeper.java", { package: "zoo", imports: [], types: { Pouch: [4, 7] } }, [
        { offset: 0, text: "", title: "Keeper", startLine: 3, endLine: 9 },
        { offset: 1, text: "", title: "feed(Pouch)", startLine: 6, endLine: 8 },
      ]),
      item("/other/Pouch2.java", { package: "other", imports: [], types: { Pouch: [2] } }),
    ];

    expect(typeReferences(items, T, "/zoo/Pouch.java")).toEqual([
      { path: "/zoo/Keeper.java", line: 4, symbol: "Keeper", kind: "type" },
      { path: "/zoo/Keeper.java", line: 7, symbol: "feed(Pouch)", kind: "type" },
    ]);
  });

  it("skips items indexed without code facts", () => {
    const bare: KnowItem = { path: "/zoo/Old.java", added: "", hash: "h", chunks: [] };
    expect(typeReferences([bare], T, "/zoo/Pouch.java")).toEqual([]);
  });
});
