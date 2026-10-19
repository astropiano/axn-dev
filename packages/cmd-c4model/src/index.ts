import type { Command } from "@axn-dev/core";
import { C4ModelCommand } from "./c4model.js";

export { C4ModelCommand };

export const commands: Command[] = [new C4ModelCommand()];
