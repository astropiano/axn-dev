import type { Command } from "@axn-dev/core";
import { FlowCommand } from "./flow.js";

export { FlowCommand };
export * from "@axn-dev/flow-format";

export const commands: Command[] = [new FlowCommand()];
