import { describe, it, expect } from "vitest";
import { extractChunks } from "../chunker.js";

const SOURCE = `package info.example.delta;

import java.util.List;

/**
 * Base task.
 */
@Deprecated
public abstract class AbstractTask extends Base implements Task {

    /** Builds the task. */
    public AbstractTask(String name) {
        super(name);
    }

    public void execute(InstallContext ctx) throws TaskException {
    }

    public void execute(InstallContext ctx, String... paths) {
    }

    // not javadoc
    private int count() { return 1; }

    public static class Inner extends AbstractTask {
        void run() {}
    }
}

enum Mode {
    ON, OFF;

    boolean enabled() { return this == ON; }
}
`;

describe("Java extraction", () => {
  it("emits types, nested types, constructors and methods with qualified paths", async () => {
    const chunks = await extractChunks("AbstractTask.java", SOURCE);

    expect(chunks.map((c) => c.titlePath)).toEqual([
      "info.example.delta.AbstractTask",
      "info.example.delta.AbstractTask.AbstractTask(String)",
      "info.example.delta.AbstractTask.execute(InstallContext)",
      "info.example.delta.AbstractTask.execute(InstallContext, String...)",
      "info.example.delta.AbstractTask.count()",
      "info.example.delta.AbstractTask.Inner",
      "info.example.delta.AbstractTask.Inner.run()",
      "info.example.delta.Mode",
      "info.example.delta.Mode.enabled()",
    ]);
  });

  it("records the 1-based line span of each declaration", async () => {
    const chunks = await extractChunks("AbstractTask.java", SOURCE);
    const byPath = new Map(chunks.map((c) => [c.titlePath, c]));

    // The declaration starts at its annotation, not at its Javadoc.
    expect(byPath.get("info.example.delta.AbstractTask")).toMatchObject({ startLine: 8, endLine: 28 });
    expect(byPath.get("info.example.delta.AbstractTask.AbstractTask(String)")).toMatchObject({ startLine: 12, endLine: 14 });
    expect(byPath.get("info.example.delta.AbstractTask.Inner.run()")).toMatchObject({ startLine: 26, endLine: 26 });
  });

  it("keeps an adjacent Javadoc in the chunk text and ignores a plain comment", async () => {
    const chunks = await extractChunks("AbstractTask.java", SOURCE);
    const text = (path: string) => chunks.find((c) => c.titlePath === path)?.text ?? "";

    expect(text("info.example.delta.AbstractTask")).toMatch(/^\/\*\*\n \* Base task\./);
    expect(text("info.example.delta.AbstractTask.AbstractTask(String)")).toMatch(/^\/\*\* Builds the task\. \*\//);
    expect(text("info.example.delta.AbstractTask.count()")).not.toContain("not javadoc");
  });

  it("assigns sequential offsets across the file", async () => {
    const chunks = await extractChunks("AbstractTask.java", SOURCE);
    expect(chunks.map((c) => c.offset)).toEqual(chunks.map((_, i) => i));
  });

  it("emits an annotation type", async () => {
    const chunks = await extractChunks("PublicApi.java", "package a;\n\npublic @interface PublicApi {\n}\n");
    expect(chunks.map((c) => c.titlePath)).toEqual(["a.PublicApi"]);
  });

  it("uses the default package when none is declared", async () => {
    const chunks = await extractChunks("Plain.java", "class Plain { void a() {} }");
    expect(chunks.map((c) => c.titlePath)).toEqual(["Plain", "Plain.a()"]);
  });
});
