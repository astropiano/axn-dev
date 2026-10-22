import { describe, expect, it } from "vitest";
import {
  flowAdapter,
  flowAdaptersForTag,
  flowAdapterSpecs,
  hasFlowAdapter,
  registerFlowAdapter,
  type FlowAdapter,
} from "./flow-adapter.js";

const fake = (out: string): FlowAdapter => ({
  run: async (step) => `${out}:${step.value ?? ""}`,
});

function ctx() {
  return {
    env: {},
    flowDir: "/tmp",
    cwd: "/tmp",
    flowName: "test",
    flow: { name: "test" },
    runScript: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    log: () => {},
  };
}

describe("flow adapter registry", () => {
  it("registers and resolves adapters by name", async () => {
    registerFlowAdapter({ name: "t-one", tags: [], load: () => fake("one") });
    expect(hasFlowAdapter("t-one")).toBe(true);
    const a = await flowAdapter("t-one");
    expect(await a.run({ type: "script", value: "x" }, ctx())).toBe("one:x");
  });

  it("indexes adapters by the tags they serve", () => {
    registerFlowAdapter({ name: "t-msg", tags: ["usermessage"], load: () => fake("m") });
    registerFlowAdapter({ name: "t-kc", tags: ["keycloak"], load: () => fake("k") });
    expect(flowAdaptersForTag("usermessage").map((s) => s.name)).toContain("t-msg");
    expect(flowAdaptersForTag("keycloak").map((s) => s.name)).toContain("t-kc");
    expect(flowAdaptersForTag("usermessage").map((s) => s.name)).not.toContain("t-kc");
  });

  it("first registration wins on name conflicts", () => {
    registerFlowAdapter({ name: "t-dup", tags: [], load: () => fake("first") });
    registerFlowAdapter({ name: "t-dup", tags: [], load: () => fake("second") });
    const matches = flowAdapterSpecs().filter((s) => s.name === "t-dup");
    expect(matches).toHaveLength(1);
  });

  it("resolves the extends chain and passes the base to the factory", async () => {
    registerFlowAdapter({ name: "t-base", tags: [], load: () => fake("base") });
    registerFlowAdapter({
      name: "t-derived",
      tags: [],
      extends: "t-base",
      load: async (base) => ({
        run: async (step, c) => `derived(${await base!.run(step, c)})`,
      }),
    });
    const a = await flowAdapter("t-derived");
    expect(await a.run({ type: "script", value: "v" }, ctx())).toBe("derived(base:v)");
  });

  it("caches loaded instances", async () => {
    let loads = 0;
    registerFlowAdapter({ name: "t-cached", tags: [], load: () => (loads++, fake("c")) });
    await flowAdapter("t-cached");
    await flowAdapter("t-cached");
    expect(loads).toBe(1);
  });

  it("throws a helpful error for unknown adapters", async () => {
    await expect(flowAdapter("t-nope")).rejects.toThrow("Unknown flow adapter 't-nope'");
  });

  it("drops reserved flow tags with a warning", () => {
    registerFlowAdapter({ name: "t-reserved", tags: ["file", "step", "kc-tag"], load: () => fake("r") });
    const spec = flowAdapterSpecs().find((s) => s.name === "t-reserved");
    expect(spec?.tags).toEqual(["kc-tag"]);
  });

  it("keeps usermessage — message adapters legitimately serve it", () => {
    registerFlowAdapter({ name: "t-msg2", tags: ["usermessage"], load: () => fake("m2") });
    const spec = flowAdapterSpecs().find((s) => s.name === "t-msg2");
    expect(spec?.tags).toEqual(["usermessage"]);
  });
});
