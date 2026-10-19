import type { Command } from "@axn-dev/core";
import { KnowCommand } from "./know.js";

export { KnowCommand };

export const commands: Command[] = [new KnowCommand()];
