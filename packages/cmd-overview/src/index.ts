import type { Command } from "@axn-dev/core";
import { OverviewCommand } from "./overview.js";

export { OverviewCommand };

export const commands: Command[] = [new OverviewCommand()];
