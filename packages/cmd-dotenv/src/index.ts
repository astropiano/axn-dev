import type { Command } from "@axn-dev/core";
import { BackupCommand } from "./backup.js";
import { RestoreCommand } from "./restore.js";

export { BackupCommand, RestoreCommand };

export const commands: Command[] = [new BackupCommand(), new RestoreCommand()];
