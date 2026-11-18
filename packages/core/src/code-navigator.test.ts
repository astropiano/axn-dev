import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { codeNavigatorsFor, navigateCode, registerCodeNavigator } from "./code-navigator.js";

const TMP = join(tmpdir(), "axn-code-nav-test-" + process.pid);

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
  // Echoes its input back, so the test can see what reached the navigator.
  writeFileSync(
    join(TMP, "echo.mjs"),
    `export const navigator = {
      async navigate(query, location) {
        return { navigator: "", hits: [{ path: location.path, symbol: query + ":" + location.typeName + "." + location.memberName }], caveats: [] };
      },
    };`,
  );
  writeFileSync(join(TMP, "empty.mjs"), "export const nothing = 1;");
  registerCodeNavigator({ name: "echo", extensions: [".javax"], entry: join(TMP, "echo.mjs") });
  registerCodeNavigator({ name: "broken", extensions: [".broken"], entry: join(TMP, "empty.mjs") });
});

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("code navigators", () => {
  it("picks a navigator by file extension, ignoring case", () => {
    expect(codeNavigatorsFor("/src/Foo.JAVAX").map((s) => s.name)).toEqual(["echo"]);
    expect(codeNavigatorsFor("/src/foo.unknown")).toEqual([]);
  });

  it("returns null when no navigator serves the file", async () => {
    expect(await navigateCode("callers", { path: "/src/foo.unknown", typeName: "Foo" })).toBeNull();
  });

  it("hands the query and location to the navigator, naming it in the result", async () => {
    const result = await navigateCode("callers", { path: "/src/Foo.javax", typeName: "Foo", memberName: "bar" });

    expect(result).toEqual({
      navigator: "echo",
      hits: [{ path: "/src/Foo.javax", symbol: "callers:Foo.bar" }],
      caveats: [],
    });
  });

  it("rejects a module that exports no navigator", async () => {
    await expect(navigateCode("callers", { path: "/x.broken", typeName: "X" })).rejects.toThrow("must export 'navigator'");
  });
});
