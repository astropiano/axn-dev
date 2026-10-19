import type { Command } from "@axn-dev/core";
import { ServeCommand } from "./serve.js";

export { ServeCommand };

export const commands: Command[] = [new ServeCommand()];
