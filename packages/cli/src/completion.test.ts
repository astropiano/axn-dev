import { describe, it, expect } from "vitest";
import { complete } from "./completion.js";
import { CommandRegistry, type Command } from "@axn-dev/core";

function makeRegistry(...cmds: Command[]): CommandRegistry {
  const registry = new CommandRegistry();
  for (const c of cmds) registry.register(c);
  return registry;
}

const stub = (name: string, completions: string[] = []): Command => ({
  name,
  description: `${name} command`,
  help: () => "",
  execute: async () => {},
  complete: () => completions,
});

describe("completion engine", () => {
  it("completes command names by prefix", async () => {
    const registry = makeRegistry(stub("flow"), stub("infra"), stub("init"));
    expect(await complete(["axn-dev", "f"], registry)).toEqual(["flow"]);
    expect(await complete(["axn-dev", "i"], registry)).toEqual(["infra", "init"]);
  });

  it("does not repeat the exact command name", async () => {
    const registry = makeRegistry(stub("flow"));
    expect(await complete(["axn-dev", "flow"], registry)).toEqual([]);
  });

  it("delegates to the command's complete()", async () => {
    const registry = makeRegistry(stub("flow", ["--file", "--filter"]));
    expect(await complete(["axn-dev", "flow", ""], registry)).toEqual(["--file", "--filter"]);
  });

  it("returns nothing for unknown commands and commands without completers", async () => {
    const registry = makeRegistry(stub("flow"), { name: "plain", description: "", help: () => "", execute: async () => {} });
    expect(await complete(["axn-dev", "nope", ""], registry)).toEqual([]);
    expect(await complete(["axn-dev", "plain", ""], registry)).toEqual([]);
  });
});
